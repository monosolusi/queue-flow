import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * DoD-3 (NFR-REL-01) — No external network at runtime.
 *
 * PRD NFR-REL-01: the system runs 100% on the local LAN — no external CDN/API
 * calls at runtime. Every asset (JS, CSS, fonts, audio, DB drivers) is served
 * from the local PC server. This spec parses each frontend's **built** bundle
 * (`dist/`) and asserts no external `https://` / `http://` URL leaks in. The
 * frontends must be built first (the orchestrated `verify` / `acceptance`
 * scripts build them before running `test:acceptance`); if a `dist` is absent
 * the spec skips that service with a clear message rather than failing, so a
 * standalone `npm run test:acceptance` from core-api stays green.
 *
 * Vendor doc-link strings inside bundled libs are NOT runtime fetches — React
 * embeds an error-decoder doc URL, Workbox embeds a bit.ly doc link, and
 * SVG/XML namespace identifiers use w3.org URLs. These are whitelisted by host.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const FRONTENDS = ['kiosk-service', 'caller-service', 'tv-display-service', 'admin-service'];

/** Hosts that may appear in built bundles without indicating a runtime fetch. */
const ALLOWED_HOSTS = new Set([
  'www.w3.org', // SVG/XML/XHTML/XLink/MathML namespace identifiers (not fetched)
  'reactjs.org', // React dev error-decoder doc link (not fetched in production)
  'bit.ly', // Workbox precache/cacheable-response doc links (warning text only)
  // `date-fns` (transitive dep of react-day-picker, admin-service DateField):
  // `_lib/protectedTokens` embeds a docs link in the text of the RangeError it
  // throws for a misused format token (`YYYY` instead of `yyyy`). It is a thrown
  // error message, never fetched — same class as the reactjs.org error-decoder URL.
  'github.com',
  // SheetJS (`xlsx`) embedded identifiers — written into the generated .xlsx XML
  // as OOXML/ODF namespace URIs and metadata, never fetched at runtime (the
  // export is a pure client-side Blob build, NFR-REL-01). Same class as w3.org.
  'schemas.openxmlformats.org', // OOXML spreadsheet/office/package namespaces
  'sheetjs.openxmlformats.org', // SheetJS OOXML relationship namespace URI written into .xlsx metadata (not fetched)
  'schemas.microsoft.com', // Office extension namespaces (VBA, rich data, …)
  'purl.org', // Dublin Core + OOXML relationship namespace identifiers
  'purl.oclc.org', // OOXML relationship namespace identifiers
  'openoffice.org', // ODF (OpenDocument) namespace identifiers
  'docs.oasis-open.org', // ODF metadata namespace identifiers
  'sheetjs.com', // SheetJS library origin/metadata string (not fetched)
  'macVmlSchemaUri', // SheetJS macOS VML schema placeholder literal (not a URL)
  // React Flow (`@xyflow/react` v12, admin-service state-machine workflow builder):
  // `reactflow.dev?utm_source=attribution` is the attribution-link constant
  // (hidden via `proOptions.hideAttribution` — never rendered, never fetched).
  // `hostOf` does not stop at `?`, so the query string is part of the extracted
  // "host" here (the URL has no path component to terminate the match earlier).
  // `${e}flow.dev` is a minified template-literal fragment from the error-code
  // help URLs (`https://${e}flow.dev/error#NNN`); `e` resolves to `"react"` or
  // `"xy"` at runtime → `reactflow.dev` / `xyflow.dev`. Both are doc/error-message
  // strings embedded in the library, never fetched at runtime (NFR-REL-01).
  'reactflow.dev?utm_source=attribution',
  // Defense-in-depth: list the concrete hosts alongside the minified template
  // fragment so a future `@xyflow/react` version that (a) drops `?utm_source=…`
  // from the attribution constant, or (b) stops emitting the `${e}flow.dev`
  // template literal in favor of the resolved strings, does not silently
  // redden the offline-assets gate. These never match today but cost nothing.
  'reactflow.dev',
  'xyflow.dev',
  '${e}flow.dev',
  // Liferay Kaleo (`admin-service` Alur Status Tiket "Sumber" view): the XML
  // codec emits a `<workflow-definition>` whose root carries the Kaleo
  // `xsi:schemaLocation` hint `http://www.liferay.com/dtd/liferay-workflow-
  // definition_7_4_0.xsd`. It is an inert literal inside a generated XML
  // *string* rendered into a textarea — no validating parser runs offline and
  // the XSD is never fetched (NFR-REL-01). Same class as the SheetJS OOXML
  // namespace URIs above, which are likewise written into generated XML. The
  // namespace proper (`urn:liferay.com:liferay-workflow_7.4.0`) is a URN, not
  // an http URL, so it never reaches this gate at all.
  'www.liferay.com',
]);

/** Extracts the host from an http(s) URL string, or null if not a real URL. */
function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/"'\s<>)]+)/.exec(url);
  return m ? m[1] : null;
}

/** All http(s) URL occurrences across a directory's files (recursive). */
function externalUrls(dir: string): string[] {
  const urls: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|css|html|webmanifest|svg)$/.test(entry.name)) {
        const src = readFileSync(full, 'utf8');
        // Match http(s) URL literals in the bundle.
        const re = /https?:\/\/[^\s"'`<>)]+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) urls.push(m[0]);
      }
    }
  };
  walk(dir);
  return urls;
}

function hasDist(service: string): boolean {
  return existsSync(join(REPO_ROOT, 'services', service, 'dist', 'index.html'));
}

describe('DoD-3 (NFR-REL-01) — built frontends make no external network calls', () => {
  const builtFrontends = FRONTENDS.filter(hasDist);

  if (builtFrontends.length === 0) {
    it.skip('skipped: no frontend dist/ found (build frontends first)', () => {
      // The orchestrated verify/acceptance scripts build frontends before this
      // runs; a standalone `test:acceptance` from core-api skips gracefully.
    });
    return;
  }

  for (const service of builtFrontends) {
    it(`${service} built bundle references no non-whitelisted external URL`, () => {
      const distDir = join(REPO_ROOT, 'services', service, 'dist');
      const offenders = externalUrls(distDir)
        .filter((u) => {
          const host = hostOf(u);
          return host !== null && !ALLOWED_HOSTS.has(host);
        });
      // Surface the offending URLs so diagnosis is immediate.
      if (offenders.length > 0) {
        throw new Error(
          `${service} references external URLs (NFR-REL-01 violation):\n` +
            offenders.map((u) => `  ${u}`).join('\n'),
        );
      }
      expect(offenders).toEqual([]);
    });

    it(`${service} index.html loads assets via the local sub-path only`, () => {
      const html = readFileSync(
        join(REPO_ROOT, 'services', service, 'dist', 'index.html'),
        'utf8',
      );
      // Every src/href in the built HTML must be a relative sub-path (the
      // gateway serves them locally), never an absolute external URL.
      const re = /(?:src|href)="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const ref = m[1];
        if (/^https?:\/\//.test(ref)) {
          throw new Error(`${service} index.html references external URL: ${ref}`);
        }
      }
    });
  }
});

// Keep `statSync` referenced for type completeness on some toolchains.
void statSync;
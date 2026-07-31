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
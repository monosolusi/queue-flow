#!/usr/bin/env node
// Orchestrates the per-service verify gate across the monorepo. Each service
// owns its own package.json + install; this script chains them in dependency
// order and fails fast on the first non-zero exit. No workspaces — each
// `npm run` is scoped to its service directory.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { SIGNING_KEY_MISSING_MESSAGE, isSigningKeyConfigured } from './lib/signing-key-gate.mjs';

const root = new URL('..', import.meta.url).pathname;

function run(label, cwd, command) {
  process.stdout.write(`\n▶ ${label}: ${command}\n`);
  execSync(command, { cwd: `${root}/services/${cwd}`, stdio: 'inherit', env: process.env });
}

// tts-service is Python, so it has no `npm run` entry point and `run()` above
// (which assumes npm) cannot reach it. Its virtualenv is a per-service install,
// exactly like every other service's node_modules — see CLAUDE.md.
function runPythonTests(label, cwd) {
  const serviceDir = `${root}/services/${cwd}`;
  const python = `${serviceDir}/.venv/bin/python`;
  if (!existsSync(python)) {
    throw new Error(
      `${cwd} has no virtualenv at .venv — set it up once with:\n` +
        `    cd services/${cwd}\n` +
        `    python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt\n` +
        `  (the suite skips its ffmpeg/Piper-dependent tests when those are absent,\n` +
        `   so no model download is needed just to run the gate)`,
    );
  }
  process.stdout.write(`\n▶ ${label}: .venv/bin/python -m pytest\n`);
  execSync(`${JSON.stringify(python)} -m pytest`, {
    cwd: serviceDir,
    stdio: 'inherit',
    env: process.env,
  });
}

// The one file in tools/license-format that is allowed to contain private
// key material: a throwaway key that signs only the golden test fixture.
const ALLOWED_KEY_FILE = 'tools/license-format/test/fixtures/test-signing-key.pem';

// Leaking the license signing key would let anyone mint licenses for every
// installation ever shipped, and a leak is unrecoverable — you cannot revoke a
// key from machines that have no network.
//
// Scans tracked, untracked AND **ignored** files. The ignored pass is the point:
// `.gitignore` excludes `*.pem`, so the single most likely accident — dropping
// a copy of the licensing product's signing key into the repo while debugging —
// is invisible to `--exclude-standard`. An ignore rule also goes silent the moment
// someone force-adds the file, which is the other case this catches.
function assertNoSigningKeyInTree() {
  process.stdout.write('\n▶ license signing-key leak gate\n');
  // `--directory` collapses a wholly-ignored directory into one entry, so the
  // ignored pass lists `node_modules/` rather than its 40k files — without it
  // the output overflows execSync's buffer (ENOBUFS) and the gate dies instead
  // of running. A stray key at the repo root is still listed individually,
  // which is the case this pass exists for.
  const listed = [
    execSync('git ls-files --cached --others --exclude-standard', { cwd: root, encoding: 'utf8' }),
    execSync('git ls-files --others --ignored --exclude-standard --directory', {
      cwd: root,
      encoding: 'utf8',
    }),
  ].join('\n');

  const files = listed
    .split('\n')
    .filter(
      (f) =>
        f.length > 0 &&
        f !== ALLOWED_KEY_FILE &&
        // Third-party trees carry their own test keys; scanning them is noise.
        // Directory entries end in '/'; readFileSync on them throws EISDIR and
        // is caught below, but filtering here keeps the scan cheap.
        !f.endsWith('/'),
    );

  const leaked = files.filter((file) => {
    try {
      return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(readFileSync(`${root}/${file}`, 'utf8'));
    } catch {
      return false; // unreadable or binary — not a PEM key
    }
  });

  if (leaked.length > 0) {
    throw new Error(
      `private key material found in the repo tree:\n    ${leaked.join('\n    ')}\n` +
        `  The license signing key must live outside the repo (default ~/.qms-license/).\n` +
        `  Only ${ALLOWED_KEY_FILE} may contain a key, and it signs test fixtures only.`,
    );
  }
}

/**
 * Fails only when `QMS_RELEASE=1` — a developer checkout before the one-time
 * key paste is a legitimate state and should not have a red gate, but the
 * release path must not be able to walk past it. `release.mjs` enforces the
 * same rule unconditionally, and core-api logs an error at boot when a
 * production image has no key.
 */
function assertSigningKeyConfigured() {
  if (isSigningKeyConfigured(root)) return;

  if (process.env.QMS_RELEASE === '1') {
    throw new Error(SIGNING_KEY_MISSING_MESSAGE);
  }
  process.stdout.write(
    `\n⚠ ${SIGNING_KEY_MISSING_MESSAGE}\n  (not fatal here; QMS_RELEASE=1 makes it fatal)\n`,
  );
}

let failed = false;
try {
  // Design-token drift gate (QUE-37): re-vendor the canonical shared tokens into
  // each service, then fail if a generated copy diverges from the source —
  // catches both a forgotten re-sync after editing the source and a direct
  // edit of a generated copy (the sync overwrites it → diff).
  process.stdout.write('\n▶ design-token sync + drift: node scripts/sync-design-tokens.mjs\n');
  execSync('node scripts/sync-design-tokens.mjs', { cwd: root, stdio: 'inherit', env: process.env });
  execSync('git diff --exit-code -- services/*/src/styles/_tokens.css services/*/src/styles/_interactions.css', {
    cwd: root, stdio: 'inherit', env: process.env,
  });
  assertNoSigningKeyInTree();
  assertSigningKeyConfigured();
  // The licence wire format (tools/, outside every Docker build context). Runs
  // first and cheaply: its committed golden.lic is the drift gate against
  // core-api's independent verifier, so if the token format moved, failing here
  // names the cause directly instead of surfacing as an unexplained verifier
  // failure later in the run.
  process.stdout.write('\n▶ license-format (node --test)\n');
  execSync('npm test', {
    cwd: `${root}/tools/license-format`, stdio: 'inherit', env: process.env,
  });
  // core-api: arch:check + jest + build (the architecture gate, NFR-MNT-01).
  run('core-api (arch + unit + build)', 'core-api', 'npm run verify');
  // tts-service: pytest. Runs before the frontends because the TV board's
  // announcement audio comes from here — a broken script generator is more
  // fundamental than a broken render.
  runPythonTests('tts-service (pytest)', 'tts-service');
  // frontends: vitest + vite build.
  for (const svc of ['admin-service', 'tv-display-service', 'caller-service', 'kiosk-service']) {
    run(`${svc} (vitest + build)`, svc, 'npm test && npm run build');
  }
  // The in-process acceptance suite (DoD-1 arch, DoD-2 wizard API, DoD-3 flow,
  // DoD-3 no-external-network). No DB required. DoD-4 (power-cut) is gated on
  // QMS_ACCEPTANCE_DB_URL and skips when unset, so this stays green without a
  // running PostgreSQL.
  run('core-api acceptance (DoD-1/2-api/3)', 'core-api', 'npm run test:acceptance');
} catch (err) {
  failed = true;
  process.stderr.write(`\n✖ verify failed: ${err.message}\n`);
}

process.exit(failed ? 1 : 0);
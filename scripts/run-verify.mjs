#!/usr/bin/env node
// Orchestrates the per-service verify gate across the monorepo. Each service
// owns its own package.json + install; this script chains them in dependency
// order and fails fast on the first non-zero exit. No workspaces — each
// `npm run` is scoped to its service directory.
import { execSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const services = ['core-api', 'admin-service', 'tv-display-service', 'caller-service', 'kiosk-service'];

function run(label, cwd, command) {
  process.stdout.write(`\n▶ ${label}: ${command}\n`);
  execSync(command, { cwd: `${root}/services/${cwd}`, stdio: 'inherit', env: process.env });
}

let failed = false;
try {
  // core-api: arch:check + jest + build (the architecture gate, NFR-MNT-01).
  run('core-api (arch + unit + build)', 'core-api', 'npm run verify');
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
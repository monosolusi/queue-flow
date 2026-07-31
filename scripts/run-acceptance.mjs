#!/usr/bin/env node
// Orchestrates the full PRD §8 Definition-of-Done acceptance run.
//
// DoD-1 (architecture), DoD-2 (first-run wizard API), and DoD-3 (offline E2E
// flow + realtime latency + no-external-network) run in-process against the
// in-memory persistence profile — no database needed. DoD-4 (power-cut
// recovery) spawns the built core-api against a real PostgreSQL and is gated
// on QMS_ACCEPTANCE_DB_URL; it skips (and the run stays green) when unset.
//
// Sequence: build frontends (so the no-external-network spec can parse their
// built dist), build core-api (so the power-cut spec can spawn dist/main.js),
// then run the acceptance jest suite.
import { execSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const dbUrl = process.env.QMS_ACCEPTANCE_DB_URL;

function run(label, cwd, command) {
  process.stdout.write(`\n▶ ${label}: ${command}\n`);
  execSync(command, { cwd: `${root}/services/${cwd}`, stdio: 'inherit', env: process.env });
}

let failed = false;
try {
  for (const svc of ['admin-service', 'tv-display-service', 'caller-service', 'kiosk-service']) {
    run(`${svc} build`, svc, 'npm run build');
  }
  run('core-api build', 'core-api', 'npm run build');
  // In-process acceptance (DoD-1/2-api/3) always runs. DoD-4 self-skips when
  // QMS_ACCEPTANCE_DB_URL is unset; when set, it boots a real Postgres-backed
  // core-api child process and SIGKILLs it mid-flight.
  const env = { ...process.env };
  if (dbUrl) {
    env.QMS_ACCEPTANCE_DB_URL = dbUrl;
  }
  process.stdout.write('\n▶ core-api acceptance (DoD-1/2-api/3 + DoD-4 if DB set)\n');
  execSync('npm run test:acceptance', { cwd: `${root}/services/core-api`, stdio: 'inherit', env });
} catch (err) {
  failed = true;
  process.stderr.write(`\n✖ acceptance failed: ${err.message}\n`);
}

process.exit(failed ? 1 : 0);
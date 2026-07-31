#!/usr/bin/env node
// QUE-27 topology smoke test — proves the single-host Docker Compose
// topology serves every PRD route through the NGINX gateway.
//
// Two tiers:
//   Tier 1 (always, no Docker daemon required): `docker compose config -q`
//     validates the compose file parses, and a static assertion confirms all
//     seven PRD services are declared.
//   Tier 2 (only if a Docker daemon is reachable): `docker compose up -d
//     --build`, wait for the gateway to come up, then GET each route and
//     assert status/body. Torn down with `docker compose down -v`.
//
// Tier 2 is SKIPPED (not failed) when no Docker daemon is available, so the
// script is safe to run in CI without a Docker socket — the skip is printed
// loudly, never silent.
//
// This is intentionally NOT part of `scripts/run-verify.mjs` — that gate is
// per-service unit/build/acceptance and must not start requiring Docker. Run
// it explicitly: `npm run compose:verify`.
//
// NOTE: we use Node's built-in `http` (not `fetch`) so we can read the 301
// `Location` header — `fetch` with `redirect: 'manual'` returns an
// opaqueredirect response (status 0, filtered headers) and hides it.
import http from 'node:http';
import { execSync, spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const HOST = 'localhost';
const PORT = 80;

const PRD_SERVICES = [
  'gateway',
  'core-api-service',
  'kiosk-service',
  'tv-display-service',
  'caller-service',
  'admin-service',
  'db-service',
];

function sh(cmd) {
  return execSync(cmd, { cwd: root, stdio: 'pipe' }).toString().trim();
}

let failed = false;
let tier2Up = false;

// Plain GET with NO redirect following — returns status + Location + body so
// we can assert both 200 (PWAs) and 301 (clean-browser redirects).
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: HOST, port: PORT, path, headers: { Connection: 'close' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`timeout GET ${path}`)));
  });
}

async function waitFor(path, { wantStatus, wantBody, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await get(path);
      if (r.status === wantStatus && (!wantBody || r.body.includes(wantBody))) return r;
    } catch {
      // gateway not ready yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timed out waiting for http://${HOST}:${PORT}${path} (wanted ${wantStatus})`);
}

async function assertRoute(label, path, { status, body, redirect } = {}) {
  const r = await get(path);
  // nginx emits an ABSOLUTE Location (e.g. `http://localhost/admin/`) for a
  // relative `return 301 /admin/` — it resolves against the Host header. Match
  // by suffix so the assertion holds for both relative and absolute forms.
  const ok =
    r.status === status &&
    (!body || r.body.includes(body)) &&
    (!redirect || (r.location || '').endsWith(redirect));
  if (!ok) {
    throw new Error(
      `${label}: expected ${status}${redirect ? ` -> …${redirect}` : ''}${body ? ` body~${JSON.stringify(body)}` : ''}, got ${r.status}${redirect ? ` loc=${r.location}` : ''}${body ? ` body=${JSON.stringify(r.body.slice(0, 80))}` : ''}`,
    );
  }
  process.stdout.write(`  ${label}: ${r.status} OK\n`);
}

function tier1() {
  process.stdout.write('\n▶ Tier 1: compose file validation\n');
  sh('docker compose config -q'); // throws on a malformed file
  process.stdout.write('  compose file parses OK\n');

  const configJson = sh('docker compose config --format json'); // no daemon needed
  const services = Object.keys(JSON.parse(configJson).services || {});
  const missing = PRD_SERVICES.filter((s) => !services.includes(s));
  if (missing.length) throw new Error(`compose missing PRD service(s): ${missing.join(', ')}`);
  process.stdout.write(`  all ${PRD_SERVICES.length} PRD services present\n`);
}

function daemonUp() {
  try {
    return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

async function tier2() {
  if (!daemonUp()) {
    process.stdout.write('\n▶ Tier 2: SKIPPED (no Docker daemon reachable)\n');
    return;
  }
  process.stdout.write('\n▶ Tier 2: boot stack + route checks (Docker daemon up)\n');
  execSync('docker compose up -d --build', { cwd: root, stdio: 'inherit' });
  tier2Up = true;

  // Wait for /api/health through the gateway — implicitly waits on the
  // gateway's service_healthy dependency on core-api (compose graph gates
  // gateway startup until core-api's healthcheck is green).
  await waitFor('/api/health', { wantStatus: 200, wantBody: '"status":"ok"' });

  await assertRoute('GET /api/health', '/api/health', { status: 200, body: '"status":"ok"' });
  await assertRoute('GET / (clean browser)', '/', { status: 301, redirect: '/admin/' });
  await assertRoute('GET /wizard', '/wizard', { status: 301, redirect: '/admin/wizard' });
  await assertRoute('GET /kiosk/', '/kiosk/', { status: 200, body: '/kiosk/manifest.webmanifest' });
  await assertRoute('GET /tv/', '/tv/', { status: 200, body: '/tv/manifest.webmanifest' });
  await assertRoute('GET /caller/', '/caller/', { status: 200, body: '/caller/manifest.webmanifest' });
  await assertRoute('GET /admin/', '/admin/', { status: 200, body: '/admin/manifest.webmanifest' });
}

try {
  tier1();
  await tier2();
  process.stdout.write('\n✓ topology OK\n');
} catch (err) {
  failed = true;
  process.stderr.write(`\n✖ topology verify failed: ${err.message}\n`);
} finally {
  if (tier2Up) {
    try {
      execSync('docker compose down -v', { cwd: root, stdio: 'inherit' });
    } catch {
      // best-effort teardown; don't mask the real failure
    }
  }
}

process.exit(failed ? 1 : 0);
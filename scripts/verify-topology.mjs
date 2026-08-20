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
import { createPrivateKey } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
// The vendor generator, used here as an integration partner rather than a
// fixture: tier 2 mints a real license for the running stack, so this check
// also proves the tool and the shipped verifier agree on the wire format.
// Both sides are .mjs at the repo root, so this is a plain same-language
// import — not the TS/.mjs cross-tree coupling the design avoids elsewhere.
import { encodeToken, generateSigningKeyPair } from '../tools/license-generator/src/token.mjs';
import { buildPayload } from '../tools/license-generator/src/payload.mjs';

const root = new URL('..', import.meta.url).pathname;
const HOST = 'localhost';
const PORT = 80;

const PRD_SERVICES = [
  'gateway',
  'core-api-service',
  'tts-service',
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
// we can assert both 200 (PWAs) and 301/302 (clean-browser + first-run redirects).
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

// JSON PUT — drives the wizard through the gateway so the first-run guard can
// be exercised pre- and post-setup (FR-WZD-01). Returns status + body.
function putJson(path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`timeout PUT ${path}`)));
    req.write(payload);
    req.end();
  });
}

// PRD §7 reference wizard payload. Intentionally inlined rather than shared
// with `services/core-api/test/acceptance/_helpers.ts` `prdWizardPayload()`: a
// shared fixture would couple this root infra script to a path inside a
// service's test tree (and the TS helper can't be imported by a standalone mjs
// without a TS loader). The two sites test different layers (in-process
// supertest vs. the live gateway). Keep both in sync with PRD §7 when the
// wizard contract changes.
//
// THIS IS THE UNGUARDED COPY. Its TS twin is checked against the controller by
// `system-config-wizard.integration.spec.ts` ("payload parity gate"), which runs
// under `npm run verify`; nothing checks this one, because reaching the
// controller's constant from a standalone .mjs would need the TS loader the
// paragraph above exists to avoid. So when that gate fails, fix BOTH — this file
// is the one that will otherwise sit broken until someone runs
// `npm run compose:verify`, which is exactly how it drifted to 7 of 15 fields.
function prdWizardPayload() {
  return {
    storeName: 'Toko Utama Surabaya',
    stateMachine: {
      states: ['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
        { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
        { from: 'CALLING', to: 'SKIPPED', actionLabel: 'Lewati / Absen' },
        { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang' },
        { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan' },
      ],
    },
    dailyReset: { mode: 'AUTOMATIC_CRON', cronExpression: '0 0 * * *', resetTicketNumberTo: 1, archivePreviousDayData: true },
    categories: [
      { code: 'A', name: 'Customer Service' },
      { code: 'B', name: 'Kasir & Pembayaran' },
    ],
    routingRules: [
      { counterId: 1, counterName: 'Counter 1 (CS)', assignedCategoryCodes: ['A'], priorityPolicy: 'FIFO_GLOBAL' },
      { counterId: 2, counterName: 'Counter 2 (Serbaguna)', assignedCategoryCodes: ['A', 'B'], priorityPolicy: 'CATEGORY_PRIORITY' },
    ],
    brandColor: '#2563eb',
    serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
    tvPanelLayout: [
      { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
      { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
      { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
      { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
      { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
    ],
    // The client is the source of truth for these canvas/appearance fields, and
    // all of them are REQUIRED by the controller's presence guard — a payload
    // missing any one is a 400, not a partial save. Seven of them were absent
    // here while the guard grew. The PUT below does throw on a non-200, so this
    // was never silent — it simply never ran: tier 2 needs a live gateway, so it
    // is outside `npm run verify` and only executes on `npm run compose:verify`.
    // Keep this list in step with `REQUIRED_CONFIG_FIELDS` in
    // services/core-api/src/interface-adapters/rest/system-config.controller.ts.
    edgeRoutingLayout: {},
    nodePositions: {},
    nodeActions: {},
    terminalNodes: { start: 'auto', end: 'auto' },
    endSources: [],
    startSources: [],
    printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
    // Announcement delivery — speed 1.0, no added pause (what the board did
    // before the setting existed).
    ttsConfiguration: { speed: 1, volume: 1, pauseMs: 0 },
    // No `actor` field — the controller ignores body.actor and uses the
    // authenticated principal's username (QUE-43). Mirrors the acceptance
    // helper `prdWizardPayload()` in services/core-api/test/acceptance/_helpers.ts.
  };
}

function postJson(path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Connection: 'close',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout POST ${path}`)));
    req.write(payload);
    req.end();
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

const overlayPath = `${root}docker-compose.topology.yml`;
let signingKey = null;

async function tier2() {
  if (!daemonUp()) {
    process.stdout.write('\n▶ Tier 2: SKIPPED (no Docker daemon reachable)\n');
    return;
  }
  process.stdout.write('\n▶ Tier 2: boot stack + route checks (Docker daemon up)\n');

  // The shipped image trusts no signing key (trusted-keys.ts is deliberately
  // empty until the vendor runs `keygen`), so a stock stack could never be
  // activated and every assertion past the license gate would be unreachable.
  // Rather than gating the whole tier behind an env var and losing the existing
  // route coverage, mint a throwaway key and hand it to core-api through the
  // non-production env seam. NODE_ENV=test is what opens that seam.
  //
  // This is a test harness deliberately relaxing the deployment, not a
  // demonstration that production is soft: a real install ships NODE_ENV=
  // production and no such key.
  signingKey = generateSigningKeyPair();
  writeFileSync(
    overlayPath,
    [
      '# Generated by scripts/verify-topology.mjs. Ephemeral — deleted on teardown.',
      'services:',
      '  core-api-service:',
      '    environment:',
      '      NODE_ENV: test',
      `      QMS_LICENSE_TRUSTED_KEY: "${signingKey.keyId} ${signingKey.publicKeyDerB64}"`,
      '',
    ].join('\n'),
    'utf8',
  );

  execSync(`docker compose -f docker-compose.yml -f ${overlayPath} up -d --build`, {
    cwd: root,
    stdio: 'inherit',
  });
  tier2Up = true;

  // Wait for /api/health through the gateway — implicitly waits on the
  // gateway's service_healthy dependency on core-api (compose graph gates
  // gateway startup until core-api's healthcheck is green).
  await waitFor('/api/health', { wantStatus: 200, wantBody: '"status":"ok"' });

  await assertRoute('GET /api/health', '/api/health', { status: 200, body: '"status":"ok"' });
  // Announcement audio. Asserted BEFORE the wizard runs, which is the point: /tts/
  // is deliberately exempt from the first-run guard (a 302 to wizard HTML would be
  // an undecodable response for an <audio> consumer), so a 200 here pre-setup
  // proves the exemption is wired. A 302 means /tts/ picked up the guard.
  await assertRoute('GET /tts/health (pre-setup, guard-exempt)', '/tts/health', {
    status: 200,
    body: '"status":"ok"',
  });
  await assertRoute('GET / (clean browser)', '/', { status: 301, redirect: '/admin/' });
  await assertRoute('GET /wizard', '/wizard', { status: 301, redirect: '/admin/wizard' });
  await assertRoute('GET /admin/', '/admin/', { status: 200, body: '/admin/manifest.webmanifest' });

  // Access guard, phase 1 — UNLICENSED. The license gate runs before the
  // first-run gate, so a stock stack sends operational routes to the activation
  // page, not the wizard. This is what proves `X-QMS-Gate` is being lifted by
  // `auth_request_set` and routed through the `map`: a broken header would fall
  // through to the `default` branch and land on /admin/wizard instead.
  await assertRoute('GET /kiosk/ (unlicensed -> aktivasi)', '/kiosk/', { status: 302, redirect: '/admin/aktivasi' });
  await assertRoute('GET /tv/ (unlicensed -> aktivasi)', '/tv/', { status: 302, redirect: '/admin/aktivasi' });
  await assertRoute('GET /caller/ (unlicensed -> aktivasi)', '/caller/', { status: 302, redirect: '/admin/aktivasi' });

  // Activate with a license minted right here by the vendor generator, against
  // the installation id the running stack reports.
  const activationRequest = await get('/api/license/activation-request');
  if (activationRequest.status !== 200) {
    throw new Error(`GET /api/license/activation-request: ${activationRequest.status}`);
  }
  const { installationId, claims } = JSON.parse(activationRequest.body);
  const activation = await postJson('/api/license', {
    token: encodeToken({
      payload: buildPayload({
        installationId,
        claims,
        customerName: 'Topology Verify',
        type: 'perpetual',
        supportUntilOn: '2099-12-31',
        // A container has no fingerprint bind-mounts unless the prod overlay is
        // applied, so there are no claims to bind to. --no-bind-host is exactly
        // what the vendor would use for such a host.
        bindHost: Object.keys(claims ?? {}).length > 0,
      }),
      privateKey: createPrivateKey(signingKey.privateKeyPem),
      keyId: signingKey.keyId,
    }),
  });
  if (activation.status !== 200) {
    throw new Error(`POST /api/license failed: ${activation.status} ${activation.body.slice(0, 200)}`);
  }
  process.stdout.write('  POST /api/license (activate): 200 OK\n');

  // Access guard, phase 2 — LICENSED BUT UNCONFIGURED. Same gate, different
  // reason, different destination.
  await assertRoute('GET /kiosk/ (pre-setup -> wizard)', '/kiosk/', { status: 302, redirect: '/admin/wizard' });
  await assertRoute('GET /tv/ (pre-setup -> wizard)', '/tv/', { status: 302, redirect: '/admin/wizard' });
  await assertRoute('GET /caller/ (pre-setup -> wizard)', '/caller/', { status: 302, redirect: '/admin/wizard' });

  // Complete the wizard through the gateway, then re-assert the operational
  // routes now serve their PWAs (guard opens once setup is complete).
  const setup = await putJson('/api/system/config', prdWizardPayload());
  if (setup.status !== 200) {
    throw new Error(`PUT /api/system/config failed: ${setup.status} ${setup.body.slice(0, 120)}`);
  }
  process.stdout.write(`  PUT /api/system/config (wizard finalize): ${setup.status} OK\n`);

  await assertRoute('GET /kiosk/ (post-setup)', '/kiosk/', { status: 200, body: '/kiosk/manifest.webmanifest' });
  await assertRoute('GET /tv/ (post-setup)', '/tv/', { status: 200, body: '/tv/manifest.webmanifest' });
  await assertRoute('GET /caller/ (post-setup)', '/caller/', { status: 200, body: '/caller/manifest.webmanifest' });
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
      execSync(`docker compose -f docker-compose.yml -f ${overlayPath} down -v`, {
        cwd: root,
        stdio: 'inherit',
      });
    } catch {
      // best-effort teardown; don't mask the real failure
    }
  }
  // The overlay carries a throwaway public key, but leaving a generated compose
  // file behind would silently apply to the next `docker compose up` a developer
  // runs by hand — it is not named override.yml, but it is still confusing.
  rmSync(overlayPath, { force: true });
}

process.exit(failed ? 1 : 0);
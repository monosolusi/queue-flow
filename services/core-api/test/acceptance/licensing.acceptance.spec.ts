import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { ACTIVATION_URL_ENV } from '../../src/infrastructure/licensing/http-license-activation-client';
import { LicenseStateService } from '../../src/infrastructure/licensing/license-state.service';
import { TRUSTED_KEY_ENV } from '../../src/infrastructure/licensing/license-token-verifier.factory';
import {
  BOOTSTRAP_ADMIN_USERNAME,
  type BootedApp,
  type FakeActivationServer,
  createApp,
  http,
  authHeader,
  bootstrapAuthedAdmin,
  prdWizardPayload,
  seedPrdConfig,
  signTestLicense,
  startFakeActivationServer,
  testActivationKey,
  testKeyLine,
} from './_helpers';

const KEY = testActivationKey();

/**
 * DoD — licence gate (online activation + graded enforcement).
 *
 * The one suite that runs with enforcement ON. `test/jest.setup.ts` disables it
 * everywhere else so the app-booting suites can test ticketing and realtime
 * without a licence; here it is turned back on, so the shipped behaviour — an
 * unlicensed store refuses new tickets, redeeming a key releases it — is proven
 * rather than assumed.
 *
 * The REAL Ed25519 verifier and the REAL `fetch` path run throughout. Only two
 * things are test doubles: the trusted KEY, injected through the env seam that
 * is inert in any shipped image, and the activation server, which is a genuine
 * `node:http` server rather than a stub — the outbound call is the single most
 * consequential thing this feature added, and a stub would leave it untested.
 * Nothing exploitable ships: the production trusted-key table is a separate,
 * deliberately empty constant, and one test here pins that.
 */
describe('DoD — license gate (activation + graded enforcement)', () => {
  const saved = {
    enforcement: process.env.QMS_LICENSE_ENFORCEMENT,
    trustedKey: process.env[TRUSTED_KEY_ENV],
    activationUrl: process.env[ACTIVATION_URL_ENV],
  };
  let booted: BootedApp | null = null;
  let activation: FakeActivationServer | null = null;

  beforeEach(async () => {
    process.env.QMS_LICENSE_ENFORCEMENT = 'on';
    process.env[TRUSTED_KEY_ENV] = testKeyLine();
    // Must be listening before the app boots: the client resolves its URL from
    // the environment when the module factory constructs it.
    activation = await startFakeActivationServer();
  });

  afterEach(async () => {
    if (booted !== null) {
      await booted.app.close();
      booted = null;
    }
    if (activation !== null) {
      await activation.close();
      activation = null;
    }
    process.env.QMS_LICENSE_ENFORCEMENT = saved.enforcement;
    if (saved.trustedKey === undefined) delete process.env[TRUSTED_KEY_ENV];
    else process.env[TRUSTED_KEY_ENV] = saved.trustedKey;
    if (saved.activationUrl === undefined) delete process.env[ACTIVATION_URL_ENV];
    else process.env[ACTIVATION_URL_ENV] = saved.activationUrl;
  });

  /** Boots a store whose config is seeded but which holds no licence. */
  async function bootUnlicensed(seed = true): Promise<BootedApp> {
    // The one suite that opts OUT of the licensed default — this is the suite
    // that proves what an unlicensed store does.
    booted = await createApp({ licensed: false });
    if (seed) await seedPrdConfig(booted.app);
    await booted.app.get(LicenseStateService).refresh();
    return booted;
  }

  it('runs the whole flow: blocked -> redeem key -> released', async () => {
    const app = (await bootUnlicensed()).app;

    // --- 1. Unlicensed: the revenue-bearing action is refused -------------
    const categories = await http(app).get('/api/categories').expect(200);
    const categoryId = categories.body[0].id as string;

    const blocked = await http(app).post('/api/tickets').send({ categoryId }).expect(403);
    expect(blocked.body).toMatchObject({ code: 'LICENSE_REQUIRED' });

    // Reads are never withheld — a licence dispute must not hide a shop's own
    // data from it, and the TV board has to keep rendering.
    await http(app).get('/api/queue/board').expect(200);

    // The gateway probe denies with a reason header it can route on.
    const gate = await http(app).get('/api/system/access-check').expect(403);
    expect(gate.headers['x-qms-gate']).toBe('LICENSE_REQUIRED');

    // --- 2. The installation id is on the status, for support calls -------
    const before = await http(app).get('/api/license').expect(200);
    const installationId = before.body.installationId as string;
    expect(installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // --- 3. Redeeming the key activates -----------------------------------
    const activated = await http(app)
      .post('/api/license/activate')
      .send({ key: KEY })
      .expect(200);
    expect(activated.body).toMatchObject({ state: 'VALID', restrictsNewTickets: false });
    // Bound to hardware this host cannot read: UNAVAILABLE, and NOT a mismatch.
    expect(activated.body.host.outcome).toBe('UNAVAILABLE');

    // The server was told who is asking, which is what lets it bind the seat.
    expect(activation!.calls).toHaveLength(1);
    expect(activation!.calls[0]).toMatchObject({
      key: KEY,
      installationId,
      product: { id: 'qms', majorVersion: 1 },
    });

    // --- 4. Released ------------------------------------------------------
    const ticket = await http(app).post('/api/tickets').send({ categoryId }).expect(201);
    expect(ticket.body.ticket.ticketNumber).toBe('A-001');

    await http(app).get('/api/system/access-check').expect(200);

    // The public config carries the licence slice every PWA reads at boot.
    const config = await http(app).get('/api/system/config').expect(200);
    expect(config.body.license).toMatchObject({ state: 'VALID', restrictsNewTickets: false });
  });

  it('runs offline forever after: the licence survives the server going away', async () => {
    // The product's central promise. Once the token is stored, evaluation reads
    // it locally — so the activation server can be switched off, moved, or shut
    // down for good and the shop keeps issuing tickets.
    const app = (await bootUnlicensed()).app;
    await http(app).post('/api/license/activate').send({ key: KEY }).expect(200);

    await activation!.close();
    activation = null;

    await app.get(LicenseStateService).refresh();
    const status = await http(app).get('/api/license').expect(200);
    expect(status.body).toMatchObject({ state: 'VALID', restrictsNewTickets: false });

    const categories = await http(app).get('/api/categories').expect(200);
    await http(app)
      .post('/api/tickets')
      .send({ categoryId: categories.body[0].id as string })
      .expect(201);
  });

  it('cannot be activated with no internet, and says so in those terms', async () => {
    // The deliberate consequence of an online-only design. The reason code has
    // to be OFFLINE and not "bad key", or a technician spends the afternoon
    // re-typing a key that was correct all along.
    const app = (await bootUnlicensed()).app;
    await activation!.close();
    activation = null;
    process.env[ACTIVATION_URL_ENV] = 'http://127.0.0.1:1/v1/activations';

    const refused = await http(app).post('/api/license/activate').send({ key: KEY }).expect(400);
    expect(refused.body).toMatchObject({ code: 'LICENSE_REJECTED', reason: 'OFFLINE' });

    const status = await http(app).get('/api/license').expect(200);
    expect(status.body.state).toBe('RESTRICTED');
  });

  it('rejects a mistyped key without ever contacting the server', async () => {
    // The check symbol earning its place: no round trip, and no failed
    // redemption recorded against a customer whose key was fine.
    const app = (await bootUnlicensed()).app;
    const mistyped = KEY.slice(0, -1) + (KEY.endsWith('0') ? '1' : '0');

    const refused = await http(app)
      .post('/api/license/activate')
      .send({ key: mistyped })
      .expect(400);

    expect(refused.body).toMatchObject({ code: 'LICENSE_REJECTED', reason: 'KEY_MALFORMED' });
    expect(activation!.calls).toHaveLength(0);
  });

  it('tells a customer whose key is already running another branch exactly that', async () => {
    // The whole commercial point of going online, and the outcome most likely
    // to reach support. It must not read as "damaged file".
    const app = (await bootUnlicensed()).app;
    activation!.respondWith({ status: 409, code: 'KEY_ALREADY_USED' });

    const refused = await http(app).post('/api/license/activate').send({ key: KEY }).expect(400);
    expect(refused.body).toMatchObject({ code: 'LICENSE_REJECTED', reason: 'KEY_ALREADY_USED' });
  });

  it('refuses a token the activation server signed with a key we do not trust', async () => {
    // THE test for the online design. The reply is not trusted because of where
    // it came from: repointing QMS_LICENSE_ACTIVATION_URL at a homemade server
    // must yield nothing, because that server cannot sign.
    const app = (await bootUnlicensed()).app;
    const token = signTestLicense();
    const [h, p, s] = token.trim().split('\n')[1].split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(p, 'base64url').toString()) as object),
        entitlements: { maxCounters: 999, maxCategories: 999, features: [] },
      }),
    ).toString('base64url');
    activation!.respondWith({
      status: 200,
      token: ['-----BEGIN QMS LICENSE-----', `${h}.${forged}.${s}`, '-----END QMS LICENSE-----'].join('\n'),
    });

    const rejected = await http(app).post('/api/license/activate').send({ key: KEY }).expect(400);
    expect(rejected.body).toMatchObject({ code: 'LICENSE_REJECTED', reason: 'UNTRUSTED' });

    const status = await http(app).get('/api/license').expect(200);
    expect(status.body.state).toBe('RESTRICTED');
  });

  it('refuses a token issued for a different installation', async () => {
    const app = (await bootUnlicensed()).app;
    activation!.respondWith({
      status: 200,
      token: signTestLicense({ installationId: '99999999-8888-4777-a666-555555555555' }),
    });

    const rejected = await http(app).post('/api/license/activate').send({ key: KEY }).expect(400);
    expect(rejected.body).toMatchObject({ code: 'LICENSE_REJECTED', reason: 'WRONG_INSTALLATION' });
  });

  it('ships with no trusted key, so an un-keyed build activates nothing', async () => {
    // The state every release is in until the licence product's public key has
    // been pasted into trusted-keys.ts. Failing closed is right; this pins that
    // it actually does, and that the env seam is the ONLY extra key.
    delete process.env[TRUSTED_KEY_ENV];
    booted = await createApp({ licensed: false, trustedKey: false });
    const app = booted.app;
    await seedPrdConfig(app);

    const rejected = await http(app).post('/api/license/activate').send({ key: KEY }).expect(400);
    expect(JSON.stringify(rejected.body)).toContain('no trusted signing key');
  });

  it('refuses to configure a store it is not licensed to run', async () => {
    // PUT /api/system/config is a mutation, so the guard withholds it — setting
    // up a store you are not licensed for is the wrong order. The READ path
    // stays open so the admin SPA can still boot and render the activation page.
    const app = (await bootUnlicensed(false)).app;

    await http(app).get('/api/system/config').expect(200);
    await http(app).put('/api/system/config').send(prdWizardPayload()).expect(403);

    const gate = await http(app).get('/api/system/access-check').expect(403);
    expect(gate.headers['x-qms-gate']).toBe('LICENSE_REQUIRED');
  });

  it('keeps the drain path reachable while RESTRICTED, and only withholds the lever', async () => {
    // The promise the whole graded ladder rests on: a shop full of people
    // holding printed tickets must still be served. Nothing tested this before
    // — the suite proved what was BLOCKED and never proved what stayed open,
    // so a renamed queue route would have killed the counter panel during a
    // licence lapse, silently, at the worst possible moment.
    //
    // 403 means LicenseGuard refused. 401 means it let the request through and
    // AuthGuard asked for credentials — which is exactly what we want to see.
    const app = (await bootUnlicensed()).app;
    const ticketId = '11111111-2222-4333-8444-555555555555';

    for (const [label, path] of [
      ['call-next', '/api/queue/call-next'],
      ['transition', `/api/queue/${ticketId}/transition`],
      ['reannounce', `/api/queue/${ticketId}/reannounce`],
      ['transfer', `/api/queue/${ticketId}/transfer`],
    ] as const) {
      const res = await http(app).post(path).send({});
      expect({ label, status: res.status }).not.toMatchObject({ label, status: 403 });
    }

    // The lever, and an unlisted mutation on another controller, stay refused.
    await http(app).post('/api/tickets').send({ categoryId: ticketId }).expect(403);
    await http(app).post('/api/users').send({ username: 'x', password: 'y', role: 'admin' }).expect(403);
    // Creating the first admin is part of SETTING UP a store, so it is withheld
    // too — an earlier `^/api/auth/.*$` wildcard exempted it by accident.
    await http(app).post('/api/auth/setup-admin').send({ username: 'a', password: 'b' }).expect(403);
    // ...but logging in must work, or an admin could never reach the licence page.
    const login = await http(app).post('/api/auth/login').send({ username: 'a', password: 'b' });
    expect(login.status).not.toBe(403);
  });

  it('audits the activating admin by name, not as the system sentinel', async () => {
    // The common real activation is NOT first-run: a licence lapses after two
    // years, an admin logs in and re-activates. NFR-SEC-02 says the actor is
    // the authenticated principal — 'system' is only for the pre-setup path.
    const app = (await bootUnlicensed()).app;
    const token = await bootstrapAuthedAdmin(app);

    await http(app)
      .post('/api/license/activate')
      .set(authHeader(token))
      .send({ key: KEY })
      .expect(200);

    const log = await http(app).get('/api/audit/log').set(authHeader(token)).expect(200);
    const activated = (log.body as { actor: string; action: string }[]).find(
      (e) => e.action === 'LICENSE_ACTIVATED',
    );
    // BOOTSTRAP_ADMIN_USERNAME is deliberately 'manager1', not 'admin', so a
    // controller that regressed to a hardcoded literal would fail here.
    expect(activated?.actor).toBe(BOOTSTRAP_ADMIN_USERNAME);
  });

  it('re-activates cleanly, which is what makes vendor-side seat release work', async () => {
    // There is no "deactivate" button in the product. When a customer replaces
    // hardware, the vendor frees the seat and the customer redeems the SAME key
    // again — so this path has to leave exactly one active licence behind.
    const app = (await bootUnlicensed()).app;
    await http(app).post('/api/license/activate').send({ key: KEY }).expect(200);

    // The second redemption needs an admin. AdminOrUnlicensedGuard opens the
    // endpoint only while the store is RESTRICTED — once it is licensed, this
    // is an ordinary administrative action and must be authenticated.
    const token = await bootstrapAuthedAdmin(app);
    await http(app).post('/api/license/activate').send({ key: KEY }).expect(401);

    const again = await http(app)
      .post('/api/license/activate')
      .set(authHeader(token))
      .send({ key: KEY })
      .expect(200);
    expect(again.body.state).toBe('VALID');

    const history = await http(app).get('/api/license/history').set(authHeader(token)).expect(200);
    expect((history.body as { isActive: boolean }[]).filter((row) => row.isActive)).toHaveLength(1);
  });

  it('refuses a config save that exceeds the licence entitlement caps', async () => {
    // The caps are sold, priced and displayed on the admin licence screen; if
    // nothing enforces them the FREE tier grants exactly what perpetual does.
    // Unseeded on purpose: PUT /api/system/config is the WIZARD path here, and
    // the wizard runs before any account exists. Seeding first would complete
    // setup and make the same route admin-only, so the test would prove an auth
    // rule rather than the entitlement cap.
    const app = (await bootUnlicensed(false)).app;
    // Bind to this installation with a one-counter cap.
    const status = await http(app).get('/api/license').expect(200);
    activation!.respondWith({
      status: 200,
      token: signTestLicense({
        installationId: status.body.installationId as string,
        entitlements: { maxCounters: 1, maxCategories: 10, features: [] },
      }),
    });
    await http(app).post('/api/license/activate').send({ key: KEY }).expect(200);

    // The PRD payload carries two counters; the licence allows one.
    const rejected = await http(app).put('/api/system/config').send(prdWizardPayload()).expect(400);
    expect(JSON.stringify(rejected.body)).toMatch(/at most 1 counter/);
  });

  it('reports SETUP_REQUIRED once licensed but not yet configured', async () => {
    // Licence first, wizard second: the gateway needs the two reasons to be
    // distinguishable so it can route to the right page.
    const app = (await bootUnlicensed(false)).app;
    await http(app).post('/api/license/activate').send({ key: KEY }).expect(200);

    const gate = await http(app).get('/api/system/access-check').expect(403);
    expect(gate.headers['x-qms-gate']).toBe('SETUP_REQUIRED');
  });
});

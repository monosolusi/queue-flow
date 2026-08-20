import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { LicenseStateService } from '../../src/infrastructure/licensing/license-state.service';
import { TRUSTED_KEY_ENV } from '../../src/infrastructure/licensing/license-token-verifier.factory';
import {
  BOOTSTRAP_ADMIN_USERNAME,
  type BootedApp,
  createApp,
  http,
  authHeader,
  bootstrapAuthedAdmin,
  prdWizardPayload,
  seedPrdConfig,
  signTestLicense,
  testKeyLine,
} from './_helpers';

/**
 * DoD — licence gate (offline activation + graded enforcement).
 *
 * The one suite that runs with enforcement ON. `test/jest.setup.ts` disables it
 * everywhere else so the app-booting suites can test ticketing and realtime
 * without minting a licence; here it is turned back on, so the shipped
 * behaviour — an unlicensed store refuses new tickets, activation releases it —
 * is proven rather than assumed.
 *
 * The REAL Ed25519 verifier runs throughout; only the trusted KEY is a test
 * one, injected through the env seam that is inert in any shipped image.
 * Nothing exploitable ships: the production trusted-key table is a separate,
 * deliberately empty constant, and the last test here pins that.
 */
describe('DoD — license gate (activation + graded enforcement)', () => {
  const saved = {
    enforcement: process.env.QMS_LICENSE_ENFORCEMENT,
    trustedKey: process.env[TRUSTED_KEY_ENV],
  };
  let booted: BootedApp | null = null;

  beforeEach(() => {
    process.env.QMS_LICENSE_ENFORCEMENT = 'on';
    process.env[TRUSTED_KEY_ENV] = testKeyLine();
  });

  afterEach(async () => {
    if (booted !== null) {
      await booted.app.close();
      booted = null;
    }
    process.env.QMS_LICENSE_ENFORCEMENT = saved.enforcement;
    if (saved.trustedKey === undefined) delete process.env[TRUSTED_KEY_ENV];
    else process.env[TRUSTED_KEY_ENV] = saved.trustedKey;
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

  it('runs the whole flow: blocked -> activation request -> activate -> released', async () => {
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

    // --- 2. The activation request the customer sends the vendor ----------
    const request = await http(app).get('/api/license/activation-request').expect(200);
    expect(request.body.blob).toMatch(/^QMSREQ1-/);
    const installationId = request.body.installationId as string;
    expect(installationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // --- 3. A licence for a DIFFERENT installation is refused -------------
    const wrong = await http(app)
      .post('/api/license')
      .send({ token: signTestLicense({ installationId: '99999999-8888-4777-a666-555555555555' }) })
      .expect(400);
    expect(wrong.body).toMatchObject({ code: 'LICENSE_REJECTED', reason: 'WRONG_INSTALLATION' });

    // --- 4. The right licence activates -----------------------------------
    const activated = await http(app)
      .post('/api/license')
      .send({ token: signTestLicense({ installationId }) })
      .expect(200);
    expect(activated.body).toMatchObject({ state: 'VALID', restrictsNewTickets: false });
    // Bound to hardware this host cannot read: UNAVAILABLE, and NOT a mismatch.
    expect(activated.body.host.outcome).toBe('UNAVAILABLE');

    // --- 5. Released ------------------------------------------------------
    const ticket = await http(app).post('/api/tickets').send({ categoryId }).expect(201);
    expect(ticket.body.ticket.ticketNumber).toBe('A-001');

    await http(app).get('/api/system/access-check').expect(200);

    // The public config carries the licence slice every PWA reads at boot.
    const config = await http(app).get('/api/system/config').expect(200);
    expect(config.body.license).toMatchObject({ state: 'VALID', restrictsNewTickets: false });
  });

  it('refuses a licence edited to widen its entitlements, and stays restricted', async () => {
    const app = (await bootUnlicensed()).app;
    const request = await http(app).get('/api/license/activation-request').expect(200);
    const token = signTestLicense({ installationId: request.body.installationId as string });

    const [h, p, s] = token.trim().split('\n')[1].split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(p, 'base64url').toString()) as object),
        entitlements: { maxCounters: 999, maxCategories: 999, features: [] },
      }),
    ).toString('base64url');

    const rejected = await http(app)
      .post('/api/license')
      .send({
        token: ['-----BEGIN QMS LICENSE-----', `${h}.${forged}.${s}`, '-----END QMS LICENSE-----'].join('\n'),
      })
      .expect(400);
    expect(rejected.body).toMatchObject({ code: 'LICENSE_REJECTED', reason: 'UNTRUSTED' });

    const status = await http(app).get('/api/license').expect(200);
    expect(status.body.state).toBe('RESTRICTED');
  });

  it('ships with no trusted key, so an un-keyed build activates nothing', async () => {
    // The state every release is in until `qms-license keygen` has been run and
    // its public half pasted into trusted-keys.ts. Failing closed is right; this
    // pins that it actually does, and that the env seam is the ONLY extra key.
    delete process.env[TRUSTED_KEY_ENV];
    booted = await createApp({ licensed: false, trustedKey: false });
    const app = booted.app;
    await seedPrdConfig(app);

    const request = await http(app).get('/api/license/activation-request').expect(200);
    const rejected = await http(app)
      .post('/api/license')
      .send({ token: signTestLicense({ installationId: request.body.installationId as string }) })
      .expect(400);

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

    const request = await http(app).get('/api/license/activation-request').set(authHeader(token)).expect(200);
    await http(app)
      .post('/api/license')
      .set(authHeader(token))
      .send({ token: signTestLicense({ installationId: request.body.installationId as string }) })
      .expect(200);

    const log = await http(app).get('/api/audit/log').set(authHeader(token)).expect(200);
    const activated = (log.body as { actor: string; action: string }[]).find(
      (e) => e.action === 'LICENSE_ACTIVATED',
    );
    // BOOTSTRAP_ADMIN_USERNAME is deliberately 'manager1', not 'admin', so a
    // controller that regressed to a hardcoded literal would fail here.
    expect(activated?.actor).toBe(BOOTSTRAP_ADMIN_USERNAME);
  });

  it('refuses a config save that exceeds the licence entitlement caps', async () => {
    // The caps are sold, priced and displayed on the admin licence screen; if
    // nothing enforces them the FREE tier grants exactly what perpetual does.
    booted = await createApp({ licensed: false });
    const app = booted.app;
    const request = await http(app).get('/api/license/activation-request').expect(200);
    await http(app)
      .post('/api/license')
      .send({
        token: signTestLicense({
          installationId: request.body.installationId as string,
          entitlements: { maxCounters: 1, maxCategories: 10, features: [] },
        }),
      })
      .expect(200);

    // The PRD payload carries two counters; the licence allows one.
    const rejected = await http(app).put('/api/system/config').send(prdWizardPayload()).expect(400);
    expect(JSON.stringify(rejected.body)).toMatch(/at most 1 counter/);
  });

  it('reports SETUP_REQUIRED once licensed but not yet configured', async () => {
    // Licence first, wizard second: the gateway needs the two reasons to be
    // distinguishable so it can route to the right page.
    const app = (await bootUnlicensed(false)).app;
    const request = await http(app).get('/api/license/activation-request').expect(200);
    await http(app)
      .post('/api/license')
      .send({ token: signTestLicense({ installationId: request.body.installationId as string }) })
      .expect(200);

    const gate = await http(app).get('/api/system/access-check').expect(403);
    expect(gate.headers['x-qms-gate']).toBe('SETUP_REQUIRED');
  });
});

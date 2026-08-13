import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  type BootedApp,
  authHeader,
  bootstrapAuthedAdmin,
  clearRepos,
  createApp,
  http,
  prdWizardPayload,
} from './_helpers';

/**
 * DoD-2 — First-Run Wizard (API half, FR-WZD-01..06).
 *
 * PRD §8 bullet 2: a clean browser is redirected to /wizard, and completing the
 * 4 steps opens normal operations. The browser redirect is verified by the
 * admin-service vitest suite (SetupGuard redirects to /wizard when
 * `isInitialSetupCompleted === false`; WizardPage walks the 4 steps and PUTs
 * the payload). This spec verifies the **backend contract** that drives that
 * behaviour, in-process with supertest (the authoritative DoD-2 gate):
 *
 *  - clean store → `GET /api/system/config` returns `isInitialSetupCompleted:false`
 *    (does NOT throw — the wizard needs the default-shaped state machine to
 *    prefill, so a clean browser gets the redirect signal, not a 500).
 *  - clean store → `GET /api/system/setup-status` returns 403
 *    `SYSTEM_NOT_CONFIGURED` (the gateway auth_request probe — 403, not 500,
 *    so the wizard can still boot).
 *  - before setup, queue endpoints respond 409 `SYSTEM_NOT_CONFIGURED`.
 *  - `PUT /api/system/config` with the PRD §7 payload completes setup
 *    (`isInitialSetupCompleted:true`) atomically.
 *  - after setup, queue endpoints succeed (normal operations open).
 *
 * The browser-side Playwright spec from the original plan is intentionally
 * omitted (air-gapped fallback the plan allows): the admin-service vitest
 * component tests cover the redirect + 4-step walk, and this spec covers the
 * contract. No DB, no network.
 */
describe('DoD-2 — First-Run Wizard API (FR-WZD-01..06)', () => {
  let booted: BootedApp;
  // QUE-43: the bootstrap admin is created once (clearRepos does not wipe the
  // Identity repos — auth is cross-cutting scaffolding) so a valid bearer is
  // available for the authenticated endpoints exercised below
  // (`/api/queue/call-next`, `/api/system/state-machine`). The first-run PUT
  // itself stays tokenless — AdminOrSetupGuard allows the pre-setup wizard.
  let token: string;

  beforeAll(async () => {
    booted = await createApp();
    token = await bootstrapAuthedAdmin(booted.app);
  });

  afterAll(async () => {
    await booted.app.close();
  });

  beforeEach(() => {
    clearRepos(booted.app);
  });

  it('a clean store reports isInitialSetupCompleted:false with a default-shaped config', async () => {
    const res = await http(booted.app).get('/api/system/config').expect(200);
    expect(res.body.isInitialSetupCompleted).toBe(false);
    // The wizard prefills the default state machine even before setup, so the
    // designer is never empty (FR-WZD-04 default graph).
    expect(res.body.stateMachine.states).toEqual([
      'WAITING',
      'CALLING',
      'SERVING',
      'SKIPPED',
      'COMPLETED',
    ]);
    expect(res.body.categories).toEqual([]);
    expect(res.body.routingRules).toEqual([]);
    // clean store prefills the wizard color input with the shared --accent default.
    expect(res.body.brandColor).toBe('#2563eb');
  });

  it('GET /api/system/setup-status returns 403 SETUP_REQUIRED on a clean store (gateway guard probe — FR-WZD-01)', async () => {
    // The gateway's nginx auth_request subrequest maps 2xx -> allow, 401/403
    // -> deny (302 /admin/wizard). A clean store must deny — but never throw
    // (403, not 500) so the wizard itself can boot. The 403 carries a distinct
    // `SETUP_REQUIRED` code (not the 409 `SYSTEM_NOT_CONFIGURED` domain error).
    const res = await http(booted.app).get('/api/system/setup-status').expect(403);
    expect(res.body.code).toBe('SETUP_REQUIRED');
    expect(res.body.isInitialSetupCompleted).toBe(false);
  });

  it('before setup, the kiosk has no categories and the caller is hard-blocked (409 SYSTEM_NOT_CONFIGURED)', async () => {
    // The kiosk reads categories — none exist before the wizard configures them,
    // so the visitor has nothing to select (FR-KSK-01 cannot operate pre-setup).
    const cats = await http(booted.app).get('/api/categories').expect(200);
    expect(cats.body).toEqual([]);

    // The caller command surface resolves the active transition policy, which
    // reads SystemConfiguration — no config -> 409 SYSTEM_NOT_CONFIGURED. The
    // endpoint is authenticated (QUE-43), so the bearer must be present to
    // reach the not-configured guard (a tokenless call would surface 401).
    const callRes = await http(booted.app)
      .post('/api/queue/call-next')
      .set(authHeader(token))
      .send({ counterId: 1 });
    expect(callRes.status).toBe(409);
    expect(callRes.body.code).toBe('SYSTEM_NOT_CONFIGURED');

    // The active state machine read (caller dynamic buttons) is authenticated
    // and blocked by the same not-configured guard post-auth.
    const smRes = await http(booted.app)
      .get('/api/system/state-machine')
      .set(authHeader(token));
    expect(smRes.status).toBe(409);
    expect(smRes.body.code).toBe('SYSTEM_NOT_CONFIGURED');
  });

  it('PUT /api/system/config with the PRD §7 payload completes initial setup (FR-WZD-06)', async () => {
    const res = await http(booted.app)
      .put('/api/system/config')
      .send(prdWizardPayload())
      .expect(200);
    expect(res.body.isInitialSetupCompleted).toBe(true);
    expect(res.body.storeName).toBe('Toko Utama Surabaya');
    // QUE-47: the required serviceThemes field round-trips through the save.
    expect(res.body.serviceThemes).toEqual({
      kiosk: 'light',
      tv: 'light',
      caller: 'light',
      admin: 'light',
    });
    // The GET projection carries the persisted map too (admin prefills from it).
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.serviceThemes).toEqual({
      kiosk: 'light',
      tv: 'light',
      caller: 'light',
      admin: 'light',
    });
  });

  it('a bad wizard payload (duplicate category codes) is rejected 400 — setup is NOT silently completed', async () => {
    const bad = prdWizardPayload();
    bad.categories = [
      { code: 'A', name: 'Customer Service' },
      { code: 'A', name: 'Duplikat' },
    ];
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
    // Setup must not flip to true on a rejected save.
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('a bad wizard payload (malformed serviceThemes) is rejected 400 (QUE-47)', async () => {
    // A present-but-invalid surface value fails fast in the domain VO before the
    // tx opens (NFR-REL-02 — no illegal theme burns a write), surfacing as a
    // clean InvalidValueObjectException → 400 (not a 500 TypeError).
    const bad = prdWizardPayload();
    bad.serviceThemes = { kiosk: 'blue', tv: 'light', caller: 'light', admin: 'light' };
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
    // Setup must not flip to true on a rejected save.
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('persists a custom per-service theme map and returns it on GET (QUE-47)', async () => {
    const payload = prdWizardPayload();
    payload.serviceThemes = { kiosk: 'light', tv: 'dark', caller: 'dark', admin: 'light' };
    const res = await http(booted.app)
      .put('/api/system/config')
      .send(payload)
      .expect(200);
    expect(res.body.serviceThemes).toEqual({
      kiosk: 'light',
      tv: 'dark',
      caller: 'dark',
      admin: 'light',
    });
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.serviceThemes).toEqual({
      kiosk: 'light',
      tv: 'dark',
      caller: 'dark',
      admin: 'light',
    });
  });

  it('rejects a non-object serviceThemes at the transport boundary with 400 (QUE-47)', async () => {
    // The controller shape guard (CONFIG_FIELD_SHAPES kind:'object') catches a
    // present-but-wrong-type value before the use case, mirroring the
    // stateMachine/categories/routingRules shape guards.
    const bad = prdWizardPayload();
    // Widen just this field so a deliberately-malformed string is assignable
    // (the typed payload otherwise rejects it at compile time); the wire body
    // still carries `serviceThemes: 'light'`, exercising the controller guard.
    (bad as { serviceThemes: unknown }).serviceThemes = 'light';
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
  });

  it('after setup, normal operations open: categories list + ticket creation + state-machine read', async () => {
    await http(booted.app).put('/api/system/config').send(prdWizardPayload()).expect(200);

    // The gateway guard probe now allows operational routes through (200).
    const status = await http(booted.app).get('/api/system/setup-status').expect(200);
    expect(status.body.isInitialSetupCompleted).toBe(true);

    // The kiosk reads categories (FR-KSK-01).
    const cats = await http(booted.app).get('/api/categories').expect(200);
    expect(cats.body).toHaveLength(2);
    expect(cats.body.map((c: { code: string }) => c.code).sort()).toEqual(['A', 'B']);

    // The caller reads the active state machine (FR-CLR-02 dynamic buttons).
    // Authenticated (QUE-43) — the bootstrap bearer reaches the read.
    const sm = await http(booted.app)
      .get('/api/system/state-machine')
      .set(authHeader(token))
      .expect(200);
    expect(sm.body.transitions).toHaveLength(5);

    // The kiosk issues a ticket (FR-ENG-01) — now unblocked.
    const catA = cats.body.find((c: { code: string }) => c.code === 'A');
    const ticket = await http(booted.app)
      .post('/api/tickets')
      .send({ categoryId: catA.id })
      .expect(201);
    expect(ticket.body.status).toBe('created');
    expect(ticket.body.ticket.ticketNumber).toBe('A-001');
    expect(ticket.body.ticket.status).toBe('WAITING');
  });

  it('persists a custom edge routing layout and returns it on GET (round-trip)', async () => {
    const payload = prdWizardPayload();
    payload.edgeRoutingLayout = {
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    };
    const res = await http(booted.app)
      .put('/api/system/config')
      .send(payload)
      .expect(200);
    expect(res.body.edgeRoutingLayout).toEqual({
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    });
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.edgeRoutingLayout).toEqual({
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    });
  });

  it('a clean store prefills edgeRoutingLayout with {} (all-default routing)', async () => {
    const res = await http(booted.app).get('/api/system/config').expect(200);
    expect(res.body.edgeRoutingLayout).toEqual({});
  });

  it('rejects a malformed edgeRoutingLayout (non-object) at the transport boundary with 400', async () => {
    const bad = prdWizardPayload();
    (bad as { edgeRoutingLayout: unknown }).edgeRoutingLayout = 'not-an-object';
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('rejects a malformed edgeRoutingLayout (array) at the transport boundary with 400', async () => {
    const bad = prdWizardPayload();
    (bad as { edgeRoutingLayout: unknown }).edgeRoutingLayout = [
      { 'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' } },
    ];
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
  });

  it('rejects a non-string sourceSide in edgeRoutingLayout at the transport boundary with 400', async () => {
    const bad = prdWizardPayload();
    (bad as { edgeRoutingLayout: unknown }).edgeRoutingLayout = {
      'SKIPPED->CALLING': { sourceSide: 5, targetSide: 'top' },
    };
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
  });

  it('rejects an edge routing layout key that is not a transition (cross-check) with 400', async () => {
    // WAITING->COMPLETED is not an edge in the default state machine — the
    // use-case cross-check throws InvalidValueObjectException → 400 (not a 500).
    const bad = prdWizardPayload();
    (bad as { edgeRoutingLayout: unknown }).edgeRoutingLayout = {
      'WAITING->COMPLETED': { sourceSide: 'top', targetSide: 'bottom' },
    };
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('rejects an invalid side enum in edgeRoutingLayout with 400 (VO of())', async () => {
    const bad = prdWizardPayload();
    (bad as { edgeRoutingLayout: unknown }).edgeRoutingLayout = {
      'SKIPPED->CALLING': { sourceSide: 'sideways', targetSide: 'top' },
    };
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
  });

  it('persists custom nodePositions and returns them on GET (round-trip)', async () => {
    const payload = prdWizardPayload();
    payload.nodePositions = {
      WAITING: { x: 0, y: 0 },
      CALLING: { x: 240, y: 0 },
    };
    const res = await http(booted.app)
      .put('/api/system/config')
      .send(payload)
      .expect(200);
    expect(res.body.nodePositions).toEqual({
      WAITING: { x: 0, y: 0 },
      CALLING: { x: 240, y: 0 },
    });
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.nodePositions).toEqual({
      WAITING: { x: 0, y: 0 },
      CALLING: { x: 240, y: 0 },
    });
  });

  it('a clean store prefills nodePositions with {} (autoLayout)', async () => {
    const res = await http(booted.app).get('/api/system/config').expect(200);
    expect(res.body.nodePositions).toEqual({});
  });

  it('rejects a malformed nodePositions (non-object) at the transport boundary with 400', async () => {
    const bad = prdWizardPayload();
    (bad as { nodePositions: unknown }).nodePositions = 'not-an-object';
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('rejects a malformed nodePositions (array) at the transport boundary with 400', async () => {
    const bad = prdWizardPayload();
    (bad as { nodePositions: unknown }).nodePositions = [
      { WAITING: { x: 0, y: 0 } },
    ];
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
  });

  it('rejects a non-number x in nodePositions at the transport boundary with 400', async () => {
    const bad = prdWizardPayload();
    (bad as { nodePositions: unknown }).nodePositions = {
      WAITING: { x: 'five', y: 0 },
    };
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
  });

  it('rejects a node positions key that is not a state (cross-check) with 400', async () => {
    // NOPE is not a state in the default state machine — the use-case
    // cross-check throws InvalidValueObjectException → 400 (not a 500).
    const bad = prdWizardPayload();
    (bad as { nodePositions: unknown }).nodePositions = {
      NOPE: { x: 0, y: 0 },
    };
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    const cfg = await http(booted.app).get('/api/system/config').expect(200);
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('rejects a non-finite x in nodePositions with 400 (VO of())', async () => {
    const bad = prdWizardPayload();
    (bad as { nodePositions: unknown }).nodePositions = {
      WAITING: { x: NaN, y: 0 },
    };
    const res = await http(booted.app).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
  });
});
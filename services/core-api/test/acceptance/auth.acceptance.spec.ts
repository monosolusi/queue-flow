import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  type BootedApp,
  authHeader,
  clearRepos,
  createApp,
  http,
  prdWizardPayload,
  seedPrdConfig,
} from './_helpers';

/**
 * DoD — Authentication & authorization boundary (QUE-43, NFR-SEC-02).
 *
 * The exhaustive auth-surface contract (login/logout/me, user CRUD, role
 * enforcement on every endpoint, setup-admin gating, audit actor) lives in the
 * unit gate as `auth-api.integration.spec.ts`. This acceptance spec is the
 * **DoD-level security stamp**: a continuous first-run story proving the
 * end-to-end identity boundary holds, plus the public kiosk/TV boundary that
 * must never require a login.
 *
 *  - First-run: setup-admin (open pre-setup) → login → authenticate a
 *    protected call → logout → the revoked token no longer works.
 *  - Public boundary: the kiosk (`POST /api/tickets`), the TV
 *    (`GET /api/queue/board`), and `GET /api/categories` succeed **without** a
 *    bearer — kiosk/TV have no users (NFR-SEC-01 + the QUE-43 design).
 *  - Protected boundary: a mutation endpoint rejects a tokenless call (401).
 *
 * In-memory profile (default) — no DB, no network.
 */
describe('DoD — AuthN/AuthZ boundary (QUE-43)', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    booted = await createApp();
  });

  afterAll(async () => {
    await booted.app.close();
  });

  beforeEach(() => {
    clearRepos(booted.app);
  });

  it('first-run: setup-admin → login → authenticated protected call → logout → revoked (FR-WZD + QUE-43)', async () => {
    // Pre-setup: the wizard seeds the initial admin (setup-admin is open).
    const seeded = await http(booted.app)
      .post('/api/auth/setup-admin')
      .send({ username: 'admin', password: 'password123' })
      .expect(200);
    expect(seeded.body.role).toBe('admin');

    // Login → opaque bearer token (returned once).
    const login = await http(booted.app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'password123' })
      .expect(200);
    const token = login.body.token as string;
    expect(token).toEqual(expect.any(String));

    // The token authenticates a protected admin route (reports — admin-only).
    const today = new Date().toISOString().slice(0, 10);
    await http(booted.app)
      .get(`/api/reports/daily?date=${today}`)
      .set(authHeader(token))
      .expect(200);

    // Logout → real revocation (the session row is deleted).
    await http(booted.app).post('/api/auth/logout').set(authHeader(token)).expect(204);

    // The revoked token no longer authenticates.
    const after = await http(booted.app).get('/api/auth/me').set(authHeader(token));
    expect(after.status).toBe(401);
  });

  it('the kiosk + TV boundary stays public — no bearer required (NFR-SEC-01, QUE-43 design)', async () => {
    // Seed the PRD config so categories + the board have content.
    const { catAId } = await seedPrdConfig(booted.app);

    // Kiosk: take a ticket with no token.
    const ticket = await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);
    expect(ticket.body.ticket.ticketNumber).toBe('A-001');

    // TV: read the board with no token.
    const board = await http(booted.app).get('/api/queue/board').expect(200);
    expect(board.body.waitingCount).toBe(1);

    // Kiosk + TV: list categories with no token.
    const cats = await http(booted.app).get('/api/categories').expect(200);
    expect(cats.body).toHaveLength(2);
  });

  it('a protected mutation endpoint rejects a tokenless call with 401 (the boundary holds)', async () => {
    // Seed config + a ticket so the only thing standing between the call and
    // success is the missing bearer (not a 409/404 from an unconfigured store).
    const { catAId } = await seedPrdConfig(booted.app);
    await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);

    const res = await http(booted.app).post('/api/queue/call-next').send({ counterId: 1 });
    expect(res.status).toBe(401);
  });

  it('the gateway setup-status probe stays public + never throws on a clean store (FR-WZD-01)', async () => {
    // clean store (beforeEach) → 403 SETUP_REQUIRED, not 500, so the wizard boots.
    const res = await http(booted.app).get('/api/system/setup-status').expect(403);
    expect(res.body.code).toBe('SETUP_REQUIRED');
    expect(res.body.isInitialSetupCompleted).toBe(false);
  });
});
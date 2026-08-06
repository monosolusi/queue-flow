import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import {
  type ISystemConfigurationRepository,
  SYSTEM_CONFIGURATION_REPOSITORY,
  SystemConfiguration,
} from '../../src/domain/store-config';
import {
  type IAuditLogRepository,
  AUDIT_LOG_REPOSITORY,
  AuditAction,
} from '../../src/domain/audit';
import { Identifier } from '../../src/domain/shared';
import {
  authHeader,
  bootstrapAuthedAdmin,
  clearRepos,
  createApp,
  http,
  prdWizardPayload,
  seedPrdConfig,
  type BootedApp,
} from '../acceptance/_helpers';

/**
 * Integration: boots the real NestJS app (in-memory persistence) and exercises
 * the QUE-43 auth REST surface end-to-end via supertest — login/logout/me,
 * first-run setup-admin gating, admin-only user CRUD, and role enforcement on
 * representative protected endpoints (401 unauthed / 403 wrong role / 200 correct).
 *
 * The bootstrap admin is named `manager1` (a change-detector — see
 * `_helpers.ts`); a `caller-staff` user is created through
 * the HTTP user-create endpoint (doubling as that endpoint's positive test) so
 * both role tokens are available. `clearRepos` does not wipe the Identity repos,
 * so the seeded users + sessions persist across the suite (auth is cross-cutting
 * scaffolding); per-test `clearRepos` resets only the queue/config state.
 */
describe('Auth REST surface (integration — QUE-43)', () => {
  let booted: BootedApp;
  let adminToken: string;
  let callerToken: string;
  let systemConfig: ISystemConfigurationRepository;

  beforeAll(async () => {
    booted = await createApp();
    systemConfig = booted.app.get(SYSTEM_CONFIGURATION_REPOSITORY);
    // Bootstrap admin (named 'manager1' so audit actor === 'manager1' is a
    // real change-detector for the authenticated-principal-as-actor fix).
    adminToken = await bootstrapAuthedAdmin(booted.app);

    // Create a caller-staff user through the HTTP surface (positive user-create
    // test) and log in to obtain a caller-role bearer for the 403/role tests.
    const created = await http(booted.app)
      .post('/api/users')
      .set(authHeader(adminToken))
      .send({ username: 'staff1', password: 'secret123', role: 'caller-staff' })
      .expect(201);
    expect(created.body.username).toBe('staff1');
    const login = await http(booted.app)
      .post('/api/auth/login')
      .send({ username: 'staff1', password: 'secret123' })
      .expect(200);
    callerToken = login.body.token;
  });

  afterAll(async () => {
    await booted.app.close();
  });

  describe('POST /api/auth/login', () => {
    it('returns 200 + {token, user} on valid credentials', async () => {
      const res = await http(booted.app)
        .post('/api/auth/login')
        .send({ username: 'manager1', password: 'password123' })
        .expect(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(res.body.user).toEqual({ id: expect.any(String), username: 'manager1', role: 'admin' });
    });

    it('returns 401 INVALID_CREDENTIALS on a wrong password (no enumeration)', async () => {
      const res = await http(booted.app)
        .post('/api/auth/login')
        .send({ username: 'manager1', password: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 INVALID_CREDENTIALS on an unknown username (same error)', async () => {
      const res = await http(booted.app)
        .post('/api/auth/login')
        .send({ username: 'nobody', password: 'secret123' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 (not 400) on a missing password — coerced to empty', async () => {
      const res = await http(booted.app).post('/api/auth/login').send({ username: 'manager1' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns 200 + the principal with a valid bearer', async () => {
      const res = await http(booted.app).get('/api/auth/me').set(authHeader(adminToken)).expect(200);
      expect(res.body).toEqual({ id: expect.any(String), username: 'manager1', role: 'admin' });
    });

    it('returns 401 without a bearer', async () => {
      const res = await http(booted.app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('returns 401 with an invalid bearer', async () => {
      const res = await http(booted.app).get('/api/auth/me').set(authHeader('not-a-real-token'));
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('returns 204 and revokes the session (subsequent /me → 401)', async () => {
      // Log in fresh so revoking this token does not invalidate the shared adminToken.
      const login = await http(booted.app)
        .post('/api/auth/login')
        .send({ username: 'manager1', password: 'password123' })
        .expect(200);
      const ephemeralToken = login.body.token;

      await http(booted.app).post('/api/auth/logout').set(authHeader(ephemeralToken)).expect(204);

      // The revoked token no longer authenticates.
      const after = await http(booted.app).get('/api/auth/me').set(authHeader(ephemeralToken));
      expect(after.status).toBe(401);
    });

    it('returns 401 without a bearer (logout requires an authenticated session)', async () => {
      const res = await http(booted.app).post('/api/auth/logout');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/setup-admin (first-run gating)', () => {
    beforeEach(() => {
      // Reset to pre-setup so setup-admin is open. Uses a distinct username so
      // the bootstrap 'manager1' (and its session) are untouched.
      clearRepos(booted.app);
    });

    it('returns 200 while setup is incomplete (the wizard seeds the initial admin)', async () => {
      const res = await http(booted.app)
        .post('/api/auth/setup-admin')
        .send({ username: 'wizard-admin', password: 'password123' })
        .expect(200);
      expect(res.body.username).toBe('wizard-admin');
      expect(res.body.role).toBe('admin');
    });

    it('returns 403 once setup is complete (self-gating, anti-takeover)', async () => {
      // Complete setup via the wizard PUT (pre-setup, AdminOrSetupGuard allows it).
      await http(booted.app).put('/api/system/config').send(prdWizardPayload()).expect(200);

      const res = await http(booted.app)
        .post('/api/auth/setup-admin')
        .send({ username: 'late-admin', password: 'password123' });
      expect(res.status).toBe(403);
    });
  });

  describe('Users CRUD (admin-only — /api/users)', () => {
    it('GET /api/users → 200 with admin token, 401 without, 403 as caller-staff', async () => {
      const ok = await http(booted.app).get('/api/users').set(authHeader(adminToken)).expect(200);
      expect(Array.isArray(ok.body)).toBe(true);
      expect(ok.body.some((u: { username: string }) => u.username === 'manager1')).toBe(true);

      const noToken = await http(booted.app).get('/api/users');
      expect(noToken.status).toBe(401);

      const caller = await http(booted.app).get('/api/users').set(authHeader(callerToken));
      expect(caller.status).toBe(403);
    });

    it('POST /api/users → 201 with admin token; 403 as caller-staff; 409 on duplicate', async () => {
      const created = await http(booted.app)
        .post('/api/users')
        .set(authHeader(adminToken))
        .send({ username: 'staff2', password: 'secret123', role: 'caller-staff' })
        .expect(201);
      expect(created.body.username).toBe('staff2');

      const caller = await http(booted.app)
        .post('/api/users')
        .set(authHeader(callerToken))
        .send({ username: 'staff3', password: 'secret123', role: 'caller-staff' });
      expect(caller.status).toBe(403);

      const dup = await http(booted.app)
        .post('/api/users')
        .set(authHeader(adminToken))
        .send({ username: 'staff2', password: 'secret123', role: 'caller-staff' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('DUPLICATE_USER');
    });

    it('DELETE /api/users/:id → 204 with admin token; 403 as caller-staff', async () => {
      // Create a throwaway caller-staff user, then delete it.
      const created = await http(booted.app)
        .post('/api/users')
        .set(authHeader(adminToken))
        .send({ username: 'throwaway', password: 'secret123', role: 'caller-staff' })
        .expect(201);
      const id = created.body.id as string;

      const caller = await http(booted.app).delete(`/api/users/${id}`).set(authHeader(callerToken));
      expect(caller.status).toBe(403);

      await http(booted.app).delete(`/api/users/${id}`).set(authHeader(adminToken)).expect(204);

      // The last-admin guard (deleting the sole remaining admin → 400) is a
      // use-case-level business rule covered in `identity.use-cases.spec.ts`
      // (DeleteUserUseCase › last-admin guard). It is not asserted here because
      // exercising it would require deleting the bootstrap `manager1`, which
      // revokes the shared `adminToken` used by the rest of this suite.
    });
  });

  describe('Protected endpoint role enforcement', () => {
    beforeEach(() => {
      clearRepos(booted.app);
    });

    it('GET /api/reports/daily (admin-only): 401 without token, 403 as caller-staff, 200 as admin', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const noToken = await http(booted.app).get(`/api/reports/daily?date=${today}`);
      expect(noToken.status).toBe(401);

      const caller = await http(booted.app).get(`/api/reports/daily?date=${today}`).set(authHeader(callerToken));
      expect(caller.status).toBe(403);

      const admin = await http(booted.app)
        .get(`/api/reports/daily?date=${today}`)
        .set(authHeader(adminToken))
        .expect(200);
      expect(admin.body.totalTickets).toBe(0); // zero-shape (no tickets)
    });

    it('POST /api/queue/call-next (admin OR caller): 401 without token, 201 with either role', async () => {
      // Seed the PRD config + a waiting ticket so call-next has work.
      const { catAId } = await seedPrdConfig(booted.app);
      await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);

      const noToken = await http(booted.app).post('/api/queue/call-next').send({ counterId: 1 });
      expect(noToken.status).toBe(401);

      // Caller-staff is permitted (the panel's primary role).
      const caller = await http(booted.app)
        .post('/api/queue/call-next')
        .set(authHeader(callerToken))
        .send({ counterId: 2 })
        .expect(201);
      expect(caller.body.status).toBe('called');

      // Issue another ticket so admin has work, then admin is also permitted.
      await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);
      const admin = await http(booted.app)
        .post('/api/queue/call-next')
        .set(authHeader(adminToken))
        .send({ counterId: 2 })
        .expect(201);
      expect(admin.body.status).toBe('called');
    });

    it('public endpoints stay public: POST /api/tickets + GET /api/categories + GET /api/queue/board (no token)', async () => {
      const { catAId } = await seedPrdConfig(booted.app);
      const ticket = await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);
      expect(ticket.body.status).toBe('created');

      const cats = await http(booted.app).get('/api/categories').expect(200);
      expect(cats.body).toHaveLength(2);

      const board = await http(booted.app).get('/api/queue/board').expect(200);
      expect(board.body.waitingCount).toBe(1);
    });
  });

  describe('Audit actor is the authenticated principal (not a forgery)', () => {
    it('a manual daily reset records the actor as the admin username (not a forged literal)', async () => {
      // Complete setup so the daily-reset surface is not in the 409 state.
      const config = SystemConfiguration.create(Identifier.generate(), 'QMS Audit Test');
      config.completeInitialSetup();
      await systemConfig.save(config);
      const audit = booted.app.get<IAuditLogRepository>(AUDIT_LOG_REPOSITORY);

      await http(booted.app)
        .post('/api/system/daily-reset')
        .set(authHeader(adminToken))
        .expect(201);

      const entries = await audit.list();
      const reset = entries.find((e) => e.action === AuditAction.MANUAL_RESET);
      expect(reset).toBeDefined();
      // The actor is the authenticated username ('manager1'), not a forged body
      // field or a hardcoded 'admin' literal — naming the bootstrap admin
      // 'manager1' makes this a real change-detector for the forgery fix.
      expect(reset!.actor).toBe('manager1');
    });
  });
});
import { describe, expect, it, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  type BootedApp,
  authHeader,
  bootstrapAuthedAdmin,
  clearRepos,
  createApp,
  http,
  repos,
  seedPrdConfig,
} from '../acceptance/_helpers';
import { QueueTicket, TicketNumber, ticketIdGenerate } from '../../src/domain/queue';
import { StateMachine } from '../../src/domain/store-config';

/**
 * Integration: boots the real Nest app (in-memory profile) and exercises the
 * range-report REST surface added by QUE-44 (`GET /api/reports/range`). Tickets
 * are seeded directly into the queue repo with chosen `createdAt` epochs so the
 * per-day series can be asserted across two local days (the command surface
 * uses real `Date.now()`, so HTTP-driven tickets all land on "today").
 *
 * QUE-43 made `/api/reports/*` admin-only (`@UseGuards(AuthGuard, RolesGuard)`
 * `@Roles(Role.ADMIN)` on `ReportingController`), so each request carries an
 * authenticated admin bearer via {@link bootstrapAuthedAdmin}/{@link authHeader}
 * (the reporting read side itself is unchanged — auth is an orthogonal layer).
 */
describe('Range report REST surface (integration — FR-ADM-03 / QUE-44)', () => {
  let booted: BootedApp;
  let catAId: string;
  let token: string;
  const policy = StateMachine.DEFAULT;

  /** Local-midnight epoch for a `YYYY-MM-DD` key. */
  const dayStart = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime();
  };

  beforeAll(async () => {
    booted = await createApp();
    // Idempotent: clearRepos does not wipe the Identity repos, so the seeded
    // admin + session persist across the suite and the token stays valid.
    token = await bootstrapAuthedAdmin(booted.app);
  });

  afterAll(async () => {
    await booted.app.close();
  });

  beforeEach(async () => {
    clearRepos(booted.app);
    const ids = await seedPrdConfig(booted.app);
    catAId = ids.catAId;
  });

  /** Saves a completed A ticket at counter 1 with the given `createdAt`. */
  async function seedCompletedA(createdAt: number) {
    const t = QueueTicket.create(
      ticketIdGenerate(),
      TicketNumber.of('A', 1),
      catAId,
      createdAt,
    );
    t.markCalling(1, policy, createdAt + 10_000);
    t.applyTransition('SERVING', policy, createdAt + 12_000);
    t.applyTransition('COMPLETED', policy, createdAt + 42_000);
    t.pullDomainEvents();
    await repos(booted.app).queue.save(t);
  }

  it('returns range totals + a per-day series + per-category + per-counter aggregates', async () => {
    // One completed A ticket on 2026-08-01, one on 2026-08-02.
    await seedCompletedA(dayStart('2026-08-01') + 1000);
    await seedCompletedA(dayStart('2026-08-02') + 1000);

    const res = await http(booted.app)
      .get('/api/reports/range?from=2026-08-01&to=2026-08-03')
      .set(authHeader(token))
      .expect(200);

    expect(res.body.from).toBe('2026-08-01');
    expect(res.body.to).toBe('2026-08-03');
    expect(res.body.totalTickets).toBe(2);
    expect(res.body.avgWaitTimeMs).toBeGreaterThan(0);
    expect(res.body.avgServiceTimeMs).toBeGreaterThan(0);

    // 3-day series; day 3 is a zero-point row.
    expect(res.body.perDay).toHaveLength(3);
    expect(res.body.perDay[0].totalTickets).toBe(1);
    expect(res.body.perDay[1].totalTickets).toBe(1);
    expect(res.body.perDay[2]).toEqual({
      date: '2026-08-03',
      totalTickets: 0,
      avgWaitTimeMs: 0,
      avgServiceTimeMs: 0,
      ticketsServed: 0,
    });

    // Per-category over the range: A has 2. The DTO carries the category NAME
    // (QUE-49 — backend-include so the frontend needs no code→name join).
    const perCat = res.body.perCategory as Array<{
      code: string;
      categoryName: string;
      totalTickets: number;
    }>;
    expect(perCat).toHaveLength(1);
    expect(perCat[0].code).toBe('A');
    expect(perCat[0].categoryName).toBe('Customer Service');
    expect(perCat[0].totalTickets).toBe(2);

    // Per-counter over the range: counter 1 served 2.
    const perCounter = res.body.perCounter as Array<{
      counterId: number;
      ticketsServed: number;
    }>;
    expect(perCounter).toEqual([{ counterId: 1, ticketsServed: 2, avgServiceTimeMs: expect.any(Number) }]);
  });

  it('returns an empty-range shape with a per-day zero series when no tickets exist', async () => {
    const res = await http(booted.app)
      .get('/api/reports/range?from=2026-08-01&to=2026-08-02')
      .set(authHeader(token))
      .expect(200);

    expect(res.body.totalTickets).toBe(0);
    expect(res.body.perCategory).toEqual([]);
    expect(res.body.perCounter).toEqual([]);
    // 2-day zero series so the trend chart axis still renders.
    expect(res.body.perDay).toEqual([
      { date: '2026-08-01', totalTickets: 0, avgWaitTimeMs: 0, avgServiceTimeMs: 0, ticketsServed: 0 },
      { date: '2026-08-02', totalTickets: 0, avgWaitTimeMs: 0, avgServiceTimeMs: 0, ticketsServed: 0 },
    ]);
  });

  it('defaults from/to to today when omitted (single-day range)', async () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const res = await http(booted.app).get('/api/reports/range').set(authHeader(token)).expect(200);
    expect(res.body.from).toBe(key);
    expect(res.body.to).toBe(key);
    expect(res.body.perDay).toHaveLength(1);
  });

  it('rejects from > to with 400', async () => {
    await http(booted.app)
      .get('/api/reports/range?from=2026-08-02&to=2026-08-01')
      .set(authHeader(token))
      .expect(400);
  });

  it('rejects a malformed date with 400', async () => {
    await http(booted.app)
      .get('/api/reports/range?from=2026-8-1&to=2026-08-02')
      .set(authHeader(token))
      .expect(400);
  });

  it('rejects a span exceeding 90 days with 400', async () => {
    // 91-day span (2026-01-01 .. 2026-04-01 inclusive).
    await http(booted.app)
      .get('/api/reports/range?from=2026-01-01&to=2026-04-01')
      .set(authHeader(token))
      .expect(400);
  });

  it('allows exactly a 90-day span', async () => {
    await http(booted.app)
      .get('/api/reports/range?from=2026-01-01&to=2026-03-31')
      .set(authHeader(token))
      .expect(200);
  });
});
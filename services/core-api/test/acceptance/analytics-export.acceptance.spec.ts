import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  type BootedApp,
  clearRepos,
  createApp,
  http,
  seedPrdConfig,
} from './_helpers';

/**
 * DoD-5 — Daily analytics & local export (FR-ADM-03 / QUE-26).
 *
 * Drives tickets through the queue lifecycle via the command REST surface so the
 * new lifecycle timestamp columns (`called_at` / `served_at` / `completed_at`)
 * are populated, then asserts the reporting read side aggregates them correctly:
 *
 *  - `GET /api/reports/daily?date=<today>` — total visitors, avg wait/service
 *    time, per-category breakdown.
 *  - `GET /api/reports/counters/:id?date=<today>` — per-counter served count +
 *    avg service time.
 *  - `GET /api/audit/log` — the audit trail of sensitive admin actions (a
 *    manual daily reset records `ARCHIVE_PREVIOUS_DAY` + `MANUAL_RESET`).
 *
 * The `.xlsx` export is client-side in admin-service (covered by the
 * admin-service vitest suite), so it is not exercised here. In-memory profile
 * (default) — no DB, no network. The manual reset's archive threshold is
 * `created_at < startOfLocalDay(now)`, so today's tickets survive the reset
 * (asserted) — the report still sees them in the active `tickets` store.
 */

/** Today's date as the store's local `YYYY-MM-DD` (single on-premise box, NFR-SEC-01). */
function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Resolves after `ms` real milliseconds. The command use cases use real
 * `Date.now()` (no injectable clock in the wired profile), and in-process
 * supertest calls are sub-millisecond — without a deliberate gap the lifecycle
 * timestamps (`calledAt`/`servedAt`/`completedAt`) can land in the same
 * millisecond, making wait/service-time deltas round to 0. A 2 ms gap between
 * transitions guarantees each delta is ≥ 1 ms so the metrics are deterministic
 * (jest defaults to real timers).
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('DoD-5 — Daily analytics & local export (FR-ADM-03 / QUE-26)', () => {
  let booted: BootedApp;
  let catAId: string;
  let catBId: string;
  const today = todayKey();

  beforeAll(async () => {
    booted = await createApp();
  });

  afterAll(async () => {
    await booted.app.close();
  });

  // A fresh store per test so each starts from a clean sequence + audit log.
  beforeEach(() => {
    clearRepos(booted.app);
  });

  async function createTicket(categoryId: string): Promise<string> {
    const res = await http(booted.app).post('/api/tickets').send({ categoryId }).expect(201);
    return res.body.ticket.ticketId as string;
  }

  async function callNext(counterId: number): Promise<string> {
    const res = await http(booted.app).post('/api/queue/call-next').send({ counterId }).expect(201);
    expect(res.body.status).toBe('called');
    return res.body.ticket.ticketId as string;
  }

  /** Issue + drive one ticket through CALLING → SERVING → COMPLETED. */
  async function createAndComplete(categoryId: string, counterId: number): Promise<string> {
    await createTicket(categoryId);
    await sleep(2);
    const ticketId = await callNext(counterId);
    await sleep(2);
    await http(booted.app).post(`/api/queue/${ticketId}/serve`).expect(201);
    await sleep(2);
    await http(booted.app).post(`/api/queue/${ticketId}/complete`).expect(201);
    return ticketId;
  }

  async function seed(): Promise<void> {
    const ids = await seedPrdConfig(booted.app);
    catAId = ids.catAId;
    catBId = ids.catBId;
  }

  it('aggregates total visitors, avg wait/service time, and per-category breakdown over the lifecycle', async () => {
    await seed();
    // Counter 1 (serves A, FIFO) completes two A tickets; the second is
    // skipped then recalled (exercises the calledAt re-set on recall).
    await createAndComplete(catAId, 1);
    // Second A ticket: call → skip → recall → serve → complete.
    await createTicket(catAId);
    await sleep(2);
    const t2 = await callNext(1);
    await sleep(2);
    await http(booted.app).post(`/api/queue/${t2}/skip`).expect(201);
    await http(booted.app).post(`/api/queue/${t2}/recall`).expect(201);
    await sleep(2);
    await http(booted.app).post(`/api/queue/${t2}/serve`).expect(201);
    await sleep(2);
    await http(booted.app).post(`/api/queue/${t2}/complete`).expect(201);
    // Counter 2 (serves A+B, CATEGORY_PRIORITY) completes one B ticket.
    await createAndComplete(catBId, 2);

    const res = await http(booted.app).get(`/api/reports/daily?date=${today}`).expect(200);

    expect(res.body.totalTickets).toBe(3);
    // Every ticket was called and completed, so both averages are populated.
    expect(res.body.avgWaitTimeMs).toBeGreaterThan(0);
    expect(res.body.avgServiceTimeMs).toBeGreaterThan(0);
    expect(res.body.date).toBe(today);

    // Per-category breakdown: A has 2 tickets, B has 1 (sorted by code).
    const perCat = res.body.perCategory as Array<{ code: string; totalTickets: number }>;
    expect(perCat).toHaveLength(2);
    const byCode = new Map(perCat.map((c) => [c.code, c.totalTickets]));
    expect(byCode.get('A')).toBe(2);
    expect(byCode.get('B')).toBe(1);
  });

  it('reports per-counter served count + avg service time', async () => {
    await seed();
    await createAndComplete(catAId, 1);
    await createAndComplete(catAId, 1);
    await createAndComplete(catBId, 2);

    const c1 = await http(booted.app).get(`/api/reports/counters/1?date=${today}`).expect(200);
    expect(c1.body.counterId).toBe(1);
    expect(c1.body.ticketsServed).toBe(2);
    expect(c1.body.avgServiceTimeMs).toBeGreaterThan(0);

    const c2 = await http(booted.app).get(`/api/reports/counters/2?date=${today}`).expect(200);
    expect(c2.body.counterId).toBe(2);
    expect(c2.body.ticketsServed).toBe(1);
    expect(c2.body.avgServiceTimeMs).toBeGreaterThan(0);

    // A counter that served nothing that day returns the zero-shape (not 404).
    const c3 = await http(booted.app).get(`/api/reports/counters/999?date=${today}`).expect(200);
    expect(c3.body.ticketsServed).toBe(0);
    expect(c3.body.avgServiceTimeMs).toBe(0);
  });

  it('returns a zero-shape daily report when no tickets exist for the date', async () => {
    await seed();
    const res = await http(booted.app).get(`/api/reports/daily?date=${today}`).expect(200);
    expect(res.body.totalTickets).toBe(0);
    expect(res.body.avgWaitTimeMs).toBe(0);
    expect(res.body.avgServiceTimeMs).toBe(0);
    expect(res.body.perCategory).toEqual([]);
  });

  it('surfaces the audit trail after a manual daily reset (ARCHIVE_PREVIOUS_DAY + MANUAL_RESET)', async () => {
    await seed();
    await createAndComplete(catAId, 1);

    // A manual reset is a human-initiated mutation → audited (NFR-SEC-02).
    const reset = await http(booted.app).post('/api/system/daily-reset').expect(201);
    expect(reset.body.archivedCount).toBe(0); // no prior-day tickets to archive.

    const log = await http(booted.app).get('/api/audit/log').expect(200);
    const actions = (log.body as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('ARCHIVE_PREVIOUS_DAY');
    expect(actions).toContain('MANUAL_RESET');

    // The reset's archive threshold is `created_at < startOfLocalDay(now)`, so
    // today's ticket survives in the active store — the daily report still sees it.
    const res = await http(booted.app).get(`/api/reports/daily?date=${today}`).expect(200);
    expect(res.body.totalTickets).toBe(1);
  });
});
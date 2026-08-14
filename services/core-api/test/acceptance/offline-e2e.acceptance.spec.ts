import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  type BootedApp,
  authHeader,
  bootstrapAuthedAdmin,
  clearRepos,
  collectMessages,
  createApp,
  http,
  openWs,
  seedPrdConfig,
  type WireEvent,
} from './_helpers';

/**
 * DoD-3 — Offline End-to-End Test (FR-ENG-01..04, FR-KSK-01..03, FR-TV-01..03,
 * FR-CLR-01..03, NFR-REL-01, NFR-PERF-01/02/03).
 *
 * PRD §8 bullet 3: the whole flow — kiosk ticket → thermal print → caller call
 * → TV audio/display — works with the WAN cable unplugged. This spec drives
 * the flow in-process against the in-memory profile (fast/deterministic,
 * reusing the canonical boot). The kiosk print budget (<1.5 s, NFR-PERF-03) is
 * asserted in the kiosk-service vitest component test (cross-referenced, not
 * re-run here); the TV audio fragment sequence is asserted in the
 * tv-display-service vitest suite. This spec asserts the **realtime backbone**
 * that ties the services together:
 *
 *  - kiosk `POST /api/tickets` → `TICKET_CREATED` on the TV (FR-ENG-04).
 *  - caller `POST /api/queue/call-next` → `TICKET_CALLED` on the TV + caller
 *    within the 150 ms LAN budget (NFR-PERF-02, p99 over 20 iterations).
 *  - `serve` → `STATUS_UPDATED`; `complete` → `STATUS_UPDATED` (the active
 *    ticket leaves the board, FR-TV-01).
 *  - HTTP API p99 < 100 ms (NFR-PERF-01, 50 `GET /api/queue?counterId=1`).
 *
 * No DB, no network. `global.fetch` is left untouched here — the
 * no-external-network assertion (NFR-REL-01) lives in its own spec so this one
 * stays focused on the realtime flow.
 */
describe('DoD-3 — Offline End-to-End realtime flow', () => {
  let booted: BootedApp;
  let catAId: string;
  // QUE-43: the caller command surface + `GET /api/queue` are authenticated
  // (admin or caller-staff). The bootstrap admin bearer threads onto every
  // queue command/read below; `POST /api/tickets` (kiosk) and `/ws` (TV) stay
  // public and tokenless — the offline flow must not require a kiosk/TV login.
  let token: string;

  beforeAll(async () => {
    booted = await createApp();
    token = await bootstrapAuthedAdmin(booted.app);
  });

  afterAll(async () => {
    await booted.app.close();
  });

  beforeEach(async () => {
    clearRepos(booted.app);
    const seeded = await seedPrdConfig(booted.app);
    catAId = seeded.catAId;
  });

  it('kiosk ticket creation broadcasts TICKET_CREATED to the TV (FR-ENG-01/04)', async () => {
    const events = await collectMessages(booted.port, 1, async () => {
      await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);
    });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe('TICKET_CREATED');
    expect(e.payload.ticketNumber).toBe('A-001');
    expect(e.payload.categoryId).toBe(catAId);
  });

  it('caller call-next broadcasts TICKET_CALLED to both the TV and the caller (FR-CLR/TV, FR-ENG-04)', async () => {
    // Seed a waiting ticket (the kiosk half), then a TV client + a caller client
    // both subscribe before the caller calls next.
    const ticket = await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);
    const ticketId = ticket.body.ticket.ticketId;

    const tv = await openWs(booted.port);
    const caller = await openWs(booted.port);
    const tvEvents: WireEvent[] = [];
    const callerEvents: WireEvent[] = [];
    tv.on('message', (d) => tvEvents.push(JSON.parse(d.toString())));
    caller.on('message', (d) => callerEvents.push(JSON.parse(d.toString())));

    // Counter 1 is routed to category A (PRD §7).
    await http(booted.app)
      .post('/api/queue/call-next')
      .set(authHeader(token))
      .send({ counterId: 1 })
      .expect(201);

    // call-next emits TICKET_CALLED + STATUS_UPDATED — wait for both on each client.
    await waitForLength(tvEvents, 2);
    await waitForLength(callerEvents, 2);

    const tvTypes = tvEvents.map((e) => e.type).sort();
    const callerTypes = callerEvents.map((e) => e.type).sort();
    expect(tvTypes).toEqual(['STATUS_UPDATED', 'TICKET_CALLED']);
    expect(callerTypes).toEqual(['STATUS_UPDATED', 'TICKET_CALLED']);
    const called = tvEvents.find((e) => e.type === 'TICKET_CALLED')!;
    expect(called.payload.ticketNumber).toBe('A-001');
    expect(called.payload.counterId).toBe(1);

    // serve → STATUS_UPDATED (CALLING -> SERVING), complete → STATUS_UPDATED (SERVING -> COMPLETED).
    const serveRes = await http(booted.app)
      .post(`/api/queue/${ticketId}/transition`).send({ targetStatus: 'SERVING' })
      .set(authHeader(token))
      .expect(201);
    expect(serveRes.body.status).toBe('transitioned');
    await waitForLength(tvEvents, 3);
    expect(tvEvents[2].type).toBe('STATUS_UPDATED');
    expect(tvEvents[2].payload.to).toBe('SERVING');

    await http(booted.app)
      .post(`/api/queue/${ticketId}/transition`).send({ targetStatus: 'COMPLETED' })
      .set(authHeader(token))
      .expect(201);
    await waitForLength(tvEvents, 4);
    expect(tvEvents[3].type).toBe('STATUS_UPDATED');
    expect(tvEvents[3].payload.to).toBe('COMPLETED');

    tv.close();
    caller.close();
  });

  it('NFR-PERF-02: caller→TV realtime round trip p99 < 150 ms over 20 calls', async () => {
    // Seed 20 waiting tickets so call-next has work 20 times.
    for (let i = 0; i < 20; i++) {
      await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);
    }
    const tv = await openWs(booted.port);
    let resolveNext: ((e: WireEvent) => void) | undefined;
    tv.on('message', (d) => {
      const e = JSON.parse(d.toString()) as WireEvent;
      if (e.type === 'TICKET_CALLED') resolveNext?.(e);
    });

    const latencies: number[] = [];
    for (let i = 0; i < 20; i++) {
      const next = new Promise<WireEvent>((r) => (resolveNext = r));
      const t0 = process.hrtime.bigint();
      await http(booted.app).post('/api/queue/call-next').set(authHeader(token)).send({ counterId: 1 }).expect(201);
      await next;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      latencies.push(ms);
    }
    tv.close();

    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    // In-process is a lower bound for LAN; < 150 ms here means the realtime
    // path has headroom for the LAN budget (NFR-PERF-02).
    expect(p99).toBeLessThan(150);
  });

  it('NFR-PERF-01: HTTP API p99 < 100 ms (GET /api/queue?counterId=1 over 50 reads)', async () => {
    // Seed one ticket so the snapshot has content (read path still works empty,
    // but a populated snapshot is the realistic measurement).
    await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);

    const latencies: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = process.hrtime.bigint();
      await http(booted.app).get('/api/queue?counterId=1').set(authHeader(token)).expect(200);
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    expect(p99).toBeLessThan(100);
  });

  it('skip + recall round-trip the SKIPPED state (FR-CLR-03 Recall/Skip)', async () => {
    const ticket = await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);
    const ticketId = ticket.body.ticket.ticketId;

    const tv = await openWs(booted.port);
    const tvEvents: WireEvent[] = [];
    tv.on('message', (d) => tvEvents.push(JSON.parse(d.toString())));

    await http(booted.app).post('/api/queue/call-next').set(authHeader(token)).send({ counterId: 1 }).expect(201);
    await waitForLength(tvEvents, 2);

    await http(booted.app).post(`/api/queue/${ticketId}/transition`).set(authHeader(token)).send({ targetStatus: 'SKIPPED' }).expect(201);
    await waitForLength(tvEvents, 3);
    expect(tvEvents[2].payload.to).toBe('SKIPPED');

    // The skipped ticket lands in the caller snapshot's `skipped` bucket, at the
    // counter that skipped it — the surface "Panggil Ulang" (the SKIPPED -> CALLING
    // edge `GET /api/queue/actions` publishes) acts on. Without it the ticket
    // would be in no bucket and the configured action unreachable.
    const afterSkip = await http(booted.app)
      .get('/api/queue?counterId=1')
      .set(authHeader(token))
      .expect(200);
    expect(afterSkip.body.active).toEqual([]);
    expect(afterSkip.body.skipped).toEqual([
      {
        ticketId,
        ticketNumber: 'A-001',
        categoryId: catAId,
        status: 'SKIPPED',
        counterId: 1,
      },
    ]);

    // No counterId in the body: a skipped ticket keeps the counter that called
    // it, so the re-call announces at that same counter.
    await http(booted.app).post(`/api/queue/${ticketId}/transition`).set(authHeader(token)).send({ targetStatus: 'CALLING' }).expect(201);
    // A re-call announces at the same counter: it emits STATUS_UPDATED
    // (SKIPPED -> CALLING) then TICKET_CALLED carrying {ticketNumber, counterId}
    // so the TV board re-shows the ticket and the audio queue re-announces it
    // (FR-TV-01/02). The TICKET_CALLED is the recall-restore signal the TV
    // consumes with no TV-side change.
    await waitForLength(tvEvents, 5);
    expect(tvEvents[3].payload.to).toBe('CALLING');
    expect(tvEvents[4].type).toBe('TICKET_CALLED');
    expect(tvEvents[4].payload.ticketNumber).toBe('A-001');
    expect(tvEvents[4].payload.counterId).toBe(1);

    // …and the recall empties the skipped bucket: the ticket is active again at
    // the same counter, so the snapshot's three buckets stay disjoint.
    const afterRecall = await http(booted.app)
      .get('/api/queue?counterId=1')
      .set(authHeader(token))
      .expect(200);
    expect(afterRecall.body.skipped).toEqual([]);
    expect(afterRecall.body.active.map((t: { ticketNumber: string }) => t.ticketNumber)).toEqual([
      'A-001',
    ]);

    tv.close();
  });

  it('reannounce re-broadcasts TICKET_CALLED for the currently-calling ticket (Panggil Lagi)', async () => {
    const ticket = await http(booted.app).post('/api/tickets').send({ categoryId: catAId }).expect(201);
    const ticketId = ticket.body.ticket.ticketId;

    const tv = await openWs(booted.port);
    const tvEvents: WireEvent[] = [];
    tv.on('message', (d) => tvEvents.push(JSON.parse(d.toString())));

    // call-next → TICKET_CALLED + STATUS_UPDATED (2 events).
    await http(booted.app).post('/api/queue/call-next').set(authHeader(token)).send({ counterId: 1 }).expect(201);
    await waitForLength(tvEvents, 2);

    // reannounce → only TICKET_CALLED (no state change, no STATUS_UPDATED).
    await http(booted.app).post(`/api/queue/${ticketId}/reannounce`).set(authHeader(token)).expect(201);
    await waitForLength(tvEvents, 3);
    expect(tvEvents[2].type).toBe('TICKET_CALLED');
    expect(tvEvents[2].payload.ticketNumber).toBe('A-001');
    expect(tvEvents[2].payload.counterId).toBe(1);

    tv.close();
  });
});

/** Resolves once `arr` reaches `n` (or after a short timeout, to avoid hangs). */
function waitForLength<T>(arr: T[], n: number, timeoutMs = 500): Promise<void> {
  if (arr.length >= n) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (arr.length >= n || Date.now() - start >= timeoutMs) resolve();
      else setTimeout(tick, 5);
    };
    setTimeout(tick, 5);
  });
}
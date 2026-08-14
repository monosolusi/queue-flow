import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';
import { authHeader, prdWizardPayload } from './_helpers';

/**
 * DoD-4 — Power Interruption Recovery Test (FR-ENG-05, NFR-REL-02/03).
 *
 * PRD §8 bullet 4: pull the PC server's power while a `WAITING` and a `SERVING`
 * ticket exist; after restart, ticket numbers and transaction state recover
 * exactly — no duplicates, no gaps. This spec simulates a power cut by
 * `SIGKILL`ing a real PostgreSQL-backed core-api mid-flight and respawning it
 * against the same DB: WAL + `fsync=on` (Postgres defaults) keep the committed
 * writes durable, so the restarted process reads back the exact state.
 *
 * Gated on `QMS_ACCEPTANCE_DB_URL` (a real Postgres) AND a built `dist/main.js`:
 * it self-skips when either is absent, so `npm run test:acceptance` (and the
 * root `verify` gate) stay green without a DB. CI sets the env var (and the
 * `acceptance` script builds core-api first) to run the real recovery test.
 *
 * Flow: reset DB → boot P1 → wizard config → create A-001/A-002 → call-next +
 * serve A-001 (→ SERVING, A-002 WAITING) → SIGKILL P1 → boot P2 → assert A-001
 * still SERVING (recovered), next ticket is exactly A-003 (no dupe/gap), and
 * call-next serves the recovered A-002 (the oldest WAITING).
 */

const DB_URL = process.env.QMS_ACCEPTANCE_DB_URL;
const CORE_API_DIR = resolve(__dirname, '../..');
const DIST_MAIN = resolve(CORE_API_DIR, 'dist/main.js');
const PORT = 3000;
const BASE = `http://127.0.0.1:${PORT}`;

const READY = DB_URL && existsSync(DIST_MAIN);
const describeOrSkip = READY ? describe : describe.skip;

/**
 * Resets the DB to a pristine schema. Drops and recreates `public` (cascading
 * every data table AND `_migrations`), so the next core-api boot re-applies all
 * migrations from scratch via the idempotent {@link PostgresMigrationRunner}.
 * This works on a cold DB (no tables yet) — a `TRUNCATE` would fail there with
 * "relation does not exist" — and gives each run a truly clean slate.
 */
async function resetDb(): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL });
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query('GRANT ALL ON SCHEMA public TO qms');
    await pool.query('GRANT ALL ON SCHEMA public TO public');
  } finally {
    await pool.end();
  }
}

/** Polls GET /api/health until 200 (or throws after `timeoutMs`). */
async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { status: string };
        if (body.status === 'ok') return;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`core-api did not become healthy within ${timeoutMs}ms (last error: ${String(lastErr)})`);
}

/** Boots a Postgres-backed core-api as a child process. */
function bootCoreApi(): ChildProcess {
  return spawn('node', ['dist/main.js'], {
    cwd: CORE_API_DIR,
    env: {
      ...process.env,
      QMS_PERSISTENCE: 'postgres',
      QMS_DB_URL: DB_URL,
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  });
}

async function killProc(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGKILL');
  await new Promise<void>((r) => proc.once('exit', () => r()));
}

/** JSON POST helper against the spawned server. `extraHeaders` threads the
 * QUE-43 bearer onto authenticated endpoints (queue commands). */
async function post(path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function getJson(path: string, extraHeaders?: Record<string, string>): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: extraHeaders });
}

describeOrSkip('DoD-4 — Power-cut recovery (FR-ENG-05, NFR-REL-02/03)', () => {
  let proc: ChildProcess | undefined;

  afterEach(async () => {
    await killProc(proc);
    proc = undefined;
  });

  afterAll(async () => {
    await killProc(proc);
  });

  it('recovers SERVING + WAITING state exactly after SIGKILL — no dupes, no gaps', async () => {
    await resetDb();

    // --- Boot P1, configure, and drive a ticket to SERVING ----------------
    proc = bootCoreApi();
    await waitForHealth();
    expect(proc.exitCode).toBeNull(); // still running

    // QUE-43: the first-run wizard seeds the initial admin (setup-admin is open
    // only while setup is incomplete) then logs in for a bearer. The session
    // row commits to Postgres, so the SAME token survives the SIGKILL reboot
    // below (P2 reads the session back from WAL) — proving auth state is
    // power-loss resilient (NFR-REL-02), not just the queue state. Kiosk
    // ticket creation stays public/tokenless.
    const setupAdminRes = await post('/api/auth/setup-admin', {
      username: 'admin',
      password: 'password123',
    });
    expect(setupAdminRes.status).toBe(200);
    const loginRes = await post('/api/auth/login', {
      username: 'admin',
      password: 'password123',
    });
    expect(loginRes.status).toBe(200);
    const { token } = (await loginRes.json()) as { token: string };
    const auth = authHeader(token);

    const cfg = await fetch(`${BASE}/api/system/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(prdWizardPayload()),
    });
    expect(cfg.status).toBe(200);

    const catsRes = await getJson('/api/categories');
    const cats = (await catsRes.json()) as { id: string; code: string }[];
    const catA = cats.find((c) => c.code === 'A')!;
    expect(catA).toBeDefined();

    const t1Res = await post('/api/tickets', { categoryId: catA.id });
    const t1 = (await t1Res.json()) as { ticket: { ticketId: string; ticketNumber: string } };
    expect(t1.ticket.ticketNumber).toBe('A-001');

    const t2Res = await post('/api/tickets', { categoryId: catA.id });
    const t2 = (await t2Res.json()) as { ticket: { ticketId: string; ticketNumber: string } };
    expect(t2.ticket.ticketNumber).toBe('A-002');

    // Counter 1 -> category A (PRD §7). Call next (A-001) then serve -> SERVING.
    await post('/api/queue/call-next', { counterId: 1 }, auth);
    const serveRes = await post(`/api/queue/${t1.ticket.ticketId}/serve`, undefined, auth);
    expect(serveRes.status).toBe(201);
    const served = (await serveRes.json()) as { status: string };
    expect(served.status).toBe('serving');

    // --- Power cut: SIGKILL mid-flight (WAL has committed every write) -----
    await killProc(proc);
    proc = undefined;

    // --- Boot P2 against the SAME database --------------------------------
    proc = bootCoreApi();
    await waitForHealth();

    // The SERVING ticket is recovered exactly (no loss — NFR-REL-02). The
    // bearer still works — the session row survived the reboot in WAL.
    const snapRes = await getJson('/api/queue?counterId=1', auth);
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      active: { ticketNumber: string; status: string }[];
      waiting: { ticketNumber: string; status: string }[];
    };
    const recoveredActive = snap.active.find((t) => t.ticketNumber === 'A-001');
    expect(recoveredActive).toBeDefined();
    expect(recoveredActive!.status).toBe('SERVING');

    // The next ticket is exactly A-003 — no duplicate (A-001/A-002 not reused)
    // and no gap (sequence continues +1). NFR-REL-02.
    const t3Res = await post('/api/tickets', { categoryId: catA.id });
    expect(t3Res.status).toBe(201);
    const t3 = (await t3Res.json()) as { ticket: { ticketNumber: string } };
    expect(t3.ticket.ticketNumber).toBe('A-003');

    // call-next serves the recovered oldest WAITING ticket (A-002), proving the
    // queue state — not just the sequence — recovered.
    const callRes = await post('/api/queue/call-next', { counterId: 1 }, auth);
    expect(callRes.status).toBe(201);
    const call = (await callRes.json()) as {
      status: string;
      ticket?: { ticketId: string; ticketNumber: string };
    };
    expect(call.status).toBe('called');
    expect(call.ticket!.ticketNumber).toBe('A-002');

    // Skipping that ticket parks it in the snapshot's counter-scoped `skipped`
    // bucket — the surface "Panggil Ulang" acts on. This is the PostgreSQL half
    // of `findSkippedByCounter` (the in-memory twin is covered in the unit
    // suite): the two implementations must stay interchangeable (LSP), and only
    // a real DB proves the SQL predicate matches.
    const skipRes = await post(`/api/queue/${call.ticket!.ticketId}/skip`, undefined, auth);
    expect(skipRes.status).toBe(201);
    const parkedRes = await getJson('/api/queue?counterId=1', auth);
    const parked = (await parkedRes.json()) as {
      skipped: { ticketNumber: string; counterId: number }[];
    };
    expect(parked.skipped.map((t) => t.ticketNumber)).toEqual(['A-002']);
    expect(parked.skipped[0].counterId).toBe(1);
  }, 90_000);
});
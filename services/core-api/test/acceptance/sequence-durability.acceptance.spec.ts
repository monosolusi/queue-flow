import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';
import { PostgresSequenceRepository } from '../../src/infrastructure/persistence/postgres/postgres-sequence.repository';
import { PostgresTransactionManager } from '../../src/infrastructure/persistence/postgres/postgres-transaction-manager';
import { PostgresMigrationRunner } from '../../src/infrastructure/persistence/postgres/migration-runner';
import { PostgresDurabilityProbe } from '../../src/infrastructure/persistence/postgres/durability-probe';
import { DurabilityDegradedException } from '../../src/infrastructure/persistence/postgres/durability-degraded.exception';

/**
 * QUE-28 — Sequence durability acceptance (NFR-REL-02).
 *
 * DoD-4 (`power-cut-recovery`) proves end-to-end that a SIGKILL'd app recovers
 * exact state. This spec proves the *contract* that makes that recovery
 * possible — directly against a real PostgreSQL, without booting the app:
 *
 *  1. Concurrency: N parallel `nextTicketNumber` calls produce N distinct,
 *     consecutive numbers — the `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 *     atomic upsert serializes on the `(category_id, date)` row, so no
 *     duplicate and no gap under contention.
 *  2. Rollback = no gap: a `runInTransaction` that reserves a number then
 *     throws rolls the increment back, so the next reservation reuses that
 *     number rather than skipping it. This is the heart of gap-free
 *     durability: a crash/failure between reserve and insert burns no
 *     sequence.
 *  3. Durability probe: on a default PG (`fsync=on`) the boot probe resolves.
 *
 * Gated on `QMS_ACCEPTANCE_DB_URL` (a real Postgres). It self-skips when unset,
 * so `npm run test:acceptance` and the root verify gate stay green without a
 * DB. CI sets the env var to run the real contract test. Unlike DoD-4, this
 * spec exercises the repository + transaction manager directly via ts-jest
 * (no `dist/main.js` spawn), so it does NOT gate on a build artifact.
 */
const DB_URL = process.env.QMS_ACCEPTANCE_DB_URL;
const describeOrSkip = DB_URL ? describe : describe.skip;

describeOrSkip('QUE-28 — Sequence durability (NFR-REL-02)', () => {
  let pool: Pool;
  let sequences: PostgresSequenceRepository;
  let txManager: PostgresTransactionManager;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    // Pristine schema: drop+recreate `public` (cascades every table AND
    // `_migrations`), then re-apply all migrations via the real runner. Works
    // on a cold DB (no tables yet); a TRUNCATE would fail there.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await new PostgresMigrationRunner(pool).onModuleInit();

    sequences = new PostgresSequenceRepository(pool);
    txManager = new PostgresTransactionManager(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('nextTicketNumber is atomic under contention — no duplicates, no gaps', async () => {
    const date = '2099-01-01';
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => sequences.nextTicketNumber('cat-concurrency', 'A', date)),
    );
    const seqs = results.map((r) => r.sequence).sort((a, b) => a - b);
    // No duplicates.
    expect(new Set(seqs).size).toBe(N);
    // No gaps: the sorted values are exactly 1..N.
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it('a rolled-back reservation burns no number (gap-free on mid-tx failure)', async () => {
    const date = '2099-01-02';

    // First reservation succeeds: value 0 -> 1, ticket A-001.
    const first = await sequences.nextTicketNumber('cat-rollback', 'A', date);
    expect(first.sequence).toBe(1);

    // Reserve inside a transaction, then fail. The increment enlists on the
    // ambient tx client, so ROLLBACK must revert it — value returns to 1.
    await expect(
      txManager.runInTransaction(async () => {
        const reserved = await sequences.nextTicketNumber('cat-rollback', 'A', date);
        expect(reserved.sequence).toBe(2); // reserved before the failure
        throw new Error('simulated crash mid-reserve');
      }),
    ).rejects.toThrow('simulated crash mid-reserve');

    // The next reservation reuses the rolled-back number (A-002), proving no
    // gap was opened by the failed reservation.
    const after = await sequences.nextTicketNumber('cat-rollback', 'A', date);
    expect(after.sequence).toBe(2);
  });

  it('durability probe resolves on a default PostgreSQL (fsync=on)', async () => {
    const probe = new PostgresDurabilityProbe(pool);
    await expect(probe.onModuleInit()).resolves.toBeUndefined();
  });

  it('durability probe fails fast when fsync is off', async () => {
    // Simulate a degraded server: a per-session `SET fsync` is not allowed
    // (postmaster context), so the probe reading `SHOW fsync` on this pool's
    // own connections would still report the server value. Instead, drive
    // the probe with a fake pool that reports `off` — asserting the fail-fast
    // path independently of a real misconfigured server.
    const degraded = {
      query: async () => ({ rows: [{ fsync: 'off' }] }),
    };
    const probe = new PostgresDurabilityProbe(degraded as unknown as Pool);
    await expect(probe.onModuleInit()).rejects.toBeInstanceOf(DurabilityDegradedException);
  });
});
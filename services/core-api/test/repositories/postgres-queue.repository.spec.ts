import type { Pool } from 'pg';
// Imported by direct path, not the persistence barrel: the barrel also pulls in
// the Nest DI module + migration runner, which this pure repository spec has no
// need for.
import { PostgresQueueRepository } from '../../src/infrastructure/persistence/postgres/postgres-queue.repository';

/**
 * Unit coverage for the PostgreSQL side of the counter-scoped reads, driven by a
 * fake `pg` pool. The Postgres repository is otherwise only exercised by the
 * DB-gated acceptance suite (`QMS_ACCEPTANCE_DB_URL`), which leaves the default
 * `npm test` gate blind to a SQL-level LSP divergence between the two
 * `IQueueRepository` implementations — this spec closes that hole for
 * `findSkippedByCounter`, whose in-memory twin is verified behaviorally in
 * `in-memory-queue.repository.spec.ts`.
 *
 * It asserts the *predicate* (which rows the query selects and in what order)
 * through the bound parameters and the SQL's filter/order clauses, plus the
 * row→aggregate mapping and the pooled-client release. A real-database check of
 * the same read runs in the power-cut acceptance spec.
 */

interface FakePool {
  readonly pool: Pool;
  readonly queries: { text: string; values: unknown[] }[];
  releases(): number;
}

/** A `pg` pool stand-in that records every query and returns `rows` verbatim. */
function fakePool(rows: Record<string, unknown>[] = []): FakePool {
  const queries: { text: string; values: unknown[] }[] = [];
  let released = 0;
  const client = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rows, rowCount: rows.length };
    },
    release: () => {
      released += 1;
    },
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    queries,
    releases: () => released,
  };
}

/** A `tickets` row as `pg` hands it back (epoch columns arrive as strings). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ticket_number: 'A-001',
    category_id: 'CAT-A',
    status: 'SKIPPED',
    counter_id: 3,
    created_at: '100',
    updated_at: '300',
    called_at: '150',
    served_at: null,
    completed_at: null,
    ...overrides,
  };
}

/** Collapses whitespace so the SQL can be asserted clause-by-clause. */
function sql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

describe('PostgresQueueRepository — counter-scoped reads', () => {
  describe('findSkippedByCounter', () => {
    it('selects SKIPPED rows for that counter, oldest skip first', async () => {
      const fake = fakePool();
      await new PostgresQueueRepository(fake.pool).findSkippedByCounter(3);

      expect(fake.queries).toHaveLength(1);
      // The predicate: this counter AND the SKIPPED status — never a category
      // filter (skip leaves counter_id assigned; recall re-announces to it).
      expect(fake.queries[0].values).toEqual([3, 'SKIPPED']);
      expect(sql(fake.queries[0].text)).toContain('WHERE counter_id = $1 AND status = $2');
      expect(sql(fake.queries[0].text)).toContain('ORDER BY updated_at ASC');
    });

    it('reconstitutes each row into a QueueTicket aggregate', async () => {
      const fake = fakePool([row(), row({ id: '22222222-2222-4222-8222-222222222222', ticket_number: 'B-012' })]);

      const tickets = await new PostgresQueueRepository(fake.pool).findSkippedByCounter(3);

      expect(tickets.map((t) => t.ticketNumber.formatted())).toEqual(['A-001', 'B-012']);
      expect(tickets[0].currentStatus).toBe('SKIPPED');
      expect(tickets[0].counterId).toBe(3);
      expect(tickets[0].calledAt).toBe(150);
      expect(tickets[0].completedAt).toBeNull();
    });

    it('releases the pooled client (no connection leak on the read path)', async () => {
      const fake = fakePool([row()]);
      await new PostgresQueueRepository(fake.pool).findSkippedByCounter(3);

      expect(fake.releases()).toBe(1);
    });
  });

  it('scopes the skipped read exactly like the active read, differing only in the status filter', async () => {
    // The two reads are siblings: same counter scope, same ordering. Asserting
    // them together keeps a change to one from silently diverging from the
    // other (both feed the same caller snapshot).
    const activePool = fakePool();
    const skippedPool = fakePool();
    await new PostgresQueueRepository(activePool.pool).findActiveByCounter(7);
    await new PostgresQueueRepository(skippedPool.pool).findSkippedByCounter(7);

    const active = sql(activePool.queries[0].text);
    const skipped = sql(skippedPool.queries[0].text);
    expect(active).toContain('WHERE counter_id = $1');
    expect(skipped).toContain('WHERE counter_id = $1');
    expect(active).toContain('ORDER BY updated_at ASC');
    expect(skipped).toContain('ORDER BY updated_at ASC');
    expect(activePool.queries[0].values).toEqual([7, 'CALLING', 'SERVING']);
    expect(skippedPool.queries[0].values).toEqual([7, 'SKIPPED']);
  });
});

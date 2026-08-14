import type { Pool } from 'pg';
// Imported by direct path, not the persistence barrel: the barrel also pulls in
// the Nest DI module + migration runner, which this pure repository spec has no
// need for (mirrors `postgres-queue.repository.spec.ts`).
import { PostgresSystemConfigurationRepository } from '../../src/infrastructure/persistence/postgres/postgres-system-configuration.repository';

/**
 * Unit coverage for the stale-`action` normalisation on the Postgres read path
 * (`toConfig`). The Postgres repository is otherwise only exercised by the
 * DB-gated acceptance suite (`QMS_ACCEPTANCE_DB_URL`); this spec closes the gap
 * for the one read-side behaviour the default `npm test` gate would otherwise
 * be blind to.
 *
 * Pre-feature rows could carry a per-edge `action: 'TRANSFER_CATEGORY'` (a
 * category move declared as an edge). That action is gone — category moves are
 * now a standalone counter action — but the edge survives as a re-queue
 * (`-> WAITING`). Its manager-authored label (often "Pindah Kategori") would
 * otherwise round-trip unchanged and duplicate the standalone "Pindah Kategori"
 * button on the caller (same label, different behaviour). The read path
 * rewrites a stale `TRANSFER_CATEGORY` edge's label to the canonical re-queue
 * wording; every other stale `action` value (and a fresh edge with no `action`
 * key) keeps its label.
 */

interface FakePool {
  readonly pool: Pool;
  readonly queries: { text: string; values: unknown[] }[];
}

/** A `pg` pool stand-in that records the query and returns `rows` verbatim. */
function fakePool(rows: Record<string, unknown>[]): FakePool {
  const queries: { text: string; values: unknown[] }[] = [];
  const client = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rows, rowCount: rows.length };
    },
    release: () => {},
  };
  return {
    pool: { connect: async () => client } as unknown as Pool,
    queries,
  };
}

/** A `system_configuration` row as `pg` hands it back, with a state machine the
 *  caller controls. Every optional JSONB column is left null so the VO `.of()`
 *  fallbacks recover their defaults — only the state machine matters here. */
function configRow(stateMachine: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    store_name: 'Toko Contoh',
    is_initial_setup_completed: true,
    state_machine: stateMachine,
    daily_reset_policy: { mode: 'MANUAL', cronExpression: null, resetTicketNumberTo: 1, archivePreviousDayData: false },
    brand_color: '#2563eb',
    service_themes: null,
    tv_panel_layout: null,
    edge_routing_layout: null,
    node_positions: null,
    node_actions: null,
    terminal_nodes: null,
    end_sources: null,
    printer_configuration: null,
  };
}

function findEdge(
  config: { stateMachine: { transitions: readonly { from: string; to: string; actionLabel: string }[] } },
  from: string,
  to: string,
): { from: string; to: string; actionLabel: string } {
  const edge = config.stateMachine.transitions.find((t) => t.from === from && t.to === to);
  if (!edge) throw new Error(`edge ${from} -> ${to} not found`);
  return edge;
}

describe('PostgresSystemConfigurationRepository — stale `action` normalisation', () => {
  it('rewrites a stale TRANSFER_CATEGORY edge label to the canonical re-queue wording', async () => {
    const { pool } = fakePool([
      configRow({
        states: ['WAITING', 'CALLING', 'SERVING', 'COMPLETED'],
        transitions: [
          // A stale category-move edge — the hazardous case.
          { from: 'CALLING', to: 'WAITING', actionLabel: 'Pindah Kategori', action: 'TRANSFER_CATEGORY' },
          // A stale UPDATE_STATUS edge — label must stand (only TRANSFER_CATEGORY normalises).
          { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya', action: 'UPDATE_STATUS' },
          // A fresh post-feature edge with no `action` key — untouched.
          { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
        ],
      }),
    ]);

    const repo = new PostgresSystemConfigurationRepository(pool);
    const config = await repo.get();

    expect(config).not.toBeNull();
    // The stale transfer edge is normalised to the re-queue label, so the caller
    // renders a "Kembalikan ke Antrian" re-queue button — distinct from the
    // standalone "Pindah Kategori" move.
    expect(findEdge(config!, 'CALLING', 'WAITING').actionLabel).toBe('Kembalikan ke Antrian');
    // A stale UPDATE_STATUS edge keeps the manager's label.
    expect(findEdge(config!, 'WAITING', 'CALLING').actionLabel).toBe('Panggil Berikutnya');
    // A fresh edge with no `action` key is untouched.
    expect(findEdge(config!, 'CALLING', 'SERVING').actionLabel).toBe('Mulai Melayani');
  });

  it('leaves a re-queue edge authored without TRANSFER_CATEGORY untouched', async () => {
    const { pool } = fakePool([
      configRow({
        states: ['WAITING', 'CALLING', 'SERVING', 'COMPLETED'],
        transitions: [
          // A genuinely re-queue edge the manager labelled as such — no stale
          // action, so the label is honoured verbatim.
          { from: 'CALLING', to: 'WAITING', actionLabel: 'Kembalikan ke Antrian' },
        ],
      }),
    ]);

    const repo = new PostgresSystemConfigurationRepository(pool);
    const config = await repo.get();

    expect(config).not.toBeNull();
    expect(findEdge(config!, 'CALLING', 'WAITING').actionLabel).toBe('Kembalikan ke Antrian');
  });
});
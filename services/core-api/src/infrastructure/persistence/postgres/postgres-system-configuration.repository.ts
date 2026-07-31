import type { Pool } from 'pg';
import {
  type ISystemConfigurationRepository,
  SystemConfiguration,
} from '../../../domain/store-config';
import {
  DailyResetMode,
  DailyResetPolicy,
  type DailyResetPolicyProps,
} from '../../../domain/store-config/value-objects/daily-reset-policy';
import { StateMachine } from '../../../domain/store-config/state-machine';
import { StateSchema } from '../../../domain/store-config/value-objects/state-schema';
import { StateTransitionRule } from '../../../domain/store-config/value-objects/state-transition-rule';
import { Identifier } from '../../../domain/shared';
import { withDbClient } from './transaction-context';

interface ConfigRow {
  id: string;
  store_name: string;
  is_initial_setup_completed: boolean;
  state_machine: { states: string[]; transitions: { from: string; to: string; actionLabel: string }[] };
  daily_reset_policy: DailyResetPolicyProps;
}

/**
 * PostgreSQL implementation of {@link ISystemConfigurationRepository} (QUE-30).
 * Stores the singleton {@link SystemConfiguration} as one row (PK `id`); the
 * state machine and daily-reset policy are serialized to JSONB. `save` is a
 * single-statement upsert (`INSERT ... ON CONFLICT (id) DO UPDATE`), so it is
 * atomic on its own even when called outside a transaction — a crash between
 * the (nonexistent) truncate and insert cannot leave the table empty. When
 * enlisted on an ambient transaction (wizard finalization), it commits
 * atomically with the audit entry. The singleton id is preserved across saves
 * by the use case, so the upsert always targets the one existing row.
 */
export class PostgresSystemConfigurationRepository implements ISystemConfigurationRepository {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<SystemConfiguration | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<ConfigRow>('SELECT * FROM system_configuration LIMIT 1');
      return rows.length ? toConfig(rows[0]) : null;
    });
  }

  async save(config: SystemConfiguration): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO system_configuration (id, store_name, is_initial_setup_completed, state_machine, daily_reset_policy)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           store_name                = EXCLUDED.store_name,
           is_initial_setup_completed = EXCLUDED.is_initial_setup_completed,
           state_machine             = EXCLUDED.state_machine,
           daily_reset_policy        = EXCLUDED.daily_reset_policy`,
        [
          config.id.value,
          config.storeName,
          config.isInitialSetupCompleted,
          JSON.stringify(serializeStateMachine(config.stateMachine)),
          JSON.stringify({
            mode: config.dailyResetPolicy.mode,
            cronExpression: config.dailyResetPolicy.cronExpression,
            resetTicketNumberTo: config.dailyResetPolicy.resetTicketNumberTo,
            archivePreviousDayData: config.dailyResetPolicy.archivePreviousDayData,
          }),
        ],
      );
    });
  }
}

function serializeStateMachine(sm: StateMachine) {
  return {
    states: [...sm.stateSchema.states],
    transitions: sm.transitions.map((t) => ({ from: t.from, to: t.to, actionLabel: t.actionLabel })),
  };
}

function toConfig(row: ConfigRow): SystemConfiguration {
  const sm = row.state_machine;
  return SystemConfiguration.reconstitute({
    id: Identifier.of(row.id),
    storeName: row.store_name,
    isInitialSetupCompleted: row.is_initial_setup_completed,
    stateMachine: new StateMachine(
      StateSchema.of(sm.states),
      sm.transitions.map((t) => StateTransitionRule.of(t.from, t.to, t.actionLabel)),
    ),
    dailyResetPolicy: deserializePolicy(row.daily_reset_policy),
  });
}

function deserializePolicy(props: DailyResetPolicyProps) {
  return DailyResetPolicy.of(
    props.mode as DailyResetMode,
    props.cronExpression,
    props.resetTicketNumberTo,
    props.archivePreviousDayData,
  );
}
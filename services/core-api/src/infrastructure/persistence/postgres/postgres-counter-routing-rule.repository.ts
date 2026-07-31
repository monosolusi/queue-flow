import type { Pool } from 'pg';
import {
  type ICounterRoutingRuleRepository,
  CounterRoutingRule,
} from '../../../domain/store-config';
import { Identifier, PriorityPolicy } from '../../../domain/shared';
import { withDbClient } from './transaction-context';

interface RoutingRow {
  id: string;
  counter_id: number;
  counter_name: string;
  assigned_category_ids: string[];
  priority_policy: string;
}

/** PostgreSQL implementation of {@link ICounterRoutingRuleRepository} (QUE-30). */
export class PostgresCounterRoutingRuleRepository implements ICounterRoutingRuleRepository {
  constructor(private readonly pool: Pool) {}

  async getByCounterId(counterId: number): Promise<CounterRoutingRule | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<RoutingRow>(
        'SELECT * FROM counter_routing_rules WHERE counter_id = $1',
        [counterId],
      );
      return rows.length ? toRule(rows[0]) : null;
    });
  }

  async getAll(): Promise<CounterRoutingRule[]> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<RoutingRow>('SELECT * FROM counter_routing_rules');
      return rows.map(toRule);
    });
  }

  async save(rule: CounterRoutingRule): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO counter_routing_rules (id, counter_id, counter_name, assigned_category_ids, priority_policy)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           counter_name = EXCLUDED.counter_name,
           assigned_category_ids = EXCLUDED.assigned_category_ids,
           priority_policy = EXCLUDED.priority_policy`,
        [
          rule.id.value,
          rule.counterId,
          rule.counterName,
          Array.from(rule.assignedCategoryIds),
          rule.priorityPolicy,
        ],
      );
    });
  }

  async deleteAll(): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query('DELETE FROM counter_routing_rules');
    });
  }
}

function toRule(row: RoutingRow): CounterRoutingRule {
  return CounterRoutingRule.reconstitute({
    id: Identifier.of(row.id),
    counterId: row.counter_id,
    counterName: row.counter_name,
    assignedCategoryIds: row.assigned_category_ids,
    priorityPolicy: row.priority_policy as PriorityPolicy,
  });
}
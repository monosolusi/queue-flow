/**
 * How a counter selects its next ticket (PRD §4.1 / §7). Lives in the shared
 * kernel because both the Queue context (next-ticket selection) and the Store
 * Config context (CounterRoutingRule) need it — keeping it here avoids either
 * bounded context importing the other (anti-corruption).
 *
 * - `FIFO_GLOBAL`: oldest WAITING ticket across the counter's assigned
 *   categories, regardless of category.
 * - `CATEGORY_PRIORITY`: categories are served in a configured priority order;
 *   within a category the oldest ticket wins.
 */
export enum PriorityPolicy {
  FIFO_GLOBAL = 'FIFO_GLOBAL',
  CATEGORY_PRIORITY = 'CATEGORY_PRIORITY',
}

export type PriorityPolicyValue = `${PriorityPolicy}`;
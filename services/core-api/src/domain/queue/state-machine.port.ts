import type { StatusValue } from './value-objects/ticket-status';

/**
 * Port (interface) the Queue aggregate consumes to decide whether a status
 * transition is permitted by the active, configurable state machine. Defined
 * here — next to its consumer — per the Interface Segregation Principle. The
 * Store Config context supplies the concrete implementation backed by
 * {@link StateTransitionRule}s, so the Queue context never imports Store
 * Config internals directly (anti-corruption layer between bounded contexts).
 */
export interface ITransitionPolicy {
  isAllowed(from: StatusValue, to: StatusValue): boolean;
  actionLabelFor(from: StatusValue, to: StatusValue): string | undefined;
}
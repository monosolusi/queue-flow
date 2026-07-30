import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * The set of valid states for a store's queue state machine (PRD §4.1.A /
 * §7). Defaults to {WAITING, CALLING, SERVING, SKIPPED, COMPLETED}; the wizard
 * may add custom states (PREPARING, PAYMENT, ...).
 */
export class StateSchema extends ValueObject<readonly string[]> {
  private constructor(states: readonly string[]) {
    super(states as string[]);
  }

  public static of(states: string[]): StateSchema {
    if (!states.length) {
      throw new InvalidValueObjectException('state schema must define at least one state');
    }
    const seen = new Set<string>();
    for (const state of states) {
      if (!state || !state.trim()) {
        throw new InvalidValueObjectException('state names must be non-empty');
      }
      if (seen.has(state)) {
        throw new InvalidValueObjectException(`duplicate state '${state}'`);
      }
      seen.add(state);
    }
    return new StateSchema(states);
  }

  public static DEFAULT = StateSchema.of([
    'WAITING',
    'CALLING',
    'SERVING',
    'SKIPPED',
    'COMPLETED',
  ]);

  public get states(): readonly string[] {
    return this.value as readonly string[];
  }

  public includes(state: string): boolean {
    return this.states.includes(state);
  }
}
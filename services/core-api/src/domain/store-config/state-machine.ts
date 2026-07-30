import type { ITransitionPolicy } from '../queue/state-machine.port';
import type { StatusValue } from '../queue/value-objects/ticket-status';
import { InvalidValueObjectException } from '../shared/errors';
import { StateSchema } from './value-objects/state-schema';
import { StateTransitionRule } from './value-objects/state-transition-rule';

/**
 * The active, configurable state machine: a graph of {@link StateTransitionRule}
 * edges over a {@link StateSchema} node set. Implements the Queue context's
 * {@link ITransitionPolicy} port (DIP) so the QueueTicket aggregate can ask
 * "is this transition allowed?" without depending on Store Config internals
 * beyond this contract.
 */
export class StateMachine implements ITransitionPolicy {
  private readonly rulesByEdge: Map<string, StateTransitionRule>;

  constructor(
    private readonly schema: StateSchema,
    private readonly rules: readonly StateTransitionRule[],
  ) {
    if (!rules.length) {
      throw new InvalidValueObjectException('state machine must define at least one transition');
    }
    const map = new Map<string, StateTransitionRule>();
    for (const rule of rules) {
      if (!schema.includes(rule.from) || !schema.includes(rule.to)) {
        throw new InvalidValueObjectException(
          `transition '${rule.from}'->'${rule.to}' references states not in the schema`,
        );
      }
      const key = StateMachine.edgeKey(rule.from, rule.to);
      if (map.has(key)) {
        throw new InvalidValueObjectException(`duplicate transition '${rule.from}'->'${rule.to}'`);
      }
      map.set(key, rule);
    }
    this.rulesByEdge = map;
  }

  /** The default 4(+SKIPPED)-state machine from PRD §7. */
  public static DEFAULT = new StateMachine(
    StateSchema.DEFAULT,
    [
      ['WAITING', 'CALLING', 'Panggil Berikutnya'],
      ['CALLING', 'SERVING', 'Mulai Melayani'],
      ['CALLING', 'SKIPPED', 'Lewati / Absen'],
      ['SKIPPED', 'CALLING', 'Panggil Ulang'],
      ['SERVING', 'COMPLETED', 'Selesai Layan'],
    ].map(([from, to, actionLabel]) => StateTransitionRule.of(from, to, actionLabel)),
  );

  private static edgeKey(from: string, to: string): string {
    return `${from}->${to}`;
  }

  public isAllowed(from: StatusValue, to: StatusValue): boolean {
    return this.rulesByEdge.has(StateMachine.edgeKey(from, to));
  }

  public actionLabelFor(from: StatusValue, to: StatusValue): string | undefined {
    return this.rulesByEdge.get(StateMachine.edgeKey(from, to))?.actionLabel;
  }

  public get transitions(): readonly StateTransitionRule[] {
    return this.rules;
  }

  public get stateSchema(): StateSchema {
    return this.schema;
  }
}
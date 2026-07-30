import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

export interface StateTransitionRuleProps {
  readonly from: string;
  readonly to: string;
  readonly actionLabel: string;
}

/**
 * One edge in the state-machine graph plus the UI button label shown on the
 * caller panel for that transition (PRD §7). Labels are Indonesian and must be
 * matched verbatim by the caller UI.
 */
export class StateTransitionRule extends ValueObject<StateTransitionRuleProps> {
  private constructor(props: StateTransitionRuleProps) {
    super(props);
  }

  public static of(from: string, to: string, actionLabel: string): StateTransitionRule {
    if (!from || !from.trim()) {
      throw new InvalidValueObjectException('transition `from` must be non-empty');
    }
    if (!to || !to.trim()) {
      throw new InvalidValueObjectException('transition `to` must be non-empty');
    }
    if (!actionLabel || !actionLabel.trim()) {
      throw new InvalidValueObjectException('transition `actionLabel` must be non-empty');
    }
    return new StateTransitionRule({ from, to, actionLabel });
  }

  public get from(): string {
    return this.value.from;
  }

  public get to(): string {
    return this.value.to;
  }

  public get actionLabel(): string {
    return this.value.actionLabel;
  }
}
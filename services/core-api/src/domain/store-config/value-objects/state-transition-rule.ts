import { InvalidValueObjectException } from '../../shared/errors';
import {
  isTransitionAction,
  TransitionAction,
  type TransitionActionValue,
} from '../../shared/transition-action';
import { ValueObject } from '../../shared/value-object';

export interface StateTransitionRuleProps {
  readonly from: string;
  readonly to: string;
  readonly actionLabel: string;
  readonly action: TransitionActionValue;
}

/**
 * One edge in the state-machine graph: its endpoints, the UI button label shown
 * on the caller panel for it (PRD §7), and the {@link TransitionAction} the
 * manager declared for it. Labels are Indonesian and must be matched verbatim by
 * the caller UI.
 *
 * `action` defaults to `UPDATE_STATUS`, which is both the overwhelmingly common
 * case and what every edge configured before this field existed means — stored
 * configurations carry no `action` key and reconstitute through this default
 * (the field lives inside the `state_machine` JSONB document, so there is no
 * migration to run).
 */
export class StateTransitionRule extends ValueObject<StateTransitionRuleProps> {
  private constructor(props: StateTransitionRuleProps) {
    super(props);
  }

  public static of(
    from: string,
    to: string,
    actionLabel: string,
    action: TransitionActionValue = TransitionAction.UPDATE_STATUS,
  ): StateTransitionRule {
    if (!from || !from.trim()) {
      throw new InvalidValueObjectException('transition `from` must be non-empty');
    }
    if (!to || !to.trim()) {
      throw new InvalidValueObjectException('transition `to` must be non-empty');
    }
    if (!actionLabel || !actionLabel.trim()) {
      throw new InvalidValueObjectException('transition `actionLabel` must be non-empty');
    }
    if (!isTransitionAction(action)) {
      throw new InvalidValueObjectException(
        `transition \`action\` must be one of ${Object.keys(TransitionAction).join(', ')}`,
      );
    }
    return new StateTransitionRule({ from, to, actionLabel, action });
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

  /** What running this edge does — declared by the manager, never inferred from
   *  {@link to}. */
  public get action(): TransitionActionValue {
    return this.value.action;
  }
}

import { InvalidValueObjectException } from '../../shared/errors';
import {
  type RequeuePolicy,
  DEFAULT_REQUEUE_POLICY,
} from '../../shared/requeue-policy';
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
  readonly requeuePolicy: RequeuePolicy;
}

/**
 * One edge in the state-machine graph: its endpoints, the UI button label shown
 * on the caller panel for it (PRD §7), the {@link TransitionAction} the manager
 * declared for it, and the {@link RequeuePolicy} a `-> WAITING` edge applies to
 * the WAITING queue's order. Labels are Indonesian and must be matched verbatim
 * by the caller UI.
 *
 * `action` defaults to `UPDATE_STATUS`, which is both the overwhelmingly common
 * case and what every edge configured before this field existed means — stored
 * configurations carry no `action` key and reconstitute through this default
 * (the field lives inside the `state_machine` JSONB document, so there is no
 * migration to run).
 *
 * `requeuePolicy` defaults to {@link DEFAULT_REQUEUE_POLICY} (KEEP) for the
 * same reason: stored configurations carry no `requeuePolicy` key and
 * reconstitute through this default, so a re-queue keeps the ticket in its
 * current FIFO slot exactly as before. Like `action`, the field lives inside
 * the `state_machine` JSONB document — no SQL migration. The default is the
 * last optional arg so `StateMachine.DEFAULT` (which calls `.of(from, to,
 * label)`) compiles unchanged and means KEEP.
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
    requeuePolicy: RequeuePolicy = DEFAULT_REQUEUE_POLICY,
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
    return new StateTransitionRule({ from, to, actionLabel, action, requeuePolicy });
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

  /** What an `-> WAITING` edge does to the WAITING queue's order — declared by
   *  the manager, never inferred from {@link to}. KEEP on every edge that
   *  predates the field (backward-compat). */
  public get requeuePolicy(): RequeuePolicy {
    return this.value.requeuePolicy;
  }
}

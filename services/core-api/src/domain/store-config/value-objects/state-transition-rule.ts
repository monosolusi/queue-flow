import { InvalidValueObjectException } from '../../shared/errors';
import {
  type RequeuePolicy,
  DEFAULT_REQUEUE_POLICY,
} from '../../shared/requeue-policy';
import { ValueObject } from '../../shared/value-object';

export interface StateTransitionRuleProps {
  readonly from: string;
  readonly to: string;
  readonly actionLabel: string;
  readonly requeuePolicy: RequeuePolicy;
}

/**
 * One edge in the state-machine graph: its endpoints, the UI button label shown
 * on the caller panel for it (PRD §7), and the {@link RequeuePolicy} a
 * `-> WAITING` edge applies to the WAITING queue's order. Labels are Indonesian
 * and must be matched verbatim by the caller UI.
 *
 * An edge is purely `from -> to + actionLabel`: what running it does is owned by
 * the target state (a ticket entering CALLING is announced; one returning to
 * WAITING leaves its counter), and the one operation that needs a runtime
 * argument no flow can supply — "pindah kategori" (FR-CLR-03) — is a standalone
 * counter action, not a per-edge declaration. So there is nothing left for the
 * manager to declare per edge beyond its endpoints, its label, and (for a
 * re-queue) where the ticket lands in the queue.
 *
 * `requeuePolicy` defaults to {@link DEFAULT_REQUEUE_POLICY} (KEEP): stored
 * configurations carry no `requeuePolicy` key and reconstitute through this
 * default, so a re-queue keeps the ticket in its current FIFO slot exactly as
 * before. The field lives inside the `state_machine` JSONB document — no SQL
 * migration. The default is the last optional arg so `StateMachine.DEFAULT`
 * (which calls `.of(from, to, label)`) compiles unchanged and means KEEP.
 */
export class StateTransitionRule extends ValueObject<StateTransitionRuleProps> {
  private constructor(props: StateTransitionRuleProps) {
    super(props);
  }

  public static of(
    from: string,
    to: string,
    actionLabel: string,
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
    return new StateTransitionRule({ from, to, actionLabel, requeuePolicy });
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

  /** What an `-> WAITING` edge does to the WAITING queue's order — declared by
   *  the manager, never inferred from {@link to}. KEEP on every edge that
   *  predates the field (backward-compat). */
  public get requeuePolicy(): RequeuePolicy {
    return this.value.requeuePolicy;
  }
}
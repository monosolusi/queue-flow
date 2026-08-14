import type {
  IQueueRepository,
  ITransitionPolicyResolver,
  StatusValue,
  TicketId,
} from '../../domain/queue';
import { TicketStatus } from '../../domain/queue';
import {
  EntityNotFoundException,
  ITransactionManager,
  NoOpTransactionManager,
} from '../../domain/shared';
import { assertRunnableAsStatusChange, declaredRequeuePolicyFor } from './declared-transition-action';
import { QueueEventDispatcher } from './queue-event-dispatcher';
import {
  computeRepositionPlan,
  type RepositionPlan,
} from './requeue-position.helper';
import { TicketStateDto, projectTicketState } from './ticket-state.dto';

/**
 * Command for running one configured transition of the active flow — the single
 * per-ticket state-change command (FR-CLR-02).
 */
export interface ApplyTransitionCommand {
  readonly ticketId: TicketId;
  /** The target status, canonical or custom (PREPARING, PAYMENT, …). The active
   *  {@link ITransitionPolicy} decides whether the edge is allowed. */
  readonly targetStatus: StatusValue;
  /**
   * The counter running the command — the caller panel's bound counter. Needed
   * only for a transition **into CALLING**, which has to announce the ticket
   * somewhere; the aggregate falls back to the counter the ticket already holds
   * (how a skipped ticket returns to the counter that called it) and rejects the
   * transition when neither is available. Every other target ignores it.
   */
  readonly counterId?: number | null;
}

/** Outcome of a transition: the ticket moved to `targetStatus`. */
export type ApplyTransitionResult = {
  readonly status: 'transitioned';
  readonly ticket: TicketStateDto;
};

/**
 * Runs one configured transition — `current -> targetStatus` — validated against
 * the active {@link ITransitionPolicy} (resolved per execution, the same resolver
 * every queue action uses, QUE-10 AC#3).
 *
 * This is **the** per-ticket state-change command. It accepts any target in the
 * active schema, canonical or custom, and the aggregate applies whatever side
 * effects that target state carries (announcement, service clock, re-queue).
 * There is deliberately no serve/complete/skip/recall command beside it: a
 * per-target command surface forces something upstream to decide which command a
 * given `(from, to)` pair needs, and that decision is precisely what cannot be
 * derived — it was the table that read every `X -> WAITING` edge as a category
 * move and handed a manager who drew `CALLING -> WAITING` a "Pindah Kategori"
 * button for a step they never configured.
 *
 * The one edge this command refuses is a `TRANSFER_CATEGORY` one, which needs a
 * destination category (see {@link assertRunnableAsStatusChange}). Illegal
 * transitions surface as {@link InvalidStateTransitionException} from the
 * aggregate (→ 409); a mis-routed one as `InvalidArgumentException` (→ 400).
 *
 * ## Re-queue position policy (→ WAITING)
 *
 * When `targetStatus === WAITING`, the edge's {@link RequeuePolicy} (resolved
 * from the active flow, never client-supplied — the REST command is unchanged)
 * decides what the re-queue does to the WAITING queue's order:
 * - `KEEP` — leave `waiting_order` unchanged (backward-compat).
 * - `TO_BACK` — re-stamp to `clock()`.
 * - `BACK_N(n)` — exact-rank insertion within the ticket's category (midpoint, or
 *   a category-renumber fallback on collision). Siblings' `waiting_order` is
 *   written via {@link IQueueRepository.assignWaitingOrders}.
 *
 * The re-queue + any sibling renumber run inside one
 * {@link ITransactionManager.runInTransaction} so a durable implementation
 * commits them atomically (NFR-REL-02 — a power cut between the re-queued
 * ticket's save and a sibling renumber must not leave two tickets at the same
 * rank or a half-renumbered category). The realtime broadcast is drained
 * **after** the tx commits so a rolled-back reposition is never announced —
 * mirrors `TransferTicketUseCase`. `txManager` defaults to a no-op so unit
 * specs that construct the use case directly stay unbroken.
 *
 * Depends only on ports (DIP): the active `StateMachine` is supplied by the
 * interface-adapter layer, not loaded here. Not audited — routine queue
 * transitions are out of the NFR-SEC-02 audit scope (manual reset / config /
 * cleanup only).
 */
export class ApplyTransitionUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly policyResolver: ITransitionPolicyResolver,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
  ) {}

  public async execute(command: ApplyTransitionCommand): Promise<ApplyTransitionResult> {
    const transitionPolicy = await this.policyResolver.getActivePolicy();

    // A -> WAITING re-queue resolves the edge's RequeuePolicy and may write
    // siblings' waiting_order, so it needs the tx + a consistent snapshot of
    // the ticket + its category-mates inside the tx. Other targets behave as
    // before (no requeue policy); they are wrapped in the same tx for uniformity
    // — a no-op tx manager makes that free, and a durable one keeps the snapshot
    // consistent with the write.
    const isRequeue = command.targetStatus === TicketStatus.WAITING;

    const ticket = await this.txManager.runInTransaction(async () => {
      const loaded = await this.queue.findById(command.ticketId);
      if (!loaded) {
        throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
      }
      assertRunnableAsStatusChange(
        transitionPolicy.describeGraph(),
        loaded.currentStatus,
        command.targetStatus,
      );

      let plan: RepositionPlan | null = null;
      let waitingOrder: number | null = null;
      if (isRequeue) {
        const policy = declaredRequeuePolicyFor(
          transitionPolicy.describeGraph(),
          loaded.currentStatus,
          TicketStatus.WAITING,
        );
        if (policy.kind === 'KEEP') {
          waitingOrder = loaded.waitingOrder;
        } else if (policy.kind === 'TO_BACK') {
          waitingOrder = this.clock();
        } else {
          // BACK_N: compute a category-rank insertion plan. Load the category's
          // waiting tickets (excluding the re-queued ticket) on the ambient tx
          // client so the snapshot is consistent with the write (NFR-REL-02).
          const categoryWaiting = (await this.queue.findWaitingByCategory(loaded.categoryId))
            .filter((t) => t.id.value !== loaded.id.value);
          plan = computeRepositionPlan(
            policy,
            { id: loaded.id.value, categoryId: loaded.categoryId, waitingOrder: loaded.waitingOrder },
            categoryWaiting.map((t) => ({
              id: t.id.value,
              categoryId: t.categoryId,
              waitingOrder: t.waitingOrder,
            })),
            this.clock(),
          );
          waitingOrder =
            plan.kind === 'renumber' ? plan.repositionedWaitingOrder : plan.waitingOrder;
        }
      }

      loaded.applyTransition(
        command.targetStatus,
        transitionPolicy,
        this.clock(),
        command.counterId ?? null,
        waitingOrder,
      );
      await this.queue.save(loaded);
      // BACK_N renumber fallback: write the siblings' waiting_order on the same
      // ambient tx (NFR-REL-02 — atomic with the re-queued ticket's save). No
      // events, no aggregate load — the repo writes only the ordering key.
      if (plan?.kind === 'renumber') {
        await this.queue.assignWaitingOrders(plan.siblingAssignments);
      }
      return loaded;
    });

    // Drain the recorded events (STATUS_UPDATED, plus TICKET_CALLED when the
    // ticket landed in CALLING) so they broadcast (FR-ENG-04). Post-commit by
    // design — a rolled-back reposition (the tx above would have thrown) never
    // reaches here, so a rolled-back re-queue is never announced (NFR-REL-02),
    // mirroring the transfer command.
    await this.dispatcher.dispatch(ticket);
    return { status: 'transitioned', ticket: projectTicketState(ticket) };
  }
}
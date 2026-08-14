import { AggregateRoot } from '../shared/aggregate-root';
import { Identifier } from '../shared/identifier';
import { InvalidArgumentException, InvalidStateTransitionException } from '../shared/errors';
import type { ITransitionPolicy } from './state-machine.port';
import { TicketNumber } from './value-objects/ticket-number';
import { TicketStatus, type StatusValue } from './value-objects/ticket-status';
import type { TicketId } from './value-objects/ticket-id';
import { TicketCreatedEvent } from './events/ticket-created.event';
import { TicketCalledEvent } from './events/ticket-called.event';
import { TicketStatusChangedEvent } from './events/ticket-status-changed.event';
import { TicketTransferredEvent } from './events/ticket-transferred.event';

/**
 * Aggregate root for a single queue ticket. All status mutations flow through
 * here and are validated against the active, configurable state machine
 * ({@link ITransitionPolicy}) before any state changes — FR-ENG-02. Every
 * successful transition records the corresponding domain event so the
 * infrastructure layer can broadcast it (FR-ENG-04).
 *
 * The aggregate knows nothing about how transitions are configured, how events
 * are published, or where tickets are persisted. Those are decided by the use
 * case and infrastructure layers.
 */
export class QueueTicket extends AggregateRoot<TicketId> {
  private _ticketNumber: TicketNumber;
  private _categoryId: string;
  private _currentStatus: StatusValue;
  private _counterId: number | null;
  private _createdAt: number;
  private _updatedAt: number;
  // The WAITING queue's ordering key. Replaces `createdAt` as the sort key for
  // every waiting read + `findNextWaiting` (the SQL index is `waiting_order ASC,
  // created_at ASC`); `createdAt` keeps its existing role (analytics, archive,
  // receipt position) and is never reset. `= createdAt` on `create` preserves
  // the exact current FIFO on the new key (first deploy backfills
  // `waiting_order = created_at`). A re-queue may re-stamp it (KEEP leaves it,
  // TO_BACK re-stamps to `now`, BACK_N inserts at a category-rank midpoint or
  // re-packs the category) — see `returnToQueue`.
  private _waitingOrder: number;
  // Lifecycle timestamps (QUE-26). The wait-time metric (WAITING → CALLING)
  // is `calledAt - createdAt`; the service-time metric (SERVING → COMPLETED) is
  // `completedAt - servedAt`. `null` until the transition fires, and the
  // analytics query FILTERs NULLs out. They are part of the ticket's lifecycle
  // state — set by the same transition methods that own status — not a
  // reporting concern bolted on after the fact.
  private _calledAt: number | null;
  private _servedAt: number | null;
  private _completedAt: number | null;

  private constructor(
    id: TicketId,
    ticketNumber: TicketNumber,
    categoryId: string,
    status: StatusValue,
    counterId: number | null,
    createdAt: number,
    updatedAt: number,
    waitingOrder: number,
    calledAt: number | null,
    servedAt: number | null,
    completedAt: number | null,
  ) {
    super(id);
    this._ticketNumber = ticketNumber;
    this._categoryId = categoryId;
    this._currentStatus = status;
    this._counterId = counterId;
    this._createdAt = createdAt;
    this._updatedAt = updatedAt;
    this._waitingOrder = waitingOrder;
    this._calledAt = calledAt;
    this._servedAt = servedAt;
    this._completedAt = completedAt;
  }

  /**
   * Factory for a brand-new ticket taken at the kiosk. Starts in WAITING and
   * records a {@link TicketCreatedEvent}. `waitingOrder` is initialized to
   * `now` (= `createdAt`) so the new key preserves the exact current FIFO on
   * first deploy (`waiting_order = created_at` backfill in migration 0017).
   */
  public static create(
    id: TicketId,
    ticketNumber: TicketNumber,
    categoryId: string,
    now = Date.now(),
  ): QueueTicket {
    const ticket = new QueueTicket(
      id,
      ticketNumber,
      categoryId,
      TicketStatus.WAITING,
      null,
      now,
      now,
      now,
      null,
      null,
      null,
    );
    ticket.record(
      new TicketCreatedEvent(id.value, ticketNumber.formatted(), categoryId, now),
    );
    return ticket;
  }

  /**
   * Reconstitutes an aggregate from persisted state without emitting events.
   * Used by repository implementations when loading a ticket.
   */
  public static reconstitute(params: {
    id: TicketId;
    ticketNumber: TicketNumber;
    categoryId: string;
    status: StatusValue;
    counterId: number | null;
    createdAt: number;
    updatedAt: number;
    waitingOrder: number;
    calledAt: number | null;
    servedAt: number | null;
    completedAt: number | null;
  }): QueueTicket {
    return new QueueTicket(
      params.id,
      params.ticketNumber,
      params.categoryId,
      params.status,
      params.counterId,
      params.createdAt,
      params.updatedAt,
      params.waitingOrder,
      params.calledAt,
      params.servedAt,
      params.completedAt,
    );
  }

  public get ticketNumber(): TicketNumber {
    return this._ticketNumber;
  }

  public get categoryId(): string {
    return this._categoryId;
  }

  public get currentStatus(): StatusValue {
    return this._currentStatus;
  }

  public get counterId(): number | null {
    return this._counterId;
  }

  public get createdAt(): number {
    return this._createdAt;
  }

  public get updatedAt(): number {
    return this._updatedAt;
  }

  /** The WAITING queue's ordering key. Replaces `createdAt` as the sort key for
   *  every waiting read; `createdAt` keeps its analytics role and is never
   *  reset. Re-stamped by `returnToQueue` per the edge's `RequeuePolicy`. */
  public get waitingOrder(): number {
    return this._waitingOrder;
  }

  /** Epoch-ms the ticket was first called to a counter, or `null` if never called. */
  public get calledAt(): number | null {
    return this._calledAt;
  }

  /** Epoch-ms service started (CALLING → SERVING), or `null` if not yet served. */
  public get servedAt(): number | null {
    return this._servedAt;
  }

  /** Epoch-ms service completed (SERVING → COMPLETED), or `null` if not done. */
  public get completedAt(): number | null {
    return this._completedAt;
  }

  /**
   * Call this ticket to a counter as the counter's *next* ticket — the
   * counter-level "Panggil Berikutnya" path (`CallNextTicketUseCase`).
   * Idempotent: a ticket already in CALLING is left untouched (no counter
   * reassignment, no event), because call-next **picks** a ticket rather than
   * acting on a chosen one, and re-picking the same one must not re-announce it.
   * A deliberate re-announcement is {@link reannounce} — or, when the manager
   * draws a `CALLING -> CALLING` edge, {@link applyTransition}.
   */
  public markCalling(counterId: number, policy: ITransitionPolicy, now = Date.now()): void {
    if (this._currentStatus === TicketStatus.CALLING) {
      return; // already calling — no-op, preserves least-surprise
    }
    this.callToCounter(counterId, policy, now);
  }

  /**
   * Repeat the announcement for the currently-calling ticket — "Panggil Lagi".
   * **Not a transition:** the ticket is already in CALLING and stays there; the
   * customer simply did not hear it. Re-emits a {@link TicketCalledEvent} (so the
   * TV board re-shows the ticket and the audio queue re-announces it,
   * FR-TV-01/02) and re-sets `calledAt` to the re-announce time (a fresh call
   * attempt). No {@link ITransitionPolicy} is consulted, because there is no edge
   * to validate — which is why this stays its own operation rather than folding
   * into {@link applyTransition}: it must remain available on a flow that draws no
   * `CALLING -> CALLING` edge. When the manager *does* draw that edge, running it
   * lands here too (via {@link applyTransition}), so there is one implementation
   * either way.
   *
   * Only valid from CALLING; any other status surfaces as an
   * {@link InvalidStateTransitionException} (→ 409) for a consistent error
   * contract with the transition command.
   *
   * The defensive `_counterId !== null` guard covers a degenerate flow that
   * reached CALLING without a counter (every normal route sets one): the
   * calledAt reset still proceeds — it *is* a call attempt — but nothing is
   * announced, because there is no counter to announce at.
   */
  public reannounce(now = Date.now()): void {
    if (this._currentStatus !== TicketStatus.CALLING) {
      throw new InvalidStateTransitionException(this._currentStatus, TicketStatus.CALLING);
    }
    // A re-announce is a fresh call attempt — reset the called-at timestamp so
    // the wait-time metric reflects the time from creation to the *latest*
    // announcement, not the original (now-stale) one. Mirrors `callToCounter`.
    this._calledAt = now;
    this._updatedAt = now;
    if (this._counterId !== null) {
      this.record(
        new TicketCalledEvent(this.id.value, this._ticketNumber.formatted(), this._counterId, now),
      );
    }
  }

  /**
   * Run one configured transition of the active flow — **the** single entry
   * point for every per-ticket status change the counter panel can make
   * (FR-CLR-02). The flow says which state comes next; this applies it, together
   * with whatever side effects that state carries.
   *
   * There is deliberately no per-target command surface above this. A ticket
   * entering CALLING is announced to a counter, one entering SERVING starts its
   * service clock, one returning to WAITING gives up its counter — those are
   * properties of the **target state**, so the aggregate owns them, and every
   * route into that state gets them. The alternative (a distinct endpoint per
   * canonical state, and a table upstream guessing which one a `(from, to)` pair
   * needs) made the API infer meaning the manager never expressed: `CALLING ->
   * WAITING` was read as a category move, so a flow drawn to put a ticket back
   * in the queue produced a "Pindah Kategori" button demanding a destination
   * category. A category move is a genuinely different operation — it takes an
   * argument no flow can supply — and lives in {@link transferTo}, reached only
   * by an edge the manager declared `TRANSFER_CATEGORY`.
   *
   * `counterId` is required in practice only for `-> CALLING`, where the ticket
   * must end up announced at a known counter; it falls back to the counter the
   * ticket is already assigned to (how a skipped ticket is re-called to the same
   * counter). Every other target ignores it.
   *
   * Idempotent for targets with no side effect of their own: `transitionTo`
   * short-circuits when `target` already equals the current status, and the
   * side-effect appliers below are gated on the status having actually changed.
   * The two self-loops that *do* something — `CALLING -> CALLING`
   * (re-announce) and a `TRANSFER_CATEGORY` edge — bypass that gate by design.
   */
  public applyTransition(
    target: StatusValue,
    policy: ITransitionPolicy,
    now = Date.now(),
    counterId: number | null = null,
    waitingOrder: number | null = null,
  ): void {
    switch (target) {
      case TicketStatus.CALLING:
        this.callToCounter(counterId, policy, now);
        return;
      case TicketStatus.WAITING:
        this.returnToQueue(policy, now, waitingOrder);
        return;
      case TicketStatus.SERVING:
        this.startServing(policy, now);
        return;
      case TicketStatus.COMPLETED:
        this.complete(policy, now);
        return;
      case TicketStatus.SKIPPED:
        this.skip(policy, now);
        return;
      default:
        // A custom state the manager added (PREPARING, PAYMENT, …). It has no
        // canonical lifecycle meaning, so a plain status change is the whole of
        // it — no timestamp, no counter, no re-issued number.
        this.transitionTo(target, policy, now);
    }
  }

  /**
   * Announce this ticket at `counterId` — every route into CALLING, whichever
   * status it comes from: the counter's next pick ({@link markCalling}), a
   * skipped customer who came back (`SKIPPED -> CALLING`, "Panggil Ulang"), or a
   * ticket pulled back from a later step. The counter assignment, the fresh
   * `calledAt` and the {@link TicketCalledEvent} that drives the TV board + audio
   * (FR-TV-01/02) belong to *arriving in CALLING*, so they happen here rather
   * than in each route's caller.
   *
   * `calledAt` is reset on every call attempt so the wait-time metric measures
   * creation (or re-queue) to the **latest** announcement, not a stale earlier
   * one. A `CALLING -> CALLING` edge is a re-announcement: the status does not
   * change, but the announcement is the point, so it still fires — the policy
   * must allow the self-loop, which is exactly what drawing that edge means.
   */
  private callToCounter(counterId: number | null, policy: ITransitionPolicy, now: number): void {
    const from = this._currentStatus;
    // The edge is checked BEFORE the counter is resolved, so a flow that draws no
    // way into CALLING reports the missing edge (409) rather than a missing
    // argument (400). Same ordering rule the transfer command follows: describe
    // what is actually wrong with the request, most fundamental first.
    if (!policy.isAllowed(from, TicketStatus.CALLING)) {
      throw new InvalidStateTransitionException(from, TicketStatus.CALLING);
    }
    const resolved = this.counterToCallTo(counterId);
    if (from === TicketStatus.CALLING) {
      this._counterId = resolved;
      this.reannounce(now);
      return;
    }
    this.transitionTo(TicketStatus.CALLING, policy, now);
    this._counterId = resolved;
    this._calledAt = now;
    this.record(
      new TicketCalledEvent(this.id.value, this._ticketNumber.formatted(), resolved, now),
    );
  }

  /**
   * Which counter a `-> CALLING` transition announces at: the one supplied by
   * the request (the panel's bound counter), falling back to the counter the
   * ticket is already assigned to — how a skipped ticket returns to the same
   * counter that called it. A ticket that has never been called and arrives with
   * no counter cannot be announced anywhere; that is a missing argument, not an
   * illegal transition, so it surfaces as a 400 rather than a 409.
   */
  private counterToCallTo(counterId: number | null): number {
    const resolved = counterId ?? this._counterId;
    if (resolved === null) {
      throw new InvalidArgumentException(
        'a transition into CALLING needs a counter to announce the ticket at',
      );
    }
    return resolved;
  }

  /**
   * Put this ticket back in the queue — any `-> WAITING` transition. The counter
   * assignment goes (the ticket is nobody's now) and the lifecycle timestamps
   * clear, because a re-queued ticket's wait starts over: leaving `calledAt` set
   * would report a wait that already ended, and leaving `servedAt` set would
   * pair a fresh completion with an abandoned service (QUE-26).
   *
   * `waitingOrder` re-stamps the WAITING queue's ordering key per the edge's
   * `RequeuePolicy` (resolved by the use case, which reads it from the active
   * flow — never client-supplied). The aggregate owns its own `waitingOrder`
   * (mirrors the `counterId` "use-case-supplies, aggregate-applies" pattern):
   * `null` ⇒ keep the current value (the KEEP default — a re-queue leaves the
   * ticket in its current FIFO slot exactly as before; backward-compat); a
   * number ⇒ re-stamp to it (TO_BACK re-stamps to `now`; BACK_N re-stamps to a
   * category-rank midpoint, computed by the use case). Siblings' `waiting_order`
   * (the BACK_N renumber fallback) is a persistence-layer ordering key written
   * via a dedicated repo port method — not here, and no new mutable setter.
   *
   * `_createdAt` is NOT re-stamped — it is the wait-time metric origin and the
   * analytics/archive/receipt position; resetting it would corrupt FR-ADM-03
   * reporting. The new ordering key takes the re-stamp instead.
   *
   * This is the transition the manager draws as "Kembalikan ke Antrian" and the
   * one that used to be executed as a category move.
   */
  private returnToQueue(
    policy: ITransitionPolicy,
    now: number,
    waitingOrder: number | null = null,
  ): void {
    if (!this.transitionTo(TicketStatus.WAITING, policy, now)) {
      return;
    }
    this._counterId = null;
    this._calledAt = null;
    this._servedAt = null;
    this._completedAt = null;
    // null ⇒ keep the current waitingOrder (the KEEP default — backward-compat).
    // The aggregate owns its own ordering key; the use case supplies the value
    // the active flow's edge policy resolves to (mirrors counterId).
    this._waitingOrder = waitingOrder ?? this._waitingOrder;
  }

  /** Begin serving. `-> SERVING` ("Mulai Melayani") — starts the service clock. */
  private startServing(policy: ITransitionPolicy, now: number): void {
    if (this.transitionTo(TicketStatus.SERVING, policy, now)) {
      this._servedAt = now;
    }
  }

  /** Mark service complete. `-> COMPLETED` ("Selesai Layan") — stops the clock. */
  private complete(policy: ITransitionPolicy, now: number): void {
    if (this.transitionTo(TicketStatus.COMPLETED, policy, now)) {
      this._completedAt = now;
    }
  }

  /** Skip / mark absent. `-> SKIPPED` ("Lewati / Absen"). Keeps the counter
   *  assignment so the ticket stays in that counter's skipped bucket and can be
   *  re-called to the same counter. */
  private skip(policy: ITransitionPolicy, now: number): void {
    this.transitionTo(TicketStatus.SKIPPED, policy, now);
  }

  /**
   * Transfer this ticket to a different category — "pindah kategori"
   * (FR-CLR-03). A first-class **configurable** transition: the status leg
   * (current -> WAITING) is validated against the active
   * {@link ITransitionPolicy} exactly like any other transition, so an active
   * state machine without the edge rejects the transfer with
   * {@link InvalidStateTransitionException}.
   *
   * The manager enables transfer by drawing the edge **and declaring its action
   * `TRANSFER_CATEGORY`** — the flow's own statement that this button moves a
   * ticket between categories. Nothing about the edge's endpoints implies it:
   * `CALLING -> WAITING` is a plain re-queue unless the manager says otherwise.
   * The application layer enforces that pairing (this aggregate is handed the
   * destination category it was asked for; it does not re-read the
   * configuration).
   *
   * On success the category is reassigned, a new per-category
   * {@link TicketNumber} is applied, and the counter is cleared — the ticket
   * re-enters the queue under the new category. Records a
   * {@link TicketStatusChangedEvent} (the status leg) and a
   * {@link TicketTransferredEvent} (the category/number reassignment) so
   * downstream can sync on the re-issued number.
   *
   * **The ticket always lands in WAITING**, and that is not a default — it is what
   * a re-issued per-category number means. A fresh `B-001` is a ticket nobody has
   * served, so the states that describe being served cannot describe it: landing
   * in SERVING would leave `servedAt` null (breaking the QUE-26 service-time row)
   * and, with the counter cleared, drop the ticket out of every counter panel with
   * no way back. Where a *plain* transition lands is the manager's choice; where a
   * category move lands follows from what it does. The application layer rejects a
   * `TRANSFER_CATEGORY` edge that targets anything else, so such a flow is refused
   * at save time rather than half-executed here.
   *
   * Note: unlike {@link transitionTo}, this method intentionally does **not**
   * short-circuit when the ticket is already WAITING. A transfer is a category
   * move regardless of whether the status also changes, so the
   * {@link TicketStatusChangedEvent} may carry `from === to` when a manager
   * configures the `WAITING -> WAITING` self-edge. Both events converge on the
   * caller's waiting list: the `STATUS_UPDATED` re-queues the ticket under its old
   * identity and the `TICKET_TRANSFERRED` replaces that entry with the new one.
   * The use-case layer additionally rejects a transfer to the ticket's *own*
   * category, so a no-op category move never reaches here.
   */
  public transferTo(
    newCategoryId: string,
    newTicketNumber: TicketNumber,
    policy: ITransitionPolicy,
    now = Date.now(),
  ): void {
    const from = this._currentStatus;
    if (!policy.isAllowed(from, TicketStatus.WAITING)) {
      throw new InvalidStateTransitionException(from, TicketStatus.WAITING);
    }
    const oldCategoryId = this._categoryId;
    const oldTicketNumber = this._ticketNumber;
    this._currentStatus = TicketStatus.WAITING;
    this._categoryId = newCategoryId;
    this._ticketNumber = newTicketNumber;
    this._counterId = null;
    // Transfer re-enters the queue as a fresh ticket under the new category
    // (new number, WAITING). The prior lifecycle timestamps no longer describe
    // this ticket — clear them so wait/service-time metrics start over.
    this._calledAt = null;
    this._servedAt = null;
    this._completedAt = null;
    // Intentionally leave `_waitingOrder` alone (out of scope for the re-queue
    // position policy — a `TRANSFER_CATEGORY` edge's policy is KEEP by rule, and
    // the manager cannot declare otherwise). Mirrors the kept-`createdAt` quirk:
    // a transferred ticket keeps its original ordering slot. This may be
    // revisited when transfer joins the policy scope; for now it preserves
    // the existing behavior.
    this._updatedAt = now;
    this.record(
      new TicketStatusChangedEvent(
        this.id.value,
        from,
        TicketStatus.WAITING,
        policy.actionLabelFor(from, TicketStatus.WAITING),
        now,
      ),
    );
    this.record(
      new TicketTransferredEvent(
        this.id.value,
        oldCategoryId,
        newCategoryId,
        oldTicketNumber.formatted(),
        newTicketNumber.formatted(),
        now,
      ),
    );
  }

  /**
   * The status change itself, validated against the active policy.
   *
   * Returns whether the status actually moved. Callers use that to gate the
   * target state's side effects: a short-circuited self-transition records no
   * event and changes nothing, so stamping `servedAt` (or clearing `calledAt`)
   * on top of it would rewrite the ticket's history from a request that, as far
   * as everything else is concerned, did nothing.
   */
  private transitionTo(target: StatusValue, policy: ITransitionPolicy, now: number): boolean {
    const from = this._currentStatus;
    if (from === target) {
      return false; // idempotent — no event, no state change
    }
    if (!policy.isAllowed(from, target)) {
      throw new InvalidStateTransitionException(from, target);
    }
    this._currentStatus = target;
    this._updatedAt = now;
    this.record(
      new TicketStatusChangedEvent(
        this.id.value,
        from,
        target,
        policy.actionLabelFor(from, target),
        now,
      ),
    );
    return true;
  }
}
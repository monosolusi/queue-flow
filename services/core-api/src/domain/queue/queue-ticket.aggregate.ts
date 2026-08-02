import { AggregateRoot } from '../shared/aggregate-root';
import { Identifier } from '../shared/identifier';
import { InvalidStateTransitionException } from '../shared/errors';
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
    this._calledAt = calledAt;
    this._servedAt = servedAt;
    this._completedAt = completedAt;
  }

  /**
   * Factory for a brand-new ticket taken at the kiosk. Starts in WAITING and
   * records a {@link TicketCreatedEvent}.
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
   * Call this ticket to a counter. WAITING -> CALLING ("Panggil Berikutnya").
   * Idempotent: calling a ticket that is already in CALLING is a no-op (no
   * counter reassignment, no event) — use {@link recall} to re-announce a
   * SKIPPED ticket.
   */
  public markCalling(counterId: number, policy: ITransitionPolicy, now = Date.now()): void {
    if (this._currentStatus === TicketStatus.CALLING) {
      return; // already calling — no-op, preserves least-surprise
    }
    this.transitionTo(TicketStatus.CALLING, policy, now);
    this._counterId = counterId;
    this._calledAt = now;
    this.record(
      new TicketCalledEvent(this.id.value, this._ticketNumber.formatted(), counterId, now),
    );
  }

  /**
   * Re-call a skipped ticket. SKIPPED -> CALLING ("Panggil Ulang"). Only valid
   * from SKIPPED — the aggregate owns this precondition so the policy alone
   * cannot leave a CALLING ticket without a counter.
   */
  public recall(policy: ITransitionPolicy, now = Date.now()): void {
    if (this._currentStatus !== TicketStatus.SKIPPED) {
      throw new InvalidStateTransitionException(this._currentStatus, TicketStatus.CALLING);
    }
    this.transitionTo(TicketStatus.CALLING, policy, now);
    // A re-call is a fresh call attempt — reset the called-at timestamp so the
    // wait-time metric reflects the time from creation (or re-queue) to the
    // *latest* call, not the original (now-stale) one.
    this._calledAt = now;
  }

  /** Begin serving. CALLING -> SERVING ("Mulai Melayani"). */
  public startServing(policy: ITransitionPolicy, now = Date.now()): void {
    this.transitionTo(TicketStatus.SERVING, policy, now);
    this._servedAt = now;
  }

  /** Mark service complete. SERVING -> COMPLETED ("Selesai Layan"). */
  public complete(policy: ITransitionPolicy, now = Date.now()): void {
    this.transitionTo(TicketStatus.COMPLETED, policy, now);
    this._completedAt = now;
  }

  /** Skip / mark absent. CALLING -> SKIPPED ("Lewati / Absen"). */
  public skip(policy: ITransitionPolicy, now = Date.now()): void {
    this.transitionTo(TicketStatus.SKIPPED, policy, now);
  }

  /**
   * Transfer this ticket to a different category — "pindah kategori"
   * (FR-CLR-03). A first-class **configurable** transition: the status leg
   * (current -> `targetStatus`, default `WAITING`) is validated against the
   * active {@link ITransitionPolicy} exactly like any other transition, so an
   * active state machine without the edge (e.g. the PRD §7 default has no
   * `CALLING -> WAITING`) rejects the transfer with
   * {@link InvalidStateTransitionException}. The wizard/admin enables transfer
   * by adding the edge (e.g. `CALLING -> WAITING` labelled "Pindah Kategori").
   *
   * On success the category is reassigned, a new per-category
   * {@link TicketNumber} is applied, and the counter is cleared — the ticket
   * re-enters the queue under the new category. Records a
   * {@link TicketStatusChangedEvent} (the status leg) and a
   * {@link TicketTransferredEvent} (the category/number reassignment) so
   * downstream can sync on the re-issued number.
   */
  public transferTo(
    newCategoryId: string,
    newTicketNumber: TicketNumber,
    targetStatus: StatusValue,
    policy: ITransitionPolicy,
    now = Date.now(),
  ): void {
    const from = this._currentStatus;
    if (!policy.isAllowed(from, targetStatus)) {
      throw new InvalidStateTransitionException(from, targetStatus);
    }
    const oldCategoryId = this._categoryId;
    const oldTicketNumber = this._ticketNumber;
    this._currentStatus = targetStatus;
    this._categoryId = newCategoryId;
    this._ticketNumber = newTicketNumber;
    this._counterId = null;
    // Transfer re-enters the queue as a fresh ticket under the new category
    // (new number, WAITING). The prior lifecycle timestamps no longer describe
    // this ticket — clear them so wait/service-time metrics start over.
    this._calledAt = null;
    this._servedAt = null;
    this._completedAt = null;
    this._updatedAt = now;
    this.record(
      new TicketStatusChangedEvent(
        this.id.value,
        from,
        targetStatus,
        policy.actionLabelFor(from, targetStatus),
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

  private transitionTo(target: StatusValue, policy: ITransitionPolicy, now: number): void {
    const from = this._currentStatus;
    if (from === target) {
      return; // idempotent — no event, no state change
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
  }
}
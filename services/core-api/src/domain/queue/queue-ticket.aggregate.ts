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

  private constructor(
    id: TicketId,
    ticketNumber: TicketNumber,
    categoryId: string,
    status: StatusValue,
    counterId: number | null,
    createdAt: number,
    updatedAt: number,
  ) {
    super(id);
    this._ticketNumber = ticketNumber;
    this._categoryId = categoryId;
    this._currentStatus = status;
    this._counterId = counterId;
    this._createdAt = createdAt;
    this._updatedAt = updatedAt;
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
  }): QueueTicket {
    return new QueueTicket(
      params.id,
      params.ticketNumber,
      params.categoryId,
      params.status,
      params.counterId,
      params.createdAt,
      params.updatedAt,
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
  }

  /** Begin serving. CALLING -> SERVING ("Mulai Melayani"). */
  public startServing(policy: ITransitionPolicy, now = Date.now()): void {
    this.transitionTo(TicketStatus.SERVING, policy, now);
  }

  /** Mark service complete. SERVING -> COMPLETED ("Selesai Layan"). */
  public complete(policy: ITransitionPolicy, now = Date.now()): void {
    this.transitionTo(TicketStatus.COMPLETED, policy, now);
  }

  /** Skip / mark absent. CALLING -> SKIPPED ("Lewati / Absen"). */
  public skip(policy: ITransitionPolicy, now = Date.now()): void {
    this.transitionTo(TicketStatus.SKIPPED, policy, now);
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
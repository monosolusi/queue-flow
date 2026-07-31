/**
 * Wire contract between caller-service and core-api. These types mirror the
 * DTOs core-api exposes over REST and the WebSocket envelopes it broadcasts
 * (FR-ENG-04). There is no shared package yet, so the contract is duplicated
 * here intentionally — the ISP boundary means the caller only knows the slice
 * of the API it consumes (never admin/reporting DTOs).
 */

/** A category assigned to a counter, with the master-data fields the UI needs. */
export interface AssignedCategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** One transition in the active state machine (FR-CLR-02). */
export interface StateTransitionDto {
  readonly from: string;
  readonly to: string;
  readonly actionLabel: string;
}

/** The active state-machine graph, returned by `GET /api/system/state-machine`. */
export interface StateMachineDto {
  readonly states: readonly string[];
  readonly transitions: readonly StateTransitionDto[];
}

/** Counter master data, returned by `GET /api/counters` (FR-CLR-01). */
export interface CounterDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategories: readonly AssignedCategoryDto[];
  readonly priorityPolicy: 'FIFO_GLOBAL' | 'CATEGORY_PRIORITY';
}

/** One ticket's state, returned inside the queue snapshot (core-api TicketStateDto). */
export interface TicketStateDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly status: string;
  readonly counterId: number | null;
}

/** Counter-scoped queue snapshot, returned by `GET /api/queue?counterId=N` (QUE-19). */
export interface QueueSnapshotDto {
  readonly counterId: number;
  readonly active: readonly TicketStateDto[];
  readonly waiting: readonly TicketStateDto[];
  readonly waitingCount: number;
}

/** WebSocket lifecycle event types broadcast by core-api (FR-ENG-04). */
export type QueueLifecycleEventType =
  | 'TICKET_CREATED'
  | 'TICKET_CALLED'
  | 'STATUS_UPDATED'
  | 'SYSTEM_RESET'
  | 'TICKET_TRANSFERRED';

export interface TicketCreatedPayload {
  readonly ticketNumber: string;
  readonly categoryId: string;
}
export interface TicketCalledPayload {
  readonly ticketNumber: string;
  readonly counterId: number;
}
export interface StatusUpdatedPayload {
  readonly from: string;
  readonly to: string;
  readonly actionLabel?: string;
}
export interface SystemResetPayload {
  readonly resetTo: number;
  readonly date: string;
}
export interface TicketTransferredPayload {
  readonly fromCategoryId: string;
  readonly toCategoryId: string;
  readonly fromTicketNumber: string;
  readonly toTicketNumber: string;
}

export type QueueLifecyclePayload =
  | TicketCreatedPayload
  | TicketCalledPayload
  | StatusUpdatedPayload
  | SystemResetPayload
  | TicketTransferredPayload;

/** The broadcast envelope every connected LAN client receives on /ws. */
export interface QueueLifecycleWireEvent {
  readonly type: QueueLifecycleEventType;
  readonly aggregateId: string;
  readonly occurredAt: number;
  readonly version: number;
  readonly payload: QueueLifecyclePayload;
}
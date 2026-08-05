/**
 * Wire contract between tv-display-service and core-api. These types mirror the
 * DTOs core-api exposes over REST (`GET /api/system/config`, `GET
 * /api/categories`) and the WebSocket envelopes it broadcasts (FR-ENG-04).
 * There is no shared package, so the contract is duplicated here intentionally —
 * the ISP boundary means the TV only knows the slice of the API it consumes
 * (never caller/admin/reporting DTOs). The lifecycle-event types mirror
 * caller-service's; the TV projects them differently (now-serving + history +
 * audio) but the wire schema is shared infrastructure, not a DTO leak.
 */

/** Category master data, returned by `GET /api/categories` (used for the running text). */
export interface CategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * A single ticket row in the TV board state read, returned by
 * `GET /api/queue/board`. Mirrors core-api's `TicketStateDto` shape (the
 * shared ticket→DTO projection) so the TV renders the same fields the caller
 * workspace sees, without leaking caller/admin/reporting DTOs (ISP). The same
 * row shape serves both the `active` (CALLING/SERVING, `counterId` non-null)
 * and `waiting` (WAITING, `counterId` null) slices.
 */
export interface TvTicketDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly status: string;
  readonly counterId: number | null;
}

/**
 * Read model returned by `GET /api/queue/board`: every active (CALLING/SERVING)
 * ticket across all counters (ordered by `updatedAt` asc — the last is the
 * most-recently-touched, which the TV projects to `nowServing`) plus every
 * WAITING ticket across all categories, oldest first (FIFO by `createdAt`).
 * The server owns this read model — the TV fetches it on boot and refetches
 * after every lifecycle event (it does not project waiting state from events,
 * and `nowServing` is restored from the `active` slice on boot/refresh).
 */
export interface TvBoardStateDto {
  readonly active: readonly TvTicketDto[];
  readonly waiting: readonly TvTicketDto[];
  readonly waitingCount: number;
}

/** Store profile, returned by `GET /api/system/config`. The TV needs the store
 * name (running text) + the manager-configured brand color (QUE-36) applied to
 * the runtime `--accent` (QUE-37 AC6). */
export interface SystemConfigurationDto {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
  readonly brandColor: string;
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
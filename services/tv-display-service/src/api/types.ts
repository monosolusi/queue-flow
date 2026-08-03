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
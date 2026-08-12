/**
 * Wire contract between caller-service and core-api. These types mirror the
 * DTOs core-api exposes over REST and the WebSocket envelopes it broadcasts
 * (FR-ENG-04). There is no shared package yet, so the contract is duplicated
 * here intentionally — the ISP boundary means the caller only knows the slice
 * of the API it consumes (never admin/reporting DTOs).
 */

/** Auth role wire values (core-api Identity context, QUE-43). The wire value is
 *  the enum; user-visible copy never shows this string raw (friendly labels
 *  live in the UI). `admin` and `caller-staff` both permit the caller workspace. */
export type UserRole = 'admin' | 'caller-staff';

/** The authenticated user, returned by `POST /api/auth/login` and
 *  `GET /api/auth/me`. Stored only in memory (resolved per session); the token
 *  is the persisted credential. */
export interface AuthUserDto {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
}

/** `POST /api/auth/login` success body — the bearer token + the resolved user. */
export interface LoginResponseDto {
  readonly token: string;
  readonly user: AuthUserDto;
}

/** A category assigned to a counter, with the master-data fields the UI needs. */
export interface AssignedCategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * The minimal slice of `GET /api/system/config` the caller consumes for theming
 * — just the manager-configured brand color (QUE-36) applied to the runtime
 * `--accent` (QUE-37 AC6). ISP: the caller consumes only this slice, never the
 * full admin `SystemConfigurationDto`. Reuses the existing config read surface
 * (DRY) rather than adding a dedicated endpoint.
 */
/** A per-surface light/dark choice (QUE-47). Light is the default. */
export type ThemeMode = 'light' | 'dark';

export interface BrandConfigSlice {
  readonly brandColor: string;
  /** This service's theme (the caller surface key from `serviceThemes`). */
  readonly themeMode: ThemeMode;
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
  | 'TICKET_TRANSFERRED'
  | 'SYSTEM_CONFIG_CHANGED';

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
/**
 * `SYSTEM_CONFIG_CHANGED` carries no fields — a pure refetch signal (mirrors
 * `SystemResetPayload`'s signal-then-refetch contract). The caller refetches the
 * active state machine so the admin-designed flow + its `actionLabel` wording
 * applies without a reload (FR-CLR-02).
 */
export interface SystemConfigChangedPayload {}

export type QueueLifecyclePayload =
  | TicketCreatedPayload
  | TicketCalledPayload
  | StatusUpdatedPayload
  | SystemResetPayload
  | TicketTransferredPayload
  | SystemConfigChangedPayload;

/** The broadcast envelope every connected LAN client receives on /ws. */
export interface QueueLifecycleWireEvent {
  readonly type: QueueLifecycleEventType;
  readonly aggregateId: string;
  readonly occurredAt: number;
  readonly version: number;
  readonly payload: QueueLifecyclePayload;
}
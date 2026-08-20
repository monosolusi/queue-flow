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

/**
 * The licence slice the caller panel consumes (ISP). Staff DO need to see a
 * licence warning — unlike the kiosk and the TV, whose audience is a customer
 * who can neither understand nor fix one — because they are the people who
 * will be asked why the kiosk stopped printing.
 */
export interface CallerLicenseSlice {
  readonly state: 'VALID' | 'EXPIRING_SOON' | 'GRACE' | 'MISMATCH_GRACE' | 'RESTRICTED';
  readonly restrictsNewTickets: boolean;
}

export interface BrandConfigSlice {
  readonly brandColor: string;
  /** `null` when core-api reported none — unknown, never "unlicensed". */
  readonly license?: CallerLicenseSlice | null;
  /** This service's theme (the caller surface key from `serviceThemes`). */
  readonly themeMode: ThemeMode;
}

/**
 * Why a transition cannot be run — a **code**, not prose: the backend owns the
 * fact, this client owns the Indonesian wording (see `lib/workflow-actions.ts`).
 *
 * - `NO_STATUS_CHANGE` — running it would leave the ticket exactly where it is.
 *
 * A per-ticket transition reaches any target the active flow allows, so the only
 * reason an edge is unrunnable is that it would change nothing. "Pindah Kategori"
 * (FR-CLR-03) is no longer a flow edge at all — it is a standalone panel action
 * on the active ticket, so it never appears in this projection.
 */
export type WorkflowActionUnavailableReason = 'NO_STATUS_CHANGE';

/** One transition of the active flow (FR-CLR-02): a plain status change from
 *  `from` to `to`, labelled with the manager's `actionLabel`. `unavailableReason
 *  !== null` means running it would do nothing — the button is still rendered
 *  (disabled + the reason) so a configured edge never silently disappears. */
export interface WorkflowActionDto {
  readonly from: string;
  readonly to: string;
  readonly actionLabel: string;
  readonly unavailableReason: WorkflowActionUnavailableReason | null;
}

/** The counter panel's action surface, returned by `GET /api/queue/actions`:
 *  every transition of the active flow grouped by its **source** status. */
export interface WorkflowActionsDto {
  readonly byStatus: Record<string, readonly WorkflowActionDto[]>;
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
  /** SKIPPED tickets belonging to this counter. Its own bucket because a skipped
   *  ticket is neither at the counter (`active`) nor back in line (`waiting`),
   *  yet it must stay on screen: "Panggil Ulang" is an outgoing transition of
   *  SKIPPED, so without a surface holding these tickets that PRD action is
   *  unreachable and an absent customer can never be re-called.
   *
   *  Optional on the wire even though core-api always sends it: this DTO
   *  describes `JSON.parse` output, not a typed literal, so the field is only as
   *  guaranteed as the response that arrived. The realistic way it goes missing
   *  is a service-worker-cached client running against a newer API — the whole
   *  stack ships from one `docker compose up`, so an older API is not the case
   *  to defend. Declaring it required would invite the reader to delete the
   *  `?? []` in `queue-store` as dead code. */
  readonly skipped?: readonly TicketStateDto[];
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
 * `SystemResetPayload`'s signal-then-refetch contract). The caller refetches its
 * action surface so the admin-designed flow + its `actionLabel` wording applies
 * without a reload (FR-CLR-02).
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
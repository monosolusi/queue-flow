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

/** A per-surface light/dark choice (QUE-47). Light is the default. */
export type ThemeMode = 'light' | 'dark';

/**
 * TV grid layout contract (2D 12-column grid, TradingView-style). The wire
 * identifiers mirror core-api's `TvComponentType` exactly — the contract is
 * duplicated here intentionally (no shared package, per the standalone-
 * service ethos; friendly component names are an admin-service concern, not a
 * TV concern). A layout is an ordered list of placed widgets; an empty array
 * is an idle board (the empty-state status renders).
 */
/** Component types a manager can place on the TV grid. Stable wire identifier. */
export type TvComponentType =
  | 'nowServing'
  | 'waitingQueue'
  | 'callHistory'
  | 'countersServing'
  | 'runningText';

/** One placed widget on the 12-column TV grid. */
export interface TvWidget {
  readonly id: string;
  readonly component: TvComponentType;
  readonly x: number; // column start, 0-based
  readonly y: number; // row start, 0-based
  readonly w: number; // column span
  readonly h: number; // row span
}

/** Persisted TV layout: an ordered list of placed widgets (empty = idle board). */
export type TvGridLayout = readonly TvWidget[];

export const GRID_COLS = 12;
export const GRID_MAX_ROWS = 20;
export const GRID_MIN_W = 1;
export const GRID_MIN_H = 1;

export const TV_COMPONENT_TYPES: readonly TvComponentType[] = [
  'nowServing', 'waitingQueue', 'callHistory', 'countersServing', 'runningText',
];

/** All-five-widgets default layout — `nowServing` is the hero (full-width,
 * 4 rows); `waitingQueue` + `callHistory` share the middle band (6 cols each,
 * 3 rows); `countersServing` is a full-width band (3 rows); `runningText` is
 * a full-width 1-row strip. Mirrors core-api's `DEFAULT_TV_GRID_LAYOUT` so a
 * store that never configures this keeps the existing TV layout (zero visual
 * regression — the hero is the biggest, the side panels share equal height). */
export const DEFAULT_TV_GRID_LAYOUT: TvGridLayout = [
  { id: 'nowServing',      component: 'nowServing',      x: 0, y: 0,  w: 12, h: 4 },
  { id: 'waitingQueue',    component: 'waitingQueue',    x: 0, y: 4,  w: 6,  h: 3 },
  { id: 'callHistory',     component: 'callHistory',     x: 6, y: 4,  w: 6,  h: 3 },
  { id: 'countersServing', component: 'countersServing', x: 0, y: 7,  w: 12, h: 3 },
  { id: 'runningText',     component: 'runningText',     x: 0, y: 10, w: 12, h: 1 },
];

/** Store profile, returned by `GET /api/system/config`. The TV needs the store
 * name (running text) + the manager-configured brand color (QUE-36) applied to
 * the runtime `--accent` (QUE-37 AC6) + this service's theme (the tv surface
 * key from `serviceThemes`, QUE-47) + the TV grid layout
 * (`tvPanelLayout` — an ordered list of placed widgets on a 12-col grid) + the
 * routing rules (for the counter id→name map used by the counters-serving
 * list — a client-side name join mirroring the categories name-lookup
 * precedent: a counter name is from an entity the board read model does not
 * touch, so the TV joins it client-side via the public config response's
 * `routingRules`). */
export interface SystemConfigurationDto {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
  readonly brandColor: string;
  readonly serviceThemes: { readonly tv: ThemeMode };
  readonly tvPanelLayout: TvGridLayout;
  /** Slim slice — the TV reads only `counterId` + `counterName` for the
   * counters-serving client-side name join; the other routing fields are
   * ignored. */
  readonly routingRules: readonly {
    readonly counterId: number;
    readonly counterName: string;
  }[];
}

/** A counter view model for the "Sedang Melayani" panel, projected
 * client-side by the TV store from `GET /api/queue/board`'s `active` array
 * joined with the `routingRules` counter-name map. The list includes EVERY
 * configured counter (from `routingRules`) — a single on-premise store has
 * every configured counter operational, so an idle counter (no active ticket
 * right now) stays visible: it carries `ticketNumber: '—'`, `ticketId: ''`,
 * `status: ''`, `idle: true` and is visually muted. A counter currently
 * serving carries its real ticket fields and `idle: false`. */
export interface CounterServing {
  readonly counterId: number;
  readonly counterName: string;
  readonly ticketNumber: string;
  readonly ticketId: string;
  readonly status: string;
  /** `true` when this counter has no active ticket (idle — visible as an em
   * dash, muted). `false` when it is currently serving a ticket. */
  readonly idle: boolean;
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
 * `SYSTEM_CONFIG_CHANGED` carries no fields — a pure refetch signal. The TV
 * does not act on it (its reducer's `default` ignores it); the type is mirrored
 * only to keep the duplicated wire contract in lock-step with core-api
 * (frontend-conventions-gotchas). A future TV that refetches config on this
 * event would handle it here.
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
/**
 * Wire contract between admin-service and core-api. These types mirror the
 * DTOs core-api exposes over REST (`GET|PUT /api/system/config`,
 * `GET /api/system/state-machine`). There is no shared package, so the
 * contract is duplicated here intentionally — the ISP boundary means the admin
 * service only knows its own slice of the API (never caller/kiosk/tv-snapshot
 * DTOs).
 */

import { BROWSER_TIMEZONE } from '../lib/timezone';

export type PriorityPolicy = 'FIFO_GLOBAL' | 'CATEGORY_PRIORITY';
export type DailyResetMode = 'AUTOMATIC_CRON' | 'MANUAL';

/** A per-surface light/dark choice (QUE-47). Light is the default. */
export type ThemeMode = 'light' | 'dark';
/** The four deployable frontend surfaces a manager can theme independently. */
export type ServiceSurface = 'kiosk' | 'tv' | 'caller' | 'admin';
/** Persisted shape: one {@link ThemeMode} per {@link ServiceSurface}. */
export type ServiceThemesMap = Record<ServiceSurface, ThemeMode>;
/** All-light default — matches `ServiceThemes.DEFAULT` and the CSS `:root`
 *  light default (zero visual regression / clean-store prefill). */
export const DEFAULT_SERVICE_THEMES: ServiceThemesMap = {
  kiosk: 'light',
  tv: 'light',
  caller: 'light',
  admin: 'light',
};

/**
 * The TV-display grid layout contract — a TradingView-style 12-column grid
 * canvas where each placed widget occupies a `{ x, y, w, h }` rect (column /
 * row units). Replaces the former 1D panel-order/size map. The friendly
 * display names for each component type live in
 * {@link import('../lib/tv-grid-layout').TV_COMPONENT_LABELS}, never here.
 *
 * The contract is intentionally duplicated across three services
 * (core-api / admin / tv-display-service) — there is no shared package (the
 * standalone-service ethos). The three definitions MUST stay in lock-step; a
 * divergence is a bug. `runningText` is no longer special-cased — it is a
 * first-class widget placed on the grid like the other four (the TV renders
 * it wherever its rect lands, not always pinned as a footer).
 */
export type TvComponentType =
  | 'nowServing'
  | 'waitingQueue'
  | 'callHistory'
  | 'countersServing'
  | 'runningText';

/** One placed widget on the TV grid. `id` is a client-minted UUID identifying
 *  the widget instance (two widgets may share a `component` type but never an
 *  `id`). Coordinates are in column/row units against the 12-col grid. */
export interface TvWidget {
  readonly id: string;
  readonly component: TvComponentType;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
/** Persisted shape: an ordered list of placed widgets (no key→config map — the
 *  layout is a free-form grid, not a fixed panel set). */
export type TvGridLayout = readonly TvWidget[];

/** Grid geometry constants (mirror core-api's `TvGridLayout` VO exactly). */
export const GRID_COLS = 12;
export const GRID_MAX_ROWS = 20;
export const GRID_MIN_W = 1;
export const GRID_MIN_H = 1;

/** Stable component-type list (matches the backend `TV_COMPONENT_TYPES`). */
export const TV_COMPONENT_TYPES: readonly TvComponentType[] = [
  'nowServing',
  'waitingQueue',
  'callHistory',
  'countersServing',
  'runningText',
];

/** Default widget size per component (palette drop / click-add). A component's
 *  default size mirrors the PRD §7 visual emphasis — `nowServing` is the hero
 *  (full width, 4 rows), the side-by-side panels share a 6-col row, the
 *  `runningText` marquee is a 1-row strip. */
export const DEFAULT_WIDGET_SIZE: Record<TvComponentType, { w: number; h: number }> = {
  nowServing: { w: 12, h: 4 },
  waitingQueue: { w: 6, h: 3 },
  callHistory: { w: 6, h: 3 },
  countersServing: { w: 12, h: 3 },
  runningText: { w: 12, h: 1 },
};

/** All-five-widgets default layout — matches `TvGridLayout.DEFAULT` (the PRD
 *  default so a store that never configures this keeps the existing TV layout
 *  — zero visual regression, mirroring `DEFAULT_SERVICE_THEMES`). `nowServing`
 *  is the hero on row 0; `waitingQueue` + `callHistory` share row 4;
 *  `countersServing` sits below; `runningText` is the bottom strip. */
export const DEFAULT_TV_GRID_LAYOUT: TvGridLayout = [
  { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
  { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
  { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
  { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
  { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
];

export interface StateTransitionDto {
  readonly from: string;
  readonly to: string;
  readonly actionLabel: string;
}

export interface StateMachineDto {
  readonly states: readonly string[];
  readonly transitions: readonly StateTransitionDto[];
}

export interface DailyResetPolicyDto {
  readonly mode: DailyResetMode;
  readonly cronExpression: string | null;
  readonly resetTicketNumberTo: number;
  readonly archivePreviousDayData: boolean;
  /** IANA timezone the daily-reset cron fires in (always present on the read
   *  projection — the backend VO defaults to the server's local TZ when
   *  unset). QUE-42. */
  readonly timezone: string;
}

export interface ConfigCategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface ConfigRoutingRuleDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategoryIds: readonly string[];
  readonly priorityPolicy: PriorityPolicy;
}

/** Full config projection from `GET /api/system/config`. */
export interface SystemConfigurationDto {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
  readonly stateMachine: StateMachineDto;
  readonly dailyResetPolicy: DailyResetPolicyDto;
  readonly categories: readonly ConfigCategoryDto[];
  readonly routingRules: readonly ConfigRoutingRuleDto[];
  readonly brandColor: string;
  /** Per-service light/dark theme map (QUE-47). Admin reads + edits the full
   *  map; each other service reads only its own surface key (ISP). */
  readonly serviceThemes: ServiceThemesMap;
  /** TV-display grid layout: a list of placed widgets on a 12-col grid. Admin
   *  reads + edits the full array on the dedicated `/tv-layout` page; the TV
   *  service reads the whole array at boot and lays each widget out at its
   *  `{ x, y, w, h }` rect on a CSS grid (the PRD default mirrors the former
   *  fixed-panel layout — zero visual regression). */
  readonly tvPanelLayout: TvGridLayout;
}

/**
 * One category in the wizard / admin payload. `id` is optional: send the
 * existing id to preserve it across a re-save (keeps `QueueTicket.categoryId`
 * valid — the backend reuses it via `Identifier.of(id)`); omit it for a newly
 * added category so the backend mints one. The backend `WizardCategoryDto`
 * already accepts this field.
 */
export interface WizardCategoryDto {
  readonly id?: string;
  readonly code: string;
  readonly name: string;
}

/** One counter routing rule in the wizard payload (categories referenced by code). */
export interface WizardRoutingRuleDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategoryCodes: readonly string[];
  readonly priorityPolicy: PriorityPolicy;
}

/**
 * The wizard / admin save payload for `PUT /api/system/config`. The `actor`
 * field was removed (QUE-43): the server now derives the audit actor from the
 * authenticated admin's bearer token, so the client never sends it. On the
 * pre-setup wizard path there is no token, so the server uses a `'system'`
 * sentinel — no client change is needed beyond omitting the field.
 */
export interface SaveSystemConfigurationPayload {
  readonly storeName: string;
  readonly stateMachine: StateMachineDto;
  readonly dailyReset: DailyResetPolicyDto;
  readonly categories: readonly WizardCategoryDto[];
  readonly routingRules: readonly WizardRoutingRuleDto[];
  readonly brandColor: string;
  readonly serviceThemes: ServiceThemesMap;
  readonly tvPanelLayout: TvGridLayout;
}

/** Result of `PUT /api/system/config`. */
export interface SaveSystemConfigurationResult {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
  readonly brandColor: string;
  readonly serviceThemes: ServiceThemesMap;
  readonly tvPanelLayout: TvGridLayout;
}

/**
 * The PRD §7 default category preset (prefilled into the wizard's Step 1
 * category designer when the manager keeps the "default" template). Like
 * {@link DEFAULT_STATE_MACHINE} this is a client mirror of the PRD §7 reference
 * config. `id` is intentionally absent — the backend mints one on first save;
 * on a re-edit the prefill carries the existing ids and the wizard's
 * id-preserving force-reset keeps them (see `defaultCategoriesWithIds`).
 */
export const DEFAULT_CATEGORIES: readonly WizardCategoryDto[] = [
  { code: 'A', name: 'Customer Service' },
  { code: 'B', name: 'Kasir & Pembayaran' },
];

/** The PRD §7 default state machine (prefilled into the wizard designer). */
export const DEFAULT_STATE_MACHINE: StateMachineDto = {
  states: ['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED'],
  transitions: [
    { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
    { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
    { from: 'CALLING', to: 'SKIPPED', actionLabel: 'Lewati / Absen' },
    { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang' },
    { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan' },
  ],
};

export const DEFAULT_DAILY_RESET: DailyResetPolicyDto = {
  mode: 'AUTOMATIC_CRON',
  cronExpression: '0 0 * * *',
  resetTicketNumberTo: 1,
  archivePreviousDayData: true,
  timezone: BROWSER_TIMEZONE,
};

/**
 * The shared accent color the four frontends hardcode in `:root` (`--accent:
 * #2563eb`). The wizard + admin panel prefill their `<input type="color">` with
 * this on a clean store, and the backend `BrandColor.DEFAULT` mirrors it so a
 * store that never sets a brand color keeps the existing look (zero visual
 * regression, AC1 "default yang masuk akal"). The UI emits `#rrggbb` only; the
 * backend VO additionally accepts OKLCH / `#rrggbbaa` for direct API calls.
 */
export const DEFAULT_BRAND_COLOR = '#2563eb';

// --- Analytics & audit-trail read surface (FR-ADM-03 / QUE-26) ----------------

/**
 * Per-category breakdown row in a {@link DailyReportDto}. Mirrors core-api's
 * `CategoryBreakdownDto` (`application/reporting/get-daily-report.use-case`).
 */
export interface CategoryBreakdownDto {
  readonly categoryId: string;
  readonly code: string;
  readonly categoryName: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
}

/**
 * Daily queue analytics report from `GET /api/reports/daily?date=YYYY-MM-DD`.
 * Mirrors core-api's `DailyReportDto`. The controller returns a zero-shape
 * (`totalTickets: 0`, empty `perCategory`) when no tickets exist for the date,
 * so this DTO is never null over the wire.
 */
export interface DailyReportDto {
  readonly date: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly perCategory: readonly CategoryBreakdownDto[];
}

/**
 * One counter's performance from `GET /api/reports/counters/:id?date=YYYY-MM-DD`.
 * Mirrors core-api's `CounterPerformanceDto`. Zero-shape when the counter served
 * nothing that day.
 */
export interface CounterPerformanceDto {
  readonly counterId: number;
  readonly date: string;
  readonly ticketsServed: number;
  readonly avgServiceTimeMs: number;
}

// --- Range analytics read surface (FR-ADM-03 / QUE-44) -----------------------

/**
 * One day's aggregate within a {@link RangeReportDto}. Mirrors core-api's
 * `DailyPointDto`. Days with no tickets surface as zero-point rows so the trend
 * chart renders a continuous axis.
 */
export interface DailyPointDto {
  readonly date: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly ticketsServed: number;
}

/** One counter's aggregate over a range. Mirrors core-api's `CounterRangeBreakdownDto`. */
export interface CounterRangeBreakdownDto {
  readonly counterId: number;
  readonly ticketsServed: number;
  readonly avgServiceTimeMs: number;
}

/**
 * Range queue analytics report from `GET /api/reports/range?from=&to=`. Mirrors
 * core-api's `RangeReportDto`. Range totals + a per-day series (for trend
 * visualization) + per-category and per-counter aggregates over the range. The
 * controller returns a zero-shape (with a per-day zero series) when no tickets
 * exist in the range, so this DTO is never null over the wire.
 */
export interface RangeReportDto {
  readonly from: string;
  readonly to: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly perDay: readonly DailyPointDto[];
  readonly perCategory: readonly CategoryBreakdownDto[];
  readonly perCounter: readonly CounterRangeBreakdownDto[];
}

// --- Live queue state read surface (FR-ADM-03 / QUE-44 Dashboard) ------------

/**
 * Transport-agnostic projection of a live queue ticket. Mirrors core-api's
 * `TicketStateDto` (`application/queue/ticket-state.dto`). `counterId` is null
 * for a WAITING ticket (not yet called to a counter).
 */
export interface TicketStateDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly status: string;
  readonly counterId: number | null;
}

/**
 * Live queue board state from `GET /api/queue/board`. Mirrors core-api's
 * `TvBoardStateDto` (the `Tv` prefix is historical on the backend; the admin
 * dashboard consumes the same read for its live operational status). `active`
 * is every CALLING/SERVING ticket across all counters, oldest-updated first —
 * the last entry is the most-recently-touched (the now-serving ticket).
 */
export interface QueueBoardStateDto {
  readonly active: readonly TicketStateDto[];
  readonly waiting: readonly TicketStateDto[];
  readonly waitingCount: number;
}

/**
 * A category assigned to a counter. Mirrors core-api's `AssignedCategoryDto`.
 */
export interface AssignedCategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * A configured counter from `GET /api/counters`. Mirrors core-api's
 * `CounterDto` (`application/store-config/list-counters.use-case`). Used by the
 * dashboard to label the counter-status list.
 */
export interface CounterDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategories: readonly AssignedCategoryDto[];
  readonly priorityPolicy: PriorityPolicy;
}

/**
 * Opaque before/after snapshot recorded with an audit entry (an arbitrary JSON
 * object on the server). Mirrors core-api's `AuditSnapshot`
 * (`Record<string, unknown>`); kept loose so the client never assumes a shape.
 */
export type AuditSnapshot = Record<string, unknown>;

/**
 * One audit-trail entry from `GET /api/audit/log`. Mirrors core-api's
 * `AuditLogEntryDto`. `action` is the serialized enum string (e.g.
 * `'MANUAL_RESET'`, `'STATE_SCHEMA_CHANGE'`, `'ARCHIVE_PREVIOUS_DAY'`).
 */
export interface AuditLogEntryDto {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly before: AuditSnapshot | null;
  readonly after: AuditSnapshot;
  readonly occurredAt: number;
}

// --- Manual override operations (FR-ADM-02 / QUE-25) -------------------------

/**
 * Result of `POST /api/system/daily-reset` (the manual daily-reset override).
 * Mirrors core-api's `ResetDailyQueueResult`. `archivedCount` is present when
 * the active policy archives prior-day tickets (the default policy does, so it
 * is usually present — 0 when no prior-day tickets existed).
 */
export interface ManualResetResultDto {
  readonly status: 'reset';
  readonly date: string;
  readonly resetTo: number;
  readonly archivedCount?: number;
}

/**
 * Result of `POST /api/system/cleanup-transaction-log` (the transaction-log
 * cleanup override). Mirrors core-api's `CleanupTransactionLogResult`.
 * `deletedCount` is how many archived transactions older than the retention
 * window were permanently removed.
 */
export interface CleanupTransactionLogResultDto {
  readonly status: 'cleaned';
  readonly retentionDays: number;
  readonly deletedCount: number;
}

// --- Identity & access (QUE-43) ----------------------------------------------

/**
 * The role a {@link UserDto} / {@link AuthUserDto} may carry. Mirrors core-api's
 * `UserRole` enum. The wire `value=` stays the enum; user-visible copy renders a
 * friendly Indonesian label via {@link USER_ROLE_LABELS} (never the raw enum).
 */
export type UserRole = 'admin' | 'caller-staff';

/**
 * The authenticated principal, returned by `GET /api/auth/me` and embedded in
 * the {@link LoginResponseDto}. Carries no `createdAt` (the `/me` projection is
 * the minimal identity slice — the created-at timestamp lives on {@link UserDto}).
 */
export interface AuthUserDto {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
}

/**
 * Result of `POST /api/auth/login`. The opaque bearer `token` is stored in
 * `qms.admin.token` (see `auth/token-store`) and threaded as
 * `Authorization: Bearer <token>` on every protected request. The client never
 * decodes the token (no JWT lib — NFR-REL-01); it reads `/api/auth/me` for the
 * current user.
 */
export interface LoginResponseDto {
  readonly token: string;
  readonly user: AuthUserDto;
}

/**
 * One user account from `GET /api/users` / `POST /api/users` /
 * `POST /api/auth/setup-admin`. Mirrors core-api's `UserDto`. `createdAt` is a
 * Unix-epoch millisecond timestamp (the backend stores BIGINT ms, matching the
 * audit-log + lifecycle timestamps convention).
 */
export interface UserDto {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
  readonly createdAt: number;
}
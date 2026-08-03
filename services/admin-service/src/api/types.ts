/**
 * Wire contract between admin-service and core-api. These types mirror the
 * DTOs core-api exposes over REST (`GET|PUT /api/system/config`,
 * `GET /api/system/state-machine`). There is no shared package, so the
 * contract is duplicated here intentionally — the ISP boundary means the admin
 * service only knows its own slice of the API (never caller/kiosk/tv-snapshot
 * DTOs).
 */

export type PriorityPolicy = 'FIFO_GLOBAL' | 'CATEGORY_PRIORITY';
export type DailyResetMode = 'AUTOMATIC_CRON' | 'MANUAL';

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

/** The wizard / admin save payload for `PUT /api/system/config`. */
export interface SaveSystemConfigurationPayload {
  readonly storeName: string;
  readonly stateMachine: StateMachineDto;
  readonly dailyReset: DailyResetPolicyDto;
  readonly categories: readonly WizardCategoryDto[];
  readonly routingRules: readonly WizardRoutingRuleDto[];
  readonly brandColor: string;
  readonly actor?: string;
}

/** Result of `PUT /api/system/config`. */
export interface SaveSystemConfigurationResult {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
  readonly brandColor: string;
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
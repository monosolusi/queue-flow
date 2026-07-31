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
}

/** One category in the wizard payload (`id` optional — generated server-side). */
export interface WizardCategoryDto {
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
  readonly actor?: string;
}

/** Result of `PUT /api/system/config`. */
export interface SaveSystemConfigurationResult {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
}

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
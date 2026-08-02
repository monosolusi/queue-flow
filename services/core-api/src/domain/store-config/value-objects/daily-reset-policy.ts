import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';
import { isValidCronExpression } from './cron-expression';

export enum DailyResetMode {
  AUTOMATIC_CRON = 'AUTOMATIC_CRON',
  MANUAL = 'MANUAL',
}

export interface DailyResetPolicyProps {
  readonly mode: DailyResetMode;
  readonly cronExpression: string | null;
  readonly resetTicketNumberTo: number;
  readonly archivePreviousDayData: boolean;
}

/**
 * How and when the daily sequence rolls back to its start value (PRD §4.1.A /
 * FR-ENG-05). Defaults: automatic at 00:00, reset to 1, archive prior day.
 */
export class DailyResetPolicy extends ValueObject<DailyResetPolicyProps> {
  private constructor(props: DailyResetPolicyProps) {
    super(props);
  }

  public static of(
    mode: DailyResetMode,
    cronExpression: string | null,
    resetTicketNumberTo = 1,
    archivePreviousDayData = true,
  ): DailyResetPolicy {
    if (mode === DailyResetMode.AUTOMATIC_CRON) {
      if (!cronExpression) {
        throw new InvalidValueObjectException(
          'AUTOMATIC_CRON mode requires a cron expression',
        );
      }
      // Format enforcement (QUE-32): a non-empty cron for AUTOMATIC_CRON must
      // also be a syntactically valid 5-field expression — otherwise it would
      // crash the boot-time / re-arm `CronJob`. Mirrors the client
      // `validateCronExpression` guard (defense-in-depth: a direct API call
      // bypassing the client must not persist an unrunnable cron). MANUAL mode
      // may carry a null/stale cron unchecked — it is never armed.
      if (!isValidCronExpression(cronExpression)) {
        throw new InvalidValueObjectException(
          `AUTOMATIC_CRON mode requires a valid 5-field cron expression, got '${cronExpression}'`,
        );
      }
    }
    if (!Number.isInteger(resetTicketNumberTo) || resetTicketNumberTo < 1) {
      throw new InvalidValueObjectException(
        `resetTicketNumberTo must be a positive integer, got '${resetTicketNumberTo}'`,
      );
    }
    return new DailyResetPolicy({
      mode,
      cronExpression,
      resetTicketNumberTo,
      archivePreviousDayData,
    });
  }

  public static DEFAULT = DailyResetPolicy.of(
    DailyResetMode.AUTOMATIC_CRON,
    '0 0 * * *',
    1,
    true,
  );

  public get mode(): DailyResetMode {
    return this.value.mode;
  }

  public get cronExpression(): string | null {
    return this.value.cronExpression;
  }

  public get resetTicketNumberTo(): number {
    return this.value.resetTicketNumberTo;
  }

  public get archivePreviousDayData(): boolean {
    return this.value.archivePreviousDayData;
  }
}
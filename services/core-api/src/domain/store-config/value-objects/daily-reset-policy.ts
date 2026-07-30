import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

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
    if (mode === DailyResetMode.AUTOMATIC_CRON && !cronExpression) {
      throw new InvalidValueObjectException(
        'AUTOMATIC_CRON mode requires a cron expression',
      );
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
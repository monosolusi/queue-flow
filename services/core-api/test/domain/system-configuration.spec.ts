import { Identifier } from '../../src/domain/shared';
import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  DailyResetMode,
  DailyResetPolicy,
  StateMachine,
  StateSchema,
  SystemConfiguration,
} from '../../src/domain/store-config';
import { TicketStatus } from '../../src/domain/queue';

describe('StateMachine (default PRD §7 graph)', () => {
  const sm = StateMachine.DEFAULT;

  it('allows the canonical edges', () => {
    expect(sm.isAllowed(TicketStatus.WAITING, TicketStatus.CALLING)).toBe(true);
    expect(sm.isAllowed(TicketStatus.CALLING, TicketStatus.SERVING)).toBe(true);
    expect(sm.isAllowed(TicketStatus.CALLING, TicketStatus.SKIPPED)).toBe(true);
    expect(sm.isAllowed(TicketStatus.SKIPPED, TicketStatus.CALLING)).toBe(true);
    expect(sm.isAllowed(TicketStatus.SERVING, TicketStatus.COMPLETED)).toBe(true);
  });

  it('rejects edges outside the graph', () => {
    expect(sm.isAllowed(TicketStatus.WAITING, TicketStatus.SERVING)).toBe(false);
    expect(sm.isAllowed(TicketStatus.WAITING, TicketStatus.SKIPPED)).toBe(false);
    expect(sm.isAllowed(TicketStatus.COMPLETED, TicketStatus.WAITING)).toBe(false);
  });

  it('exposes the verbatim Indonesian action labels', () => {
    expect(sm.actionLabelFor(TicketStatus.WAITING, TicketStatus.CALLING)).toBe(
      'Panggil Berikutnya',
    );
    expect(sm.actionLabelFor(TicketStatus.CALLING, TicketStatus.SERVING)).toBe(
      'Mulai Melayani',
    );
    expect(sm.actionLabelFor(TicketStatus.CALLING, TicketStatus.SKIPPED)).toBe(
      'Lewati / Absen',
    );
    expect(sm.actionLabelFor(TicketStatus.SKIPPED, TicketStatus.CALLING)).toBe(
      'Panggil Ulang',
    );
    expect(sm.actionLabelFor(TicketStatus.SERVING, TicketStatus.COMPLETED)).toBe(
      'Selesai Layan',
    );
  });
});

describe('StateSchema', () => {
  it('defaults to the five canonical states', () => {
    expect(StateSchema.DEFAULT.states).toEqual([
      'WAITING',
      'CALLING',
      'SERVING',
      'SKIPPED',
      'COMPLETED',
    ]);
  });

  it('rejects empty or duplicate state lists', () => {
    expect(() => StateSchema.of([])).toThrow(InvalidValueObjectException);
    expect(() => StateSchema.of(['WAITING', 'WAITING'])).toThrow(
      InvalidValueObjectException,
    );
  });
});

describe('DailyResetPolicy', () => {
  it('defaults to automatic cron at 00:00, reset to 1, archive on', () => {
    const d = DailyResetPolicy.DEFAULT;
    expect(d.mode).toBe(DailyResetMode.AUTOMATIC_CRON);
    expect(d.cronExpression).toBe('0 0 * * *');
    expect(d.resetTicketNumberTo).toBe(1);
    expect(d.archivePreviousDayData).toBe(true);
  });

  it('allows MANUAL mode without a cron expression', () => {
    expect(() => DailyResetPolicy.of(DailyResetMode.MANUAL, null)).not.toThrow();
  });

  it('requires a cron expression for AUTOMATIC_CRON mode', () => {
    expect(() => DailyResetPolicy.of(DailyResetMode.AUTOMATIC_CRON, null)).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a non-positive reset target', () => {
    expect(() => DailyResetPolicy.of(DailyResetMode.MANUAL, null, 0)).toThrow(
      InvalidValueObjectException,
    );
  });
});

describe('SystemConfiguration aggregate', () => {
  it('starts unconfigured with the default state machine and reset policy', () => {
    const config = SystemConfiguration.create(Identifier.generate());
    expect(config.isInitialSetupCompleted).toBe(false);
    expect(config.stateMachine).toBe(StateMachine.DEFAULT);
    expect(config.dailyResetPolicy).toBe(DailyResetPolicy.DEFAULT);
  });

  it('cannot complete setup without a store name', () => {
    const config = SystemConfiguration.create(Identifier.generate());
    expect(() => config.completeInitialSetup()).toThrow(InvalidValueObjectException);
  });

  it('completes setup once a store name is set', () => {
    const config = SystemConfiguration.create(Identifier.generate(), 'Toko Utama Surabaya');
    config.completeInitialSetup();
    expect(config.isInitialSetupCompleted).toBe(true);
  });

  it('rejects an empty store name', () => {
    const config = SystemConfiguration.create(Identifier.generate(), 'Toko');
    expect(() => config.setStoreName('')).toThrow(InvalidValueObjectException);
  });
});
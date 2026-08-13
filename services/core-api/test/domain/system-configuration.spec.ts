import { Identifier } from '../../src/domain/shared';
import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  BrandColor,
  DailyResetMode,
  DailyResetPolicy,
  EdgeRoutingLayout,
  NodePositions,
  PrinterConfiguration,
  ServiceThemes,
  StateMachine,
  StateSchema,
  SystemConfiguration,
  TvPanelLayout,
} from '../../src/domain/store-config';
import { DEFAULT_TIMEZONE } from '../../src/domain/store-config/value-objects/timezone';
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

  it('defaults timezone to the server local IANA zone when omitted (QUE-42)', () => {
    const d = DailyResetPolicy.DEFAULT;
    expect(d.timezone).toBe(DEFAULT_TIMEZONE);
    // An explicit-omit construction (`of(...)` with no 5th arg) also defaults.
    const manual = DailyResetPolicy.of(DailyResetMode.MANUAL, null);
    expect(manual.timezone).toBe(DEFAULT_TIMEZONE);
    // An empty-string timezone is treated as omitted (defaults to local TZ).
    const empty = DailyResetPolicy.of(DailyResetMode.MANUAL, null, 1, true, '');
    expect(empty.timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('accepts a valid IANA timezone (QUE-42)', () => {
    const d = DailyResetPolicy.of(
      DailyResetMode.AUTOMATIC_CRON,
      '0 0 * * *',
      1,
      true,
      'Asia/Jakarta',
    );
    expect(d.timezone).toBe('Asia/Jakarta');
  });

  it.each([
    ['Foo/Bar', 'unknown IANA name'],
    ['NotATimezone', 'not a path-shaped IANA name'],
    ['Asia/Jakarta/Extra', 'too many segments'],
  ])('rejects a malformed timezone %j (%s) with InvalidValueObjectException (QUE-42)', (tz) => {
    expect(() => DailyResetPolicy.of(DailyResetMode.AUTOMATIC_CRON, '0 0 * * *', 1, true, tz)).toThrow(
      InvalidValueObjectException,
    );
  });

  it('validates the timezone in MANUAL mode too (the stored value must always be a valid IANA TZ)', () => {
    expect(() => DailyResetPolicy.of(DailyResetMode.MANUAL, null, 1, true, 'Foo/Bar')).toThrow(
      InvalidValueObjectException,
    );
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

  // QUE-32: backend cron-format enforcement — mirrors the client
  // `validateCronExpression` guard so a direct API call cannot persist a cron
  // the boot-time / re-arm `CronJob` would reject.
  it.each([
    '0 0 * * *',
    '*/5 * * * *',
    '0 1-6 * * *',
    '0 0 1,15 * *',
    '0 0 1 */2 *',
    '0 0 * * 7', // 7 = Sunday, accepted alongside 0
  ])('accepts a valid 5-field cron expression (%s)', (cron) => {
    expect(() => DailyResetPolicy.of(DailyResetMode.AUTOMATIC_CRON, cron)).not.toThrow();
  });

  it.each([
    ['0 99 * * *', 'minute out of range'],
    ['0 24 * * *', 'hour out of range'],
    ['* *', 'too few fields'],
    ['0 0 * *', 'too few fields'],
    ['0 0 * * * *', 'too many fields'],
    ['0 0 0 * *', 'day-of-month below range'],
    ['0 0 * 13 *', 'month out of range'],
    ['0 0 * * 8', 'day-of-week out of range (8 > 7)'],
    ['a b c d e', 'non-numeric'],
    ['0-99 * * * *', 'range high out of range'],
    ['*/0 * * * *', 'zero step'],
    ['0 0 * jan *', 'named month not supported'],
    ['0 0 * * mon', 'named day not supported'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
  ])('rejects a malformed cron expression %j (%s) for AUTOMATIC_CRON', (cron) => {
    expect(() => DailyResetPolicy.of(DailyResetMode.AUTOMATIC_CRON, cron)).toThrow(
      InvalidValueObjectException,
    );
  });

  it('does not validate the cron format for MANUAL mode (cron is ignored)', () => {
    // MANUAL mode may carry a null or even an ill-formed cron unchecked — it is
    // never armed, so format is moot. (The admin/wizard client clears the cron
    // field when switching to MANUAL; the VO must not 400 on a stale value.)
    expect(() => DailyResetPolicy.of(DailyResetMode.MANUAL, 'not a cron')).not.toThrow();
  });
});

describe('SystemConfiguration aggregate', () => {
  it('starts unconfigured with the default state machine and reset policy', () => {
    const config = SystemConfiguration.create(Identifier.generate());
    expect(config.isInitialSetupCompleted).toBe(false);
    expect(config.stateMachine).toBe(StateMachine.DEFAULT);
    expect(config.dailyResetPolicy).toBe(DailyResetPolicy.DEFAULT);
  });

  it('defaults brandColor to the shared --accent #2563eb (zero visual regression)', () => {
    const config = SystemConfiguration.create(Identifier.generate());
    expect(config.brandColor.value).toBe('#2563eb');
    expect(config.brandColor).toBe(BrandColor.DEFAULT);
  });

  it('defaults serviceThemes to all-light (zero visual regression)', () => {
    const config = SystemConfiguration.create(Identifier.generate());
    expect(config.serviceThemes).toBe(ServiceThemes.DEFAULT);
    expect(config.serviceThemes.toDto()).toEqual({
      kiosk: 'light',
      tv: 'light',
      caller: 'light',
      admin: 'light',
    });
  });

  it('defaults tvPanelLayout to the PRD-default grid layout (zero visual regression)', () => {
    const config = SystemConfiguration.create(Identifier.generate());
    expect(config.tvPanelLayout).toBe(TvPanelLayout.DEFAULT);
    expect(config.tvPanelLayout.toDto()).toEqual([
      { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
      { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
      { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
      { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
      { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
    ]);
  });

  it('defaults edgeRoutingLayout to the empty default map (zero visual regression)', () => {
    const config = SystemConfiguration.create(Identifier.generate());
    expect(config.edgeRoutingLayout).toBe(EdgeRoutingLayout.DEFAULT);
    expect(config.edgeRoutingLayout.toDto()).toEqual({});
  });

  it('defaults nodePositions to the empty default map (zero visual regression — autoLayout)', () => {
    const config = SystemConfiguration.create(Identifier.generate());
    expect(config.nodePositions).toBe(NodePositions.DEFAULT);
    expect(config.nodePositions.toDto()).toEqual({});
  });

  it('defaults printerConfiguration to the chrome default (zero behavior change — Chrome print dialog)', () => {
    const config = SystemConfiguration.create(Identifier.generate());
    expect(config.printerConfiguration).toBe(PrinterConfiguration.DEFAULT);
    expect(config.printerConfiguration.toDto()).toEqual({
      mode: 'chrome',
      paperWidth: 80,
      host: '',
      port: 9100,
      cutMode: 'partial',
      baudRate: 9600,
    });
  });

  it('reconstitute carries a custom brand color through', () => {
    const config = SystemConfiguration.reconstitute({
      id: Identifier.generate(),
      storeName: 'Toko Brand',
      isInitialSetupCompleted: true,
      stateMachine: StateMachine.DEFAULT,
      dailyResetPolicy: DailyResetPolicy.DEFAULT,
      brandColor: BrandColor.of('#aabbcc'),
      serviceThemes: ServiceThemes.DEFAULT,
      tvPanelLayout: TvPanelLayout.DEFAULT,
      edgeRoutingLayout: EdgeRoutingLayout.DEFAULT,
      nodePositions: NodePositions.DEFAULT,
      printerConfiguration: PrinterConfiguration.DEFAULT,
    });
    expect(config.brandColor.value).toBe('#aabbcc');
  });

  it('reconstitute carries custom per-service themes through', () => {
    const config = SystemConfiguration.reconstitute({
      id: Identifier.generate(),
      storeName: 'Toko Brand',
      isInitialSetupCompleted: true,
      stateMachine: StateMachine.DEFAULT,
      dailyResetPolicy: DailyResetPolicy.DEFAULT,
      brandColor: BrandColor.DEFAULT,
      serviceThemes: ServiceThemes.of({ kiosk: 'light', tv: 'dark', caller: 'dark', admin: 'light' }),
      tvPanelLayout: TvPanelLayout.DEFAULT,
      edgeRoutingLayout: EdgeRoutingLayout.DEFAULT,
      nodePositions: NodePositions.DEFAULT,
      printerConfiguration: PrinterConfiguration.DEFAULT,
    });
    expect(config.serviceThemes.toDto()).toEqual({
      kiosk: 'light',
      tv: 'dark',
      caller: 'dark',
      admin: 'light',
    });
  });

  it('reconstitute carries a custom TV grid layout through', () => {
    const config = SystemConfiguration.reconstitute({
      id: Identifier.generate(),
      storeName: 'Toko Brand',
      isInitialSetupCompleted: true,
      stateMachine: StateMachine.DEFAULT,
      dailyResetPolicy: DailyResetPolicy.DEFAULT,
      brandColor: BrandColor.DEFAULT,
      serviceThemes: ServiceThemes.DEFAULT,
      tvPanelLayout: TvPanelLayout.of([
        { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 8, h: 4 },
        { id: 'waitingQueue', component: 'waitingQueue', x: 8, y: 0, w: 4, h: 4 },
      ]),
      edgeRoutingLayout: EdgeRoutingLayout.DEFAULT,
      nodePositions: NodePositions.DEFAULT,
      printerConfiguration: PrinterConfiguration.DEFAULT,
    });
    expect(config.tvPanelLayout.toDto()).toEqual([
      { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 8, h: 4 },
      { id: 'waitingQueue', component: 'waitingQueue', x: 8, y: 0, w: 4, h: 4 },
    ]);
  });

  it('reconstitute carries a custom edge routing layout through', () => {
    const config = SystemConfiguration.reconstitute({
      id: Identifier.generate(),
      storeName: 'Toko Brand',
      isInitialSetupCompleted: true,
      stateMachine: StateMachine.DEFAULT,
      dailyResetPolicy: DailyResetPolicy.DEFAULT,
      brandColor: BrandColor.DEFAULT,
      serviceThemes: ServiceThemes.DEFAULT,
      tvPanelLayout: TvPanelLayout.DEFAULT,
      edgeRoutingLayout: EdgeRoutingLayout.of({
        'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
      }),
      nodePositions: NodePositions.DEFAULT,
      printerConfiguration: PrinterConfiguration.DEFAULT,
    });
    expect(config.edgeRoutingLayout.toDto()).toEqual({
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    });
  });

  it('reconstitute carries a custom node positions map through', () => {
    const config = SystemConfiguration.reconstitute({
      id: Identifier.generate(),
      storeName: 'Toko Brand',
      isInitialSetupCompleted: true,
      stateMachine: StateMachine.DEFAULT,
      dailyResetPolicy: DailyResetPolicy.DEFAULT,
      brandColor: BrandColor.DEFAULT,
      serviceThemes: ServiceThemes.DEFAULT,
      tvPanelLayout: TvPanelLayout.DEFAULT,
      edgeRoutingLayout: EdgeRoutingLayout.DEFAULT,
      nodePositions: NodePositions.of({
        WAITING: { x: 0, y: 0 },
        CALLING: { x: 240, y: 0 },
      }),
      printerConfiguration: PrinterConfiguration.DEFAULT,
    });
    expect(config.nodePositions.toDto()).toEqual({
      WAITING: { x: 0, y: 0 },
      CALLING: { x: 240, y: 0 },
    });
  });

  it('reconstitute carries a custom network-escpos printer configuration through', () => {
    const config = SystemConfiguration.reconstitute({
      id: Identifier.generate(),
      storeName: 'Toko Cetak',
      isInitialSetupCompleted: true,
      stateMachine: StateMachine.DEFAULT,
      dailyResetPolicy: DailyResetPolicy.DEFAULT,
      brandColor: BrandColor.DEFAULT,
      serviceThemes: ServiceThemes.DEFAULT,
      tvPanelLayout: TvPanelLayout.DEFAULT,
      edgeRoutingLayout: EdgeRoutingLayout.DEFAULT,
      nodePositions: NodePositions.DEFAULT,
      printerConfiguration: PrinterConfiguration.of({
        mode: 'network-escpos',
        paperWidth: 58,
        host: '192.168.1.50',
        port: 9100,
        cutMode: 'full',
      }),
    });
    expect(config.printerConfiguration.toDto()).toEqual({
      mode: 'network-escpos',
      paperWidth: 58,
      host: '192.168.1.50',
      port: 9100,
      cutMode: 'full',
      baudRate: 9600,
    });
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
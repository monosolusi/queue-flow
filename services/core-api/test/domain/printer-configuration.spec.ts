import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  PrinterConfiguration,
  type PrinterConfigurationDto,
} from '../../src/domain/store-config/value-objects/printer-configuration';

const DEFAULT_DTO: PrinterConfigurationDto = {
  mode: 'chrome',
  paperWidth: 80,
  host: '',
  port: 9100,
  cutMode: 'partial',
  baudRate: 9600,
};

describe('PrinterConfiguration', () => {
  it('of(undefined) / of(null) → DEFAULT (chrome, zero behavior change)', () => {
    expect(PrinterConfiguration.of(undefined)).toBe(PrinterConfiguration.DEFAULT);
    expect(PrinterConfiguration.of(null)).toBe(PrinterConfiguration.DEFAULT);
    expect(PrinterConfiguration.DEFAULT.toDto()).toEqual(DEFAULT_DTO);
  });

  it('of({}) → all fields default (forward-compatible partial input)', () => {
    const cfg = PrinterConfiguration.of({});
    expect(cfg.toDto()).toEqual(DEFAULT_DTO);
    expect(cfg.mode).toBe('chrome');
    expect(cfg.paperWidth).toBe(80);
    expect(cfg.host).toBe('');
    expect(cfg.port).toBe(9100);
    expect(cfg.cutMode).toBe('partial');
    expect(cfg.baudRate).toBe(9600);
  });

  it('round-trips a full network-escpos config via toDto()', () => {
    const input: PrinterConfigurationDto = {
      mode: 'network-escpos',
      paperWidth: 58,
      host: '192.168.1.50',
      port: 9100,
      cutMode: 'full',
      baudRate: 19200,
    };
    const cfg = PrinterConfiguration.of(input);
    expect(cfg.toDto()).toEqual(input);
    expect(cfg.mode).toBe('network-escpos');
    expect(cfg.paperWidth).toBe(58);
    expect(cfg.host).toBe('192.168.1.50');
    expect(cfg.port).toBe(9100);
    expect(cfg.cutMode).toBe('full');
    expect(cfg.baudRate).toBe(19200);
  });

  it('accepts a partial network-escpos input (only mode + host, rest defaults)', () => {
    const cfg = PrinterConfiguration.of({ mode: 'network-escpos', host: '10.0.0.1' });
    expect(cfg.toDto()).toEqual({
      mode: 'network-escpos',
      paperWidth: 80,
      host: '10.0.0.1',
      port: 9100,
      cutMode: 'partial',
      baudRate: 9600,
    });
  });

  it('accepts usb-serial mode (no host required; baudRate carried, host cleared)', () => {
    const cfg = PrinterConfiguration.of({ mode: 'usb-serial', baudRate: 38400, host: 'stale' });
    expect(cfg.mode).toBe('usb-serial');
    expect(cfg.host).toBe(''); // usb-serial has no network host
    expect(cfg.baudRate).toBe(38400);
  });

  it('usb-serial defaults baudRate to 9600 when omitted', () => {
    const cfg = PrinterConfiguration.of({ mode: 'usb-serial' });
    expect(cfg.baudRate).toBe(9600);
    expect(cfg.host).toBe('');
  });

  it('chrome mode normalizes a provided host to empty (toggling mode is a clean no-op)', () => {
    const cfg = PrinterConfiguration.of({ mode: 'chrome', host: 'stale-host-value' });
    expect(cfg.mode).toBe('chrome');
    expect(cfg.host).toBe('');
  });

  it('toDto() returns an independent copy (mutating the DTO does not affect the VO)', () => {
    const cfg = PrinterConfiguration.of({ mode: 'network-escpos', host: 'h' });
    const dto = cfg.toDto();
    dto.host = 'mutated';
    dto.mode = 'chrome';
    expect(cfg.host).toBe('h');
    expect(cfg.mode).toBe('network-escpos');
  });

  it.each([
    ['a string', 'not-an-object'],
    ['a number', 5],
    ['an array', [{ mode: 'chrome' }]],
    ['a boolean', true],
  ])('rejects a non-object raw (%s) with InvalidValueObjectException', (_label, raw) => {
    expect(() => PrinterConfiguration.of(raw)).toThrow(InvalidValueObjectException);
  });

  it.each([
    ['chrome-ish typo', 'chrom'],
    ['unknown mode', 'airprint'],
    ['non-string mode', 5],
  ])('rejects an invalid mode (%s)', (_label, mode) => {
    expect(() => PrinterConfiguration.of({ mode })).toThrow(InvalidValueObjectException);
  });

  it.each([57, 81, 0, 100, '80', true])('rejects an invalid paperWidth %p', (paperWidth) => {
    expect(() => PrinterConfiguration.of({ paperWidth })).toThrow(InvalidValueObjectException);
  });

  it('accepts paperWidth 58 and 80', () => {
    expect(PrinterConfiguration.of({ paperWidth: 58 }).paperWidth).toBe(58);
    expect(PrinterConfiguration.of({ paperWidth: 80 }).paperWidth).toBe(80);
  });

  it.each(['ful', 'tear', 1, true])('rejects an invalid cutMode %p', (cutMode) => {
    expect(() => PrinterConfiguration.of({ cutMode })).toThrow(InvalidValueObjectException);
  });

  it.each([5, true, { host: 'h' }, null])('rejects a non-string host %p', (host) => {
    expect(() => PrinterConfiguration.of({ host })).toThrow(InvalidValueObjectException);
  });

  it.each([
    ['a float', 9100.5],
    ['zero', 0],
    ['negative', -1],
    ['too high', 65536],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a string', '9100'],
    ['a boolean', true],
  ])('rejects an invalid port (%s, %p)', (_label, port) => {
    expect(() => PrinterConfiguration.of({ port })).toThrow(InvalidValueObjectException);
  });

  it('accepts port 1 and 65535 (boundary)', () => {
    expect(PrinterConfiguration.of({ port: 1 }).port).toBe(1);
    expect(PrinterConfiguration.of({ port: 65535 }).port).toBe(65535);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a float', 9600.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a string', '9600'],
    ['a boolean', true],
  ])('rejects an invalid baudRate (%s, %p)', (_label, baudRate) => {
    expect(() => PrinterConfiguration.of({ baudRate })).toThrow(InvalidValueObjectException);
  });

  it('accepts baudRate 9600 and 115200 (common serial speeds)', () => {
    expect(PrinterConfiguration.of({ baudRate: 9600 }).baudRate).toBe(9600);
    expect(PrinterConfiguration.of({ baudRate: 115200 }).baudRate).toBe(115200);
  });

  it('rejects network-escpos with an empty host (cross-field invariant)', () => {
    expect(() => PrinterConfiguration.of({ mode: 'network-escpos', host: '' })).toThrow(
      InvalidValueObjectException,
    );
    expect(() => PrinterConfiguration.of({ mode: 'network-escpos', host: '   ' })).toThrow(
      InvalidValueObjectException,
    );
    // host omitted entirely on network-escpos → defaults to '' → rejected.
    expect(() => PrinterConfiguration.of({ mode: 'network-escpos' })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('toString() returns JSON', () => {
    const cfg = PrinterConfiguration.of({ mode: 'network-escpos', host: 'h', paperWidth: 58 });
    expect(cfg.toString()).toBe(JSON.stringify(cfg.toDto()));
  });

  it('equals (inherited structural deep-equal): same props → equal, different → not', () => {
    const a = PrinterConfiguration.of({ mode: 'network-escpos', host: 'h' });
    const b = PrinterConfiguration.of({ mode: 'network-escpos', host: 'h' });
    const c = PrinterConfiguration.of({ mode: 'network-escpos', host: 'h', port: 80 });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    // The DEFAULT singleton is structurally equal to a fresh-of chrome config.
    expect(PrinterConfiguration.of({}).equals(PrinterConfiguration.DEFAULT)).toBe(true);
  });
});
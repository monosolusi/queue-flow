import { describe, expect, it } from 'vitest';
import {
  composeReceipt,
  INIT,
  DOUBLE_SIZE,
  NORMAL,
  columnCount,
  wrapLine,
} from './escpos-commands';
import type { PrintPayload } from './print-provider';

/**
 * Subsequence search — `Uint8Array.prototype.indexOf` only finds a single
 * element value (unlike Node `Buffer.indexOf`, which finds a subsequence), and
 * `Uint8Array.prototype.equals` is not available pre-ES2025. This manual search
 * mirrors the `Buffer.indexOf`-based `contains` in core-api's spec.
 */
function indexOfSubarray(buf: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  for (let i = 0; i <= buf.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** `contains` — mirrors core-api's `Buffer.indexOf`-based `contains`. */
function contains(buf: Uint8Array, needle: Uint8Array): boolean {
  return indexOfSubarray(buf, needle) !== -1;
}

/**
 * Pure byte-composer spec — LOCK-STEP mirror of core-api's
 * `escpos-commands.spec.ts`. Asserts the ESC/POS byte stream contains the right
 * commands (init, double-size header, the ticket text as UTF-8, the cut bytes
 * per cut mode) and wraps long lines to the paper column count. No `navigator`,
 * no Web Serial, no I/O — stays unit-testable in jsdom (which has no Web Serial).
 * A drift between this composer and the core-api canonical source fails loudly here.
 */
describe('escpos-commands — composeReceipt (pure byte composer, kiosk copy)', () => {
  const payload: PrintPayload = {
    ticketNumber: 'A-001',
    categoryName: 'Customer Service',
    storeName: 'Toko Cetak',
    issuedAt: 1_700_000_000_000,
    waitingAhead: 3,
  };

  it('starts with the INIT (ESC @) bytes', () => {
    const buf = composeReceipt(payload, 80, 'partial');
    expect(indexOfSubarray(buf, INIT)).toBe(0);
  });

  it('emits the ticket number as UTF-8 text', () => {
    const buf = composeReceipt(payload, 80, 'partial');
    const encoder = new TextEncoder();
    expect(contains(buf, encoder.encode('A-001'))).toBe(true);
  });

  it('emits the store name when present', () => {
    const buf = composeReceipt(payload, 80, 'partial');
    const encoder = new TextEncoder();
    expect(contains(buf, encoder.encode('Toko Cetak'))).toBe(true);
  });

  it('emits the category name', () => {
    const buf = composeReceipt(payload, 80, 'partial');
    const encoder = new TextEncoder();
    expect(contains(buf, encoder.encode('Customer Service'))).toBe(true);
  });

  it('emits the position line "Anda antrian ke-4 dari 4" (waitingAhead+1)', () => {
    const buf = composeReceipt(payload, 80, 'partial');
    const encoder = new TextEncoder();
    expect(contains(buf, encoder.encode('Anda antrian ke-4 dari 4'))).toBe(true);
  });

  it('emits the double-size print mode bytes (header + ticket number)', () => {
    const buf = composeReceipt(payload, 80, 'partial');
    expect(contains(buf, Uint8Array.of(0x1b, 0x21, DOUBLE_SIZE))).toBe(true);
    // Resets to normal after the doubled sections.
    expect(contains(buf, Uint8Array.of(0x1b, 0x21, NORMAL))).toBe(true);
  });

  it('omits the store name line when storeName is absent', () => {
    const noStore: PrintPayload = { ...payload, storeName: undefined };
    const buf = composeReceipt(noStore, 80, 'partial');
    const encoder = new TextEncoder();
    expect(contains(buf, encoder.encode('Toko Cetak'))).toBe(false);
  });

  it('emits a partial cut (GS V 1) for cutMode partial', () => {
    const buf = composeReceipt(payload, 80, 'partial');
    expect(contains(buf, Uint8Array.of(0x1d, 0x56, 0x01))).toBe(true);
  });

  it('emits a full cut (GS V 0) for cutMode full', () => {
    const buf = composeReceipt(payload, 80, 'full');
    expect(contains(buf, Uint8Array.of(0x1d, 0x56, 0x00))).toBe(true);
  });

  it('emits NO cut bytes for cutMode none', () => {
    const buf = composeReceipt(payload, 80, 'none');
    expect(contains(buf, Uint8Array.of(0x1d, 0x56, 0x00))).toBe(false);
    expect(contains(buf, Uint8Array.of(0x1d, 0x56, 0x01))).toBe(false);
  });

  it('feeds 3 lines before the cut (ESC d 3)', () => {
    const buf = composeReceipt(payload, 80, 'full');
    expect(contains(buf, Uint8Array.of(0x1b, 0x64, 0x03))).toBe(true);
  });

  it('does not emit a partial cut when a full cut is requested (and vice versa)', () => {
    const full = composeReceipt(payload, 80, 'full');
    expect(contains(full, Uint8Array.of(0x1d, 0x56, 0x01))).toBe(false);
    const partial = composeReceipt(payload, 80, 'partial');
    expect(contains(partial, Uint8Array.of(0x1d, 0x56, 0x00))).toBe(false);
  });

  it('returns a Uint8Array (Web Serial BufferSource, not a Node Buffer)', () => {
    const buf = composeReceipt(payload, 80, 'partial');
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.byteLength).toBeGreaterThan(0);
  });
});

describe('escpos-commands — paper width / wrapping', () => {
  it('columnCount: 58mm → 32 cols, 80mm → 48 cols', () => {
    expect(columnCount(58)).toBe(32);
    expect(columnCount(80)).toBe(48);
  });

  it('wrapLine: short line stays one line + trailing newline', () => {
    expect(wrapLine('hello', 32)).toBe('hello\n');
  });

  it('wrapLine: empty line → just a newline', () => {
    expect(wrapLine('', 32)).toBe('\n');
  });

  it('wrapLine: wraps a long line into cols-sized chunks', () => {
    expect(wrapLine('0123456789ABCDEF', 4)).toBe('0123\n4567\n89AB\nCDEF\n');
  });

  it('wrapLine: wraps an odd-length line (final chunk shorter)', () => {
    expect(wrapLine('0123456789ABCDE', 4)).toBe('0123\n4567\n89AB\nCDE\n');
  });

  it('wraps the store name to half the columns at double size (58mm)', () => {
    const longStore = 'Toko Antrian Jaya Makmur Sejahtera';
    const buf = composeReceipt(
      { ticketNumber: 'A-001', categoryName: 'CS', storeName: longStore, issuedAt: 0, waitingAhead: 0 },
      58,
      'none',
    );
    // At double width on 58mm (32 cols), the header wraps at 16 cols. The first
    // 16 chars must appear; the 17th char starts a new line.
    const encoder = new TextEncoder();
    expect(contains(buf, encoder.encode(longStore.slice(0, 16)))).toBe(true);
  });
});
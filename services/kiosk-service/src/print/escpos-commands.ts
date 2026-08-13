import type { PrintPayload } from './print-provider';

/**
 * Pure ESC/POS byte composer for the kiosk's `usb-serial` mode (FR-printer-config).
 *
 * LOCK-STEP with `services/core-api/src/infrastructure/printing/escpos/escpos-commands.ts`
 * — the canonical source. This is a duplicated copy, NOT a shared package (the QMS
 * monorepo shares types via duplicated lock-step copies, e.g. `TvGridLayout` across
 * core-api + tv-display + admin — NFR-REL-01 keeps the build offline with no workspace
 * package). The two must produce byte-identical receipts; the kiosk byte test mirrors
 * core-api's `escpos-commands.spec.ts` so a drift fails loudly.
 *
 * Framework-free and DOM-free — no `navigator.serial`, no I/O; just functions returning
 * `Uint8Array`s. This keeps the byte-level ESC/POS knowledge unit-testable in jsdom
 * (which has no Web Serial) and free of transport concerns (SRP: composing the byte
 * stream is one concern, writing it over Web Serial is another — done by
 * `UsbSerialPrintProvider`).
 *
 * Browser has no Node `Buffer`, so bytes are `Uint8Array` (Web Serial `write` accepts a
 * `BufferSource`). Text is encoded UTF-8 via `TextEncoder` (global in browsers + jsdom).
 * Printers are assumed UTF-8 capable; no codepage set is sent (v1 simplicity).
 */

const encoder = new TextEncoder();

/** ESC @ — initialize the printer (clears the print buffer + reset mode). */
const INIT: Uint8Array = Uint8Array.of(0x1b, 0x40);

/** Align: 0 = left, 1 = center, 2 = right. */
function align(n: 0 | 1 | 2): Uint8Array {
  return Uint8Array.of(0x1b, 0x61, n);
}

/** ESC ! n — set print mode bit flags. 0x00 normal, 0x30 double width+height. */
function setPrintMode(n: number): Uint8Array {
  return Uint8Array.of(0x1b, 0x21, n);
}

/** Double width + height (0x20 | 0x10). */
const DOUBLE_SIZE = 0x30;

/** Normal size. */
const NORMAL = 0x00;

/** Feed n lines (ESC d n). */
function feedLines(n: number): Uint8Array {
  return Uint8Array.of(0x1b, 0x64, n);
}

/**
 * Cut: GS V m. `full` → `GS V 0`, `partial` → `GS V 1`, `none` → empty (leave
 * the paper uncut for a manual tear-off). `feedLines(3)` is sent before the cut
 * regardless so the receipt clears the print head.
 */
function cut(mode: 'full' | 'partial' | 'none'): Uint8Array {
  if (mode === 'full') return Uint8Array.of(0x1d, 0x56, 0x00);
  if (mode === 'partial') return Uint8Array.of(0x1d, 0x56, 0x01);
  return new Uint8Array(0);
}

/** Column count per paper width: 58mm → 32 cols, 80mm → 48 cols. */
function columnCount(paperWidth: 58 | 80): number {
  return paperWidth === 58 ? 32 : 48;
}

/**
 * Char-wraps `line` to `cols` columns (a simple character chunk — ESC/POS has
 * no auto-wrap, so overlong lines would run off the paper edge). Returns the
 * wrapped text with `\n` after each chunk.
 */
function wrapLine(line: string, cols: number): string {
  if (line.length === 0) return '\n';
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += cols) {
    chunks.push(line.slice(i, i + cols));
  }
  return chunks.join('\n') + '\n';
}

/** Encodes `text` as UTF-8. */
function text(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Concatenates `parts` into a single `Uint8Array`. */
function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/**
 * Composes the full ESC/POS receipt byte stream for `payload` on the given
 * paper width with the given cut mode. Layout (mirrors core-api):
 *
 * 1. INIT (reset the printer)
 * 2. center align
 * 3. (if storeName) double-size header + store name + newline + normal size
 * 4. date line (`issuedAt` formatted `id-ID`) + newline
 * 5. category name + newline
 * 6. double-size ticket number + newline + normal size
 * 7. position line ("Anda antrian ke-{n} dari {n}") + newline
 * 8. feed 3 lines (clear the print head before the cut)
 * 9. cut (full / partial / none)
 *
 * Long lines are char-wrapped to the paper column count (58mm → 32, 80mm → 48).
 */
export function composeReceipt(
  payload: PrintPayload,
  paperWidth: 58 | 80,
  cutMode: 'full' | 'partial' | 'none',
): Uint8Array {
  const cols = columnCount(paperWidth);
  const parts: Uint8Array[] = [INIT, align(1)]; // center

  if (payload.storeName) {
    parts.push(setPrintMode(DOUBLE_SIZE));
    parts.push(text(wrapLine(payload.storeName, Math.floor(cols / 2))));
    parts.push(setPrintMode(NORMAL));
  }

  const dateLine = new Date(payload.issuedAt).toLocaleString('id-ID');
  parts.push(text(wrapLine(dateLine, cols)));

  parts.push(text(wrapLine(payload.categoryName, cols)));

  parts.push(setPrintMode(DOUBLE_SIZE));
  parts.push(text(wrapLine(payload.ticketNumber, Math.floor(cols / 2))));
  parts.push(setPrintMode(NORMAL));

  const position = payload.waitingAhead + 1;
  parts.push(text(wrapLine(`Anda antrian ke-${position} dari ${position}`, cols)));

  parts.push(feedLines(3));
  parts.push(cut(cutMode));

  return concat(parts);
}

// Exports for unit tests (the byte constants are assertable proof the right
// commands were emitted).
export { INIT, DOUBLE_SIZE, NORMAL, columnCount, wrapLine };
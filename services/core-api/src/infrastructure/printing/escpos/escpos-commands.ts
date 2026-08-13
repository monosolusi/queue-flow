import type { CutMode, PaperWidth } from '../../../domain/store-config/value-objects/printer-configuration';
import type { TicketPrintPayload } from '../../../domain/store-config/printer-driver.port';

/**
 * Pure ESC/POS byte composer (FR-printer-config). Framework-free — no `net`, no
 * I/O; just functions returning `Buffer`s. This keeps the byte-level ESC/POS
 * knowledge unit-testable without a socket and free of transport concerns (SRP:
 * composing the byte stream is one concern, sending it over TCP is another).
 *
 * Printers are assumed UTF-8 capable (the vast majority of network ESC/POS
 * printers are, and the Indonesian receipt text is ASCII-safe for the parts
 * that matter — no codepage set is sent, keeping v1 simple). All text is
 * encoded with `Buffer.from(s, 'utf8')`.
 */

/** ESC @ — initialize the printer (clears the print buffer + reset mode). */
const INIT = Buffer.from([0x1b, 0x40]);

/** Align: 0 = left, 1 = center, 2 = right. */
function align(n: 0 | 1 | 2): Buffer {
  return Buffer.from([0x1b, 0x61, n]);
}

/** ESC ! n — set print mode bit flags. 0x00 normal, 0x30 double width+height. */
function setPrintMode(n: number): Buffer {
  return Buffer.from([0x1b, 0x21, n]);
}

/** Double width + height (0x20 | 0x10). */
const DOUBLE_SIZE = 0x30;

/** Normal size. */
const NORMAL = 0x00;

/** Feed n lines (ESC d n). */
function feedLines(n: number): Buffer {
  return Buffer.from([0x1b, 0x64, n]);
}

/**
 * Cut: GS V m. `full` → `GS V 0`, `partial` → `GS V 1`, `none` → empty (leave
 * the paper uncut for a manual tear-off). `feedLines(3)` is sent before the cut
 * regardless so the receipt clears the print head.
 */
function cut(mode: CutMode): Buffer {
  if (mode === 'full') return Buffer.from([0x1d, 0x56, 0x00]);
  if (mode === 'partial') return Buffer.from([0x1d, 0x56, 0x01]);
  return Buffer.alloc(0);
}

/** Column count per paper width: 58mm → 32 cols, 80mm → 48 cols. */
function columnCount(paperWidth: PaperWidth): number {
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
function text(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

/**
 * Composes the full ESC/POS receipt byte stream for `payload` on the given
 * paper width with the given cut mode. Layout:
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
  payload: TicketPrintPayload,
  paperWidth: PaperWidth,
  cutMode: CutMode,
): Buffer {
  const cols = columnCount(paperWidth);
  const parts: Buffer[] = [INIT, align(1)]; // center

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

  return Buffer.concat(parts);
}

// Exports for unit tests (the byte constants are assertable proof the right
// commands were emitted).
export { INIT, DOUBLE_SIZE, NORMAL, columnCount, wrapLine };
import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * How the kiosk produces a physical ticket. Two modes:
 * - `'chrome'` — the kiosk's browser print dialog (Chrome's default printer).
 *   No network host is involved; the kiosk renders the receipt HTML and the
 *   operator picks a paper size in the dialog. This is the zero-behavior-change
 *   default so a store that never configures this keeps printing exactly as
 *   before.
 * - `'network-escpos'` — the kiosk POSTs the print payload to core-api
 *   (`POST /api/print/ticket`), which composes ESC/POS bytes (incl. the cut
 *   command) and streams them over a raw TCP socket to `host:port`. A browser
 *   PWA cannot open raw TCP sockets, so the LAN-attached printer is proxied
 *   through core-api (the only process that may use Node's `net`).
 */
export type PrinterMode = 'chrome' | 'network-escpos';

export const PRINTER_MODES: readonly PrinterMode[] = ['chrome', 'network-escpos'];

function isPrinterMode(value: unknown): value is PrinterMode {
  return typeof value === 'string' && (PRINTER_MODES as readonly string[]).includes(value);
}

/** Receipt paper width in millimeters. Drives the ESC/POS column wrap (58→32,
 *  80→48 cols). */
export type PaperWidth = 58 | 80;

export const PAPER_WIDTHS = [58, 80] as const;

function isPaperWidth(value: unknown): value is PaperWidth {
  return value === 58 || value === 80;
}

/** When the ESC/POS cut command fires after the receipt. `none` leaves the
 *  paper uncut (a tear-off manual feed). */
export type CutMode = 'full' | 'partial' | 'none';

export const CUT_MODES: readonly CutMode[] = ['full', 'partial', 'none'];

function isCutMode(value: unknown): value is CutMode {
  return typeof value === 'string' && (CUT_MODES as readonly string[]).includes(value);
}

/** The validated, immutable printer configuration props. */
export interface PrinterConfigurationProps {
  readonly mode: PrinterMode;
  readonly paperWidth: PaperWidth;
  readonly host: string;
  readonly port: number;
  readonly cutMode: CutMode;
}

/** Wire DTO (the shape returned by `toDto()` and carried on the config
 *  GET/PUT under the top-level `printerConfiguration` field). Mutable so the
 *  admin/wizard client can edit it before sending. */
export interface PrinterConfigurationDto {
  mode: PrinterMode;
  paperWidth: PaperWidth;
  host: string;
  port: number;
  cutMode: CutMode;
}

/**
 * Printer configuration persisted on {@link SystemConfiguration} as a single
 * JSONB object column (the `daily_reset_policy` nested-props precedent, not
 * the keyed-map `node_positions` column — a flat object of scalars is a nested
 * value object). The admin/wizard client reads `GET /api/system/config`, edits
 * the printer section, and writes the whole object back on save. The default
 * is `{ mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode:
 * 'partial' }` — `chrome` mode = zero behavior change (the kiosk keeps using
 * Chrome's print dialog), so a store that never configures this prints exactly
 * as before.
 *
 * `of()` is permissive on *missing* (a `undefined`/`null` raw from the
 * pre-migration boot window or a JSON `null`) so a reconstituted row from before
 * this column existed recovers to the default (chrome mode) without a
 * migration. It is also permissive on *partially-missing* fields: a present
 * object that omits `port`/`cutMode`/etc. defaults each to its canonical value,
 * so a forward-compatible client that sends only `{ mode, host }` is accepted.
 * It is strict only on *present-but-invalid* fields: a non-object raw, a
 * present `mode`/`paperWidth`/`cutMode` outside its enum, or a present
 * `port` that is not an integer 1..65535 throws `InvalidValueObjectException`
 * (→ HTTP 400) so a malformed PUT fails fast (NFR-REL-02 — no illegal config
 * burns a write).
 *
 * Cross-field invariant: `mode === 'network-escpos'` requires a non-empty
 * `host` (a network printer with no address is uncallable); `mode === 'chrome'`
 * forces `host = ''` (chrome mode has no host — a stray host is ignored, not
 * rejected, so toggling mode without clearing host is a clean no-op rather than
 * a 400).
 *
 * Not change-gated for audit — `printerConfiguration` is an operational
 * concern, like `nodePositions`/`edgeRoutingLayout`/`tvPanelLayout`, and is not
 * in the NFR-SEC-02 audited list (manual reset, state-schema, routing).
 * `equals` is inherited (structural deep-equal) and available if a future
 * ticket adds printer-change diff-audit.
 */
export class PrinterConfiguration extends ValueObject<PrinterConfigurationProps> {
  private constructor(props: PrinterConfigurationProps) {
    super(props);
  }

  public static of(raw: unknown): PrinterConfiguration {
    // Non-object (undefined/null from the pre-migration boot window or a JSON
    // null) → chrome default (zero behavior change). A present-but-wrong-shape
    // value (string, array, number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return PrinterConfiguration.DEFAULT;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `printer configuration must be a plain object, got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;

    // mode: optional → 'chrome' default; present-but-invalid enum → reject.
    const modeRaw = incoming.mode;
    let mode: PrinterMode;
    if (modeRaw === undefined) {
      mode = 'chrome';
    } else if (isPrinterMode(modeRaw)) {
      mode = modeRaw;
    } else {
      throw new InvalidValueObjectException(
        `printer configuration.mode must be one of [${PRINTER_MODES.join(', ')}], got '${String(modeRaw)}'`,
      );
    }

    // paperWidth: optional → 80 default; present-but-invalid → reject.
    const paperWidthRaw = incoming.paperWidth;
    let paperWidth: PaperWidth;
    if (paperWidthRaw === undefined) {
      paperWidth = 80;
    } else if (isPaperWidth(paperWidthRaw)) {
      paperWidth = paperWidthRaw;
    } else {
      throw new InvalidValueObjectException(
        `printer configuration.paperWidth must be one of [${PAPER_WIDTHS.join(', ')}], got '${String(paperWidthRaw)}'`,
      );
    }

    // cutMode: optional → 'partial' default; present-but-invalid enum → reject.
    const cutModeRaw = incoming.cutMode;
    let cutMode: CutMode;
    if (cutModeRaw === undefined) {
      cutMode = 'partial';
    } else if (isCutMode(cutModeRaw)) {
      cutMode = cutModeRaw;
    } else {
      throw new InvalidValueObjectException(
        `printer configuration.cutMode must be one of [${CUT_MODES.join(', ')}], got '${String(cutModeRaw)}'`,
      );
    }

    // host: optional → '' default; present-but-non-string → reject. Empty is
    // allowed (chrome mode carries no host; network-escpos is rejected below
    // when host is empty).
    const hostRaw = incoming.host;
    let host: string;
    if (hostRaw === undefined) {
      host = '';
    } else if (typeof hostRaw === 'string') {
      host = hostRaw;
    } else {
      throw new InvalidValueObjectException(
        `printer configuration.host must be a string, got '${String(hostRaw)}'`,
      );
    }

    // port: optional → 9100 default; present-but-not-an-integer-in-range → reject.
    const portRaw = incoming.port;
    let port: number;
    if (portRaw === undefined) {
      port = 9100;
    } else if (
      typeof portRaw === 'number' &&
      Number.isFinite(portRaw) &&
      Number.isInteger(portRaw) &&
      portRaw >= 1 &&
      portRaw <= 65535
    ) {
      // `typeof === 'number'` narrows for the range comparison; `Number.isFinite`
      // + `Number.isInteger` are runtime guards (reject NaN/Infinity/fractional),
      // and the `typeof`-narrowed value needs no further cast.
      port = portRaw;
    } else {
      throw new InvalidValueObjectException(
        `printer configuration.port must be an integer 1..65535, got '${String(portRaw)}'`,
      );
    }

    // Cross-field invariant: network-escpos requires a non-empty host; chrome
    // mode has no host (normalize to '' so a stray host is a clean no-op).
    if (mode === 'network-escpos') {
      if (host.trim() === '') {
        throw new InvalidValueObjectException(
          'network-escpos printer requires a host',
        );
      }
    } else {
      host = '';
    }

    return new PrinterConfiguration({ mode, paperWidth, host, port, cutMode });
  }

  /** Chrome mode, 80mm paper, empty host, default port 9100, partial cut —
   *  zero behavior change (the kiosk keeps using Chrome's print dialog). */
  public static DEFAULT: PrinterConfiguration = PrinterConfiguration.of({
    mode: 'chrome',
    paperWidth: 80,
    host: '',
    port: 9100,
    cutMode: 'partial',
  });

  public get mode(): PrinterMode {
    return this.props.mode;
  }

  public get paperWidth(): PaperWidth {
    return this.props.paperWidth;
  }

  public get host(): string {
    return this.props.host;
  }

  public get port(): number {
    return this.props.port;
  }

  public get cutMode(): CutMode {
    return this.props.cutMode;
  }

  /** Returns a plain object copy so callers can mutate the DTO without
   *  affecting the VO (all props are primitives, so a shallow copy suffices). */
  public toDto(): PrinterConfigurationDto {
    return {
      mode: this.props.mode,
      paperWidth: this.props.paperWidth,
      host: this.props.host,
      port: this.props.port,
      cutMode: this.props.cutMode,
    };
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}
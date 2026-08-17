/**
 * Thermal print provider (FR-KSK-02/03, NFR-PERF-03).
 *
 * The kiosk prints a physical ticket immediately after issuing one. The print
 * mechanism is an OCP extension point: {@link IPrintProvider} is the interface;
 * {@link BrowserPrintProvider} (hidden iframe + `window.print`) is the default
 * for a browser-attached kiosk,
 * {@link NetworkEscPosPrintProvider} proxies a network printer through core-api,
 * and {@link UsbSerialPrintProvider} drives a USB thermal printer directly over
 * Web Serial. A provider can be swapped in without touching the page (OCP — add
 * a provider, don't modify the page). The latency budget is < 1.5 s from touch
 * to print trigger (NFR-PERF-03); the page fires print immediately after the
 * ticket is issued.
 */
import { composeReceipt, wrapStoreName, columnCount } from './escpos-commands';

/** The data printed on the physical ticket. `storeName` is optional (the kiosk
 * may not have fetched the store config when it prints). `waitingAhead` is the
 * number of people already WAITING in this category when the ticket was issued
 * (FR-KSK-03 "Jumlah Antrian Di Belakang"); the visitor is the newest waiting
 * ticket, so their position and the total waiting count are both
 * `waitingAhead + 1` (e.g. "Anda antrian ke-3 dari 3"). */
export interface PrintPayload {
  readonly ticketNumber: string;
  readonly categoryName: string;
  readonly storeName?: string;
  readonly issuedAt: number;
  readonly waitingAhead: number;
}

/** Extension point for ticket printing (OCP — new providers don't touch the page). */
export interface IPrintProvider {
  print(payload: PrintPayload): Promise<void>;
}

/** No-op provider used when printing is disabled (headless / tests that don't
 * assert printing). Keeps the page's `printProvider` prop optional. */
export class NoOpPrintProvider implements IPrintProvider {
  async print(_payload: PrintPayload): Promise<void> {
    /* no-op */
  }
}

export type IframeFactory = () => HTMLIFrameElement;

/** Default iframe factory — a fresh detached iframe per print. */
function defaultCreateIframe(): HTMLIFrameElement {
  return document.createElement('iframe');
}

/** Thermal paper width in millimeters — drives the `@page` size rule. */
export type PaperWidth = 58 | 80;

/** When the ESC/POS cut command fires after the receipt (mirrors core-api). */
export type CutMode = 'full' | 'partial' | 'none';

/** Options for {@link BrowserPrintProvider} (all optional, sensible defaults). */
export interface BrowserPrintProviderOptions {
  /** Paper width for the `@page` size (defaults to 80mm — prior behavior). */
  readonly paperWidth?: PaperWidth;
  /** Iframe factory (test seam; defaults to a fresh detached iframe). */
  readonly createIframe?: IframeFactory;
}

/**
 * Default provider for a browser-attached kiosk: renders the ticket into a
 * hidden iframe and calls `print()`. The iframe is created/removed per print
 * so no stale content carries between tickets. Print failures (e.g. the print
 * dialog is blocked) resolve without rejecting so a printing failure never
 * blocks the visitor flow — the on-screen result page is the source of truth.
 *
 * The `@page { size: <paperWidth>mm auto; margin: 2mm }` rule DEFINES the paper
 * size so Chrome's print dialog prints at the configured thermal width instead
 * of an undefined default — the fix for "the paper size is not defined".
 */
export class BrowserPrintProvider implements IPrintProvider {
  private readonly paperWidth: PaperWidth;
  private readonly createIframe: IframeFactory;

  constructor(opts: BrowserPrintProviderOptions = {}) {
    this.paperWidth = opts.paperWidth ?? 80;
    this.createIframe = opts.createIframe ?? defaultCreateIframe;
  }

  async print(payload: PrintPayload): Promise<void> {
    const iframe = this.createIframe();
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);
    try {
      const doc = iframe.contentWindow?.document;
      if (!doc) return;
      doc.open();
      doc.write(renderTicketHtml(payload, this.paperWidth));
      doc.close();
      // Yield one tick so the DOM flushes before the print dialog opens.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      // Print failure is non-fatal; the result screen still shows the ticket.
    } finally {
      iframe.remove();
    }
  }
}

/**
 * Prints via a networked ESC/POS thermal printer proxied through core-api
 * (`POST /api/print/ticket`). The browser cannot open raw TCP (NFR-REL-01 keeps
 * all IO server-side), so core-api forwards the ESC/POS bytes + cut command to
 * the configured printer host/port. The actual fetch is injected as a
 * `printTicket` function so this provider never imports the API type (OCP/ISP —
 * it depends only on the print seam, not the kiosk API surface) and tests can
 * substitute a fake without real network. Print failures resolve without
 * rejecting — the same non-fatal contract as {@link BrowserPrintProvider}.
 */
export class NetworkEscPosPrintProvider implements IPrintProvider {
  constructor(
    private readonly printTicket: (payload: PrintPayload) => Promise<void>,
  ) {}

  async print(payload: PrintPayload): Promise<void> {
    try {
      await this.printTicket(payload);
    } catch {
      // Print failure is non-fatal; the result screen still shows the ticket.
    }
  }
}

/**
 * The injectable Web Serial API surface — the test seam for
 * {@link UsbSerialPrintProvider}. jsdom has no `navigator.serial`, so the
 * provider takes a `serial` option (mirror of the `WebSocketCtor`/`AudioCtor`
 * convention: providers own the resource options, never a pre-built instance).
 * Production wires `navigator.serial`; tests pass a fake.
 */
export interface SerialLike {
  /** Returns the ports the operator already granted (persists per origin). */
  getPorts(): Promise<readonly SerialPortLike[]>;
}

/** The subset of `SerialPort` the provider uses (open → write → close). */
export interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  writable: { getWriter(): { write(data: Uint8Array): Promise<void>; releaseLock(): void } } | null;
  close(): Promise<void>;
}

/** The default serial surface — the browser's `navigator.serial` (or null when
 *  unavailable, e.g. a non-Web-Serial browser). The provider treats null as
 *  "no printer paired" and resolves non-fatal. */
function defaultSerial(): SerialLike | null {
  if (typeof navigator === 'undefined') return null;
  const s = (navigator as unknown as { serial?: SerialLike }).serial;
  return s ?? null;
}

/** Options for {@link UsbSerialPrintProvider}. `serial` is the test seam. */
export interface UsbSerialPrintProviderOptions {
  /** Paper width — drives the ESC/POS column wrap (58 → 32, 80 → 48 cols). */
  readonly paperWidth: PaperWidth;
  /** Cut command after the receipt. */
  readonly cutMode: CutMode;
  /** Serial speed for `port.open({ baudRate })` (default 9600). */
  readonly baudRate: number;
  /** Injectable Web Serial surface (defaults to `navigator.serial`). */
  readonly serial?: SerialLike | null;
}

/**
 * Prints via a USB thermal printer cabled to the kiosk box, using the Web Serial
 * API (`navigator.serial`) — OCP's third provider (the page is untouched). A USB
 * printer is kiosk-local: core-api cannot proxy it (USB is not on the server), so
 * this provider composes the ESC/POS bytes itself (via {@link composeReceipt},
 * the kiosk copy of the core-api composer) and writes them directly to the port.
 *
 * Pairing is a one-time operator action: the kiosk setup overlay calls
 * `requestPort()` under a user gesture, and the browser persists the grant. This
 * provider then reads the granted ports via `getPorts()` — if none are granted
 * (the printer was never paired, or the permission was cleared), `print()`
 * resolves non-fatal (the result screen still shows the ticket); it does NOT call
 * `requestPort()` itself (that needs a user gesture the unattended print path
 * cannot provide). Print failures (port open/write error) are also non-fatal —
 * the same contract as {@link BrowserPrintProvider}/{@link NetworkEscPosPrintProvider}.
 */
export class UsbSerialPrintProvider implements IPrintProvider {
  private readonly paperWidth: PaperWidth;
  private readonly cutMode: CutMode;
  private readonly baudRate: number;
  private readonly serial: SerialLike | null;

  constructor(opts: UsbSerialPrintProviderOptions) {
    this.paperWidth = opts.paperWidth;
    this.cutMode = opts.cutMode;
    this.baudRate = opts.baudRate;
    this.serial = opts.serial === undefined ? defaultSerial() : opts.serial;
  }

  async print(payload: PrintPayload): Promise<void> {
    try {
      if (!this.serial) return; // Web Serial unavailable — non-fatal.
      const ports = await this.serial.getPorts();
      if (ports.length === 0) return; // Not paired yet — non-fatal.
      const port = ports[0];
      await port.open({ baudRate: this.baudRate });
      // `port.close()` MUST run once open() succeeds, on EVERY path (success,
      // a null writable stream, or a write throw). Web Serial's getPorts()
      // returns persistent per-origin port handles, so an already-open port
      // makes the NEXT print's open() reject with InvalidStateError — silently
      // no-op'ing every later USB print until the page reloads. Closing in a
      // finally keeps the non-fatal contract self-healing per print, not just
      // "promise resolves". (close() itself can reject if the port was never
      // fully opened — swallow that too.)
      try {
        const writer = port.writable?.getWriter();
        if (!writer) return;
        try {
          const bytes = composeReceipt(payload, this.paperWidth, this.cutMode);
          await writer.write(bytes);
        } finally {
          writer.releaseLock();
        }
      } finally {
        await port.close().catch(() => {
          /* already-closed / open-incomplete — non-fatal */
        });
      }
    } catch {
      // Print failure is non-fatal; the result screen still shows the ticket.
    }
  }
}

function renderTicketHtml(payload: PrintPayload, paperWidth: PaperWidth): string {
  // Pre-split the store name with the SAME pure helper the thermal paths use
  // (`wrapStoreName`), at the SAME column budget (half the paper columns — the
  // header renders double-size). The HTML body is monospace, so char-length is
  // a valid width measure and this is the single source of truth for the
  // header wrap across all 3 print paths (thermal/network/browser). `escapeHtml`
  // only escapes `&<>"'` — `\n` is preserved and rendered via `white-space:pre-line`.
  const headerCols = Math.floor(columnCount(paperWidth) / 2);
  const storeNameLines = payload.storeName ? wrapStoreName(payload.storeName, headerCols) : '';
  const store = storeNameLines ? `<h2 class="store">${escapeHtml(storeNameLines)}</h2>` : '';
  const when = new Date(payload.issuedAt).toLocaleString();
  // FR-KSK-03 "Jumlah Antrian Di Belakang": at issuance the visitor is the
  // newest waiting ticket, so position == total == waitingAhead + 1.
  const position = payload.waitingAhead + 1;
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Tiket</title>' +
    '<style>' +
    // The `@page` rule defines the paper size so Chrome's print dialog prints
    // at the configured thermal width instead of an undefined default. `auto`
    // height lets the receipt grow with the content; a small 2mm margin gives
    // the thermal look without clipping the monospace text.
    `@page{size:${paperWidth}mm auto;margin:2mm}` +
    `body{font-family:monospace;text-align:center;width:${paperWidth}mm;padding:1rem}` +
    'h1{font-size:2.5rem;margin:.2rem;letter-spacing:.05em}.muted{color:#555}' +
    // `.store` renders the pre-split header from `wrapStoreName` (`\n` → line
    // breaks via `white-space:pre-line`). The `overflow:hidden` + `max-height`
    // is a safety net capping at 2 visual lines with NO ellipsis — consistent
    // with the no-marker hard-break in `wrapStoreName`. font-size 1.05rem fits
    // cols/2=16 monospace chars in 58mm and cols/2=24 in 80mm with margin.
    '.store{white-space:pre-line;font-size:1.05rem;line-height:1.25;max-height:2.5em;overflow:hidden;margin:.2rem 0 .4rem}' +
    '</style>' +
    '</head><body>' +
    store +
    `<p class="muted">${escapeHtml(when)}</p>` +
    `<p>${escapeHtml(payload.categoryName)}</p>` +
    `<h1>${escapeHtml(payload.ticketNumber)}</h1>` +
    `<p class="muted">Anda antrian ke-${position} dari ${position}</p>` +
    '</body></html>'
  );
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );
}
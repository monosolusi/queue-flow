/**
 * Thermal print provider (FR-KSK-02/03, NFR-PERF-03).
 *
 * The kiosk prints a physical ticket immediately after issuing one. The print
 * mechanism is an OCP extension point: {@link IPrintProvider} is the interface;
 * {@link BrowserPrintProvider} (hidden iframe + `window.print`) is the default
 * for a browser-attached kiosk, and a future ESC/POS-over-Serial provider can
 * be swapped in without touching the page (OCP — add a provider, don't modify
 * the page). The latency budget is < 1.5 s from touch to print trigger
 * (NFR-PERF-03); the page fires print immediately after the ticket is issued.
 */

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

function renderTicketHtml(payload: PrintPayload, paperWidth: PaperWidth): string {
  const store = payload.storeName
    ? `<h2 class="store">${escapeHtml(payload.storeName)}</h2>`
    : '';
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
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
 * may not have fetched the store config when it prints). */
export interface PrintPayload {
  readonly ticketNumber: string;
  readonly categoryName: string;
  readonly storeName?: string;
  readonly issuedAt: number;
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

/**
 * Default provider for a browser-attached kiosk: renders the ticket into a
 * hidden iframe and calls `print()`. The iframe is created/removed per print
 * so no stale content carries between tickets. Print failures (e.g. the print
 * dialog is blocked) resolve without rejecting so a printing failure never
 * blocks the visitor flow — the on-screen result page is the source of truth.
 */
export class BrowserPrintProvider implements IPrintProvider {
  constructor(private readonly createIframe: IframeFactory = defaultCreateIframe) {}

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
      doc.write(renderTicketHtml(payload));
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

function renderTicketHtml(payload: PrintPayload): string {
  const store = payload.storeName
    ? `<h2 class="store">${escapeHtml(payload.storeName)}</h2>`
    : '';
  const when = new Date(payload.issuedAt).toLocaleString();
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Tiket</title>' +
    '<style>body{font-family:monospace;text-align:center;padding:1rem}' +
    'h1{font-size:2.5rem;margin:.2rem;letter-spacing:.05em}.muted{color:#555}</style>' +
    '</head><body>' +
    store +
    `<p class="muted">${escapeHtml(when)}</p>` +
    `<p>${escapeHtml(payload.categoryName)}</p>` +
    `<h1>${escapeHtml(payload.ticketNumber)}</h1>` +
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
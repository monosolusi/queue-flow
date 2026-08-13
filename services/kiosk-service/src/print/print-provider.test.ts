import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserPrintProvider,
  NetworkEscPosPrintProvider,
  NoOpPrintProvider,
} from './print-provider';
import type { PrintPayload } from './print-provider';

const payload: PrintPayload = {
  ticketNumber: 'A-001',
  categoryName: 'Customer Service',
  storeName: 'Toko Contoh',
  issuedAt: 1_700_000_000_000,
  waitingAhead: 2,
};

/** A minimal fake iframe/document capturing written HTML and print() calls. */
function makeFakeIframe() {
  const printCall = vi.fn();
  const focusCall = vi.fn();
  // Holder object so the mock's mutation is visible to the test (a bare
  // destructured `let written` would copy the primitive and never update).
  const state = { written: '' };
  const doc = {
    open: vi.fn(),
    write: vi.fn((html: string) => {
      state.written = html;
    }),
    close: vi.fn(),
  };
  const iframe = {
    style: {} as CSSStyleDeclaration,
    contentWindow: { document: doc, focus: focusCall, print: printCall },
    remove: vi.fn(),
  } as unknown as HTMLIFrameElement;
  return { iframe, printCall, focusCall, state };
}

describe('NoOpPrintProvider', () => {
  it('resolves without doing anything', async () => {
    const provider = new NoOpPrintProvider();
    await expect(provider.print(payload)).resolves.toBeUndefined();
  });
});

describe('BrowserPrintProvider (FR-KSK-02/03)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('writes the ticket into a hidden iframe and calls print()', async () => {
    const { iframe, printCall, focusCall, state } = makeFakeIframe();
    const createIframe = vi.fn(() => iframe);
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation(() => iframe);

    const provider = new BrowserPrintProvider({ createIframe });
    await provider.print(payload);

    expect(createIframe).toHaveBeenCalledTimes(1);
    // The iframe is hidden (zero size, off-screen) so it never flashes.
    expect(iframe.style.width).toBe('0');
    expect(iframe.style.height).toBe('0');
    // The ticket number and store name land in the printed HTML.
    expect(state.written).toContain('A-001');
    expect(state.written).toContain('Toko Contoh');
    // FR-KSK-03: the queue-position line ("Anda antrian ke-N dari N") renders —
    // at issuance position == total == waitingAhead + 1.
    expect(state.written).toContain('Anda antrian ke-3 dari 3');
    expect(focusCall).toHaveBeenCalledTimes(1);
    expect(printCall).toHaveBeenCalledTimes(1);
    // The iframe is removed after printing (no stale content between tickets).
    expect(iframe.remove).toHaveBeenCalledTimes(1);

    appendSpy.mockRestore();
  });

  it('defines the paper size via @page (80mm default)', async () => {
    const { iframe, state } = makeFakeIframe();
    const createIframe = vi.fn(() => iframe);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => iframe);

    const provider = new BrowserPrintProvider({ createIframe });
    await provider.print(payload);

    // The @page rule defines the paper size so Chrome prints at 80mm instead of
    // an undefined default — the fix for "the paper size is not defined".
    expect(state.written).toContain('@page{size:80mm auto;margin:2mm}');
    expect(state.written).toContain('body{font-family:monospace;text-align:center;width:80mm');
  });

  it('honors a 58mm paper width', async () => {
    const { iframe, state } = makeFakeIframe();
    const createIframe = vi.fn(() => iframe);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => iframe);

    const provider = new BrowserPrintProvider({ paperWidth: 58, createIframe });
    await provider.print(payload);

    expect(state.written).toContain('@page{size:58mm auto;margin:2mm}');
    expect(state.written).toContain('width:58mm');
  });

  it('renders without a store name when storeName is omitted', async () => {
    const { iframe, state } = makeFakeIframe();
    const createIframe = vi.fn(() => iframe);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => iframe);

    const provider = new BrowserPrintProvider({ createIframe });
    await provider.print({
      ticketNumber: 'B-002',
      categoryName: 'Kasir',
      issuedAt: 1,
      waitingAhead: 0,
    });

    expect(state.written).toContain('B-002');
    expect(state.written).not.toContain('class="store"');
    // The queue-position line still renders (first in queue → "ke-1 dari 1").
    expect(state.written).toContain('Anda antrian ke-1 dari 1');
  });

  it('resolves (does not reject) when the print dialog throws', async () => {
    const { iframe, printCall } = makeFakeIframe();
    printCall.mockImplementation(() => {
      throw new Error('blocked');
    });
    const createIframe = vi.fn(() => iframe);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => iframe);

    const provider = new BrowserPrintProvider({ createIframe });
    // A print failure is non-fatal — the result screen is the source of truth.
    await expect(provider.print(payload)).resolves.toBeUndefined();
  });

  it('resolves when the iframe has no contentWindow document (degraded)', async () => {
    const iframe = { style: {}, contentWindow: {}, remove: vi.fn() } as unknown as HTMLIFrameElement;
    const createIframe = vi.fn(() => iframe);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => iframe);

    const provider = new BrowserPrintProvider({ createIframe });
    await expect(provider.print(payload)).resolves.toBeUndefined();
  });
});

describe('NetworkEscPosPrintProvider (FR-KSK-02, network ESC/POS)', () => {
  it('calls the injected printTicket fn with the payload', async () => {
    const printTicket = vi.fn(() => Promise.resolve());
    const provider = new NetworkEscPosPrintProvider(printTicket);

    await provider.print(payload);

    expect(printTicket).toHaveBeenCalledTimes(1);
    expect(printTicket).toHaveBeenCalledWith(payload);
  });

  it('resolves (does not reject) when printTicket rejects (non-fatal)', async () => {
    const printTicket = vi.fn(() => Promise.reject(new Error('printer unreachable')));
    const provider = new NetworkEscPosPrintProvider(printTicket);

    // A print failure is non-fatal — the result screen is the source of truth.
    await expect(provider.print(payload)).resolves.toBeUndefined();
  });

  it('resolves when printTicket throws synchronously', async () => {
    const printTicket = vi.fn(() => {
      throw new Error('sync blowup');
    });
    const provider = new NetworkEscPosPrintProvider(printTicket);

    await expect(provider.print(payload)).resolves.toBeUndefined();
  });
});
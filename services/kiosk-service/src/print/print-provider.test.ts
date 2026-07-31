import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserPrintProvider, NoOpPrintProvider } from './print-provider';
import type { PrintPayload } from './print-provider';

const payload: PrintPayload = {
  ticketNumber: 'A-001',
  categoryName: 'Customer Service',
  storeName: 'Toko Contoh',
  issuedAt: 1_700_000_000_000,
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

    const provider = new BrowserPrintProvider(createIframe);
    await provider.print(payload);

    expect(createIframe).toHaveBeenCalledTimes(1);
    // The iframe is hidden (zero size, off-screen) so it never flashes.
    expect(iframe.style.width).toBe('0');
    expect(iframe.style.height).toBe('0');
    // The ticket number and store name land in the printed HTML.
    expect(state.written).toContain('A-001');
    expect(state.written).toContain('Toko Contoh');
    expect(focusCall).toHaveBeenCalledTimes(1);
    expect(printCall).toHaveBeenCalledTimes(1);
    // The iframe is removed after printing (no stale content between tickets).
    expect(iframe.remove).toHaveBeenCalledTimes(1);

    appendSpy.mockRestore();
  });

  it('renders without a store name when storeName is omitted', async () => {
    const { iframe, state } = makeFakeIframe();
    const createIframe = vi.fn(() => iframe);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => iframe);

    const provider = new BrowserPrintProvider(createIframe);
    await provider.print({ ticketNumber: 'B-002', categoryName: 'Kasir', issuedAt: 1 });

    expect(state.written).toContain('B-002');
    expect(state.written).not.toContain('class="store"');
  });

  it('resolves (does not reject) when the print dialog throws', async () => {
    const { iframe, printCall } = makeFakeIframe();
    printCall.mockImplementation(() => {
      throw new Error('blocked');
    });
    const createIframe = vi.fn(() => iframe);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => iframe);

    const provider = new BrowserPrintProvider(createIframe);
    // A print failure is non-fatal — the result screen is the source of truth.
    await expect(provider.print(payload)).resolves.toBeUndefined();
  });

  it('resolves when the iframe has no contentWindow document (degraded)', async () => {
    const iframe = { style: {}, contentWindow: {}, remove: vi.fn() } as unknown as HTMLIFrameElement;
    const createIframe = vi.fn(() => iframe);
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => iframe);

    const provider = new BrowserPrintProvider(createIframe);
    await expect(provider.print(payload)).resolves.toBeUndefined();
  });
});
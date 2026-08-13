import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserPrintProvider,
  NetworkEscPosPrintProvider,
  NoOpPrintProvider,
  UsbSerialPrintProvider,
} from './print-provider';
import type { PrintPayload, SerialLike, SerialPortLike } from './print-provider';

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

describe('UsbSerialPrintProvider (FR-KSK-02, USB thermal over Web Serial)', () => {
  /**
   * Subsequence search — `Uint8Array.prototype.indexOf` only finds a single
   * element (unlike Node `Buffer.indexOf`), and `.equals` is not available
   * pre-ES2025. Mirrors the helper in `escpos-commands.test.ts`.
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

  /** A fake port recording the bytes written + the open baudRate. */
  function makeFakePort(shouldThrow = false): { port: SerialPortLike; written: Uint8Array[]; openArgs: { baudRate: number }[] } {
    const written: Uint8Array[] = [];
    const openArgs: { baudRate: number }[] = [];
    const writer = {
      write: vi.fn(async (data: Uint8Array) => {
        written.push(data);
      }),
      releaseLock: vi.fn(),
    };
    // `writable` is a WritableStream-like: getWriter() returns the writer. The
    // provider does `port.writable?.getWriter()` then `writer.write(bytes)`.
    let writable: { getWriter(): typeof writer } | null = { getWriter: () => writer };
    const port: SerialPortLike = {
      open: vi.fn(async (opts: { baudRate: number }) => {
        openArgs.push(opts);
        if (shouldThrow) throw new Error('open failed');
      }),
      get writable() {
        return writable;
      },
      close: vi.fn(async () => {
        writable = null;
      }),
    };
    return { port, written, openArgs };
  }

  /** A fake serial surface returning `ports` from getPorts. */
  function makeFakeSerial(ports: SerialPortLike[]): SerialLike {
    return { getPorts: vi.fn(async () => ports) };
  }

  it('composes ESC/POS bytes and writes them to the first granted port', async () => {
    const { port, written, openArgs } = makeFakePort();
    const serial = makeFakeSerial([port]);
    const provider = new UsbSerialPrintProvider({
      paperWidth: 80,
      cutMode: 'partial',
      baudRate: 9600,
      serial,
    });

    await provider.print(payload);

    // Opened the port at the configured baudRate.
    expect(openArgs).toEqual([{ baudRate: 9600 }]);
    // Exactly one write — the composed receipt (starts with INIT ESC @ then align).
    expect(written.length).toBe(1);
    expect(indexOfSubarray(written[0], Uint8Array.of(0x1b, 0x40, 0x1b))).toBe(0);
    // The ticket number is in the byte stream (UTF-8).
    const encoder = new TextEncoder();
    expect(indexOfSubarray(written[0], encoder.encode('A-001'))).not.toBe(-1);
    // The port is closed after writing.
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it('honors the configured cut mode (full cut bytes present)', async () => {
    const { port, written } = makeFakePort();
    const provider = new UsbSerialPrintProvider({
      paperWidth: 80,
      cutMode: 'full',
      baudRate: 9600,
      serial: makeFakeSerial([port]),
    });

    await provider.print(payload);

    expect(indexOfSubarray(written[0], Uint8Array.of(0x1d, 0x56, 0x00))).not.toBe(-1);
  });

  it('closes the port when writer.write rejects (no leaked-open port)', async () => {
    // A write throw must still close the port — Web Serial's getPorts() returns
    // persistent per-origin handles, so an already-open port makes the NEXT
    // print's open() reject with InvalidStateError and silently no-op every
    // later USB print until the page reloads. The non-fatal contract is
    // self-healing per print, not just "promise resolves".
    const closeCall = vi.fn(async () => {});
    const writer = {
      write: vi.fn(async () => {
        throw new Error('write aborted');
      }),
      releaseLock: vi.fn(),
    };
    const port: SerialPortLike = {
      open: vi.fn(async () => {}),
      writable: { getWriter: () => writer },
      close: closeCall,
    };
    const provider = new UsbSerialPrintProvider({
      paperWidth: 80,
      cutMode: 'partial',
      baudRate: 9600,
      serial: makeFakeSerial([port]),
    });

    await expect(provider.print(payload)).resolves.toBeUndefined();
    // The port was closed despite the write throw — no leak.
    expect(closeCall).toHaveBeenCalledTimes(1);
    // The writer lock was released too.
    expect(writer.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('closes the port when writable is null (no getWriter)', async () => {
    // open() succeeds but the writable stream is absent — the provider bails
    // out, but must STILL close the port it opened.
    const closeCall = vi.fn(async () => {});
    const port: SerialPortLike = {
      open: vi.fn(async () => {}),
      writable: null,
      close: closeCall,
    };
    const provider = new UsbSerialPrintProvider({
      paperWidth: 80,
      cutMode: 'partial',
      baudRate: 9600,
      serial: makeFakeSerial([port]),
    });

    await expect(provider.print(payload)).resolves.toBeUndefined();
    expect(closeCall).toHaveBeenCalledTimes(1);
  });

  it('resolves non-fatal when no port is paired yet (getPorts empty)', async () => {
    const serial = makeFakeSerial([]);
    const provider = new UsbSerialPrintProvider({
      paperWidth: 80,
      cutMode: 'partial',
      baudRate: 9600,
      serial,
    });

    // Not paired — non-fatal (the result screen still shows the ticket).
    await expect(provider.print(payload)).resolves.toBeUndefined();
  });

  it('resolves non-fatal when Web Serial is unavailable (serial null)', async () => {
    const provider = new UsbSerialPrintProvider({
      paperWidth: 80,
      cutMode: 'partial',
      baudRate: 9600,
      serial: null,
    });

    await expect(provider.print(payload)).resolves.toBeUndefined();
  });

  it('resolves non-fatal when opening the port throws (printer error)', async () => {
    const { port } = makeFakePort(true);
    const provider = new UsbSerialPrintProvider({
      paperWidth: 80,
      cutMode: 'partial',
      baudRate: 9600,
      serial: makeFakeSerial([port]),
    });

    await expect(provider.print(payload)).resolves.toBeUndefined();
  });

  it('defaults to navigator.serial when serial is omitted (null here → non-fatal)', async () => {
    // jsdom has no navigator.serial → defaultSerial() returns null → non-fatal.
    const provider = new UsbSerialPrintProvider({
      paperWidth: 80,
      cutMode: 'partial',
      baudRate: 9600,
    });

    await expect(provider.print(payload)).resolves.toBeUndefined();
  });
});
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KioskApi } from './kiosk-api';
import type { CategoryDto, StoreProfileSlice } from './types';

/**
 * Exercises the real `KioskApi` (not a mock) against a stubbed `global.fetch`.
 * jsdom does not provide a global `fetch`, so stubbing is required — the
 * production code uses the global `fetch`. This guards the wire contract the
 * page tests can't see (they mock `IKioskApi` with a flat DTO, which is the
 * correct ISP boundary but blind to an envelope-unwrap regression).
 */

/** Builds a fetch Response stub for a JSON body. */
function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

/** The call signature of the global `fetch` as `KioskApi` uses it. */
type FetchArgs = [input: string, init?: RequestInit];

/** Matches the request init `postJson`/`getJson` pass to `fetch`. */
function jsonBody(init: RequestInit | undefined): unknown {
  if (!init?.body) return undefined;
  return JSON.parse(init.body as string);
}

/** A fetch stub returning `body` for every call. */
function fetchReturning(body: unknown) {
  return vi.fn((..._args: FetchArgs) => jsonResponse(body));
}

describe('KioskApi (wire contract — FR-ENG-01 / QUE-9)', () => {
  const api = new KioskApi();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createTicket unwraps the `{ status, ticket }` envelope and returns the flat DTO', async () => {
    const envelope = {
      status: 'created',
      ticket: {
        ticketId: 't-1',
        ticketNumber: 'A-001',
        categoryId: 'cat-a',
        status: 'WAITING',
        waitingAhead: 3,
      },
    };
    const fetchMock = fetchReturning(envelope);
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.createTicket('cat-a');

    // Called POST /api/tickets with the JSON body `{ categoryId }`.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/tickets');
    expect(init?.method).toBe('POST');
    expect(jsonBody(init)).toEqual({ categoryId: 'cat-a' });

    // The returned DTO is the INNER ticket (proves the unwrap) — not the
    // envelope, and not `undefined` from a flat-typed response.
    expect(result).toEqual(envelope.ticket);
    expect(result.ticketNumber).toBe('A-001');
    expect(result.waitingAhead).toBe(3);
    expect(result.status).toBe('WAITING');
    expect(result.ticketId).toBe('t-1');
    expect(result.categoryId).toBe('cat-a');
  });

  it('createTicket throws on a non-2xx response (does not return undefined)', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ message: 'bad' }) }),
    );

    // The error message uses the `path` arg (`/tickets`), not the full URL.
    await expect(api.createTicket('cat-a')).rejects.toThrow(/POST \/tickets -> 400: bad/);
  });

  it('listCategories GETs /api/categories and returns the array', async () => {
    const categories: CategoryDto[] = [
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Kasir' },
    ];
    const fetchMock = fetchReturning(categories);
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.listCategories();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/categories');
    expect(init?.method).toBeUndefined(); // GET — no method set
    expect(result).toEqual(categories);
  });

  it('getStoreProfile GETs /api/system/config and returns the store-profile slice', async () => {
    // QUE-47: the raw config carries `serviceThemes`; getStoreProfile maps the
    // kiosk surface key into the `themeMode` slice field.
    const rawConfig = {
      storeName: 'Toko Contoh',
      brandColor: '#2563eb',
      serviceThemes: { kiosk: 'light', tv: 'dark', caller: 'dark', admin: 'light' },
    };
    const expected: StoreProfileSlice = {
      storeName: 'Toko Contoh',
      brandColor: '#2563eb',
      themeMode: 'light',
      printerMode: 'chrome',
      printerPaperWidth: 80,
      printerCutMode: 'partial',
      printerBaudRate: 9600,
      // The mocked response carries no `license`, and absent must map to null
      // ("unknown"), never to a fabricated verdict in either direction.
      license: null,
    };
    const fetchMock = fetchReturning(rawConfig);
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getStoreProfile();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/system/config');
    expect(init?.method).toBeUndefined();
    expect(result).toEqual(expected);
  });

  it('getStoreProfile maps the license slice when core-api reports one', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning({
        storeName: 'Toko Contoh',
        brandColor: '#2563eb',
        license: { state: 'RESTRICTED', issue: 'ABSENT', restrictsNewTickets: true },
      }),
    );

    const result = await api.getStoreProfile();

    expect(result.license).toEqual({ state: 'RESTRICTED', restrictsNewTickets: true });
  });

  it.each([
    ['an unrecognised state', { state: 'SOMETHING_NEW', restrictsNewTickets: false }, 'VALID', false],
    ['a missing flag', { state: 'GRACE' }, 'GRACE', false],
    ['a non-boolean flag', { state: 'GRACE', restrictsNewTickets: 'yes' }, 'GRACE', false],
  ])('getStoreProfile degrades %s to "not restricted"', async (_label, license, state, restricts) => {
    // Only an explicit `true` may stop a shop selling tickets. Anything the
    // client cannot parse has to fail OPEN here — the server's own guard is the
    // real enforcement point, so a lenient client costs nothing and a strict one
    // would turn a wire-format surprise into a closed shop.
    vi.stubGlobal('fetch', fetchReturning({ storeName: 'T', brandColor: '#000', license }));

    const result = await api.getStoreProfile();

    expect(result.license).toEqual({ state, restrictsNewTickets: restricts });
  });

  it('getStoreProfile maps printerConfiguration.mode/paperWidth → printerMode/printerPaperWidth', async () => {
    const rawConfig = {
      storeName: 'Toko ESC/POS',
      brandColor: '',
      serviceThemes: { kiosk: 'dark' },
      printerConfiguration: { mode: 'network-escpos', paperWidth: 58, host: '192.168.1.50', port: 9100, cutMode: 'full' },
    };
    const fetchMock = fetchReturning(rawConfig);
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getStoreProfile();

    // The kiosk only carries the mode + paper width (ISP) — host/port/cutMode
    // stay server-side for the network proxy.
    expect(result.printerMode).toBe('network-escpos');
    expect(result.printerPaperWidth).toBe(58);
    expect(result.themeMode).toBe('dark');
  });

  it('getStoreProfile maps usb-serial mode + cutMode/baudRate (USB needs both client-side)', async () => {
    const rawConfig = {
      storeName: 'Toko USB',
      brandColor: '',
      serviceThemes: { kiosk: 'light' },
      printerConfiguration: { mode: 'usb-serial', paperWidth: 80, cutMode: 'full', baudRate: 19200 },
    };
    const fetchMock = fetchReturning(rawConfig);
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getStoreProfile();

    // usb-serial composes ESC/POS client-side, so the kiosk carries cutMode +
    // baudRate (unlike network-escpos, where they stay server-side). The
    // explicit usb-serial arm keeps it from silently degrading to chrome.
    expect(result.printerMode).toBe('usb-serial');
    expect(result.printerPaperWidth).toBe(80);
    expect(result.printerCutMode).toBe('full');
    expect(result.printerBaudRate).toBe(19200);
  });

  it('getStoreProfile defaults cutMode/baudRate when usb-serial omits them', async () => {
    const rawConfig = {
      storeName: '',
      brandColor: '',
      printerConfiguration: { mode: 'usb-serial', paperWidth: 58 },
    };
    vi.stubGlobal('fetch', fetchReturning(rawConfig));

    const result = await api.getStoreProfile();

    expect(result.printerMode).toBe('usb-serial');
    expect(result.printerCutMode).toBe('partial');
    expect(result.printerBaudRate).toBe(9600);
  });

  it('getStoreProfile defaults to chrome/80mm when printerConfiguration is absent (prior behavior)', async () => {
    const rawConfig = { storeName: '', brandColor: '', serviceThemes: {} };
    vi.stubGlobal('fetch', fetchReturning(rawConfig));

    const result = await api.getStoreProfile();

    expect(result.printerMode).toBe('chrome');
    expect(result.printerPaperWidth).toBe(80);
  });

  it('getStoreProfile defaults to chrome/80mm on an unknown mode/paperWidth', async () => {
    const rawConfig = {
      storeName: '',
      brandColor: '',
      printerConfiguration: { mode: 'bogus', paperWidth: 999 },
    };
    vi.stubGlobal('fetch', fetchReturning(rawConfig));

    const result = await api.getStoreProfile();

    expect(result.printerMode).toBe('chrome');
    expect(result.printerPaperWidth).toBe(80);
  });

  it('printTicket POSTs /api/print/ticket with the payload and resolves on 204', async () => {
    const fetchMock = vi.fn((..._args: FetchArgs) =>
      Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.printTicket({
      ticketNumber: 'A-001',
      categoryName: 'Customer Service',
      storeName: 'Toko Contoh',
      issuedAt: 1_700_000_000_000,
      waitingAhead: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/print/ticket');
    expect(init?.method).toBe('POST');
    expect(jsonBody(init)).toEqual({
      ticketNumber: 'A-001',
      categoryName: 'Customer Service',
      storeName: 'Toko Contoh',
      issuedAt: 1_700_000_000_000,
      waitingAhead: 2,
    });
  });

  it('printTicket rejects on a non-2xx response', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ message: 'unreachable' }) }),
    );

    await expect(
      api.printTicket({ ticketNumber: 'A-001', categoryName: 'CS', issuedAt: 1, waitingAhead: 0 }),
    ).rejects.toThrow(/POST \/print\/ticket -> 502: unreachable/);
  });
});
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
});
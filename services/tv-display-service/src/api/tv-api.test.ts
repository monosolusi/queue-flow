import { afterEach, describe, expect, it, vi } from 'vitest';
import { TvApi } from './tv-api';
import type { WaitingQueueDto } from './types';

/**
 * Exercises the real `TvApi` (not a mock) against a stubbed `global.fetch`.
 * jsdom does not provide a global `fetch`, so stubbing is required. Guards the
 * wire contract the page tests can't see (they mock `ITvApi` with a flat DTO,
 * which is the correct ISP boundary but blind to a path/unwrap regression).
 */

/** Builds a fetch Response stub for a JSON body. */
function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

/** The call signature of the global `fetch` as `TvApi` uses it. */
type FetchArgs = [input: string, init?: RequestInit];

/** A fetch stub returning `body` for every call. */
function fetchReturning(body: unknown) {
  return vi.fn((..._args: FetchArgs) => jsonResponse(body));
}

describe('TvApi (wire contract)', () => {
  const api = new TvApi();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getSystemConfig GETs /api/system/config', async () => {
    const config = { isInitialSetupCompleted: true, storeName: 'Apotek Sehat', brandColor: '#a1b2c3' };
    const fetchMock = fetchReturning(config);
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getSystemConfig();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/system/config');
    expect(init?.method).toBeUndefined(); // GET — no method set
    expect(result).toEqual(config);
  });

  it('getCategories GETs /api/categories and returns the array', async () => {
    const categories = [
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Kasir' },
    ];
    const fetchMock = fetchReturning(categories);
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getCategories();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/categories');
    expect(result).toEqual(categories);
  });

  it('getWaitingQueue GETs /api/queue/waiting and returns the DTO', async () => {
    const dto: WaitingQueueDto = {
      waiting: [
        { ticketId: 't1', ticketNumber: 'B-001', categoryId: 'cat-b', status: 'WAITING', counterId: null },
        { ticketId: 't2', ticketNumber: 'A-002', categoryId: 'cat-a', status: 'WAITING', counterId: null },
      ],
      waitingCount: 2,
    };
    const fetchMock = fetchReturning(dto);
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getWaitingQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/queue/waiting');
    expect(init?.method).toBeUndefined(); // GET — no method set
    expect(result).toEqual(dto);
    expect(result.waitingCount).toBe(2);
  });

  it('getWaitingQueue throws on a non-2xx response (does not return undefined)', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ message: 'boom' }) }),
    );
    await expect(api.getWaitingQueue()).rejects.toThrow(/GET \/queue\/waiting -> 500: boom/);
  });
});
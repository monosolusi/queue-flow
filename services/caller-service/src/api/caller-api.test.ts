import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallerApi, InvalidCredentialsError } from './caller-api';
import { readToken, writeToken } from '../auth/token-store';

/** The most recent fetch call's url + init, captured by {@link mockFetch}. */
let lastUrl = '';
let lastInit: RequestInit | null = null;

function mockFetch(
  res: Response | ((init: RequestInit | undefined) => Response),
): void {
  const handler = typeof res === 'function' ? res : () => res;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    lastUrl = String(input);
    lastInit = init ?? null;
    return Promise.resolve(handler(init));
  });
}

function headerAuth(init: RequestInit | null): string | null {
  if (!init || !init.headers) {
    return null;
  }
  const h = init.headers as Record<string, string>;
  return h.Authorization ?? null;
}

function jsonRes(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  localStorage.clear();
  lastUrl = '';
  lastInit = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CallerApi authed fetch (QUE-43)', () => {
  it('attaches Authorization: Bearer <token> to a protected call', async () => {
    writeToken('abc123');
    mockFetch(() => jsonRes([]));
    const api = new CallerApi();
    await api.listCounters();
    expect(lastUrl).toContain('/api/counters');
    expect(headerAuth(lastInit)).toBe('Bearer abc123');
  });

  it('attaches the bearer to a POST command call', async () => {
    writeToken('tok');
    mockFetch(() => jsonRes({}));
    const api = new CallerApi();
    await api.callNext(1);
    expect(headerAuth(lastInit)).toBe('Bearer tok');
    expect((lastInit!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(lastInit!.method).toBe('POST');
  });

  it('omits the Authorization header when no token is stored', async () => {
    mockFetch(() => jsonRes([]));
    const api = new CallerApi();
    await api.listCounters();
    expect(headerAuth(lastInit)).toBeNull();
  });

  it('on 401 clears the token and fires onUnauthorized (no window redirect)', async () => {
    writeToken('abc123');
    const onUnauthorized = vi.fn();
    mockFetch(() => jsonRes({ message: 'no' }, 401, 'Unauthorized'));
    const api = new CallerApi({ onUnauthorized });
    await expect(api.listCounters()).rejects.toThrow(/401/);
    expect(readToken()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('reads the workflow actions from GET /api/queue/actions with the bearer', async () => {
    // The panel's action surface (FR-CLR-02): each transition is a plain status
    // change with the manager's wording, so no routing table lives on this side.
    writeToken('tok');
    mockFetch(() =>
      jsonRes({
        byStatus: {
          CALLING: [
            {
              from: 'CALLING',
              to: 'SERVING',
              actionLabel: 'Mulai Melayani',
              unavailableReason: null,
            },
          ],
        },
      }),
    );
    const api = new CallerApi();
    const actions = await api.getWorkflowActions();
    expect(lastUrl).toContain('/api/queue/actions');
    expect(headerAuth(lastInit)).toBe('Bearer tok');
    expect(actions.byStatus.CALLING[0]).toMatchObject({ to: 'SERVING', actionLabel: 'Mulai Melayani' });
  });

  it('on 401 from the workflow actions clears the token and fires onUnauthorized', async () => {
    writeToken('abc123');
    const onUnauthorized = vi.fn();
    mockFetch(() => jsonRes({ message: 'no' }, 401, 'Unauthorized'));
    const api = new CallerApi({ onUnauthorized });
    await expect(api.getWorkflowActions()).rejects.toThrow(/401/);
    expect(readToken()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('on 401 POST command clears the token and fires onUnauthorized', async () => {
    writeToken('abc123');
    const onUnauthorized = vi.fn();
    mockFetch(() => jsonRes({}, 401, 'Unauthorized'));
    const api = new CallerApi({ onUnauthorized });
    await expect(api.applyTransition('t-1', 'SERVING')).rejects.toThrow(/401/);
    expect(readToken()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('CallerApi auth surface (QUE-43)', () => {
  it('login returns token + user', async () => {
    mockFetch(() =>
      jsonRes({ token: 'server-tok', user: { id: 'u1', username: 'staff', role: 'caller-staff' } }),
    );
    const api = new CallerApi();
    const res = await api.login('staff', 'pw');
    expect(lastUrl).toContain('/api/auth/login');
    expect(res.token).toBe('server-tok');
    expect(res.user.username).toBe('staff');
  });

  it('login throws InvalidCredentialsError on 401 (no redirect path)', async () => {
    mockFetch(() => jsonRes({ code: 'INVALID_CREDENTIALS' }, 401, 'Unauthorized'));
    const api = new CallerApi();
    await expect(api.login('staff', 'bad')).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('getMe returns null when no token is stored', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const api = new CallerApi();
    expect(await api.getMe()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('getMe resolves the user when the token is valid', async () => {
    writeToken('tok');
    mockFetch(() => jsonRes({ id: 'u1', username: 'staff', role: 'caller-staff' }));
    const api = new CallerApi();
    expect((await api.getMe())?.username).toBe('staff');
    expect(headerAuth(lastInit)).toBe('Bearer tok');
  });

  it('getMe clears the token and returns null on 401 (expired)', async () => {
    writeToken('tok');
    mockFetch(() => jsonRes({}, 401, 'Unauthorized'));
    const api = new CallerApi();
    expect(await api.getMe()).toBeNull();
    expect(readToken()).toBeNull();
  });

  it('getMe returns null WITHOUT clearing the token on a network failure', async () => {
    writeToken('tok');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('server down'));
    const api = new CallerApi();
    expect(await api.getMe()).toBeNull();
    // Transient failure must not log the staff out — token kept for retry.
    expect(readToken()).toBe('tok');
  });

  it('logout posts to /auth/logout with the bearer and is best-effort', async () => {
    writeToken('tok');
    mockFetch(() => new Response(null, { status: 204 }));
    const api = new CallerApi();
    await api.logout();
    expect(lastUrl).toContain('/api/auth/logout');
    expect(lastInit!.method).toBe('POST');
    expect(headerAuth(lastInit)).toBe('Bearer tok');
    // logout() does not clear the local token — the caller clears it so the
    // device-local counter binding is preserved across logout.
    expect(readToken()).toBe('tok');
  });

  it('logout is a no-op when no token is stored (no network call)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const api = new CallerApi();
    await api.logout();
    expect(spy).not.toHaveBeenCalled();
  });

  it('logout swallows network failures (idempotent)', async () => {
    writeToken('tok');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const api = new CallerApi();
    await expect(api.logout()).resolves.toBeUndefined();
  });
});
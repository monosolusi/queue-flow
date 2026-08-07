import { clearToken, readToken } from '../auth/token-store';
import type {
  AuthUserDto,
  BrandConfigSlice,
  CounterDto,
  LoginResponseDto,
  QueueSnapshotDto,
  StateMachineDto,
} from './types';

/**
 * The slice of core-api the caller panel consumes (ISP — never leaks
 * admin/reporting DTOs into the caller). The read surface (counters + queue
 * snapshot + active state machine) feeds the workspace; the command surface
 * drives queue transitions (FR-CLR-02 / FR-ENG-03). Command results are
 * delivered to the workspace over the WebSocket broadcaster (TICKET_CALLED /
 * STATUS_UPDATED / TICKET_TRANSFERRED), so the command methods return
 * `Promise<void>` — the caller does not need the result DTO, the store updates
 * from the realtime event. Implementations live behind this interface so tests
 * can substitute a fake without touching the network.
 *
 * The auth surface (login/logout/getMe, QUE-43) resolves the signed-in staff
 * member. Every protected workspace call carries `Authorization: Bearer
 * <token>` via the authed helpers below; on 401 the token is cleared and the
 * app redirects to `/login` (the user is dropped back at the login screen).
 */
export interface ICallerApi {
  // Auth surface (QUE-43) ---------------------------------------------------
  /** Exchange credentials for a bearer token + user. Throws
   *  {@link InvalidCredentialsError} on 401. */
  login(username: string, password: string): Promise<LoginResponseDto>;
  /** Server-side logout (idempotent, best-effort). Does NOT clear the local
   *  token — the caller clears it so the counter binding (device-local) is
   *  preserved across logout. */
  logout(): Promise<void>;
  /** Resolve the current user from the stored token, or `null` when there is
   *  no token / the token is no longer valid (401 clears it). Network failures
   *  resolve `null` without clearing the token so a server blip does not log
   *  the staff out. */
  getMe(): Promise<AuthUserDto | null>;
  // Read surface -----------------------------------------------------------
  listCounters(): Promise<CounterDto[]>;
  getQueueSnapshot(counterId: number): Promise<QueueSnapshotDto>;
  getActiveStateMachine(): Promise<StateMachineDto>;
  /** The manager-configured brand color (QUE-36) applied to `--accent` (QUE-37 AC6). */
  getBrandColor(): Promise<BrandConfigSlice>;
  // Command surface (FR-CLR-02 / FR-ENG-03) -------------------------------
  callNext(counterId: number): Promise<void>;
  serve(ticketId: string): Promise<void>;
  complete(ticketId: string): Promise<void>;
  skip(ticketId: string): Promise<void>;
  recall(ticketId: string): Promise<void>;
  /** Re-announce the currently-calling ticket ("Panggil Lagi") — re-emits
   *  TICKET_CALLED without a state change; only valid from CALLING. */
  reannounce(ticketId: string): Promise<void>;
  transfer(ticketId: string, targetCategoryId: string): Promise<void>;
  /** Generic apply-transition (QUE-33): drives a wizard-configurable edge to
   *  an arbitrary target state not covered by the six fixed commands. */
  applyTransition(ticketId: string, targetStatus: string): Promise<void>;
}

const API_BASE = '/api';

/** The SPA login route URL (router `basename` is `/caller`). Used for the
 *  401 redirect — a full reload to the public login route, which also clears
 *  any stale workspace state. */
const LOGIN_PATH = '/caller/login';

/** Thrown by {@link CallerApi.login} on 401 — invalid credentials. Distinct
 *  from a generic transport error so the LoginPage can show the right copy. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}

/** Per-request auth options for the authed helpers (the 401 redirect hook). */
interface AuthOptions {
  onUnauthorized?: () => void;
}

/**
 * Default 401 handler — a full reload to the public login route. Skipped when
 * already on the login path to avoid a redirect loop (the login page itself
 * never hits a protected endpoint, but this is cheap defense-in-depth).
 */
function defaultOnUnauthorized(): void {
  if (window.location.pathname !== LOGIN_PATH) {
    window.location.assign(LOGIN_PATH);
  }
}

/** Builds the auth-bearing request headers. The bearer token is attached only
 *  when present (a missing token still reaches public endpoints fine; a
 *  protected call with no token 401s and triggers the redirect). */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = readToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Generic GET helper that throws on non-2xx so callers can try/catch. On 401
 *  the token is cleared and the unauthorized handler fires (default: redirect
 *  to /login) before throwing. */
async function getJson<T>(path: string, opts: AuthOptions = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) {
    clearToken();
    (opts.onUnauthorized ?? defaultOnUnauthorized)();
    throw new Error(`GET ${path} -> 401`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`GET ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

/** Generic POST helper (empty body) that throws on non-2xx. 401 → clear +
 *  redirect + throw (see {@link getJson}). */
async function postEmpty(path: string, opts: AuthOptions = {}): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (res.status === 401) {
    clearToken();
    (opts.onUnauthorized ?? defaultOnUnauthorized)();
    throw new Error(`POST ${path} -> 401`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`POST ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

/** Generic POST helper (JSON body) that throws on non-2xx. 401 → clear +
 *  redirect + throw (see {@link getJson}). */
async function postJson<T>(path: string, body: unknown, opts: AuthOptions = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    clearToken();
    (opts.onUnauthorized ?? defaultOnUnauthorized)();
    throw new Error(`POST ${path} -> 401`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`POST ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch-based {@link ICallerApi} using relative `/api` URLs — same-origin behind
 * NGINX in production, proxied to core-api:3000 by Vite in dev. No remote calls
 * (NFR-REL-01). Command endpoints map to the core-api `QueueCommandsController`
 * (`POST /api/queue/call-next`, `…/:id/serve|complete|skip|recall|reannounce|transfer`).
 *
 * The optional `onUnauthorized` constructor option overrides the default 401
 * redirect (tests inject a spy); production constructs `new CallerApi()` with
 * no args, so the default redirect applies.
 */
export class CallerApi implements ICallerApi {
  private readonly onUnauthorized?: () => void;

  constructor(opts?: { onUnauthorized?: () => void }) {
    this.onUnauthorized = opts?.onUnauthorized;
  }

  login(username: string, password: string): Promise<LoginResponseDto> {
    // The login endpoint is unauthenticated (no bearer token) and must NOT
    // trigger the 401 redirect — a 401 here is invalid credentials, surfaced
    // to the form as InvalidCredentialsError. Uses its own fetch, not the
    // authed helpers, for that reason.
    return (async () => {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 401) {
        throw new InvalidCredentialsError();
      }
      if (!res.ok) {
        throw new Error(`POST /auth/login -> ${res.status}`);
      }
      return res.json() as Promise<LoginResponseDto>;
    })();
  }

  async logout(): Promise<void> {
    // Best-effort server-side logout (idempotent per the contract). The local
    // token clear is the authoritative side and is performed by the caller
    // (the auth context / user menu) so the device-local counter binding is
    // preserved. Network failures are ignored — the local clear still runs.
    const token = readToken();
    if (!token) {
      return;
    }
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* idempotent — local token clear is authoritative */
    }
  }

  async getMe(): Promise<AuthUserDto | null> {
    // Resolves the user from the stored token. A 401 (expired/invalid) clears
    // the token and resolves null so RequireAuth can redirect to /login
    // gracefully (no full-reload redirect here — the guard owns navigation).
    // A network failure resolves null WITHOUT clearing the token, so a
    // transient server blip does not log the staff out.
    const token = readToken();
    if (!token) {
      return null;
    }
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        clearToken();
        return null;
      }
      return (await res.json()) as AuthUserDto;
    } catch {
      return null;
    }
  }

  listCounters(): Promise<CounterDto[]> {
    return getJson<CounterDto[]>('/counters', { onUnauthorized: this.onUnauthorized });
  }
  getQueueSnapshot(counterId: number): Promise<QueueSnapshotDto> {
    return getJson<QueueSnapshotDto>(`/queue?counterId=${encodeURIComponent(counterId)}`, {
      onUnauthorized: this.onUnauthorized,
    });
  }
  getActiveStateMachine(): Promise<StateMachineDto> {
    return getJson<StateMachineDto>('/system/state-machine', { onUnauthorized: this.onUnauthorized });
  }
  getBrandColor(): Promise<BrandConfigSlice> {
    // Reuses the existing `GET /api/system/config` read surface (DRY); the
    // caller consumes only the `{ brandColor, themeMode }` slice (ISP). The
    // endpoint is public so it never 401s; the bearer token (when present) is
    // harmlessly ignored by the server. `themeMode` is this service's surface
    // key from the `serviceThemes` map (QUE-47).
    return getJson<{ brandColor: string; serviceThemes?: { caller?: string } }>(
      '/system/config',
      { onUnauthorized: this.onUnauthorized },
    ).then((c) => ({
      brandColor: c.brandColor,
      themeMode: c.serviceThemes?.caller === 'dark' ? 'dark' : 'light',
    }));
  }
  callNext(counterId: number): Promise<void> {
    return postJson(`/queue/call-next`, { counterId }, { onUnauthorized: this.onUnauthorized }).then(
      () => undefined,
    );
  }
  serve(ticketId: string): Promise<void> {
    return postEmpty(`/queue/${encodeURIComponent(ticketId)}/serve`, {
      onUnauthorized: this.onUnauthorized,
    });
  }
  complete(ticketId: string): Promise<void> {
    return postEmpty(`/queue/${encodeURIComponent(ticketId)}/complete`, {
      onUnauthorized: this.onUnauthorized,
    });
  }
  skip(ticketId: string): Promise<void> {
    return postEmpty(`/queue/${encodeURIComponent(ticketId)}/skip`, {
      onUnauthorized: this.onUnauthorized,
    });
  }
  recall(ticketId: string): Promise<void> {
    return postEmpty(`/queue/${encodeURIComponent(ticketId)}/recall`, {
      onUnauthorized: this.onUnauthorized,
    });
  }
  reannounce(ticketId: string): Promise<void> {
    return postEmpty(`/queue/${encodeURIComponent(ticketId)}/reannounce`, {
      onUnauthorized: this.onUnauthorized,
    });
  }
  transfer(ticketId: string, targetCategoryId: string): Promise<void> {
    return postJson(
      `/queue/${encodeURIComponent(ticketId)}/transfer`,
      { targetCategoryId },
      { onUnauthorized: this.onUnauthorized },
    ).then(() => undefined);
  }
  applyTransition(ticketId: string, targetStatus: string): Promise<void> {
    return postJson(
      `/queue/${encodeURIComponent(ticketId)}/transition`,
      { targetStatus },
      { onUnauthorized: this.onUnauthorized },
    ).then(() => undefined);
  }
}
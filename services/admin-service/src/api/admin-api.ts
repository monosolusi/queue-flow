import { clearToken, readToken, UNAUTHORIZED_EVENT } from '../auth/token-store';
import type {
  AuditLogEntryDto,
  AuthUserDto,
  CleanupTransactionLogResultDto,
  CounterDto,
  CounterPerformanceDto,
  DailyReportDto,
  LoginResponseDto,
  ManualResetResultDto,
  QueueBoardStateDto,
  RangeReportDto,
  SaveSystemConfigurationPayload,
  SaveSystemConfigurationResult,
  StateMachineDto,
  SystemConfigurationDto,
  UserDto,
  UserRole,
} from './types';

/**
 * The slice of core-api the admin panel consumes (ISP — only config read/save,
 * the active state-machine read, the reporting / audit-trail read surface, the
 * live queue-board + counters read for the operational dashboard (QUE-44), and
 * the two manual override operations; never leaks caller/kiosk/tv-snapshot
 * DTOs beyond the board + counters the dashboard needs). Implementations live
 * behind this interface so tests can substitute a fake without touching the
 * network.
 */
export interface IAdminApi {
  getSystemConfig(): Promise<SystemConfigurationDto>;
  saveSystemConfig(payload: SaveSystemConfigurationPayload): Promise<SaveSystemConfigurationResult>;
  getActiveStateMachine(): Promise<StateMachineDto>;
  /** Daily queue analytics (total visitors, avg wait/service time, per-category). */
  getDailyReport(date: string): Promise<DailyReportDto>;
  /** One counter's served count + avg service time for a date. */
  getCounterPerformance(counterId: number, date: string): Promise<CounterPerformanceDto>;
  /** Range queue analytics (totals + per-day series + per-category/counter over `[from, to]`). */
  getRangeReport(from: string, to: string): Promise<RangeReportDto>;
  /** Live queue board state — active (now-serving) + waiting tickets across all counters. */
  getQueueBoard(): Promise<QueueBoardStateDto>;
  /** Every configured counter with its assigned categories (for the dashboard counter-status list). */
  getCounters(): Promise<readonly CounterDto[]>;
  /** The local audit trail (human-initiated mutations), oldest-first. */
  getAuditLog(): Promise<readonly AuditLogEntryDto[]>;
  /** Manual daily-reset override — `POST /api/system/daily-reset` (FR-ADM-02). */
  triggerManualReset(): Promise<ManualResetResultDto>;
  /** Transaction-log cleanup override — `POST /api/system/cleanup-transaction-log` (FR-ADM-02). */
  cleanupTransactionLogs(retentionDays: number): Promise<CleanupTransactionLogResultDto>;
}

/**
 * The authentication slice (ISP — login/logout/me/setup-admin only). Kept
 * separate from {@link IAdminApi} so the existing config/report fakes (which
 * never touch auth) stay valid unchanged, and so a test that exercises only
 * `LoginPage` can build a fake that implements just this slice. `login` is the
 * one auth call that does NOT thread the bearer token (there is none yet) and
 * does NOT trigger the 401 redirect — a 401 here means "invalid credentials",
 * which {@link LoginPage} surfaces inline, not an expired session.
 */
export interface IAuthApi {
  login(username: string, password: string): Promise<LoginResponseDto>;
  /** Idempotent — `POST /api/auth/logout` (Bearer) → 204. Never rejects the
   *  caller: a network failure still drops the local session. */
  logout(): Promise<void>;
  /** `GET /api/auth/me` (Bearer) → the authenticated principal, or 401. */
  getMe(): Promise<AuthUserDto>;
  /** `POST /api/auth/setup-admin` — first-run only (403 once setup completes). */
  setupInitialAdmin(username: string, password: string): Promise<UserDto>;
}

/**
 * The user-management slice (ISP — list/create/delete users, admin-only).
 * Separate from {@link IAdminApi} for the same reason as {@link IAuthApi}.
 */
export interface IUsersApi {
  listUsers(): Promise<readonly UserDto[]>;
  createUser(input: { username: string; password: string; role: UserRole }): Promise<UserDto>;
  deleteUser(id: string): Promise<void>;
}

/**
 * The full admin-app API surface — the union of the three slices. {@link AdminApi}
 * implements this; `App` accepts it as its optional `api` prop so the test seam
 * stays a single injected object while each page consumes only the slice it
 * needs (`WizardPage` takes `IAdminApi & IAuthApi`, `LoginPage` takes
 * `IAuthApi`, `UsersPage` takes `IUsersApi`).
 */
export type IAdminAppApi = IAdminApi & IAuthApi & IUsersApi;

const API_BASE = '/api';

/**
 * Bearer-token header merge. Returns `{ Authorization: 'Bearer <token>' }` when a
 * token is stored, or `{}` otherwise — so public endpoints (config read pre-login,
 * login, setup-admin) simply omit the header when there is no session yet.
 * Sending a (valid) token to a public endpoint is harmless; the read path is
 * still served. Threading the token here (one chokepoint in every helper) keeps
 * every request authenticated without each method repeating the merge.
 */
function authHeaders(): Record<string, string> {
  const token = readToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Handles a 401 from a protected endpoint: the session is expired/invalid, so
 * drop the stored token and notify the {@link AuthProvider} (via the
 * `qms:unauthorized` window event) to clear its cached user — {@link RequireAuth}
 * then redirects to `/login`. Decoupling the redirect from the API layer keeps
 * `admin-api.ts` free of router knowledge.
 */
function onUnauthorized(): void {
  clearToken();
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}

/** Generic GET helper that throws on non-2xx so callers can try/catch. */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...authHeaders(), Accept: 'application/json' },
  });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
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

/** Generic PUT helper that throws on non-2xx so callers can try/catch. */
async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`PUT ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

/** Generic POST helper that throws on non-2xx so callers can try/catch. */
async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
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
 * POST helper for empty-response (204) endpoints — `logout`. Does NOT parse a
 * JSON body (204 has none). Still threads the bearer token + 401 redirect.
 */
async function postEmpty(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), Accept: 'application/json' },
  });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`POST ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

/** DELETE helper for empty-response (204) endpoints — `deleteUser`. */
async function deleteEmpty(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { ...authHeaders(), Accept: 'application/json' },
  });
  if (!res.ok) {
    if (res.status === 401) onUnauthorized();
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`DELETE ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Fetch-based {@link IAdminApi} using relative `/api` URLs — same-origin behind
 * NGINX in production, proxied to core-api:3000 by Vite in dev. No remote calls
 * (NFR-REL-01).
 */
export class AdminApi implements IAdminApi {
  getSystemConfig(): Promise<SystemConfigurationDto> {
    return getJson<SystemConfigurationDto>('/system/config');
  }
  saveSystemConfig(payload: SaveSystemConfigurationPayload): Promise<SaveSystemConfigurationResult> {
    return putJson<SaveSystemConfigurationResult>('/system/config', payload);
  }
  getActiveStateMachine(): Promise<StateMachineDto> {
    return getJson<StateMachineDto>('/system/state-machine');
  }
  getDailyReport(date: string): Promise<DailyReportDto> {
    return getJson<DailyReportDto>(`/reports/daily?date=${encodeURIComponent(date)}`);
  }
  getCounterPerformance(counterId: number, date: string): Promise<CounterPerformanceDto> {
    return getJson<CounterPerformanceDto>(
      `/reports/counters/${encodeURIComponent(counterId)}?date=${encodeURIComponent(date)}`,
    );
  }
  getRangeReport(from: string, to: string): Promise<RangeReportDto> {
    return getJson<RangeReportDto>(
      `/reports/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
  }
  getQueueBoard(): Promise<QueueBoardStateDto> {
    return getJson<QueueBoardStateDto>('/queue/board');
  }
  getCounters(): Promise<readonly CounterDto[]> {
    return getJson<readonly CounterDto[]>('/counters');
  }
  getAuditLog(): Promise<readonly AuditLogEntryDto[]> {
    return getJson<readonly AuditLogEntryDto[]>('/audit/log');
  }
  triggerManualReset(): Promise<ManualResetResultDto> {
    return postJson<ManualResetResultDto>('/system/daily-reset');
  }
  cleanupTransactionLogs(retentionDays: number): Promise<CleanupTransactionLogResultDto> {
    return postJson<CleanupTransactionLogResultDto>('/system/cleanup-transaction-log', {
      retentionDays,
    });
  }

  // --- IAuthApi (QUE-43) -----------------------------------------------------
  //
  // `login` is the one auth call that bypasses the generic helpers: a 401 here
  // means "invalid credentials" (not an expired session), so it must NOT clear
  // the token or fire the `qms:unauthorized` redirect — `LoginPage` surfaces the
  // error inline. It also sends no bearer token (there is none yet).

  async login(username: string, password: string): Promise<LoginResponseDto> {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      // 401 INVALID_CREDENTIALS — surface to the caller (LoginPage); do NOT
      // fire the unauthorized redirect here.
      let detail = '';
      try {
        detail = (await res.json())?.message ?? '';
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`POST /auth/login -> ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res.json() as Promise<LoginResponseDto>;
  }

  async logout(): Promise<void> {
    // Idempotent: a network failure must not prevent the local session drop. The
    // caller (AuthProvider.logout) clears the token + user regardless; this
    // best-effort server call lets the server invalidate its side.
    try {
      await postEmpty('/auth/logout');
    } catch {
      /* swallow — local logout proceeds regardless */
    }
  }

  getMe(): Promise<AuthUserDto> {
    return getJson<AuthUserDto>('/auth/me');
  }

  setupInitialAdmin(username: string, password: string): Promise<UserDto> {
    // Public pre-setup endpoint; 403 once setup completes (the wizard's re-edit
    // path never calls this — only the first-run finalize does).
    return postJson<UserDto>('/auth/setup-admin', { username, password });
  }

  // --- IUsersApi (QUE-43) ----------------------------------------------------

  listUsers(): Promise<readonly UserDto[]> {
    return getJson<readonly UserDto[]>('/users');
  }

  createUser(input: { username: string; password: string; role: UserRole }): Promise<UserDto> {
    return postJson<UserDto>('/users', input);
  }

  deleteUser(id: string): Promise<void> {
    return deleteEmpty(`/users/${encodeURIComponent(id)}`);
  }
}
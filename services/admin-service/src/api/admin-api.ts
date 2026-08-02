import type {
  AuditLogEntryDto,
  CounterPerformanceDto,
  DailyReportDto,
  SaveSystemConfigurationPayload,
  SaveSystemConfigurationResult,
  StateMachineDto,
  SystemConfigurationDto,
} from './types';

/**
 * The slice of core-api the admin panel consumes (ISP — only config read/save,
 * the active state-machine read, and the reporting / audit-trail read surface;
 * never leaks caller/kiosk/tv DTOs). Implementations live behind this interface
 * so tests can substitute a fake without touching the network.
 */
export interface IAdminApi {
  getSystemConfig(): Promise<SystemConfigurationDto>;
  saveSystemConfig(payload: SaveSystemConfigurationPayload): Promise<SaveSystemConfigurationResult>;
  getActiveStateMachine(): Promise<StateMachineDto>;
  /** Daily queue analytics (total visitors, avg wait/service time, per-category). */
  getDailyReport(date: string): Promise<DailyReportDto>;
  /** One counter's served count + avg service time for a date. */
  getCounterPerformance(counterId: number, date: string): Promise<CounterPerformanceDto>;
  /** The local audit trail (human-initiated mutations), oldest-first. */
  getAuditLog(): Promise<readonly AuditLogEntryDto[]>;
}

const API_BASE = '/api';

/** Generic GET helper that throws on non-2xx so callers can try/catch. */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
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

/** Generic PUT helper that throws on non-2xx so callers can try/catch. */
async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
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
  getAuditLog(): Promise<readonly AuditLogEntryDto[]> {
    return getJson<readonly AuditLogEntryDto[]>('/audit/log');
  }
}
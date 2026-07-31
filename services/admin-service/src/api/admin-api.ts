import type {
  SaveSystemConfigurationPayload,
  SaveSystemConfigurationResult,
  StateMachineDto,
  SystemConfigurationDto,
} from './types';

/**
 * The slice of core-api the admin panel consumes (ISP — only config read/save
 * and the active state-machine read; never leaks caller/kiosk/tv DTOs).
 * Implementations live behind this interface so tests can substitute a fake
 * without touching the network.
 */
export interface IAdminApi {
  getSystemConfig(): Promise<SystemConfigurationDto>;
  saveSystemConfig(payload: SaveSystemConfigurationPayload): Promise<SaveSystemConfigurationResult>;
  getActiveStateMachine(): Promise<StateMachineDto>;
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
}
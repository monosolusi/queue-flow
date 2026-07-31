import type { CategoryDto, SystemConfigurationDto } from './types';

/**
 * The slice of core-api the TV board consumes (ISP — only the store profile
 * for the running-text idle marquee and the category master data; never leaks
 * caller/admin/reporting DTOs). Implementations live behind this interface so
 * tests can substitute a fake without touching the network.
 */
export interface ITvApi {
  getSystemConfig(): Promise<SystemConfigurationDto>;
  getCategories(): Promise<CategoryDto[]>;
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

/**
 * Fetch-based {@link ITvApi} using relative `/api` URLs — same-origin behind
 * NGINX in production, proxied to core-api:3000 by Vite in dev. No remote calls
 * (NFR-REL-01).
 */
export class TvApi implements ITvApi {
  getSystemConfig(): Promise<SystemConfigurationDto> {
    return getJson<SystemConfigurationDto>('/system/config');
  }
  getCategories(): Promise<CategoryDto[]> {
    return getJson<CategoryDto[]>('/categories');
  }
}
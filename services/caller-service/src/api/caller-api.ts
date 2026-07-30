import type { CounterDto, QueueSnapshotDto } from './types';

/**
 * The slice of the core-api the caller panel consumes (ISP — never leaks
 * admin/reporting DTOs into the caller). Implementations live behind this
 * interface so tests can substitute a fake without touching the network.
 */
export interface ICallerApi {
  listCounters(): Promise<CounterDto[]>;
  getQueueSnapshot(counterId: number): Promise<QueueSnapshotDto>;
}

const API_BASE = '/api';

/** Generic fetch helper that throws on non-2xx so callers can try/catch. */
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
 * Fetch-based {@link ICallerApi} using relative `/api` URLs — same-origin
 * behind NGINX in production, proxied to core-api:3000 by Vite in dev. No
 * remote calls (NFR-REL-01).
 */
export class CallerApi implements ICallerApi {
  listCounters(): Promise<CounterDto[]> {
    return getJson<CounterDto[]>('/counters');
  }
  getQueueSnapshot(counterId: number): Promise<QueueSnapshotDto> {
    return getJson<QueueSnapshotDto>(`/queue?counterId=${encodeURIComponent(counterId)}`);
  }
}
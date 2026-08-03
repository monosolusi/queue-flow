import type { CategoryDto, CreatedTicketDto, StoreProfileSlice } from './types';

/**
 * The slice of the core-api the kiosk consumes (ISP — only category listing,
 * ticket creation, and the store name for the receipt header; never leaks
 * admin/reporting/caller DTOs). Implementations live behind this interface so
 * tests can substitute a fake without touching the network.
 */
export interface IKioskApi {
  listCategories(): Promise<CategoryDto[]>;
  createTicket(categoryId: string): Promise<CreatedTicketDto>;
  /** The store name for the receipt header (FR-KSK-03 "Nama Toko"). */
  getStoreName(): Promise<string>;
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

/** Generic POST helper that throws on non-2xx so callers can try/catch. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
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
    throw new Error(`POST ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch-based {@link IKioskApi} using relative `/api` URLs — same-origin behind
 * NGINX in production, proxied to core-api:3000 by Vite in dev. No remote calls
 * (NFR-REL-01).
 */
export class KioskApi implements IKioskApi {
  listCategories(): Promise<CategoryDto[]> {
    return getJson<CategoryDto[]>('/categories');
  }
  createTicket(categoryId: string): Promise<CreatedTicketDto> {
    return postJson<CreatedTicketDto>('/tickets', { categoryId });
  }
  getStoreName(): Promise<string> {
    // Reuses the existing `GET /api/system/config` read surface (QUE-30 — it
    // returns `storeName` even pre-setup as `''`) rather than adding a dedicated
    // endpoint (DRY). The kiosk consumes only the `{ storeName }` slice (ISP).
    return getJson<StoreProfileSlice>('/system/config').then((c) => c.storeName ?? '');
  }
}
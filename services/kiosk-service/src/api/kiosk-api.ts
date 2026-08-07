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
  /** Store profile for the receipt header + runtime accent (FR-KSK-03 / QUE-37 AC6). */
  getStoreProfile(): Promise<StoreProfileSlice>;
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
  /**
   * Creates a ticket. core-api wraps the result in a `{ status: 'created',
   * ticket }` envelope (see `tickets-api.integration.spec.ts`); this unwraps
   * it so the kiosk consumes the flat {@link CreatedTicketDto} (the envelope
   * is a transport detail the kiosk client owns — the ISP slice stays flat).
   */
  createTicket(categoryId: string): Promise<CreatedTicketDto> {
    return postJson<{ status: 'created'; ticket: CreatedTicketDto }>('/tickets', {
      categoryId,
    }).then((r) => r.ticket);
  }
  getStoreProfile(): Promise<StoreProfileSlice> {
    // Reuses the existing `GET /api/system/config` read surface (QUE-30 — it
    // returns `storeName`/`brandColor` even pre-setup as `''`) rather than adding
    // a dedicated endpoint (DRY). The kiosk consumes only the store-profile
    // slice (ISP): store name + brand color + this service's theme (the kiosk
    // surface key from `serviceThemes`, QUE-47).
    return getJson<{ storeName: string; brandColor: string; serviceThemes?: { kiosk?: string } }>(
      '/system/config',
    ).then((c) => ({
      storeName: c.storeName,
      brandColor: c.brandColor,
      themeMode: c.serviceThemes?.kiosk === 'dark' ? 'dark' : 'light',
    }));
  }
}
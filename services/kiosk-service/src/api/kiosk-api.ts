import type { PrintPayload } from '../print/print-provider';
import type {
  CategoryDto,
  CreatedTicketDto,
  CutMode,
  KioskLicenseSlice,
  PaperWidth,
  PrinterMode,
  StoreProfileSlice,
} from './types';

/** Recognised license states. An unknown one is treated as VALID: a state this
 *  build has never heard of must not stop a shop from selling tickets. */
const LICENSE_STATES: ReadonlySet<string> = new Set([
  'VALID',
  'EXPIRING_SOON',
  'GRACE',
  'MISMATCH_GRACE',
  'RESTRICTED',
]);

/**
 * The slice of the core-api the kiosk consumes (ISP — only category listing,
 * ticket creation, the store name for the receipt header, and the network-print
 * proxy; never leaks admin/reporting/caller DTOs). Implementations live behind
 * this interface so tests can substitute a fake without touching the network.
 */
export interface IKioskApi {
  listCategories(): Promise<CategoryDto[]>;
  createTicket(categoryId: string): Promise<CreatedTicketDto>;
  /** Store profile for the receipt header + runtime accent (FR-KSK-03 / QUE-37 AC6). */
  getStoreProfile(): Promise<StoreProfileSlice>;
  /**
   * Proxies a ticket print to core-api's network ESC/POS printer (POST
   * /api/print/ticket). Resolves on 2xx (204 — empty body); rejects on non-2xx.
   * The kiosk treats a rejection as a non-fatal print failure — the caller
   * swallows it so a printer outage never blocks the visitor flow.
   */
  printTicket(payload: PrintPayload): Promise<void>;
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
 * POST helper for endpoints that return an empty body (204). Unlike `postJson`,
 * it never parses the response — `res.json()` would reject on a 204. Throws on
 * non-2xx so callers can try/catch.
 */
async function postVoid(path: string, body: unknown): Promise<void> {
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
    // surface key from `serviceThemes`, QUE-47) + the printer config it needs to
    // choose its print provider (FR-KSK-02). `printerConfiguration` is absent
    // pre-config / before the field existed — default to `chrome` + 80mm, which
    // is the prior behavior (BrowserPrintProvider with the page's default size).
    return getJson<{
      storeName: string;
      brandColor: string;
      serviceThemes?: { kiosk?: string };
      license?: { state?: unknown; restrictsNewTickets?: unknown } | null;
      printerConfiguration?: {
        mode?: unknown;
        paperWidth?: unknown;
        cutMode?: unknown;
        baudRate?: unknown;
      };
    }>('/system/config').then((c) => {
      const mode = c.printerConfiguration?.mode;
      const width = c.printerConfiguration?.paperWidth;
      const cut = c.printerConfiguration?.cutMode;
      const baud = c.printerConfiguration?.baudRate;
      // Allowlist map: an explicit `usb-serial` arm keeps it from silently
      // degrading to chrome; any other unknown mode still falls back to chrome.
      const printerMode: PrinterMode =
        mode === 'network-escpos' ? 'network-escpos' : mode === 'usb-serial' ? 'usb-serial' : 'chrome';
      const printerPaperWidth: PaperWidth = width === 58 ? 58 : 80;
      const printerCutMode: CutMode =
        cut === 'full' || cut === 'none' ? cut : 'partial';
      const printerBaudRate: number =
        typeof baud === 'number' && Number.isInteger(baud) && baud > 0 ? baud : 9600;
      // Only an EXPLICIT `restrictsNewTickets === true` blocks the kiosk.
      // A missing field, a null slice, or an unrecognised state all resolve to
      // "not restricted" — the same absence-is-not-evidence rule the server's
      // host fingerprint follows, applied at the client boundary.
      const rawLicense = c.license;
      const license: KioskLicenseSlice | null =
        rawLicense == null
          ? null
          : {
              state: LICENSE_STATES.has(String(rawLicense.state))
                ? (String(rawLicense.state) as KioskLicenseSlice['state'])
                : 'VALID',
              restrictsNewTickets: rawLicense.restrictsNewTickets === true,
            };

      return {
        storeName: c.storeName,
        brandColor: c.brandColor,
        license,
        themeMode: c.serviceThemes?.kiosk === 'dark' ? 'dark' : 'light',
        printerMode,
        printerPaperWidth,
        printerCutMode,
        printerBaudRate,
      };
    });
  }
  printTicket(payload: PrintPayload): Promise<void> {
    // core-api proxies ESC/POS bytes + cut to the networked thermal printer over
    // TCP (the browser cannot open raw TCP — NFR-REL-01 keeps IO server-side).
    // The endpoint returns 204 (empty body) on success, hence `postVoid`.
    return postVoid('/print/ticket', payload);
  }
}
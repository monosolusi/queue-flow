/**
 * Wire contract between kiosk-service and core-api. These types mirror the
 * DTOs core-api exposes over REST. There is no shared package yet, so the
 * contract is duplicated here intentionally — the ISP boundary means the kiosk
 * only knows the slice of the API it consumes (categories + ticket creation;
 * never admin/reporting/caller-snapshot DTOs).
 */

/** A category the visitor can pick, returned by `GET /api/categories` (FR-KSK-01). */
export interface CategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * The newly issued ticket, returned by `POST /api/tickets` (FR-ENG-01 / QUE-9).
 * The kiosk displays `ticketNumber` (e.g. `A-001`); `status` is `WAITING`.
 * `waitingAhead` (people already WAITING in this category when the ticket was
 * issued) drives the receipt's queue-position line (FR-KSK-03).
 *
 * core-api wraps this in a `{ status: 'created', ticket }` envelope on the
 * wire; `KioskApi.createTicket` unwraps it, so kiosk code sees the inner
 * ticket (this type) directly.
 */
export interface CreatedTicketDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly status: string;
  readonly waitingAhead: number;
}

/**
 * The minimal slice of `GET /api/system/config` the kiosk consumes — the store
 * name for the receipt header (FR-KSK-03 "Nama Toko") + the manager-configured
 * brand color (QUE-36) applied to the runtime `--accent` (QUE-37 AC6). The kiosk
 * depends on this slice only (ISP — it never types the full admin
 * `SystemConfigurationDto`), reusing the existing config read surface rather
 * than a dedicated endpoint (DRY, matching the QUE-24 reuse precedent).
 */
/** A per-surface light/dark choice (QUE-47). Light is the default. */
export type ThemeMode = 'light' | 'dark';

export interface StoreProfileSlice {
  readonly storeName: string;
  readonly brandColor: string;
  /** This service's theme (the kiosk surface key from `serviceThemes`). */
  readonly themeMode: ThemeMode;
}
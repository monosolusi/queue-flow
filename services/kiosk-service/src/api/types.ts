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

/**
 * The printer mode the manager configured on the store config. `chrome` prints
 * via the browser's print dialog (Chrome's default printer) at a defined paper
 * width; `network-escpos` POSTs the ticket to core-api, which proxies the ESC/POS
 * bytes + cut to a networked thermal printer over TCP (the browser cannot open
 * raw TCP — NFR-REL-01 keeps all IO server-side); `usb-serial` drives a USB
 * thermal printer cabled to the kiosk directly over Web Serial (core-api cannot
 * proxy USB — it is kiosk-local). The kiosk only needs the mode to pick its print
 * provider; host/port stay server-side (ISP). `usb-serial` composes ESC/POS
 * client-side, so it also needs `printerCutMode` + `printerBaudRate`.
 */
export type PrinterMode = 'chrome' | 'network-escpos' | 'usb-serial';

/** Thermal paper width in millimeters — drives the `@page` size for chrome mode
 *  and the ESC/POS column count for usb-serial mode. */
export type PaperWidth = 58 | 80;

/** When the ESC/POS cut command fires (usb-serial mode only). */
export type CutMode = 'full' | 'partial' | 'none';

export interface StoreProfileSlice {
  readonly storeName: string;
  readonly brandColor: string;
  /** This service's theme (the kiosk surface key from `serviceThemes`). */
  readonly themeMode: ThemeMode;
  /** Which print provider the kiosk wires (FR-KSK-02, config-driven). */
  readonly printerMode: PrinterMode;
  /** Paper width for chrome + usb-serial mode (ignored by the network provider). */
  readonly printerPaperWidth: PaperWidth;
  /** Cut command for usb-serial mode (the kiosk composes ESC/POS client-side).
   *  Ignored by chrome/network-escpos. Defaults to 'partial'. */
  readonly printerCutMode: CutMode;
  /** Serial baud rate for usb-serial mode (`port.open({ baudRate })`). Ignored by
   *  chrome/network-escpos. Defaults to 9600. */
  readonly printerBaudRate: number;
}
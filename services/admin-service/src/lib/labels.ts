import type {
  DailyResetMode,
  PrinterCutMode,
  PrinterMode,
  PrinterPaperWidth,
  PriorityPolicy,
  ServiceSurface,
  ThemeMode,
  UserRole,
} from '../api/types';

/**
 * Friendly Bahasa Indonesia display labels for the enum values the manager
 * picks in the wizard / admin panel. The enum stays as the wire `value=` (the
 * `PUT /api/system/config` contract is unchanged — QUE-34 only swaps display
 * text, never the enum); these maps keep the human label next to the value so
 * the two never drift apart (a single source of truth for the friendly text).
 *
 * Mirrors the QUE-34 rule: no internal/technical terms in user-visible strings.
 * `FIFO_GLOBAL` / `CATEGORY_PRIORITY` / `AUTOMATIC_CRON` are backend enum names
 * and must never appear as display text — only as `value=`.
 *
 * The short `PRIORITY_POLICY_LABELS` (just the term) is what the manager sees
 * inline in the step-2 routing table and the `<select>` options — keeping the
 * column narrow and the dropdown scannable. The longer `PRIORITY_POLICY_DESCRIPTIONS`
 * carries the full explanation and is surfaced as a tooltip (table info glyph)
 * and an `aria-describedby` hint (modal select), so the short label never loses
 * the meaning the parenthetical used to inline (feedback: copy was too long).
 */
export const PRIORITY_POLICY_LABELS: Record<PriorityPolicy, string> = {
  FIFO_GLOBAL: 'Urutan masuk',
  CATEGORY_PRIORITY: 'Prioritas kategori',
};

/**
 * Full Bahasa Indonesia explanation of each priority policy. Surfaced as a
 * `title` tooltip on the step-2 table info glyph and as an `aria-describedby`
 * hint under the modal priority `<select>` — the long-form companion to the
 * short {@link PRIORITY_POLICY_LABELS}. Never sent to the backend (display
 * only), so it lives in this single source of truth beside the label map.
 */
export const PRIORITY_POLICY_DESCRIPTIONS: Record<PriorityPolicy, string> = {
  FIFO_GLOBAL: 'Tiket dilayani sesuai urutan masuk: yang lebih dulu mengambil antrian dilayani lebih dulu.',
  CATEGORY_PRIORITY: 'Kategori dengan prioritas lebih tinggi dilayani lebih dulu, meskipun baru masuk.',
};

export const DAILY_RESET_MODE_LABELS: Record<DailyResetMode, string> = {
  AUTOMATIC_CRON: 'Otomatis setiap hari',
  MANUAL: 'Manual (tombol reset)',
};

/**
 * Friendly Bahasa Indonesia labels for the printer-mode enum (the
 * `/printer-config` page mode radio). The enum stays as the wire `value=`
 * (`PUT /api/system/config` sends `chrome` / `network-escpos`, never the
 * friendly text); these maps keep the human label next to the value so the two
 * never drift. Mirrors the QUE-34 rule: the raw enum (`chrome`,
 * `network-escpos`) must never appear as display text — only as `value=`.
 * "Chrome" and "ESC/POS" are the printer technology names the manager already
 * knows, so they stay; the rest of the copy is friendly Indonesian context.
 */
export const PRINTER_MODE_LABELS: Record<PrinterMode, string> = {
  chrome: 'Printer Browser (Chrome)',
  'network-escpos': 'Printer Thermal ESC/POS (Jaringan)',
  'usb-serial': 'Printer Thermal ESC/POS (USB)',
};

/**
 * The selectable serial baud rates for `usb-serial` mode, in stable display
 * order (matches the `/printer-config` baud-rate select). Common thermal
 * printer speeds; 9600 is the default (mirrors core-api's
 * `PrinterConfiguration.DEFAULT`).
 */
export const PRINTER_BAUD_RATES: readonly number[] = [9600, 19200, 38400, 57600, 115200];

/**
 * Friendly labels for the receipt paper-width radio. The mm width stays in the
 *  label (it IS the value the manager picks between); the parenthetical is the
 * friendly hint (small vs. the standard roll).
 */
export const PRINTER_PAPER_WIDTH_LABELS: Record<PrinterPaperWidth, string> = {
  58: '58mm (kecil)',
  80: '80mm (standar)',
};

/**
 * Friendly labels for the thermal-printer cut-mode radio (network-escpos +
 * usb-serial modes — both compose ESC/POS, so both send a cut command). The
 * enum stays as the wire `value=` (`full` / `partial` / `none`); the Indonesian
 * "Gunting …" copy is the manager-facing term for the cut command.
 */
export const PRINTER_CUT_MODE_LABELS: Record<PrinterCutMode, string> = {
  full: 'Gunting Penuh',
  partial: 'Gunting Separuh',
  none: 'Tidak Digunting',
};

/**
 * Friendly Bahasa Indonesia labels for the per-service light/dark theme choice
 * (QUE-47). The enum stays as the wire `value=` (`PUT /api/system/config` sends
 * `light`/`dark`, never the friendly text); these maps keep the human label next
 * to the value so the two never drift. Mirrors the QUE-34 rule: no technical
 * terms in user-visible copy.
 */
export const SERVICE_THEME_LABELS: Record<ThemeMode, string> = {
  light: 'Mode terang',
  dark: 'Mode gelap',
};

/**
 * Friendly Bahasa Indonesia labels for the four themable service surfaces
 * (QUE-47). The surface key stays as the wire identifier (`kiosk`/`tv`/…); this
 * map is the display name shown as the row label in the admin "Tema Layanan"
 * section. Never sent to the backend (display only).
 */
export const SERVICE_SURFACE_LABELS: Record<ServiceSurface, string> = {
  kiosk: 'Kiosk Antrian',
  tv: 'TV Display',
  caller: 'Panel Loket (Caller)',
  admin: 'Panel Admin',
};

/**
 * Friendly Bahasa Indonesia labels for a counter's live operational status on
 * the dashboard (QUE-44). `active` = a CALLING/SERVING ticket is at the counter
 * ("Sedang melayani"); `idle` = the counter has no active ticket ("Siap"). The
 * status is derived client-side from the live board, never sent to the backend
 * (display only). No internal status names (CALLING/SERVING) leak into the
 * label — mirroring the QUE-34 rule.
 */
export const COUNTER_STATUS_LABELS: Record<'active' | 'idle', string> = {
  active: 'Sedang melayani',
  idle: 'Siap',
};

/**
 * Friendly Bahasa Indonesia labels for the {@link UserRole} enum (QUE-43). The
 * enum stays as the wire `value=` (`POST /api/users` sends `admin` /
 * `caller-staff`, never the friendly text); these maps keep the human label
 * next to the value so the two never drift. Mirrors the QUE-34 rule: no
 * technical enum names in user-visible copy — "caller-staff" is a backend role
 * name and must never appear as display text.
 *
 * `USER_ROLE_LABELS` is the short label shown in the users table + the create
 * form `<select>`. `USER_ROLE_DESCRIPTIONS` is the longer companion surfaced as
 * an `aria-describedby` hint under the create-form role select.
 */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrator',
  'caller-staff': 'Staf Loket',
};

export const USER_ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'Akses penuh: konfigurasi, pengguna, analitik, dan audit.',
  'caller-staff': 'Akses panel loket: melayani antrian dari counter yang ditugaskan.',
};

/**
 * Friendly Bahasa Indonesia labels for the audit-trail `action` values. The
 * `action` field on {@link import('../api/types').AuditLogEntryDto} is the
 * serialized core-api `AuditAction` enum string (`MANUAL_RESET`,
 * `STATE_SCHEMA_CHANGE`, …) — a raw backend enum that must never appear as
 * display text (same QUE-34 / QUE-45 rule as the priority/reset maps above).
 * Surfaced wherever an audit entry is rendered to a manager: the `Log Audit`
 * page table (QUE-45) and the Dashboard "Aktivitas Terbaru" feed.
 *
 * The map is intentionally `Record<string, string>` (not `Record<AuditAction,
 * string>`) — the client types `action` as a plain `string` so an unknown /
 * future action degrades to the raw value via {@link labelForAuditAction}
 * rather than crashing or silently blanking. Adding a new action label is
 * additive and never breaks a wire value the client doesn't know about yet.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  MANUAL_RESET: 'Reset Antrian Manual',
  ARCHIVE_PREVIOUS_DAY: 'Arsip Data Hari Sebelumnya',
  STATE_SCHEMA_CHANGE: 'Ubah Alur Status',
  ROUTING_CHANGE: 'Ubah Routing Counter',
  DAILY_RESET_POLICY_CHANGE: 'Ubah Kebijakan Reset Harian',
  TRANSACTION_LOG_CLEANUP: 'Bersihkan Log Transaksi',
  SYSTEM_RESET: 'Reset Sistem Harian',
};

/**
 * Friendly label for an audit `action` wire value, falling back to the raw
 * string for an unknown/future action (safe degradation — never blanks). Use
 * this at every audit-action render site so the raw enum never leaks.
 */
export function labelForAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

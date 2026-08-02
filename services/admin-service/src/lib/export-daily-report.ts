import * as XLSX from 'xlsx';
import type { AuditLogEntryDto, DailyReportDto } from '../api/types';

/**
 * Builds a multi-sheet `.xlsx` workbook from the daily report + audit trail and
 * triggers a client-side download (FR-ADM-03 / QUE-26).
 *
 * SheetJS (`xlsx`) is pure JS — Vite bundles it into the admin-service bundle,
 * so the export runs fully offline with no runtime network call (NFR-REL-01).
 * `XLSX.writeFile` builds a Blob and clicks an anchor with the HTML5 `download`
 * attribute; no server round-trip, no external CDN.
 *
 * Three sheets:
 *  - **Ringkasan** — the daily totals (date, total visitors, avg wait, avg service).
 *  - **Per Kategori** — per-category breakdown rows.
 *  - **Audit Trail** — the recorded administrative actions.
 *
 * The `before`/`after` audit snapshots are opaque JSON objects (see
 * {@link AuditLogEntryDto}); they are stringified so an Excel cell can hold them.
 *
 * @param report   the daily analytics report (zero-shape when no tickets exist).
 * @param audit    the audit-trail entries, oldest-first.
 * @param fileName the download file name (e.g. `qms-report-2026-08-01.xlsx`).
 */
export function exportDailyReport(
  report: DailyReportDto,
  audit: readonly AuditLogEntryDto[],
  fileName: string,
): void {
  const wb = XLSX.utils.book_new();

  const summary = XLSX.utils.aoa_to_sheet([
    ['Tanggal', report.date],
    ['Total Pengunjung', report.totalTickets],
    ['Rata-rata Waktu Tunggu (ms)', report.avgWaitTimeMs],
    ['Rata-rata Waktu Layanan (ms)', report.avgServiceTimeMs],
  ]);
  XLSX.utils.book_append_sheet(wb, summary, 'Ringkasan');

  const categorySheet = XLSX.utils.aoa_to_sheet([
    ['Kode', 'Total Tiket', 'Rata Waktu Tunggu (ms)', 'Rata Waktu Layanan (ms)'],
    ...report.perCategory.map((c) => [
      c.code,
      c.totalTickets,
      c.avgWaitTimeMs,
      c.avgServiceTimeMs,
    ]),
  ]);
  XLSX.utils.book_append_sheet(wb, categorySheet, 'Per Kategori');

  const auditSheet = XLSX.utils.aoa_to_sheet([
    ['Waktu (epoch ms)', 'Aktor', 'Aksi', 'Sebelum', 'Sesudah'],
    ...audit.map((a) => [
      a.occurredAt,
      a.actor,
      a.action,
      a.before === null ? '' : JSON.stringify(a.before),
      JSON.stringify(a.after),
    ]),
  ]);
  XLSX.utils.book_append_sheet(wb, auditSheet, 'Audit Trail');

  XLSX.writeFile(wb, fileName);
}
import type { AuditLogEntryDto, DailyReportDto } from '../api/types';

/**
 * Builds a multi-sheet `.xlsx` workbook from the daily report + audit trail and
 * triggers a client-side download (FR-ADM-03 / QUE-26).
 *
 * SheetJS (`xlsx`) is pure JS and fully offline (NFR-REL-01). It is
 * **lazily `import()`-ed on first export** (QUE-41 AC9) so the heavy dependency
 * splits into its own Vite chunk and never enters the main bundle — the
 * analytics page loads faster and SheetJS is only fetched when the manager
 * actually exports. `XLSX.writeFile` builds a Blob and clicks an anchor with
 * the HTML5 `download` attribute; no server round-trip, no external CDN.
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
export async function exportDailyReport(
  report: DailyReportDto,
  audit: readonly AuditLogEntryDto[],
  fileName: string,
): Promise<void> {
  // Lazy-load SheetJS so it lands in a separate chunk, not the main bundle.
  const XLSX = await import('xlsx');

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
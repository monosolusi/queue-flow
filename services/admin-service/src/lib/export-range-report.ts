import type { AuditLogEntryDto, RangeReportDto } from '../api/types';

/**
 * Builds a multi-sheet `.xlsx` workbook from the range report + audit trail and
 * triggers a client-side download (FR-ADM-03 / QUE-44).
 *
 * SheetJS (`xlsx`) is pure JS and fully offline (NFR-REL-01). It is
 * **lazily `import()`-ed on first export** (QUE-41 AC9) so the heavy dependency
 * splits into its own Vite chunk and never enters the main bundle. Mirrors
 * `export-daily-report.ts`'s lazy-load + chunk-split pattern; re-running the
 * offline-assets gate after any lazy-split is a QUE-41 standing rule.
 *
 * Five sheets:
 *  - **Ringkasan** — the range bounds + totals.
 *  - **Per Hari** — the per-day series (date, totals, avg wait/service, served).
 *  - **Per Kategori** — per-category aggregates over the range.
 *  - **Performa Counter** — per-counter aggregates over the range (name-joined).
 *  - **Audit Trail** — the recorded administrative actions.
 *
 * @param report           the range analytics report (zero-shape when no tickets exist).
 * @param audit            the audit-trail entries, oldest-first.
 * @param counterNameById  display names for the counters (from `GET /api/counters`); a
 *   counter id missing from the map falls back to a `Counter {id}` label.
 * @param fileName         the download file name (e.g. `qms-report-2026-08-01_2026-08-07.xlsx`).
 */
export async function exportRangeReport(
  report: RangeReportDto,
  audit: readonly AuditLogEntryDto[],
  counterNameById: ReadonlyMap<number, string>,
  fileName: string,
): Promise<void> {
  // Lazy-load SheetJS so it lands in a separate chunk, not the main bundle.
  const XLSX = await import('xlsx');

  const wb = XLSX.utils.book_new();

  const summary = XLSX.utils.aoa_to_sheet([
    ['Dari', report.from],
    ['Sampai', report.to],
    ['Total Pengunjung', report.totalTickets],
    ['Rata-rata Waktu Tunggu (ms)', report.avgWaitTimeMs],
    ['Rata-rata Waktu Layanan (ms)', report.avgServiceTimeMs],
  ]);
  XLSX.utils.book_append_sheet(wb, summary, 'Ringkasan');

  const perDaySheet = XLSX.utils.aoa_to_sheet([
    ['Tanggal', 'Total Tiket', 'Dilayani', 'Rata Waktu Tunggu (ms)', 'Rata Waktu Layanan (ms)'],
    ...report.perDay.map((p) => [
      p.date,
      p.totalTickets,
      p.ticketsServed,
      p.avgWaitTimeMs,
      p.avgServiceTimeMs,
    ]),
  ]);
  XLSX.utils.book_append_sheet(wb, perDaySheet, 'Per Hari');

  const categorySheet = XLSX.utils.aoa_to_sheet([
    ['Kategori', 'Kode', 'Total Tiket', 'Rata Waktu Tunggu (ms)', 'Rata Waktu Layanan (ms)'],
    ...report.perCategory.map((c) => [
      c.categoryName,
      c.code,
      c.totalTickets,
      c.avgWaitTimeMs,
      c.avgServiceTimeMs,
    ]),
  ]);
  XLSX.utils.book_append_sheet(wb, categorySheet, 'Per Kategori');

  const counterSheet = XLSX.utils.aoa_to_sheet([
    ['Counter', 'Dilayani', 'Rata Waktu Layanan (ms)'],
    ...report.perCounter.map((c) => [
      counterNameById.get(c.counterId) ?? `Counter ${c.counterId}`,
      c.ticketsServed,
      c.avgServiceTimeMs,
    ]),
  ]);
  XLSX.utils.book_append_sheet(wb, counterSheet, 'Performa Counter');

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
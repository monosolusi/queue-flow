import { describe, expect, it, vi } from 'vitest';
import type { AuditLogEntryDto, DailyReportDto } from '../api/types';

/**
 * QUE-41 AC9 — SheetJS must be lazily `import()`-ed so the heavy dependency
 * splits into its own Vite chunk and never enters the main bundle. The test
 * proves laziness by mocking the `xlsx` module and asserting its factory only
 * runs when `exportDailyReport` is actually called — never merely on importing
 * the lib module.
 *
 * `vi.mock` factories are hoisted above the test body (they run before any
 * `import`), so a plain outer `let loaded = false` is in the temporal dead
 * zone and the factory cannot close over it. `vi.hoisted` returns a stable
 * mutable holder the hoisted factory CAN close over (the QUE-36 precedent).
 */
const { xlsxLoaded, markXlsxLoaded } = vi.hoisted(() => {
  let loaded = false;
  return {
    xlsxLoaded: () => loaded,
    markXlsxLoaded: () => {
      loaded = true;
    },
  };
});

vi.mock('xlsx', () => {
  markXlsxLoaded();
  return {
    utils: {
      book_new: () => ({ Sheets: {}, SheetNames: [] }),
      aoa_to_sheet: () => ({}),
      book_append_sheet: () => {},
    },
    writeFile: () => {},
  };
});

const emptyReport: DailyReportDto = {
  date: '2026-08-01',
  totalTickets: 0,
  avgWaitTimeMs: 0,
  avgServiceTimeMs: 0,
  perCategory: [],
};

describe('exportDailyReport (QUE-41 AC9 — lazy SheetJS)', () => {
  it('does not load xlsx merely on importing the lib module', async () => {
    // This test runs first (definition order); the factory has not been hit.
    expect(xlsxLoaded()).toBe(false);
    await import('./export-daily-report');
    // Importing the module alone must NOT trigger the dynamic `import('xlsx')`
    // (that line lives inside the function body, not at module top level).
    expect(xlsxLoaded()).toBe(false);
  });

  it('loads xlsx only when exportDailyReport is actually called', async () => {
    const { exportDailyReport } = await import('./export-daily-report');
    expect(xlsxLoaded()).toBe(false);

    await exportDailyReport(
      emptyReport,
      [] as readonly AuditLogEntryDto[],
      'qms-report-2026-08-01.xlsx',
    );

    expect(xlsxLoaded()).toBe(true);
  });
});
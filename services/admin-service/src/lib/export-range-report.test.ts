import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogEntryDto, RangeReportDto } from '../api/types';

/**
 * QUE-41 AC9 — SheetJS must be lazily `import()`-ed so the heavy dependency
 * splits into its own Vite chunk and never enters the main bundle. The test
 * proves laziness by mocking the `xlsx` module and asserting its factory only
 * runs when `exportRangeReport` is actually called — never merely on importing
 * the lib module. Mirrors the former `export-daily-report.test.ts` (QUE-44
 * moved the export to the range view).
 *
 * `vi.mock` factories are hoisted above the test body (they run before any
 * `import`), so a plain outer `let loaded = false` is in the temporal dead
 * zone and the factory cannot close over it. `vi.hoisted` returns a stable
 * mutable holder the hoisted factory CAN close over (the QUE-36 precedent).
 */
const { xlsxLoaded, markXlsxLoaded, aoaCalls, pushAoa } = vi.hoisted(() => {
  let loaded = false;
  const calls: unknown[][] = [];
  return {
    xlsxLoaded: () => loaded,
    markXlsxLoaded: () => {
      loaded = true;
    },
    aoaCalls: () => calls,
    pushAoa: (rows: unknown[]) => {
      calls.push(rows);
    },
  };
});

vi.mock('xlsx', () => {
  markXlsxLoaded();
  return {
    utils: {
      book_new: () => ({ Sheets: {}, SheetNames: [] }),
      aoa_to_sheet: (rows: unknown[]) => {
        pushAoa(rows);
        return {};
      },
      book_append_sheet: () => {},
    },
    writeFile: () => {},
  };
});

const emptyRange: RangeReportDto = {
  from: '2026-08-01',
  to: '2026-08-07',
  totalTickets: 0,
  avgWaitTimeMs: 0,
  avgServiceTimeMs: 0,
  perDay: [],
  perCategory: [],
  perCounter: [],
};

describe('exportRangeReport (QUE-41 AC9 — lazy SheetJS)', () => {
  // The hoisted `aoaCalls` accumulator is shared across tests; reset it before
  // each so a test that asserts on the captured aoa_to_sheet rows sees only its
  // own calls (pre-empts future contamination if more tests assert on it).
  beforeEach(() => {
    aoaCalls().length = 0;
  });

  it('does not load xlsx merely on importing the lib module', async () => {
    // This test runs first (definition order); the factory has not been hit.
    expect(xlsxLoaded()).toBe(false);
    await import('./export-range-report');
    // Importing the module alone must NOT trigger the dynamic `import('xlsx')`
    // (that line lives inside the function body, not at module top level).
    expect(xlsxLoaded()).toBe(false);
  });

  it('loads xlsx only when exportRangeReport is actually called', async () => {
    const { exportRangeReport } = await import('./export-range-report');
    expect(xlsxLoaded()).toBe(false);

    await exportRangeReport(
      emptyRange,
      [] as readonly AuditLogEntryDto[],
      new Map<number, string>(),
      'qms-report-2026-08-01_2026-08-07.xlsx',
    );

    expect(xlsxLoaded()).toBe(true);
  });

  it('writes the Per Kategori sheet with a "Kategori" header + the category NAME (QUE-49)', async () => {
    const { exportRangeReport } = await import('./export-range-report');
    const report: RangeReportDto = {
      ...emptyRange,
      perCategory: [
        {
          categoryId: 'cat-a',
          code: 'A',
          categoryName: 'Customer Service',
          totalTickets: 3,
          avgWaitTimeMs: 1000,
          avgServiceTimeMs: 2000,
        },
      ],
    };

    await exportRangeReport(
      report,
      [] as readonly AuditLogEntryDto[],
      new Map<number, string>(),
      'qms-report.xlsx',
    );

    // The Per Kategori sheet is the 3rd aoa_to_sheet call (Ringkasan, Per Hari, …).
    const categorySheet = aoaCalls()[2] as unknown[][];
    expect(categorySheet[0]).toEqual([
      'Kategori',
      'Kode',
      'Total Tiket',
      'Rata Waktu Tunggu (ms)',
      'Rata Waktu Layanan (ms)',
    ]);
    // The data row carries the human-readable NAME, not the raw code — the
    // actual QUE-49 fix (names in the export, codes demoted to a column).
    expect(categorySheet[1]).toEqual(['Customer Service', 'A', 3, 1000, 2000]);
  });
});

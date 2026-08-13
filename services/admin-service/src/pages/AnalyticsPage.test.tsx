import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AnalyticsPage, type RangeReportExporter } from './AnalyticsPage';
import { ToastProvider } from '../toast/toast-context';
import { daysAgoLocalKey, todayLocalKey } from '../lib/date';
import type { IAdminApi } from '../api/admin-api';
import type {
  AuditLogEntryDto,
  RangeReportDto,
  SystemConfigurationDto,
} from '../api/types';
import { DEFAULT_STATE_MACHINE, DEFAULT_BRAND_COLOR, DEFAULT_PRINTER_CONFIGURATION, DEFAULT_SERVICE_THEMES, DEFAULT_TV_GRID_LAYOUT } from '../api/types';

/**
 * The calendar's visible month + the day-button names depend on `new Date()`
 * (the page seeds `from`/`to` from `daysAgoLocalKey`/`todayLocalKey`). Pin the
 * system time to 20 July 2026 so the default range is deterministic
 * (`2026-07-14 – 2026-07-20`), the calendar opens on July 2026, and day buttons
 * are named e.g. "1 Juli 2026". `vi.setSystemTime` does NOT fake timers, so
 * `waitFor` (which uses `setTimeout`) still works.
 */
beforeAll(() => {
  vi.setSystemTime(new Date(2026, 6, 20));
});
afterAll(() => {
  vi.useRealTimers();
});

/** A configured store with two categories + two counters. */
function configuredStore(): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: true,
    storeName: 'Apotek Sehat',
    stateMachine: DEFAULT_STATE_MACHINE,
    dailyResetPolicy: {
      mode: 'AUTOMATIC_CRON',
      cronExpression: '0 0 * * *',
      resetTicketNumberTo: 1,
      archivePreviousDayData: true,
      timezone: 'Asia/Jakarta',
    },
    categories: [
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Kasir' },
    ],
    routingRules: [
      { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: ['cat-a'], priorityPolicy: 'FIFO_GLOBAL' },
      { counterId: 2, counterName: 'Counter 2', assignedCategoryIds: ['cat-a', 'cat-b'], priorityPolicy: 'CATEGORY_PRIORITY' },
    ],
    brandColor: DEFAULT_BRAND_COLOR,
    serviceThemes: { ...DEFAULT_SERVICE_THEMES },
    tvPanelLayout: DEFAULT_TV_GRID_LAYOUT,
    edgeRoutingLayout: {},
    nodePositions: {},
    printerConfiguration: { ...DEFAULT_PRINTER_CONFIGURATION },
  };
}

function rangeReport(from: string, to: string): RangeReportDto {
  return {
    from,
    to,
    totalTickets: 4,
    avgWaitTimeMs: 12000,
    avgServiceTimeMs: 30000,
    perDay: [
      { date: from, totalTickets: 2, avgWaitTimeMs: 10000, avgServiceTimeMs: 28000, ticketsServed: 2 },
      { date: to, totalTickets: 2, avgWaitTimeMs: 14000, avgServiceTimeMs: 32000, ticketsServed: 2 },
    ],
    perCategory: [
      { categoryId: 'cat-a', code: 'A', categoryName: 'Customer Service', totalTickets: 3, avgWaitTimeMs: 10000, avgServiceTimeMs: 28000 },
      { categoryId: 'cat-b', code: 'B', categoryName: 'Kasir', totalTickets: 1, avgWaitTimeMs: 2000, avgServiceTimeMs: 40000 },
    ],
    perCounter: [{ counterId: 1, ticketsServed: 2, avgServiceTimeMs: 33000 }],
  };
}

function emptyRangeReport(from: string, to: string): RangeReportDto {
  return {
    from,
    to,
    totalTickets: 0,
    avgWaitTimeMs: 0,
    avgServiceTimeMs: 0,
    perDay: [
      { date: from, totalTickets: 0, avgWaitTimeMs: 0, avgServiceTimeMs: 0, ticketsServed: 0 },
      { date: to, totalTickets: 0, avgWaitTimeMs: 0, avgServiceTimeMs: 0, ticketsServed: 0 },
    ],
    perCategory: [],
    perCounter: [],
  };
}

function auditEntries(): AuditLogEntryDto[] {
  return [
    {
      id: 'aud-1',
      actor: 'admin',
      action: 'MANUAL_RESET',
      before: null,
      after: { resetTo: 1 },
      occurredAt: 1_700_000_000_000,
    },
    {
      id: 'aud-2',
      actor: 'admin',
      action: 'STATE_SCHEMA_CHANGE',
      before: { states: ['WAITING'] },
      after: { states: ['WAITING', 'CALLING'] },
      occurredAt: 1_700_000_001_000,
    },
  ];
}

interface ApiStubs {
  getRangeReport: ReturnType<typeof vi.fn>;
  getAuditLog: ReturnType<typeof vi.fn>;
}

function makeApi(
  overrides: {
    config?: SystemConfigurationDto;
    range?: (from: string, to: string) => RangeReportDto;
    audit?: AuditLogEntryDto[];
  } = {},
): { api: IAdminApi; stubs: ApiStubs } {
  const config = overrides.config ?? configuredStore();
  const range = overrides.range ?? rangeReport;
  const audit = overrides.audit ?? auditEntries();
  const getRangeReport = vi.fn((from: string, to: string) => Promise.resolve(range(from, to)));
  const getAuditLog = vi.fn(() => Promise.resolve(audit));
  const getSystemConfig = vi.fn(() => Promise.resolve(config));
  const api: IAdminApi = {
    getSystemConfig,
    saveSystemConfig: vi.fn(),
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
    getDailyReport: vi.fn(),
    getCounterPerformance: vi.fn(),
    getRangeReport,
    getQueueBoard: vi.fn(),
    getCounters: vi.fn(),
    getAuditLog,
    triggerManualReset: vi.fn(),
    cleanupTransactionLogs: vi.fn(),
  };
  return { api, stubs: { getRangeReport, getAuditLog } };
}

/** Wrapped in a real ToastProvider — the export outcome is announced there. */
function renderPage(api: IAdminApi, exporter?: RangeReportExporter) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AnalyticsPage api={api} exporter={exporter ?? (async () => {})} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * The toast live regions, scoped through the viewport's `region` landmark. The
 * page's own loading paragraph is also `role="status"`, so a bare
 * `getByRole('status')` would be ambiguous while a range is loading.
 */
function toastViewport() {
  return within(screen.getByRole('region', { name: 'Notifikasi' }));
}
/** The polite live region — success toasts land here. */
function politeRegion() {
  return within(toastViewport().getByRole('status'));
}
/** The assertive live region — error toasts land here. */
function alertRegion() {
  return within(toastViewport().getByRole('alert'));
}

/** Opens the range calendar by clicking the grouped textbox trigger. The
 *  `DateRangeField` is reveal-on-custom (manager feedback: the rentang tanggal
 *  only appears when "Kustom" is pressed), so press "Kustom" first when the
 *  trigger is not yet mounted. */
function openRangeCalendar() {
  if (!screen.queryByTestId('analytics-range')) {
    fireEvent.click(screen.getByTestId('relative-range-custom'));
  }
  fireEvent.click(screen.getByTestId('analytics-range'));
}

describe('AnalyticsPage (range analytics — FR-ADM-03 / QUE-44)', () => {
  it('loads the range report and renders metrics, per-category + counter tables', async () => {
    const { api } = makeApi();
    const { container } = renderPage(api);

    expect(screen.getByText('Memuat analitik…')).toBeInTheDocument();
    expect(await screen.findByTestId('metric-total')).toHaveTextContent('4');
    expect(screen.getByTestId('metric-wait')).toHaveTextContent('12.0 detik');
    expect(screen.getByTestId('metric-service')).toHaveTextContent('30.0 detik');

    // Regression guard (arch-review): the ready render path must compose the
    // shared `.page` root so it keeps the unified max-width/centering/padding.
    // The geometry block was removed from `.analytics` — without `.page` the
    // primary view renders full-width, uncentered, no padding.
    expect(container.firstElementChild).toHaveClass('page');

    const perCategory = screen.getByRole('region', { name: 'Per kategori' });
    // QUE-49 — the per-category view shows human-readable NAMES, not raw codes.
    // Each name now appears twice: in the chart label and the table cell.
    expect(within(perCategory).getAllByText('Customer Service')).toHaveLength(2);
    expect(within(perCategory).getAllByText('Kasir')).toHaveLength(2);
    // The raw codes must NOT leak as visible category labels anymore (exact
    // match — a bare 'A'/'B' text node was the pre-fix table cell).
    expect(within(perCategory).queryByText('A')).not.toBeInTheDocument();
    expect(within(perCategory).queryByText('B')).not.toBeInTheDocument();

    // Counter 1 served 2 (from perCounter); Counter 2 backfilled to 0.
    expect(screen.getByText(/Counter 1 \(#1\)/)).toBeInTheDocument();
    const perf = screen.getByRole('region', { name: 'Performa counter' });
    expect(within(perf).getByText('2')).toBeInTheDocument();

    // QUE-45 — the audit trail moved to `/audit`; the in-page audit section no
    // longer renders. A "Lihat log audit" link bridges to the dedicated page,
    // and the raw enum strings must NOT leak here anymore.
    expect(screen.queryByText('MANUAL_RESET')).not.toBeInTheDocument();
    expect(screen.queryByText('STATE_SCHEMA_CHANGE')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Lihat log audit' })).toHaveAttribute('href', '/audit');
  });

  it('renders the range trend chart with one bar per day', async () => {
    const { api } = makeApi();
    renderPage(api);

    await screen.findByTestId('range-trend-chart');
    expect(screen.getByTestId('range-trend-bar-0')).toBeInTheDocument();
    expect(screen.getByTestId('range-trend-bar-1')).toBeInTheDocument();
    // Accessible summary carries the per-day values.
    expect(
      screen.getByRole('img', { name: /Total pengunjung per hari:/ }),
    ).toBeInTheDocument();
  });

  it('renders the zero state (no tickets) without short-circuiting the chart', async () => {
    const { api } = makeApi({ range: emptyRangeReport, audit: [] });
    renderPage(api);

    expect(await screen.findByTestId('metric-total')).toHaveTextContent('0');
    // The per-day zero series still renders bars (the backend materializes zero rows).
    expect(screen.getByTestId('range-trend-bar-0')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Per kategori' })).toHaveTextContent(
      'Tidak ada tiket pada rentang ini.',
    );
    // QUE-45 — the audit trail moved to `/audit`; the empty-range state no
    // longer renders an in-page audit section.
    expect(screen.queryByRole('region', { name: 'Audit trail' })).not.toBeInTheDocument();
  });

  it('surfaces an error and a back-to-dashboard link when the load fails', async () => {
    const { api } = makeApi();
    api.getRangeReport = vi.fn(() => Promise.reject(new Error('core-api down')));
    renderPage(api);

    expect(await screen.findByTestId('analytics-error')).toHaveTextContent(
      /Gagal memuat analitik: core-api down/i,
    );
    expect(screen.getByTestId('analytics-to-dashboard')).toHaveAttribute('href', '/');
  });

  it('invokes the exporter with the report, audit, counter-name map, and a range-stamped file name', async () => {
    const { api } = makeApi();
    const exporter = vi.fn<RangeReportExporter>();
    renderPage(api, exporter);

    await screen.findByTestId('metric-total');
    // Pin the range via the calendar so the file name is deterministic. The
    // day-button accessible name is "Weekday, D Juli 2026" — the `, ` prefix
    // disambiguates single-digit days (day 1 vs 11/21/31, day 7 vs 17/27).
    openRangeCalendar();
    fireEvent.click(screen.getByRole('button', { name: /, 1 Juli 2026/ }));
    fireEvent.click(screen.getByRole('button', { name: /, 7 Juli 2026/ }));
    await waitFor(() => expect(api.getRangeReport).toHaveBeenLastCalledWith('2026-07-01', '2026-07-07'));

    fireEvent.click(screen.getByTestId('analytics-export'));
    await waitFor(() => expect(exporter).toHaveBeenCalledTimes(1));
    const [report, audit, counterNameById, fileName] = exporter.mock.calls[0];
    expect(report.totalTickets).toBe(4);
    expect(audit).toHaveLength(2);
    expect(counterNameById.get(1)).toBe('Counter 1');
    expect(counterNameById.get(2)).toBe('Counter 2');
    expect(fileName).toBe('qms-report-2026-07-01_2026-07-07.xlsx');
  });

  it('reloads when the calendar picks a new range', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');
    const initialCalls = stubs.getRangeReport.mock.calls.length;

    openRangeCalendar();
    fireEvent.click(screen.getByRole('button', { name: /, 1 Juli 2026/ }));
    fireEvent.click(screen.getByRole('button', { name: /, 7 Juli 2026/ }));

    await waitFor(() =>
      expect(stubs.getRangeReport).toHaveBeenLastCalledWith('2026-07-01', '2026-07-07'),
    );
    expect(stubs.getRangeReport.mock.calls.length).toBeGreaterThan(initialCalls);
  });
});

// NOTE: the previous "inverted range blocks load" / "malformed date blocks
// load" / "per-field range validity" tests are gone — typing is no longer
// supported (the calendar is the only way to set a custom range), and the
// calendar structurally cannot produce a malformed or inverted pair. The
// page keeps a defensive `rangeInvalid` guard as defense-in-depth against a
// future caller that bypasses the calendar, but it is unreachable via the
// current UI, so there is no user-driven path to exercise it.

describe('AnalyticsPage — export feedback', () => {
  it('announces a successful export', async () => {
    const exporter = vi.fn(async () => {});
    const { api } = makeApi();
    renderPage(api, exporter);
    await screen.findByTestId('metric-total');

    fireEvent.click(screen.getByTestId('analytics-export'));

    expect(
      await politeRegion().findByText('Laporan .xlsx berhasil diunduh.'),
    ).toBeInTheDocument();
  });

  it('announces a FAILED export instead of swallowing the rejection', async () => {
    // `handleExport` had try/finally with no catch, so an exporter rejection was
    // silently dropped: the button returned to "Ekspor .xlsx" and the manager
    // believed a file had been written.
    const exporter = vi.fn(() => Promise.reject(new Error('disk penuh')));
    const { api } = makeApi();
    renderPage(api, exporter);
    await screen.findByTestId('metric-total');

    fireEvent.click(screen.getByTestId('analytics-export'));

    expect(await alertRegion().findByText(/disk penuh/)).toBeInTheDocument();
    expect(alertRegion().getByText(/^Gagal mengekspor laporan: /)).toBeInTheDocument();
    // The button is released for a retry.
    await waitFor(() => expect(screen.getByTestId('analytics-export')).not.toBeDisabled());
  });

  it('two same-tick export clicks run the exporter exactly once', async () => {
    const exporter = vi.fn(async () => {});
    const { api } = makeApi();
    renderPage(api, exporter);
    await screen.findByTestId('metric-total');

    const button = screen.getByTestId('analytics-export');
    fireEvent.click(button);
    fireEvent.click(button);

    await politeRegion().findByText('Laporan .xlsx berhasil diunduh.');
    expect(exporter).toHaveBeenCalledTimes(1);
  });
});

describe('AnalyticsPage — relative-range presets + unified range calendar', () => {
  it('the default render (last 7 days) has the "7 hari" preset pressed, "Kustom" not pressed, and the range trigger HIDDEN (reveal-on-custom)', async () => {
    const { api } = makeApi();
    renderPage(api);
    // The picker renders in the header even while the report loads, so no need
    // to await the ready state.
    expect(screen.getByTestId('relative-range-7')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('relative-range-14')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-30')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-90')).toHaveAttribute('aria-pressed', 'false');
    // Manager feedback: the rentang tanggal was too wide and should only appear
    // on custom. "Kustom" is present but not pressed, and the manual range
    // trigger is NOT mounted in preset mode (no separate from/to text inputs).
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('analytics-range')).not.toBeInTheDocument();
    expect(screen.queryByTestId('analytics-from')).not.toBeInTheDocument();
    expect(screen.queryByTestId('analytics-to')).not.toBeInTheDocument();
  });

  it('clicking the 30-hari preset reloads with daysAgoLocalKey(29) + todayLocalKey()', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    fireEvent.click(screen.getByTestId('relative-range-30'));

    const expectedFrom = daysAgoLocalKey(29);
    const expectedTo = todayLocalKey();
    await waitFor(() => expect(stubs.getRangeReport).toHaveBeenLastCalledWith(expectedFrom, expectedTo));
    // The 30-hari preset is now pressed; 7-hari is not; "Kustom" is not pressed
    // and the manual range trigger stays hidden (presets leave preset mode).
    expect(screen.getByTestId('relative-range-30')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('relative-range-7')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('analytics-range')).not.toBeInTheDocument();
  });

  it('clicking the 90-hari preset reloads with the 90-day window (the MAX_RANGE_DAYS cap)', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    fireEvent.click(screen.getByTestId('relative-range-90'));
    await waitFor(() =>
      expect(stubs.getRangeReport).toHaveBeenLastCalledWith(daysAgoLocalKey(89), todayLocalKey()),
    );
    expect(screen.getByTestId('relative-range-90')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('analytics-range')).not.toBeInTheDocument();
  });

  it('picking a custom range via the calendar reloads with the hand-picked window', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    openRangeCalendar();
    expect(screen.getByRole('dialog', { name: 'Pilih Rentang tanggal' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /, 1 Juli 2026/ }));
    fireEvent.click(screen.getByRole('button', { name: /, 7 Juli 2026/ }));

    await waitFor(() => expect(stubs.getRangeReport).toHaveBeenLastCalledWith('2026-07-01', '2026-07-07'));
    // Manager feedback: the manual range is reveal-on-custom. "Kustom" is
    // pressed, the trigger is mounted and shows the hand-picked window, and no
    // preset is pressed (the page suppresses the match to `null` while custom
    // is active, even though 1–7 Juli 2026 is not a preset window anyway).
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('analytics-range')).toHaveTextContent('2026-07-01');
    expect(screen.getByTestId('analytics-range')).toHaveTextContent('2026-07-07');
    expect(screen.getByTestId('relative-range-7')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-30')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking a preset from a hand-picked range leaves preset mode (hides the trigger) and loads the preset window', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    // First pick a custom range via the calendar (reveals the manual range).
    openRangeCalendar();
    fireEvent.click(screen.getByRole('button', { name: /, 1 Juli 2026/ }));
    fireEvent.click(screen.getByRole('button', { name: /, 7 Juli 2026/ }));
    await waitFor(() => expect(stubs.getRangeReport).toHaveBeenLastCalledWith('2026-07-01', '2026-07-07'));
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('analytics-range')).toHaveTextContent('2026-07-01');

    // Tap a preset → the page leaves custom mode (the manual range hides, the
    // "Kustom" toggle releases), that preset is pressed, and the load fires
    // with the preset range.
    fireEvent.click(screen.getByTestId('relative-range-30'));
    await waitFor(() =>
      expect(stubs.getRangeReport).toHaveBeenLastCalledWith(daysAgoLocalKey(29), todayLocalKey()),
    );
    expect(screen.getByTestId('relative-range-30')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('analytics-range')).not.toBeInTheDocument();
  });

  it('re-clicking "Kustom" toggles it off (hides the manual range and returns to preset mode)', async () => {
    const { api } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    // Reveal the manual range.
    fireEvent.click(screen.getByTestId('relative-range-custom'));
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('analytics-range')).toBeInTheDocument();

    // Re-click "Kustom" → a real toggle, not a one-way reveal: it releases,
    // the manual range hides, and preset mode resumes. The current range (last
    // 7 days) matches the 7-hari preset, so it honestly shows pressed again.
    fireEvent.click(screen.getByTestId('relative-range-custom'));
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('analytics-range')).not.toBeInTheDocument();
    expect(screen.getByTestId('relative-range-7')).toHaveAttribute('aria-pressed', 'true');
  });
});
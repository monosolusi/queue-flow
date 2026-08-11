import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AnalyticsPage, type RangeReportExporter } from './AnalyticsPage';
import { ToastProvider } from '../toast/toast-context';
import type { IAdminApi } from '../api/admin-api';
import type {
  AuditLogEntryDto,
  RangeReportDto,
  SystemConfigurationDto,
} from '../api/types';
import { DEFAULT_STATE_MACHINE, DEFAULT_BRAND_COLOR, DEFAULT_SERVICE_THEMES } from '../api/types';

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

describe('AnalyticsPage (range analytics — FR-ADM-03 / QUE-44)', () => {
  it('loads the range report and renders metrics, per-category + counter tables', async () => {
    const { api } = makeApi();
    renderPage(api);

    expect(screen.getByText('Memuat analitik…')).toBeInTheDocument();
    expect(await screen.findByTestId('metric-total')).toHaveTextContent('4');
    expect(screen.getByTestId('metric-wait')).toHaveTextContent('12.0 detik');
    expect(screen.getByTestId('metric-service')).toHaveTextContent('30.0 detik');

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
    // Pin the range so the file name is deterministic.
    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByTestId('analytics-to'), { target: { value: '2026-07-07' } });
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

  it('reloads when the from/to inputs change', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');
    expect(stubs.getRangeReport).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );

    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-07-01' } });
    await waitFor(() =>
      expect(stubs.getRangeReport).toHaveBeenLastCalledWith('2026-07-01', expect.any(String)),
    );
  });

  it('rejects an inverted range (from > to): no load, export disabled, validation message', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');
    const initialCalls = stubs.getRangeReport.mock.calls.length;

    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-12-31' } });
    fireEvent.change(screen.getByTestId('analytics-to'), { target: { value: '2026-01-01' } });

    expect(await screen.findByTestId('analytics-range-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-export')).toBeDisabled();
    // The inverted range must not trigger a load.
    expect(stubs.getRangeReport.mock.calls.length).toBe(initialCalls);
  });

  it('blocks a MALFORMED date and fires no getRangeReport', async () => {
    // The field is a text input now (DateField), so it accepts a partial or
    // impossible key where `type="date"` silently coerced to ''. `isDateKey`
    // catches it client-side before the request goes out.
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');
    const initialCalls = stubs.getRangeReport.mock.calls.length;

    // Half-typed, then an impossible civil date — neither may reach the API.
    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-07' } });
    expect(await screen.findByTestId('analytics-range-invalid')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-02-31' } });
    expect(screen.getByTestId('analytics-range-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-export')).toBeDisabled();
    expect(screen.getByTestId('analytics-from')).toHaveAttribute('aria-invalid', 'true');
    expect(stubs.getRangeReport.mock.calls.length).toBe(initialCalls);

    // A complete, real date resumes loading.
    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-07-01' } });
    await waitFor(() =>
      expect(stubs.getRangeReport.mock.calls.length).toBeGreaterThan(initialCalls),
    );
  });
});

describe('AnalyticsPage — per-field range validity', () => {
  it('flags ONLY the malformed field, and describes it by the error node', async () => {
    const { api } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-0' } });

    const from = screen.getByTestId('analytics-from');
    const to = screen.getByTestId('analytics-to');
    expect(from).toHaveAttribute('aria-invalid', 'true');
    // `to` is still a perfectly good date — flagging it would misdirect the fix.
    expect(to).not.toHaveAttribute('aria-invalid');

    // aria-invalid and aria-describedby travel together (repo convention), and
    // the id must resolve to a node that actually exists.
    const error = screen.getByTestId('analytics-range-invalid');
    expect(from).toHaveAttribute('aria-describedby', error.id);
    expect(to).not.toHaveAttribute('aria-describedby');
  });

  it('flags ONLY the malformed field when it sorts ABOVE the other (mirror case)', async () => {
    // The sibling test's `2026-0` happens to sort BELOW the default `to`, so it
    // would pass even with the inversion test ungated. These two mis-attribute
    // the fault to the valid field unless `from > to` is gated on both sides
    // being well-formed: `'2026-1' > '2026-08-11'` is true char-wise
    // (`'1' > '0'`), and `'2026-08-05' > ''` is true for any non-empty string.
    const { api } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-1' } });
    expect(screen.getByTestId('analytics-from')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('analytics-to')).not.toHaveAttribute('aria-invalid');

    // And the reverse: clearing `to` must not flag a perfectly valid `from`.
    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-08-05' } });
    fireEvent.change(screen.getByTestId('analytics-to'), { target: { value: '' } });
    expect(screen.getByTestId('analytics-to')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('analytics-from')).not.toHaveAttribute('aria-invalid');
  });

  it('flags BOTH fields when the range is inverted (the pair is what is wrong)', async () => {
    const { api } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-12-31' } });
    fireEvent.change(screen.getByTestId('analytics-to'), { target: { value: '2026-01-01' } });

    const error = await screen.findByTestId('analytics-range-invalid');
    expect(screen.getByTestId('analytics-from')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('analytics-to')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('analytics-from')).toHaveAttribute('aria-describedby', error.id);
    expect(screen.getByTestId('analytics-to')).toHaveAttribute('aria-describedby', error.id);
  });

  it('clears both flags once the range is valid again', async () => {
    const { api } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-0' } });
    expect(screen.getByTestId('analytics-from')).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-01-01' } });
    await waitFor(() =>
      expect(screen.queryByTestId('analytics-range-invalid')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('analytics-from')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByTestId('analytics-from')).not.toHaveAttribute('aria-describedby');
  });
});

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

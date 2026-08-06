import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AnalyticsPage, type RangeReportExporter } from './AnalyticsPage';
import type { IAdminApi } from '../api/admin-api';
import type {
  AuditLogEntryDto,
  RangeReportDto,
  SystemConfigurationDto,
} from '../api/types';
import { DEFAULT_STATE_MACHINE, DEFAULT_BRAND_COLOR } from '../api/types';

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
      { categoryId: 'cat-a', code: 'A', totalTickets: 3, avgWaitTimeMs: 10000, avgServiceTimeMs: 28000 },
      { categoryId: 'cat-b', code: 'B', totalTickets: 1, avgWaitTimeMs: 2000, avgServiceTimeMs: 40000 },
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

function renderPage(api: IAdminApi, exporter?: RangeReportExporter) {
  return render(
    <MemoryRouter>
      <AnalyticsPage api={api} exporter={exporter ?? (async () => {})} />
    </MemoryRouter>,
  );
}

describe('AnalyticsPage (range analytics — FR-ADM-03 / QUE-44)', () => {
  it('loads the range report and renders metrics, per-category + counter tables', async () => {
    const { api } = makeApi();
    renderPage(api);

    expect(screen.getByText('Memuat analitik…')).toBeInTheDocument();
    expect(await screen.findByTestId('metric-total')).toHaveTextContent('4');
    expect(screen.getByTestId('metric-wait')).toHaveTextContent('12.0 s');
    expect(screen.getByTestId('metric-service')).toHaveTextContent('30.0 s');

    const perCategory = screen.getByRole('region', { name: 'Per kategori' });
    expect(within(perCategory).getByText('A')).toBeInTheDocument();
    expect(within(perCategory).getByText('B')).toBeInTheDocument();

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
});
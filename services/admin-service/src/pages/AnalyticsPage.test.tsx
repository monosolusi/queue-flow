import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AnalyticsPage, type DailyReportExporter } from './AnalyticsPage';
import type { IAdminApi } from '../api/admin-api';
import type {
  AuditLogEntryDto,
  CounterPerformanceDto,
  DailyReportDto,
  SystemConfigurationDto,
} from '../api/types';
import { DEFAULT_STATE_MACHINE, DEFAULT_BRAND_COLOR } from '../api/types';

/** A configured store with two categories + two counters (mirrors AdminPanel fixtures). */
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

function dailyReport(date: string): DailyReportDto {
  return {
    date,
    totalTickets: 4,
    avgWaitTimeMs: 12000,
    avgServiceTimeMs: 30000,
    perCategory: [
      { categoryId: 'cat-a', code: 'A', totalTickets: 3, avgWaitTimeMs: 10000, avgServiceTimeMs: 28000 },
      { categoryId: 'cat-b', code: 'B', totalTickets: 1, avgWaitTimeMs: 2000, avgServiceTimeMs: 40000 },
    ],
  };
}

function emptyDailyReport(date: string): DailyReportDto {
  return { date, totalTickets: 0, avgWaitTimeMs: 0, avgServiceTimeMs: 0, perCategory: [] };
}

function counterPerf(counterId: number, date: string, served: number, avg: number): CounterPerformanceDto {
  return { counterId, date, ticketsServed: served, avgServiceTimeMs: avg };
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
  getDailyReport: ReturnType<typeof vi.fn>;
  getCounterPerformance: ReturnType<typeof vi.fn>;
  getAuditLog: ReturnType<typeof vi.fn>;
}

function makeApi(
  overrides: {
    config?: SystemConfigurationDto;
    daily?: (date: string) => DailyReportDto;
    counter?: (counterId: number, date: string) => CounterPerformanceDto;
    audit?: AuditLogEntryDto[];
  } = {},
): { api: IAdminApi; stubs: ApiStubs } {
  const config = overrides.config ?? configuredStore();
  const daily = overrides.daily ?? dailyReport;
  const counter = overrides.counter ?? ((id: number, date: string) => counterPerf(id, date, id === 1 ? 2 : 1, 33000));
  const audit = overrides.audit ?? auditEntries();
  const getDailyReport = vi.fn((date: string) => Promise.resolve(daily(date)));
  const getCounterPerformance = vi.fn((id: number, date: string) => Promise.resolve(counter(id, date)));
  const getAuditLog = vi.fn(() => Promise.resolve(audit));
  const getSystemConfig = vi.fn(() => Promise.resolve(config));
  const api: IAdminApi = {
    getSystemConfig,
    saveSystemConfig: vi.fn(),
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
    getDailyReport,
    getCounterPerformance,
    getAuditLog,
    triggerManualReset: vi.fn(),
    cleanupTransactionLogs: vi.fn(),
  };
  return { api, stubs: { getDailyReport, getCounterPerformance, getAuditLog } };
}

function renderPage(api: IAdminApi, exporter?: DailyReportExporter) {
  return render(
    <MemoryRouter>
      <AnalyticsPage api={api} exporter={exporter ?? (async () => {})} />
    </MemoryRouter>,
  );
}

describe('AnalyticsPage (FR-ADM-03 / QUE-26)', () => {
  it('shows a loading state, then renders the daily metrics, per-category + counter tables, and the audit trail', async () => {
    const { api } = makeApi();
    renderPage(api);

    expect(screen.getByText('Memuat analitik…')).toBeInTheDocument();
    // Metrics render (totals + averages formatted as seconds).
    expect(await screen.findByTestId('metric-total')).toHaveTextContent('4');
    expect(screen.getByTestId('metric-wait')).toHaveTextContent('12.0 s');
    expect(screen.getByTestId('metric-service')).toHaveTextContent('30.0 s');
    // Per-category rows — the breakdown carries the category code, not the name.
    // Scoped to the "Per kategori" region so the recap-chart code labels (also A/B)
    // don't make `getByText` match multiple nodes.
    const perCategory = screen.getByRole('region', { name: 'Per kategori' });
    expect(within(perCategory).getByText('A')).toBeInTheDocument();
    expect(within(perCategory).getByText('B')).toBeInTheDocument();
    // Counter performance rows are labelled by name + #id.
    expect(screen.getByText(/Counter 1 \(#1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Counter 2 \(#2\)/)).toBeInTheDocument();
    // Audit trail rows — the action strings render.
    expect(screen.getByText('MANUAL_RESET')).toBeInTheDocument();
    expect(screen.getByText('STATE_SCHEMA_CHANGE')).toBeInTheDocument();
  });

  it('renders a per-category bar chart for each FR-ADM-03 metric (Total/Wait/Service)', async () => {
    const { api } = makeApi();
    renderPage(api);

    // The recap section renders one bar per category per metric (3 metrics x 2
    // categories = 6 bars). Each bar carries its metric + category code in the
    // testid so the chart is assertable without SheetJS or a pixel diff.
    await screen.findByTestId('recap-charts');
    for (const metric of ['total', 'wait', 'service'] as const) {
      expect(screen.getByTestId(`recap-bar-${metric}-A`)).toBeInTheDocument();
      expect(screen.getByTestId(`recap-bar-${metric}-B`)).toBeInTheDocument();
    }
    // The accessible summary carries the formatted values, so a chart that
    // rendered six zero-width bars for any input would fail this — it verifies
    // the value-formatting wiring (count vs `formatSeconds`) without a pixel diff.
    expect(
      screen.getByRole('img', { name: /Total Pengunjung per kategori: A 3, B 1/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Rata-rata Waktu Tunggu per kategori: A 10\.0 s, B 2\.0 s/ }),
    ).toBeInTheDocument();
  });

  it('renders the empty state when there is no data for the date and disables export', async () => {
    const { api } = makeApi({
      daily: emptyDailyReport,
      counter: (_id, date) => counterPerf(_id, date, 0, 0),
      audit: [],
    });
    renderPage(api);

    expect(await screen.findByTestId('analytics-empty')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-export')).toBeDisabled();
    // No recap charts in the empty state (the page short-circuits before them).
    expect(screen.queryByTestId('recap-charts')).not.toBeInTheDocument();
  });

  it('surfaces an error and a back-to-admin link when the load fails', async () => {
    const { api } = makeApi();
    // Force the daily report read to fail.
    api.getDailyReport = vi.fn(() => Promise.reject(new Error('core-api down')));
    renderPage(api);

    expect(await screen.findByText(/Gagal memuat analitik: core-api down/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kembali ke Admin' })).toBeInTheDocument();
  });

  it('invokes the exporter with the loaded report, audit trail, and a date-stamped file name', async () => {
    const { api } = makeApi();
    const exporter = vi.fn();
    renderPage(api, exporter);

    await screen.findByTestId('metric-total');
    fireEvent.click(screen.getByTestId('analytics-export'));

    await waitFor(() => expect(exporter).toHaveBeenCalledTimes(1));
    const [report, audit, fileName] = exporter.mock.calls[0];
    expect(report.totalTickets).toBe(4);
    expect(audit).toHaveLength(2);
    expect(fileName).toMatch(/^qms-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it('reloads when the date changes', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');
    expect(stubs.getDailyReport).toHaveBeenLastCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));

    // Change the date — the report read is called again with the new key.
    fireEvent.change(screen.getByTestId('analytics-date'), { target: { value: '2026-07-31' } });
    await waitFor(() => expect(stubs.getDailyReport).toHaveBeenLastCalledWith('2026-07-31'));
  });

  it('requests per-counter performance for every configured counter', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('metric-total');

    expect(stubs.getCounterPerformance).toHaveBeenCalledWith(1, expect.any(String));
    expect(stubs.getCounterPerformance).toHaveBeenCalledWith(2, expect.any(String));
  });
});
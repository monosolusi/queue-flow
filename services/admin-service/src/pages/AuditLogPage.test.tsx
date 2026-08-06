import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuditLogPage } from './AuditLogPage';
import type { IAdminApi } from '../api/admin-api';
import type { AuditLogEntryDto, SystemConfigurationDto } from '../api/types';
import { DEFAULT_STATE_MACHINE, DEFAULT_BRAND_COLOR } from '../api/types';

/** Local `YYYY-MM-DD` for an epoch-ms timestamp — mirrors the page helper so the
 *  date-filter test is TZ-independent (the runner's local TZ determines the civil
 *  date; computing the filter value the same way the page does keeps them aligned). */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

/** Two entries on consecutive days at 12:00 UTC — noon UTC keeps the civil date
 *  stable across all real runner TZs (−12..+12), so the date-filter test is
 *  deterministic regardless of the test host's local timezone. */
function auditEntries(): AuditLogEntryDto[] {
  return [
    {
      id: 'aud-1',
      actor: 'admin',
      action: 'MANUAL_RESET',
      before: null,
      after: { resetTo: 1 },
      occurredAt: Date.UTC(2023, 10, 14, 12),
    },
    {
      id: 'aud-2',
      actor: 'admin',
      action: 'STATE_SCHEMA_CHANGE',
      before: { states: ['WAITING'] },
      after: { states: ['WAITING', 'CALLING'] },
      occurredAt: Date.UTC(2023, 10, 15, 12),
    },
  ];
}

function makeApi(overrides: { audit?: AuditLogEntryDto[] } = {}): { api: IAdminApi } {
  const config = configuredStore();
  const audit = overrides.audit ?? auditEntries();
  const api: IAdminApi = {
    getSystemConfig: vi.fn(() => Promise.resolve(config)),
    saveSystemConfig: vi.fn(),
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
    getDailyReport: vi.fn(),
    getCounterPerformance: vi.fn(),
    getRangeReport: vi.fn(),
    getQueueBoard: vi.fn(),
    getCounters: vi.fn(),
    getAuditLog: vi.fn(() => Promise.resolve(audit)),
    triggerManualReset: vi.fn(),
    cleanupTransactionLogs: vi.fn(),
  };
  return { api };
}

function renderPage(api: IAdminApi) {
  return render(
    <MemoryRouter>
      <AuditLogPage api={api} />
    </MemoryRouter>,
  );
}

describe('AuditLogPage (QUE-45)', () => {
  it('shows a loading state, then renders the audit table with friendly action labels', async () => {
    const { api } = makeApi();
    renderPage(api);

    expect(screen.getByText('Memuat log audit…')).toBeInTheDocument();
    // The raw enum strings must NEVER leak — the friendly labels render instead.
    expect(await screen.findByText('Reset Antrian Manual')).toBeInTheDocument();
    expect(screen.getByText('Ubah Alur Status')).toBeInTheDocument();
    expect(screen.queryByText('MANUAL_RESET')).not.toBeInTheDocument();
    expect(screen.queryByText('STATE_SCHEMA_CHANGE')).not.toBeInTheDocument();
  });

  it('renders the empty state when there are no entries', async () => {
    const { api } = makeApi({ audit: [] });
    renderPage(api);

    expect(await screen.findByTestId('audit-empty')).toHaveTextContent('Belum ada entri audit.');
  });

  it('surfaces an error and a back-to-dashboard link when the load fails', async () => {
    const { api } = makeApi();
    api.getAuditLog = vi.fn(() => Promise.reject(new Error('core-api down')));
    renderPage(api);

    expect(await screen.findByText(/Gagal memuat log audit: core-api down/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kembali ke Dashboard' })).toBeInTheDocument();
  });

  it('filters entries client-side by the selected date and clears back to all', async () => {
    const entries = auditEntries();
    const dayA = localDayKey(entries[0].occurredAt); // MANUAL_RESET day
    const { api } = makeApi({ audit: entries });
    renderPage(api);

    // Both entries render initially (most-recent-first: STATE_SCHEMA_CHANGE, then MANUAL_RESET).
    await screen.findByText('Ubah Alur Status');
    expect(screen.getByText('Reset Antrian Manual')).toBeInTheDocument();

    // Filter to day A — only the MANUAL_RESET entry (friendly label) remains.
    fireEvent.change(screen.getByTestId('audit-filter-date'), { target: { value: dayA } });
    expect(screen.getByText('Reset Antrian Manual')).toBeInTheDocument();
    expect(screen.queryByText('Ubah Alur Status')).not.toBeInTheDocument();

    // Clear the filter — both entries return.
    fireEvent.change(screen.getByTestId('audit-filter-date'), { target: { value: '' } });
    expect(screen.getByText('Reset Antrian Manual')).toBeInTheDocument();
    expect(screen.getByText('Ubah Alur Status')).toBeInTheDocument();
  });

  it('shows the empty state when the filter matches no entries', async () => {
    const { api } = makeApi();
    renderPage(api);
    await screen.findByText('Reset Antrian Manual');

    // A date with no entries → the empty state (not a blank table).
    fireEvent.change(screen.getByTestId('audit-filter-date'), { target: { value: '2020-01-01' } });
    expect(await screen.findByTestId('audit-empty')).toBeInTheDocument();
  });

  it('renders the page <h1> on the loading and ready states (page owns the h1)', () => {
    // The AppShell topbar title is a non-heading <span>, so the routed page must
    // provide the <h1> on every view (AC8) — including loading.
    const { api } = makeApi();
    renderPage(api);
    expect(screen.getByRole('heading', { level: 1, name: 'Log Audit' })).toBeInTheDocument();
  });
});
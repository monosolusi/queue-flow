import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from './DashboardPage';
import type { IAdminApi } from '../api/admin-api';
import type {
  CounterDto,
  QueueBoardStateDto,
  SystemConfigurationDto,
  TicketStateDto,
} from '../api/types';
import { DEFAULT_STATE_MACHINE, DEFAULT_BRAND_COLOR, DEFAULT_PRINTER_CONFIGURATION, DEFAULT_SERVICE_THEMES, DEFAULT_TV_GRID_LAYOUT } from '../api/types';

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
    nodePositions: {}, nodeActions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    printerConfiguration: { ...DEFAULT_PRINTER_CONFIGURATION },
  };
}

const COUNTERS: readonly CounterDto[] = [
  {
    counterId: 1,
    counterName: 'Counter 1',
    assignedCategories: [{ id: 'cat-a', code: 'A', name: 'Customer Service' }],
    priorityPolicy: 'FIFO_GLOBAL',
  },
  {
    counterId: 2,
    counterName: 'Counter 2',
    assignedCategories: [
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Kasir' },
    ],
    priorityPolicy: 'CATEGORY_PRIORITY',
  },
];

function ticket(
  id: string,
  number: string,
  categoryId: string,
  status: string,
  counterId: number | null,
): TicketStateDto {
  return { ticketId: id, ticketNumber: number, categoryId, status, counterId };
}

/** A board with one active call at counter 1 + 3 waiting (2×A, 1×B). */
function liveBoard(): QueueBoardStateDto {
  return {
    active: [ticket('t1', 'A-001', 'cat-a', 'CALLING', 1)],
    waiting: [
      ticket('t2', 'A-002', 'cat-a', 'WAITING', null),
      ticket('t3', 'A-003', 'cat-a', 'WAITING', null),
      ticket('t4', 'B-001', 'cat-b', 'WAITING', null),
    ],
    waitingCount: 3,
  };
}

interface ApiStubs {
  getQueueBoard: ReturnType<typeof vi.fn>;
  getCounters: ReturnType<typeof vi.fn>;
}

function makeApi(
  overrides: {
    board?: QueueBoardStateDto | (() => Promise<QueueBoardStateDto>);
    counters?: readonly CounterDto[];
  } = {},
): { api: IAdminApi; stubs: ApiStubs } {
  const board = overrides.board ?? liveBoard();
  const counters = overrides.counters ?? COUNTERS;
  const getQueueBoard = vi.fn(() =>
    board instanceof Function ? board() : Promise.resolve(board),
  );
  const getCounters = vi.fn(() => Promise.resolve(counters));
  const api: IAdminApi = {
    getSystemConfig: vi.fn(),
    saveSystemConfig: vi.fn(),
    getActiveStateMachine: vi.fn(),
    getDailyReport: vi.fn(),
    getCounterPerformance: vi.fn(),
    getRangeReport: vi.fn(),
    getQueueBoard,
    getCounters,
    getAuditLog: vi.fn(),
    triggerManualReset: vi.fn(),
    cleanupTransactionLogs: vi.fn(),
  };
  return { api, stubs: { getQueueBoard, getCounters } };
}

function renderPage(api: IAdminApi, config: SystemConfigurationDto | null = configuredStore()) {
  return render(
    <MemoryRouter>
      <DashboardPage api={api} config={config} />
    </MemoryRouter>,
  );
}

describe('DashboardPage (live operational status — QUE-44)', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('renders the now-serving card + waiting counts + counter statuses', async () => {
    const { api } = makeApi();
    const { container } = renderPage(api);

    // Now-serving: last active ticket → A-001 at Counter 1.
    expect(await screen.findByTestId('now-serving-number')).toHaveTextContent('A-001');
    // Regression guard (layout-consistency refactor): the ready render path
    // must compose the shared `.page` root so it keeps the unified
    // max-width/centering/padding. DashboardPage was the 1100px / 1.25rem
    // outlier this refactor specifically converges — guard the ready path so a
    // future edit cannot silently re-introduce the divergent geometry (the
    // static CSS guard catches the rule, this catches the runtime class).
    expect(container.firstElementChild).toHaveClass('page');
    expect(screen.getByTestId('now-serving-counter')).toHaveTextContent('Counter 1');

    // Waiting per category: 2×A, 1×B.
    expect(screen.getByTestId('waiting-count-A')).toHaveTextContent('2');
    expect(screen.getByTestId('waiting-count-B')).toHaveTextContent('1');

    // Counter statuses: counter 1 active, counter 2 idle.
    expect(screen.getByTestId('counter-status-1')).toHaveTextContent('Sedang melayani');
    expect(screen.getByTestId('counter-status-2')).toHaveTextContent('Siap');
    expect(screen.getByTestId('counter-ticket-1')).toHaveTextContent('A-001');
    expect(screen.queryByTestId('counter-ticket-2')).not.toBeInTheDocument();
  });

  it('renders the empty now-serving state + all-idle counters when the board is quiet', async () => {
    const { api } = makeApi({
      board: { active: [], waiting: [], waitingCount: 0 },
    });
    renderPage(api);

    expect(await screen.findByTestId('now-serving-empty')).toHaveTextContent(
      'Tidak ada panggilan aktif.',
    );
    expect(screen.getByTestId('counter-status-1')).toHaveTextContent('Siap');
    expect(screen.getByTestId('counter-status-2')).toHaveTextContent('Siap');
  });

  it('renders the skeleton a11y state while the first fetch is pending', () => {
    // A fetch that never resolves keeps `loading` true → skeleton (CLAUDE.md recipe).
    const { api } = makeApi({ board: () => new Promise<QueueBoardStateDto>(() => {}) });
    renderPage(api);

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveTextContent('Memuat status antrian…');
    expect(screen.getByTestId('dashboard-skeleton')).toBeInTheDocument();
    // No live widgets leak before the snapshot resolves.
    expect(screen.queryByTestId('now-serving-number')).not.toBeInTheDocument();
  });

  it('renders the skeleton while config is still loading (not yet threaded)', () => {
    const { api } = makeApi();
    renderPage(api, null);

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('dashboard-skeleton')).toBeInTheDocument();
    // Poll is gated on config — no fetch fires yet.
    expect(screen.queryByTestId('now-serving-number')).not.toBeInTheDocument();
  });

  it('surfaces an error message (no wizard CTA) when the load fails', async () => {
    const { api } = makeApi();
    api.getQueueBoard = vi.fn(() => Promise.reject(new Error('core-api down')));
    renderPage(api);

    expect(await screen.findByTestId('dashboard-error')).toHaveTextContent(
      /Gagal memuat status antrian: core-api down/i,
    );
    expect(screen.queryByRole('link', { name: /Buka Wizard/i })).not.toBeInTheDocument();
  });

  it('keeps showing the last board when a refresh fails (stale-data banner)', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('now-serving-number');

    // The next poll fails.
    api.getQueueBoard = vi.fn(() => Promise.reject(new Error('timeout')));
    fireEvent.click(screen.getByTestId('dashboard-refresh'));

    // Stale banner appears, but the last board stays visible.
    expect(await screen.findByTestId('dashboard-stale')).toBeInTheDocument();
    expect(screen.getByTestId('now-serving-number')).toHaveTextContent('A-001');
    expect(stubs.getQueueBoard).toHaveBeenCalled();
  });

  it('renders the page <h1> on the loading + error states', async () => {
    const { api } = makeApi();
    api.getQueueBoard = vi.fn(() => Promise.reject(new Error('core-api down')));
    renderPage(api);

    // Loading state renders the h1 immediately (synchronous header).
    expect(screen.getByRole('heading', { level: 1, name: 'Status Antrian' })).toBeInTheDocument();
    await screen.findByTestId('dashboard-error');
    expect(screen.getByRole('heading', { level: 1, name: 'Status Antrian' })).toBeInTheDocument();
  });

  it('Muat Ulang triggers a re-fetch', async () => {
    const { api, stubs } = makeApi();
    renderPage(api);
    await screen.findByTestId('now-serving-number');
    expect(stubs.getQueueBoard).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('dashboard-refresh'));
    await screen.findByTestId('now-serving-number');
    expect(stubs.getQueueBoard).toHaveBeenCalledTimes(2);
  });

  it('polls the board on the 8 s interval (fake timers)', async () => {
    vi.useFakeTimers();
    const { api, stubs } = makeApi();
    renderPage(api);
    // Flush the initial fetch microtask (fake timers don't auto-flush).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stubs.getQueueBoard).toHaveBeenCalledTimes(1);

    // First interval tick → one more fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(stubs.getQueueBoard).toHaveBeenCalledTimes(2);
    // Second tick → another.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(stubs.getQueueBoard).toHaveBeenCalledTimes(3);
  });

  it('pauses polling when the tab is hidden and re-fetches on return (fake timers)', async () => {
    vi.useFakeTimers();
    const { api, stubs } = makeApi();
    renderPage(api);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stubs.getQueueBoard).toHaveBeenCalledTimes(1);

    // Hide the tab → advancing the interval must NOT fetch.
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(stubs.getQueueBoard).toHaveBeenCalledTimes(1);

    // Return to the tab → an immediate fetch fires + the interval resumes.
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stubs.getQueueBoard).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(stubs.getQueueBoard).toHaveBeenCalledTimes(3);
  });

  it('renders the analytics link', async () => {
    const { api } = makeApi();
    renderPage(api);
    await screen.findByTestId('now-serving-number');
    expect(screen.getByTestId('dashboard-to-analytics')).toHaveAttribute('href', '/analytics');
  });

  it('shows the configured category name (not the raw id) on the waiting tile', async () => {
    const { api } = makeApi();
    renderPage(api);
    const grid = await screen.findByTestId('waiting-grid');
    expect(within(grid).getByText('Customer Service')).toBeInTheDocument();
    expect(within(grid).getByText('Kasir')).toBeInTheDocument();
  });
});
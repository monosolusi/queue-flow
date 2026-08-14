import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CounterSelectPage } from './CounterSelectPage';
import type { CounterDto } from '../api/types';
import type { ICallerApi } from '../api/caller-api';

const counters: CounterDto[] = [
  {
    counterId: 1,
    counterName: 'Loket 1',
    assignedCategories: [{ id: 'cat-a', code: 'A', name: 'Customer Service' }],
    priorityPolicy: 'FIFO_GLOBAL',
  },
  {
    counterId: 2,
    counterName: 'Loket 2',
    assignedCategories: [
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Kasir & Pembayaran' },
    ],
    priorityPolicy: 'CATEGORY_PRIORITY',
  },
];

function makeApi(list: CounterDto[] = counters, reject?: Error): ICallerApi {
  return {
    listCounters: reject ? () => Promise.reject(reject) : () => Promise.resolve(list),
    getQueueSnapshot: () =>
      Promise.resolve({ counterId: 0, active: [], waiting: [], skipped: [], waitingCount: 0 }),
    // The counter-select page never invokes these (ISP — it only lists
    // counters); stubs satisfy the wider ICallerApi type for the fake.
    getWorkflowActions: () => Promise.resolve({ byStatus: {} }),
    callNext: () => Promise.resolve(),
    reannounce: () => Promise.resolve(),
    transfer: () => Promise.resolve(),
    applyTransition: () => Promise.resolve(),
    getBrandColor: () => Promise.resolve({ brandColor: '', themeMode: 'light' as const }),
    // Auth surface (QUE-43) — not invoked by this page; stubs satisfy the type.
    login: () =>
      Promise.resolve({ token: 'tok', user: { id: 'u', username: 's', role: 'caller-staff' as const } }),
    logout: () => Promise.resolve(),
    getMe: () => Promise.resolve(null),
  };
}

describe('CounterSelectPage', () => {
  it('renders the counter list and binds on selection', async () => {
    const onChoose = vi.fn();
    render(<CounterSelectPage api={makeApi()} onChoose={onChoose} />);
    expect(await screen.findByText('Loket 1')).toBeInTheDocument();
    expect(screen.getByText('Loket 2')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Loket 2'));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose.mock.calls[0][0].counterId).toBe(2);
  });

  it('shows an empty state when no counters are configured', async () => {
    render(<CounterSelectPage api={makeApi([])} onChoose={vi.fn()} />);
    expect(await screen.findByText(/Belum ada loket/i)).toBeInTheDocument();
  });

  it('shows an error state when the API fails', async () => {
    render(<CounterSelectPage api={makeApi(counters, new Error('jaringan terputus'))} onChoose={vi.fn()} />);
    expect(await screen.findByText(/jaringan terputus/i)).toBeInTheDocument();
  });

  it('shows skeleton placeholders (not text-only Memuat) while counters are loading', async () => {
    const api = makeApi(counters);
    api.listCounters = () => new Promise<CounterDto[]>(() => {});
    render(<CounterSelectPage api={api} onChoose={vi.fn()} />);
    const loading = await screen.findByTestId('counter-select-loading');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    expect(loading.querySelector('.sr-only')).toHaveTextContent('Memuat daftar loket…');
    expect(screen.queryByText('Loket 1')).not.toBeInTheDocument();
  });
});
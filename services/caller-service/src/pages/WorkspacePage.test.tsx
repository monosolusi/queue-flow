import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkspacePage } from './WorkspacePage';
import { AuthProvider } from '../auth/useAuth';
import { QueueStoreProvider } from '../state/queue-store';
import type { BoundCounter } from '../state/counter-binding';
import type { ICallerApi } from '../api/caller-api';
import type { QueueLifecycleWireEvent, QueueSnapshotDto } from '../api/types';

/** A controllable WebSocket transport the provider's QueueSocket wraps. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: unknown) {
    this.onmessage?.({ data });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

afterEach(() => {
  FakeWebSocket.last = null;
});

const bound: BoundCounter = {
  counterId: 1,
  counterName: 'Loket 1',
  assignedCategoryIds: ['cat-a'],
  assignedCategories: [{ id: 'cat-a', code: 'A', name: 'Customer Service' }],
};

const snapshot: QueueSnapshotDto = {
  counterId: 1,
  active: [{ ticketId: 'a1', ticketNumber: 'A-001', categoryId: 'cat-a', status: 'CALLING', counterId: 1 }],
  waiting: [
    { ticketId: 'w1', ticketNumber: 'A-002', categoryId: 'cat-a', status: 'WAITING', counterId: null },
  ],
  waitingCount: 1,
};

const defaultStateMachine = {
  states: ['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED'],
  transitions: [
    { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
    { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
    { from: 'CALLING', to: 'SKIPPED', actionLabel: 'Lewati / Absen' },
    { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang' },
    { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan' },
  ],
};

function makeApi(snap: QueueSnapshotDto = snapshot): ICallerApi {
  return {
    listCounters: () => Promise.resolve([]),
    getQueueSnapshot: vi.fn(() => Promise.resolve(snap)),
    getActiveStateMachine: vi.fn(() => Promise.resolve(defaultStateMachine)),
    callNext: vi.fn(() => Promise.resolve()),
    serve: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() => Promise.resolve()),
    skip: vi.fn(() => Promise.resolve()),
    recall: vi.fn(() => Promise.resolve()),
    reannounce: vi.fn(() => Promise.resolve()),
    transfer: vi.fn(() => Promise.resolve()),
    applyTransition: vi.fn(() => Promise.resolve()),
    getBrandColor: () => Promise.resolve({ brandColor: '', themeMode: 'light' as const }),
    // Auth surface (QUE-43) — not invoked by the workspace; stubs satisfy the type.
    login: () =>
      Promise.resolve({ token: 'tok', user: { id: 'u', username: 's', role: 'caller-staff' as const } }),
    logout: () => Promise.resolve(),
    getMe: () => Promise.resolve(null),
  };
}

const socketOptions = { WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket };

function wireEvent(
  type: QueueLifecycleWireEvent['type'],
  aggregateId: string,
  payload: QueueLifecycleWireEvent['payload'],
): string {
  return JSON.stringify({ type, aggregateId, occurredAt: 1, version: 1, payload });
}

function renderWorkspace(snap: QueueSnapshotDto = snapshot, onUnbind = vi.fn()) {
  const api = makeApi(snap);
  render(
    <MemoryRouter>
      <AuthProvider api={api}>
        <QueueStoreProvider bound={bound} api={api} socketOptions={socketOptions}>
          <WorkspacePage bound={bound} onUnbind={onUnbind} />
        </QueueStoreProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return { api };
}

describe('WorkspacePage', () => {
  it('renders the active ticket and waiting list from the snapshot', async () => {
    renderWorkspace();
    expect(await screen.findByText('A-001')).toBeInTheDocument();
    expect(screen.getByText('A-002')).toBeInTheDocument();
    expect(screen.getByText(/1 tiket/i)).toBeInTheDocument();
    // WS opens after the provider's socket effect runs.
    FakeWebSocket.last!.open();
    expect(await screen.findByText('Terhubung')).toBeInTheDocument();
  });

  it('updates live when a TICKET_CREATED event arrives in scope', async () => {
    renderWorkspace();
    await screen.findByText('A-002');
    FakeWebSocket.last!.send(wireEvent('TICKET_CREATED', 'w2', { ticketNumber: 'A-003', categoryId: 'cat-a' }));
    expect(await screen.findByText('A-003')).toBeInTheDocument();
    expect(screen.getByText(/2 tiket/i)).toBeInTheDocument();
  });

  it('removes the active ticket when COMPLETED arrives', async () => {
    renderWorkspace();
    await screen.findByText('A-001');
    FakeWebSocket.last!.send(wireEvent('STATUS_UPDATED', 'a1', { from: 'CALLING', to: 'COMPLETED' }));
    await waitFor(() => expect(screen.queryByText('A-001')).not.toBeInTheDocument());
    expect(screen.getByText(/Belum ada tiket aktif/i)).toBeInTheDocument();
  });

  it('renders the QUE-20 action controls slot', async () => {
    renderWorkspace();
    await screen.findByText('A-001');
    expect(screen.getByLabelText('Aksi')).toBeInTheDocument();
  });

  it('shows skeleton placeholders (not text-only Memuat) while the snapshot is loading', async () => {
    // A snapshot fetch that never resolves keeps loadStatus === 'loading'.
    const api = makeApi(snapshot);
    api.getQueueSnapshot = vi.fn(() => new Promise<QueueSnapshotDto>(() => {}));
    render(
      <MemoryRouter>
        <AuthProvider api={api}>
          <QueueStoreProvider bound={bound} api={api} socketOptions={socketOptions}>
            <WorkspacePage bound={bound} onUnbind={vi.fn()} />
          </QueueStoreProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    const loading = await screen.findByTestId('workspace-loading');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    // Skeleton shapes render inside the loading region (AC6: not text-only).
    expect(loading.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    // The "Memuat antrian…" label is present only as the visually-hidden SR label,
    // not as a visible text-only hint (no .workspace__hint during loading).
    expect(loading.querySelector('.sr-only')).toHaveTextContent('Memuat antrian…');
    expect(document.querySelector('.workspace__hint')).not.toBeInTheDocument();
    // No ticket number leaks into the DOM before the snapshot resolves.
    expect(screen.queryByText('A-001')).not.toBeInTheDocument();
  });

  it('unbinds when "Ganti Counter" is pressed', async () => {
    const onUnbind = vi.fn();
    renderWorkspace(snapshot, onUnbind);
    await screen.findByText('A-001');
    screen.getByRole('button', { name: /Ganti Counter/i }).click();
    expect(onUnbind).toHaveBeenCalledTimes(1);
  });

  it('shows an empty active state for a counter with no active ticket', async () => {
    renderWorkspace({
      counterId: 1,
      active: [],
      waiting: [{ ticketId: 'w1', ticketNumber: 'A-002', categoryId: 'cat-a', status: 'WAITING', counterId: null }],
      waitingCount: 1,
    });
    expect(await screen.findByText(/Belum ada tiket aktif/i)).toBeInTheDocument();
  });
});
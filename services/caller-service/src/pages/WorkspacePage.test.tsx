import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { WorkspacePage } from './WorkspacePage';
import { AuthProvider } from '../auth/useAuth';
import { QueueStoreProvider } from '../state/queue-store';
import type { BoundCounter } from '../state/counter-binding';
import type { ICallerApi } from '../api/caller-api';
import type { QueueLifecycleWireEvent, QueueSnapshotDto } from '../api/types';
import { PRD_DEFAULT_WORKFLOW, edge, workflowActions } from '../test/workflow-fixtures';

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
  skipped: [],
  waitingCount: 1,
};

function makeApi(snap: QueueSnapshotDto = snapshot): ICallerApi {
  return {
    listCounters: () => Promise.resolve([]),
    getQueueSnapshot: vi.fn(() => Promise.resolve(snap)),
    getWorkflowActions: vi.fn(() => Promise.resolve(PRD_DEFAULT_WORKFLOW)),
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

  it('drives the waiting rows from the same flow it drives the action panel with', async () => {
    // The manager's rule end-to-end: one flow fetch feeds both the panel (the
    // active ticket's outgoing edges) and each waiting row (WAITING's outgoing
    // edges, minus the counter-level call-next).
    const api = makeApi(snapshot);
    api.getWorkflowActions = vi.fn(() =>
      Promise.resolve(
        workflowActions(
          edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'CALL_NEXT'),
          edge('WAITING', 'BATAL', 'Batalkan Tiket', 'APPLY_TRANSITION'),
          edge('CALLING', 'SERVING', 'Mulai Melayani', 'SERVE'),
        ),
      ),
    );
    render(
      <MemoryRouter>
        <AuthProvider api={api}>
          <QueueStoreProvider bound={bound} api={api} socketOptions={socketOptions}>
            <WorkspacePage bound={bound} onUnbind={vi.fn()} />
          </QueueStoreProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    // The waiting ticket (w1) offers WAITING → BATAL, and only that edge.
    const cancel = await screen.findByTestId('waiting-action-w1-BATAL');
    expect(cancel).toHaveTextContent('Batalkan Tiket');
    // The active ticket (CALLING) offers its own outgoing edge in the panel.
    expect(screen.getByTestId('action-serve')).toHaveTextContent('Mulai Melayani');
    // A single fetch serves both.
    expect(api.getWorkflowActions).toHaveBeenCalledTimes(1);

    await userEvent.click(cancel);
    expect(api.applyTransition).toHaveBeenCalledWith('w1', 'BATAL');
  });

  it('keeps a skipped ticket on the panel so staff can actually recall it (the real path)', async () => {
    // End-to-end through the store, not a hand-built SKIPPED prop: staff taps
    // "Lewati / Absen", core-api broadcasts the resulting lifecycle event, and
    // the ticket must land on a surface that offers the flow's SKIPPED edge.
    // Previously the reducer dropped it and "Panggil Ulang" — published by
    // `GET /api/queue/actions` — was unreachable from every screen.
    const { api } = renderWorkspace();
    await screen.findByText('A-001');
    await userEvent.click(screen.getByTestId('action-skip'));
    expect(api.skip).toHaveBeenCalledWith('a1');

    FakeWebSocket.last!.send(wireEvent('STATUS_UPDATED', 'a1', { from: 'CALLING', to: 'SKIPPED' }));

    // It left the counter…
    expect(await screen.findByText(/Belum ada tiket aktif/i)).toBeInTheDocument();
    // …onto the skipped list, with the flow's own wording for SKIPPED → CALLING.
    const skippedList = screen.getByRole('region', { name: 'Tiket Dilewati' });
    expect(skippedList).toHaveTextContent('A-001');
    const recall = screen.getByTestId('skipped-action-a1-CALLING');
    expect(skippedList).toContainElement(recall);
    expect(recall).toHaveTextContent('Panggil Ulang');
    expect(recall).not.toBeDisabled();

    // And tapping it issues the recall command for that ticket.
    await userEvent.click(recall);
    expect(api.recall).toHaveBeenCalledWith('a1');

    // The recall's own events bring the ticket back to the counter.
    FakeWebSocket.last!.send(wireEvent('STATUS_UPDATED', 'a1', { from: 'SKIPPED', to: 'CALLING' }));
    FakeWebSocket.last!.send(wireEvent('TICKET_CALLED', 'a1', { ticketNumber: 'A-001', counterId: 1 }));
    await waitFor(() =>
      expect(screen.queryByTestId('skipped-action-a1-CALLING')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('region', { name: 'Tiket Dilewati' })).toHaveTextContent(
      'Tidak ada tiket yang dilewati.',
    );
    expect(screen.getByTestId('action-serve')).toBeInTheDocument();
  });

  it('shows the skipped list empty rather than hiding it', async () => {
    renderWorkspace();
    await screen.findByText('A-001');
    const skippedList = screen.getByRole('region', { name: 'Tiket Dilewati' });
    expect(skippedList).toHaveTextContent('Tidak ada tiket yang dilewati.');
    expect(skippedList).toHaveTextContent('0 tiket');
  });

  it('seeds the skipped list from the snapshot (a reload keeps skipped tickets)', async () => {
    // A counter reloading its panel must not lose the tickets it skipped —
    // core-api returns them in the snapshot's third bucket.
    renderWorkspace({
      counterId: 1,
      active: [],
      waiting: [],
      skipped: [
        { ticketId: 's1', ticketNumber: 'A-007', categoryId: 'cat-a', status: 'SKIPPED', counterId: 1 },
      ],
      waitingCount: 0,
    });
    expect(await screen.findByTestId('skipped-action-s1-CALLING')).toHaveTextContent('Panggil Ulang');
  });

  it('renders the skipped rows in skip order, not ticket-number order', async () => {
    // What the staff's finger sees. B-003 is skipped first, so it stays above
    // A-011 even though the ticket numbers sort the other way — and that is also
    // the order a reload gets back (the server sends this bucket updatedAt asc).
    // A row that moves while a finger is reaching for it is a mis-tap onto the
    // wrong customer's "Panggil Ulang".
    renderWorkspace({ counterId: 1, active: [], waiting: [], skipped: [], waitingCount: 0 });
    await screen.findByText(/Belum ada tiket aktif/i);
    FakeWebSocket.last!.send(wireEvent('TICKET_CALLED', 'sb', { ticketNumber: 'B-003', counterId: 1 }));
    FakeWebSocket.last!.send(wireEvent('STATUS_UPDATED', 'sb', { from: 'CALLING', to: 'SKIPPED' }));
    FakeWebSocket.last!.send(wireEvent('TICKET_CALLED', 'sa', { ticketNumber: 'A-011', counterId: 1 }));
    FakeWebSocket.last!.send(wireEvent('STATUS_UPDATED', 'sa', { from: 'CALLING', to: 'SKIPPED' }));

    const list = screen.getByRole('region', { name: 'Tiket Dilewati' });
    await waitFor(() => expect(list.querySelectorAll('.skipped-queue__number')).toHaveLength(2));
    expect(
      Array.from(list.querySelectorAll('.skipped-queue__number')).map((n) => n.textContent),
    ).toEqual(['B-003', 'A-011']);
  });

  it('drives the skipped rows from the same flow as every other surface', async () => {
    // No special case for recall: the skipped row's buttons are exactly the
    // outgoing transitions of SKIPPED, with the manager's wording and commands.
    const api = makeApi({
      counterId: 1,
      active: [],
      waiting: [],
      skipped: [
        { ticketId: 's1', ticketNumber: 'A-007', categoryId: 'cat-a', status: 'SKIPPED', counterId: 1 },
      ],
      waitingCount: 0,
    });
    api.getWorkflowActions = vi.fn(() =>
      Promise.resolve(
        workflowActions(
          edge('SKIPPED', 'CALLING', 'Panggil Lagi Yang Absen', 'RECALL'),
          edge('SKIPPED', 'BATAL', 'Batalkan Tiket', 'APPLY_TRANSITION'),
        ),
      ),
    );
    render(
      <MemoryRouter>
        <AuthProvider api={api}>
          <QueueStoreProvider bound={bound} api={api} socketOptions={socketOptions}>
            <WorkspacePage bound={bound} onUnbind={vi.fn()} />
          </QueueStoreProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    const row = await screen.findByRole('group', { name: 'Aksi untuk tiket A-007' });
    expect(row).toHaveTextContent('Panggil Lagi Yang Absen');
    expect(row).toHaveTextContent('Batalkan Tiket');
    await userEvent.click(screen.getByTestId('skipped-action-s1-BATAL'));
    expect(api.applyTransition).toHaveBeenCalledWith('s1', 'BATAL');
  });

  it('keeps the primary controls above the queue lists, however many tickets are skipped', async () => {
    // Manager feedback: "pada /caller ketika tiket dilewati banyak tampilan jadi
    // semakin kebawah" — the queue lists rendered above the action panel, so
    // every skipped ticket pushed "Panggil Berikutnya" further down the page.
    // The panel now sits directly under the active ticket, and no amount of
    // queue depth may move it. (The other half of the fix — the lists' own
    // max-height + overflow-y — is CSS, guarded in src/styles.test.ts, since
    // jsdom runs with `css: false`.)
    const sectionOrder = () =>
      Array.from(document.querySelector('.workspace__body')!.children).map((el) =>
        el.getAttribute('aria-label'),
      );
    const expectCallNextAboveTheQueues = () => {
      const callNext = screen.getByRole('button', { name: 'Panggil Berikutnya' });
      for (const name of ['Antrian Menunggu', 'Tiket Dilewati']) {
        const list = screen.getByRole('region', { name });
        expect(
          callNext.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
          `${name} must come after the call-next button`,
        ).toBeTruthy();
      }
    };

    renderWorkspace({ counterId: 1, active: [], waiting: [], skipped: [], waitingCount: 0 });
    await screen.findByText(/Belum ada tiket aktif/i);
    expect(sectionOrder()).toEqual(['Tiket Aktif', 'Aksi', 'Antrian Menunggu', 'Tiket Dilewati']);
    expectCallNextAboveTheQueues();

    // Six skips down the real event path (call, then skip) — the depth that used
    // to bury the button below the fold.
    for (let i = 1; i <= 6; i += 1) {
      FakeWebSocket.last!.send(
        wireEvent('TICKET_CALLED', `sk${i}`, { ticketNumber: `A-10${i}`, counterId: 1 }),
      );
      FakeWebSocket.last!.send(
        wireEvent('STATUS_UPDATED', `sk${i}`, { from: 'CALLING', to: 'SKIPPED' }),
      );
    }
    await waitFor(() =>
      expect(
        screen
          .getByRole('region', { name: 'Tiket Dilewati' })
          .querySelectorAll('.skipped-queue__number'),
      ).toHaveLength(6),
    );

    expect(sectionOrder()).toEqual(['Tiket Aktif', 'Aksi', 'Antrian Menunggu', 'Tiket Dilewati']);
    expectCallNextAboveTheQueues();
  });

  it('shows an empty active state for a counter with no active ticket', async () => {
    renderWorkspace({
      counterId: 1,
      active: [],
      waiting: [{ ticketId: 'w1', ticketNumber: 'A-002', categoryId: 'cat-a', status: 'WAITING', counterId: null }],
      skipped: [],
      waitingCount: 1,
    });
    expect(await screen.findByText(/Belum ada tiket aktif/i)).toBeInTheDocument();
  });
});
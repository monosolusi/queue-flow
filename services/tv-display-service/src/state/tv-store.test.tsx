import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { TvStoreProvider } from './tv-store';
import { TvBoardPage } from '../pages/TvBoardPage';
import type { ITvApi } from '../api/tv-api';
import type { AudioProvider } from '../audio/audio-provider';
import type { QueueLifecycleWireEvent, TvTicketDto, TvPanelLayoutMap } from '../api/types';
import { DEFAULT_TV_PANEL_LAYOUT } from '../api/types';

/** Fake WebSocket whose instances the test can reach to deliver frames. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 1; // OPEN
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.readyState = 3;
  }
  /** Test helper: deliver a parsed envelope as a JSON frame. */
  sendEvent(event: QueueLifecycleWireEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

function makeApi(
  brandColor = '',
  waiting: TvTicketDto[] = [],
  active: TvTicketDto[] = [],
  panelLayout: TvPanelLayoutMap = DEFAULT_TV_PANEL_LAYOUT,
): ITvApi {
  return {
    getSystemConfig: vi.fn(() =>
      Promise.resolve({
        isInitialSetupCompleted: true,
        storeName: 'Apotek Sehat',
        brandColor,
        serviceThemes: { tv: 'light' as const },
        tvPanelLayout: panelLayout,
        routingRules: [
          { counterId: 1, counterName: 'Loket 1' },
          { counterId: 2, counterName: 'Loket 2' },
        ],
      }),
    ),
    getCategories: vi.fn(() =>
      Promise.resolve([
        { id: 'cat-a', code: 'A', name: 'Customer Service' },
        { id: 'cat-b', code: 'B', name: 'Kasir' },
      ]),
    ),
    getBoardState: vi.fn(() =>
      Promise.resolve({ active, waiting, waitingCount: waiting.length }),
    ),
  };
}

function makeAudio(): AudioProvider & { sequences: string[][] } {
  const sequences: string[][] = [];
  return {
    sequences,
    playSequence: vi.fn((fragments: readonly string[]) => {
      sequences.push([...fragments]);
      return Promise.resolve();
    }),
    stop: vi.fn(),
  };
}

function renderBoard(api: ITvApi, audio: ReturnType<typeof makeAudio>) {
  FakeWebSocket.instances = [];
  return render(
    <MemoryRouter>
      <TvStoreProvider
        api={api}
        audio={audio}
        socketOptions={{ WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket }}
      >
        <TvBoardPage />
      </TvStoreProvider>
    </MemoryRouter>,
  );
}

/** Delivers a socket frame inside act() so the resulting dispatch flushes. */
function fire(ws: FakeWebSocket, event: QueueLifecycleWireEvent): void {
  act(() => ws.sendEvent(event));
}

function calledEvent(ticketId: string, ticketNumber: string, counterId: number): QueueLifecycleWireEvent {
  return {
    type: 'TICKET_CALLED',
    aggregateId: ticketId,
    occurredAt: 1,
    version: 1,
    payload: { ticketNumber, counterId },
  };
}

function statusEvent(ticketId: string, from: string, to: string): QueueLifecycleWireEvent {
  return {
    type: 'STATUS_UPDATED',
    aggregateId: ticketId,
    occurredAt: 2,
    version: 2,
    payload: { from, to },
  };
}

describe('TvStoreProvider realtime projection + audio (FR-TV-01/02)', () => {
  it('loads the store name, announces on TICKET_CALLED, and shows now-serving', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);

    // Boot: store name + categories + board state loaded. Awaiting the boot
    // BOARD_LOADED flush is load-bearing here — without it the boot
    // getBoardState() microtask resolves AFTER the TICKET_CALLED dispatch
    // below and its BOARD_LOADED (mock active=[]) wipes the event-projected
    // nowServing before findByText polls. The async act on `ws.onopen` is
    // also load-bearing: onopen triggers a reconnect refetch via onStatus,
    // whose .then() microtask would otherwise drain at the findByText await
    // AFTER the event dispatch and wipe nowServing (mock active=[]). Async
    // act drains that microtask first.
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    await screen.findByText('Apotek Sehat');
    await act(async () => {
      ws.onopen?.(new Event('open'));
    });

    // A call arrives → now-serving shows the number + counter, and the audio
    // sequencer is driven with the announcement fragments (FR-TV-02).
    fire(ws, calledEvent('t1', 'A-005', 2));
    expect(await screen.findByText('A-005')).toBeInTheDocument();
    expect(screen.getByText('Counter 2')).toBeInTheDocument();
    expect(audio.sequences).toHaveLength(1);
    expect(audio.sequences[0]).toEqual([
      'bell',
      'nomor-antrian',
      'A',
      '0',
      '0',
      '5',
      'silakan-ke-counter',
      '2',
    ]);
  });

  it('applies the manager-configured brand color to the runtime --accent on boot (QUE-37 AC6)', async () => {
    document.documentElement.style.setProperty('--accent', '#2563eb');
    const api = makeApi('#a1b2c3');
    const audio = makeAudio();
    renderBoard(api, audio);

    // Boot resolves the config + applies the brandColor to --accent.
    await screen.findByText('Apotek Sehat');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#a1b2c3');
  });

  it('keeps the static --accent default when the brand color is empty (no flash)', async () => {
    document.documentElement.style.setProperty('--accent', '#2563eb');
    const api = makeApi('');
    const audio = makeAudio();
    renderBoard(api, audio);

    await screen.findByText('Apotek Sehat');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb');
  });

  it('pushes the previous now-serving into history on the next call', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');

    fire(ws, calledEvent('t2', 'B-001', 1));
    expect(await screen.findByText('B-001')).toBeInTheDocument();
    // The previous call (A-005) is now in the history list.
    expect(screen.getByText('Riwayat Panggilan')).toBeInTheDocument();
    expect(screen.getAllByText('A-005')).toHaveLength(1); // history item only
  });

  it('clears now-serving on SYSTEM_RESET and returns to the idle empty state', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');

    fire(ws, {
      type: 'SYSTEM_RESET',
      aggregateId: 'system',
      occurredAt: 3,
      version: 3,
      payload: { resetTo: 1, date: '2026-07-31' },
    });
    // nowServing clears → the active board's NowServingCard renders its empty
    // state ("Menunggu panggilan berikutnya…"). SYSTEM_RESET clears history too,
    // so A-005 must be gone from the DOM ENTIRELY (no standby panel exists); the
    // CallHistory section title stays, but the empty-state message renders.
    expect(await screen.findByText('Menunggu panggilan berikutnya…')).toBeInTheDocument();
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();
    expect(screen.getByText('Riwayat Panggilan')).toBeInTheDocument();
    expect(screen.getByText('Belum ada riwayat.')).toBeInTheDocument();
  });

  it('clears now-serving when the ticket completes and returns to the idle empty state', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');

    fire(ws, statusEvent('t1', 'CALLING', 'COMPLETED'));
    // nowServing clears → NowServingCard renders its empty state. The completed
    // A-005 is retained in the CallHistory section (FR-TV-01), so it stays in the
    // DOM as a history entry.
    expect(await screen.findByText('Menunggu panggilan berikutnya…')).toBeInTheDocument();
    expect(screen.getByText('Riwayat Panggilan')).toBeInTheDocument();
    expect(screen.getAllByText('A-005')).toHaveLength(1); // history entry only
  });

  it('retains a completed ticket in history on the quiet-store path (FR-TV-01)', async () => {
    // The common single-counter flow is call → serve → complete → call next.
    // The completed ticket must enter "Riwayat Panggilan" even though no other
    // call displaced it while it was on the board (the quiet-store case that
    // left history empty before the retention fix). The retention is observed
    // when the next call brings the active board back; while idle the
    // NowServingCard renders its empty state (FR-TV-01).
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');

    // Serve → complete. nowServing clears → idle empty state; A-005 leaves the
    // now-serving card but is retained in history.
    fire(ws, statusEvent('t1', 'CALLING', 'SERVING'));
    fire(ws, statusEvent('t1', 'SERVING', 'COMPLETED'));
    expect(await screen.findByText('Menunggu panggilan berikutnya…')).toBeInTheDocument();
    // A-005 is retained in CallHistory — exactly one history entry.
    expect(screen.getAllByText('A-005')).toHaveLength(1);

    // The next call brings the now-serving card back; A-005 must appear exactly
    // once (history), not double-pushed (nowServing was null at COMPLETED, so
    // the TICKET_CALLED had nothing to displace).
    fire(ws, calledEvent('t2', 'B-013', 1));
    expect(await screen.findByText('B-013')).toBeInTheDocument();
    expect(screen.getByText('Riwayat Panggilan')).toBeInTheDocument();
    expect(screen.getAllByText('A-005')).toHaveLength(1); // exactly one history entry
  });

  it('does not retain a skipped ticket in history (recallable, not concluded)', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');

    fire(ws, statusEvent('t1', 'CALLING', 'SKIPPED'));
    // nowServing clears → idle empty state; a skipped ticket is recallable via
    // "Panggil Ulang" and is not retained in history (only COMPLETED tickets are).
    expect(await screen.findByText('Menunggu panggilan berikutnya…')).toBeInTheDocument();
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();

    // Bring a new call in; the skipped ticket must not appear in history.
    fire(ws, calledEvent('t2', 'B-001', 1));
    expect(await screen.findByText('B-001')).toBeInTheDocument();
    expect(screen.getByText('Belum ada riwayat.')).toBeInTheDocument();
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();
  });

  it('recall ("Panggil Ulang") re-shows the skipped ticket on the board and re-announces it (FR-TV-01/02)', async () => {
    // The domain (QueueTicket.recall) emits STATUS_UPDATED (SKIPPED -> CALLING)
    // followed by TICKET_CALLED carrying {ticketNumber, counterId} — a recall is
    // a re-call to the same counter. The TV's existing TICKET_CALLED path re-shows
    // the ticket + re-announces audio with no TV-side retained state. The prior
    // STATUS_UPDATED is a no-op here (nowServing was null'd on skip, so the
    // `nowServing?.ticketId !== aggregateId` guard returns state unchanged).
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');
    expect(audio.sequences).toHaveLength(1); // announced on the first call

    fire(ws, statusEvent('t1', 'CALLING', 'SKIPPED'));
    expect(await screen.findByText('Menunggu panggilan berikutnya…')).toBeInTheDocument();
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();

    // Recall: STATUS_UPDATED (SKIPPED -> CALLING) then TICKET_CALLED for the SAME
    // ticket (not a new ticket) — the real recall flow the previous test masked.
    fire(ws, statusEvent('t1', 'SKIPPED', 'CALLING'));
    fire(ws, calledEvent('t1', 'A-005', 2));
    expect(await screen.findByText('A-005')).toBeInTheDocument();
    expect(audio.sequences).toHaveLength(2); // re-announced on recall
  });

  it('re-numbers the now-serving ticket on TICKET_TRANSFERRED', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');

    fire(ws, {
      type: 'TICKET_TRANSFERRED',
      aggregateId: 't1',
      occurredAt: 4,
      version: 4,
      payload: {
        fromCategoryId: 'cat-a',
        toCategoryId: 'cat-b',
        fromTicketNumber: 'A-005',
        toTicketNumber: 'B-010',
      },
    });
    // STATUS_UPDATED to WAITING follows the transfer (CALLING→WAITING); the
    // re-number must still be observable on the board before the clear, so we
    // assert the new number appeared at least once via findByText.
    expect(await screen.findByText('B-010')).toBeInTheDocument();
  });
});

describe('TvBoardPage idle/active switching (FR-TV-01)', () => {
  it('shows the now-serving empty state when idle, switches to the ticket on a call, and returns to the empty state when the call completes', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    // Idle: NowServingCard renders its empty state ("Menunggu panggilan
    // berikutnya…"). There is no standby panel — the active board is the sole
    // always-visible layer (the promosi/standby feature was removed).
    expect(screen.getByText('Menunggu panggilan berikutnya…')).toBeInTheDocument();
    expect(screen.getByTestId('board-active')).toBeInTheDocument();
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();

    // A call arrives → the now-serving board shows the ticket number + counter.
    fire(ws, calledEvent('t1', 'A-005', 2));
    expect(await screen.findByText('A-005')).toBeInTheDocument();
    expect(screen.getByText('Counter 2')).toBeInTheDocument();
    expect(screen.getByText('Riwayat Panggilan')).toBeInTheDocument();
    expect(screen.queryByText('Menunggu panggilan berikutnya…')).not.toBeInTheDocument();

    // Complete the ticket → nowServing clears → NowServingCard renders its
    // empty state again; A-005 is retained in CallHistory (FR-TV-01).
    fire(ws, statusEvent('t1', 'CALLING', 'COMPLETED'));
    expect(await screen.findByText('Menunggu panggilan berikutnya…')).toBeInTheDocument();
    expect(screen.getByText('Riwayat Panggilan')).toBeInTheDocument();
    expect(screen.getAllByText('A-005')).toHaveLength(1); // history entry only
  });
});

describe('TV board state refetch (server owns the read model)', () => {
  it('boot dispatches BOARD_LOADED with the fetched waiting list', async () => {
    const waiting = [
      { ticketId: 't1', ticketNumber: 'B-001', categoryId: 'cat-b', status: 'WAITING', counterId: null },
      { ticketId: 't2', ticketNumber: 'A-002', categoryId: 'cat-a', status: 'WAITING', counterId: null },
    ];
    const api = makeApi('', waiting);
    const audio = makeAudio();
    renderBoard(api, audio);

    // The waiting panel renders the fetched rows. There is no longer a standby
    // duplicate of the waiting panel — the active board is the sole layer — so
    // each row / count line appears exactly once.
    expect(await screen.findAllByText('B-001')).toHaveLength(1);
    expect(screen.getAllByText('A-002')).toHaveLength(1);
    expect(screen.getAllByText(/Menunggu: 2 tiket/)).toHaveLength(1);
    expect(api.getBoardState).toHaveBeenCalledTimes(1);
  });

  it('boot restores nowServing from the active slice (refresh shows the current antrian)', async () => {
    // The bug: a TV board refresh left nowServing null because no TICKET_CALLED
    // event had fired. The server-sourced active slice restores it.
    const active = [
      { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 2 },
    ];
    const api = makeApi('', [], active);
    const audio = makeAudio();
    renderBoard(api, audio);

    // The now-serving hero shows the restored ticket + counter. The ticket
    // number also appears in the counters-serving panel, so use findAllByText.
    expect((await screen.findAllByText('A-005')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Counter 2')).toBeInTheDocument();
    // The active board is visible; nowServing is non-null, so NowServingCard
    // does NOT render its empty-state text.
    expect(screen.queryByText('Menunggu panggilan berikutnya…')).not.toBeInTheDocument();
    expect(api.getBoardState).toHaveBeenCalledTimes(1);
  });

  it('boot leaves nowServing null when the active slice is empty (idle empty state)', async () => {
    const api = makeApi('', [], []);
    const audio = makeAudio();
    renderBoard(api, audio);

    // No active ticket → NowServingCard renders its empty state.
    expect(await screen.findByText('Menunggu panggilan berikutnya…')).toBeInTheDocument();
    expect(screen.getByTestId('board-active')).toBeInTheDocument();
  });

  it('restores the most-recently-touched active ticket (last in the active slice)', async () => {
    // findAllActive orders by updatedAt asc; the last is the most-recently-
    // touched. The TV projects that one to nowServing.
    const active = [
      { ticketId: 't-old', ticketNumber: 'A-001', categoryId: 'cat-a', status: 'SERVING', counterId: 1 },
      { ticketId: 't-new', ticketNumber: 'B-007', categoryId: 'cat-b', status: 'CALLING', counterId: 2 },
    ];
    const api = makeApi('', [], active);
    const audio = makeAudio();
    renderBoard(api, audio);

    // The newer call (B-007 at counter 2) wins as nowServing. The ticket
    // number also appears in the counters-serving panel, so use findAllByText.
    expect((await screen.findAllByText('B-007')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Counter 2')).toBeInTheDocument();
  });

  it('BOARD_LOADED dedupes history against the restored nowServing', async () => {
    // Seed: boot with no active ticket (idle empty state). Fire a TICKET_CALLED
    // so a ticket enters nowServing, then fire a second call that pushes the
    // first into history, then complete the second call (nowServing clears,
    // history retains it), then trigger a refetch whose active slice restores
    // the first ticket as nowServing — it must be removed from history (no
    // double-appearance).
    const api = makeApi('', []);
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    // Two calls: t1 (A-005) then t2 (B-001). t1 is displaced to history.
    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');
    fire(ws, calledEvent('t2', 'B-001', 1));
    expect(await screen.findByText('B-001')).toBeInTheDocument();
    // A-005 is now in history (one occurrence — the history list).
    expect(screen.getAllByText('A-005')).toHaveLength(1);

    // Complete t2 → nowServing clears → idle empty state. A refetch with
    // active=[t1] restores t1 as nowServing and must remove it from history.
    fire(ws, statusEvent('t2', 'CALLING', 'COMPLETED'));
    expect(await screen.findByText('Menunggu panggilan berikutnya…')).toBeInTheDocument();

    // Swap the mock so the next refetch returns t1 as the only active ticket.
    (api.getBoardState as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({
        active: [
          { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 2 },
        ],
        waiting: [],
        waitingCount: 0,
      }),
    );
    // Drive a TICKET_CREATED event to schedule a debounced refetch (any event
    // schedules one), then wait for the 300ms debounce + fetch to resolve.
    // We can't use findByText('A-005') here — A-005 is already in the DOM via
    // history (CallHistory retains it under css:false), so findByText would
    // resolve immediately from the stale history item before the debounced
    // refetch fires. Wait real time past the debounce instead.
    fire(ws, {
      type: 'TICKET_CREATED',
      aggregateId: 't3',
      occurredAt: 9,
      version: 9,
      payload: { ticketNumber: 'A-009', categoryId: 'cat-a' },
    });
    // Wait for the 300ms debounce + microtask to flush — the BOARD_LOADED
    // dispatch restores t1 as nowServing and dedupes it from history.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    // A-005 is now nowServing (restored from the server's active slice). The
    // now-serving card shows the ticket + counter.
    expect(screen.getByText('Counter 2')).toBeInTheDocument();
    expect(screen.queryByText('Menunggu panggilan berikutnya…')).not.toBeInTheDocument();
    // A-005 must NOT appear in history (deduped against the restored
    // nowServing). The CallHistory section is the only place history renders.
    const history = screen.getByText('Riwayat Panggilan').closest('section');
    expect(within(history!).queryByText('A-005')).not.toBeInTheDocument();
  });

  it('a board-state-fetch failure degrades gracefully — board still boots, waiting stays []', async () => {
    const api: ITvApi = {
      getSystemConfig: vi.fn(() =>
        Promise.resolve({
          isInitialSetupCompleted: true,
          storeName: 'Apotek Sehat',
          brandColor: '',
          serviceThemes: { tv: 'light' as const },
          tvPanelLayout: DEFAULT_TV_PANEL_LAYOUT,
          routingRules: [],
        }),
      ),
      getCategories: vi.fn(() => Promise.resolve([{ id: 'cat-a', code: 'A', name: 'CS' }])),
      getBoardState: vi.fn(() => Promise.reject(new Error('boom'))),
    };
    const audio = makeAudio();
    renderBoard(api, audio);

    // Config still loaded — board boots. Empty waiting state — the active
    // board's waiting panel renders the empty-state text exactly once (no
    // standby duplicate exists).
    expect(await screen.findByText('Apotek Sehat')).toBeInTheDocument();
    expect(screen.getByText('Belum ada antrian menunggu.')).toBeInTheDocument();
    expect(screen.getByText(/Menunggu: 0 tiket/)).toBeInTheDocument();
  });

  it('SYSTEM_RESET clears the waiting list immediately for snappy UX', async () => {
    const waiting = [
      { ticketId: 't1', ticketNumber: 'B-001', categoryId: 'cat-b', status: 'WAITING', counterId: null },
    ];
    const api = makeApi('', waiting);
    const audio = makeAudio();
    renderBoard(api, audio);
    // The waiting panel renders the row (the active board is the sole layer;
    // no standby duplicate).
    expect(await screen.findAllByText('B-001')).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];

    // Bring up a call so the now-serving card is populated, then reset.
    fire(ws, calledEvent('t2', 'A-005', 2));
    expect(await screen.findByText('A-005')).toBeInTheDocument();

    fire(ws, {
      type: 'SYSTEM_RESET',
      aggregateId: 'system',
      occurredAt: 3,
      version: 3,
      payload: { resetTo: 1, date: '2026-07-31' },
    });
    // The waiting list is cleared locally immediately — B-001 leaves the
    // waiting panel (the debounced refetch confirms an empty list with the
    // mock's initial seed; here the mock stays at one row so we only assert
    // the local clear before the debounce fires). queryAllByText returns []
    // when none remain.
    expect(screen.queryAllByText('B-001')).toHaveLength(0);
  });

  it('a TICKET_CALLED event triggers a debounced refetch of the board state', async () => {
    vi.useFakeTimers();
    try {
      const api = makeApi('', []);
      const audio = makeAudio();
      renderBoard(api, audio);
      // Wait for boot (Promise.allSettled under fake timers — flush microtasks).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const ws = FakeWebSocket.instances[0];
      // Initial boot fetch.
      expect(api.getBoardState).toHaveBeenCalledTimes(1);

      // A call arrives → schedules a debounced refetch.
      act(() => ws.sendEvent(calledEvent('t1', 'A-005', 2)));
      expect(api.getBoardState).toHaveBeenCalledTimes(1); // not yet — debounced

      // Advance the debounce window — the refetch fires once.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(api.getBoardState).toHaveBeenCalledTimes(2);

      // A second event within the debounce window coalesces into one fetch.
      act(() => ws.sendEvent(calledEvent('t2', 'B-001', 1)));
      act(() => ws.sendEvent(calledEvent('t3', 'B-002', 1)));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      // Two more events produced one more fetch (3 total after boot).
      expect(api.getBoardState).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads the board state under <React.StrictMode> (mountedRef not stuck false)', async () => {
    // Regression: the dedicated `[]`-deps effect that flips `mountedRef.current
    // = false` in cleanup must reset it to `true` in the body. Under
    // <React.StrictMode> an `[]`-deps effect is double-invoked on mount
    // (body -> cleanup -> body); without the reset, the cleanup's `false`
    // wins and every later `refetchBoard` resolution is dropped — the board
    // never loads in dev. RTL `render()` does NOT wrap in StrictMode, so the
    // existing tests miss this; this case wraps the provider harness in
    // <React.StrictMode> explicitly.
    const waiting = [
      { ticketId: 't1', ticketNumber: 'B-001', categoryId: 'cat-b', status: 'WAITING', counterId: null },
      { ticketId: 't2', ticketNumber: 'A-002', categoryId: 'cat-a', status: 'WAITING', counterId: null },
    ];
    const api = makeApi('', waiting);
    const audio = makeAudio();
    FakeWebSocket.instances = [];
    render(
      <React.StrictMode>
        <MemoryRouter>
          <TvStoreProvider
            api={api}
            audio={audio}
            socketOptions={{ WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket }}
          >
            <TvBoardPage />
          </TvStoreProvider>
        </MemoryRouter>
      </React.StrictMode>,
    );

    // The waiting rows render in the active board's waiting panel (no standby
    // duplicate exists — the promosi/standby feature was removed). The key
    // assertion is that they render AT ALL under StrictMode — pre-fix,
    // `mountedRef` was stuck `false` and the boot `refetchBoard` resolution
    // was dropped.
    expect(await screen.findAllByText('B-001')).toHaveLength(1);
    expect(screen.getAllByText('A-002')).toHaveLength(1);
    expect(screen.getAllByText(/Menunggu: 2 tiket/)).toHaveLength(1);
    expect(api.getBoardState).toHaveBeenCalledTimes(1);
  });
});

describe('TvStoreProvider counters-serving projection + panel layout', () => {
  it('BOARD_LOADED projects countersServing from active + counterNameById (Sedang Melayani)', async () => {
    // Two active tickets at two counters; each counter appears once with its
    // boot-config name and the ticket number being served.
    const active = [
      { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 2 },
      { ticketId: 't2', ticketNumber: 'B-010', categoryId: 'cat-b', status: 'SERVING', counterId: 1 },
    ];
    const api = makeApi('', [], active);
    const audio = makeAudio();
    renderBoard(api, audio);

    // The counters-serving panel renders both counters (sorted by counterId
    // ascending → counter 1 first). Each row shows the counter name + ticket.
    // Scope to the Sedang Melayani section — ticket numbers also appear in the
    // now-serving card (nowServing = the last active = B-010).
    const section = (await screen.findByRole('group', { name: 'Counter Sedang Melayani' }));
    expect(within(section).getByText('Loket 1')).toBeInTheDocument();
    expect(within(section).getByText('B-010')).toBeInTheDocument();
    expect(within(section).getByText('Loket 2')).toBeInTheDocument();
    expect(within(section).getByText('A-005')).toBeInTheDocument();
  });

  it('groups by counterId keeping the most-recently-touched active row (last wins)', async () => {
    // active is ordered by updatedAt asc; the last row for a counter wins.
    const active = [
      { ticketId: 't-old', ticketNumber: 'A-001', categoryId: 'cat-a', status: 'CALLING', counterId: 1 },
      { ticketId: 't-new', ticketNumber: 'A-002', categoryId: 'cat-a', status: 'SERVING', counterId: 1 },
    ];
    const api = makeApi('', [], active);
    const audio = makeAudio();
    renderBoard(api, audio);

    const section = (await screen.findByRole('group', { name: 'Counter Sedang Melayani' }));
    // Only one row for counter 1; the newer ticket (A-002) wins.
    expect(within(section).getByText('Loket 1')).toBeInTheDocument();
    expect(within(section).getByText('A-002')).toBeInTheDocument();
    expect(within(section).queryByText('A-001')).not.toBeInTheDocument();
  });

  it('falls back to `Counter {id}` when the counter has no boot-config name', async () => {
    // A counter appears in the active slice but was NOT in the boot routingRules
    // (e.g. a counter added after boot). The name falls back defensively.
    const active = [
      { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 9 },
    ];
    const api: ITvApi = {
      getSystemConfig: vi.fn(() =>
        Promise.resolve({
          isInitialSetupCompleted: true,
          storeName: 'Apotek Sehat',
          brandColor: '',
          serviceThemes: { tv: 'light' as const },
          tvPanelLayout: DEFAULT_TV_PANEL_LAYOUT,
          routingRules: [{ counterId: 1, counterName: 'Loket 1' }],
        }),
      ),
      getCategories: vi.fn(() => Promise.resolve([])),
      getBoardState: vi.fn(() =>
        Promise.resolve({ active, waiting: [], waitingCount: 0 }),
      ),
    };
    const audio = makeAudio();
    renderBoard(api, audio);

    // "Counter 9" appears in BOTH the now-serving card (shows `Counter {id}`)
    // and the counters-serving panel (fallback name). Scope to the section.
    const section = (await screen.findByRole('group', { name: 'Counter Sedang Melayani' }));
    expect(within(section).getByText('Counter 9')).toBeInTheDocument();
    expect(within(section).getByText('A-005')).toBeInTheDocument();
  });

  it('shows all configured counters as idle (em dash) when none are serving', async () => {
    const api = makeApi('', [], []);
    const audio = makeAudio();
    renderBoard(api, audio);

    const section = (await screen.findByRole('group', { name: 'Counter Sedang Melayani' }));
    // The panel is NOT empty — both configured counters render, idle (em dash).
    expect(within(section).getByText('Loket 1')).toBeInTheDocument();
    expect(within(section).getByText('Loket 2')).toBeInTheDocument();
    expect(within(section).getAllByText('—')).toHaveLength(2);
    // The empty-state message must NOT appear — there ARE configured counters.
    expect(screen.queryByText('Tidak ada counter yang sedang melayani.')).not.toBeInTheDocument();
  });

  it('SYSTEM_RESET marks all configured counters idle immediately (em dash)', async () => {
    const active = [
      { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 2 },
    ];
    const api = makeApi('', [], active);
    const audio = makeAudio();
    renderBoard(api, audio);
    const section = (await screen.findByRole('group', { name: 'Counter Sedang Melayani' }));
    expect(within(section).getByText('Loket 2')).toBeInTheDocument();
    const ws = FakeWebSocket.instances[0];

    fire(ws, {
      type: 'SYSTEM_RESET',
      aggregateId: 'system',
      occurredAt: 3,
      version: 3,
      payload: { resetTo: 1, date: '2026-07-31' },
    });
    // Synchronous queries — read the immediate projection before the ~300ms
    // debounced refetch reconciles with the server's fresh-day read model.
    // After SYSTEM_RESET, every configured counter shows as idle (em dash):
    // Loket 1 + Loket 2 are still present, both idle; A-005 is gone; the
    // empty-state message must NOT appear (there ARE configured counters).
    // Scope to the captured section (the DOM node is reused across the
    // act-wrapped re-render) — mirrors the sibling idle test's scoping.
    expect(within(section).getByText('Loket 1')).toBeInTheDocument();
    expect(within(section).getByText('Loket 2')).toBeInTheDocument();
    expect(within(section).getAllByText('—')).toHaveLength(2);
    expect(within(section).queryByText('A-005')).not.toBeInTheDocument();
    expect(screen.queryByText('Tidak ada counter yang sedang melayani.')).not.toBeInTheDocument();
  });

  it('panelLayout carried from BOOT_LOADED — all visible by default renders panels in order', async () => {
    const active = [
      { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 2 },
    ];
    const api = makeApi('', [], active);
    const audio = makeAudio();
    renderBoard(api, audio);

    // All content panels visible by default. NowServing is non-null (active
    // ticket), so the hero renders the ticket (not the idle empty state).
    // A-005 appears in BOTH the now-serving card and the counters-serving
    // panel, so await the nowServing panel wrapper by testid instead.
    expect(await screen.findByTestId('tv-board__panel--nowServing')).toBeInTheDocument();
    expect(screen.getByText('Sedang Melayani')).toBeInTheDocument();
    expect(screen.getByText('Antrian Berikutnya')).toBeInTheDocument();
    expect(screen.getByText('Riwayat Panggilan')).toBeInTheDocument();
    // RunningText footer is rendered.
    expect(screen.getByRole('marquee')).toBeInTheDocument();

    // The visible content panels render in the DEFAULT order:
    // nowServing(0) → waitingQueue(1) → callHistory(2) → countersServing(3).
    const order = Array.from(
      document.querySelectorAll('[data-testid^="tv-board__panel--"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'tv-board__panel--nowServing',
      'tv-board__panel--waitingQueue',
      'tv-board__panel--callHistory',
      'tv-board__panel--countersServing',
    ]);
  });

  it('hides a panel when visible=false (panel not in DOM; others fill the flex column)', async () => {
    const layout: TvPanelLayoutMap = {
      nowServing: { visible: true, order: 0, size: 4 },
      waitingQueue: { visible: false, order: 1, size: 2 },
      callHistory: { visible: false, order: 2, size: 2 },
      countersServing: { visible: false, order: 3, size: 2 },
      runningText: { visible: false, order: 4, size: 2 },
    };
    const active = [
      { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 2 },
    ];
    const api = makeApi('', [], active, layout);
    const audio = makeAudio();
    renderBoard(api, audio);

    // nowServing stays visible (hero); the side panels + footer are hidden.
    expect(await screen.findByTestId('tv-board__panel--nowServing')).toBeInTheDocument();
    expect(screen.queryByText('Sedang Melayani')).not.toBeInTheDocument();
    expect(screen.queryByText('Antrian Berikutnya')).not.toBeInTheDocument();
    expect(screen.queryByText('Riwayat Panggilan')).not.toBeInTheDocument();
    expect(screen.queryByRole('marquee')).not.toBeInTheDocument();
    // Only the nowServing panel wrapper is rendered.
    const order = Array.from(
      document.querySelectorAll('[data-testid^="tv-board__panel--"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['tv-board__panel--nowServing']);
  });

  it('nowServing.visible=false → NowServingCard not rendered, no misleading "Menunggu" idle copy', async () => {
    const layout: TvPanelLayoutMap = {
      nowServing: { visible: false, order: 0, size: 4 },
      waitingQueue: { visible: true, order: 1, size: 2 },
      callHistory: { visible: true, order: 2, size: 2 },
      countersServing: { visible: true, order: 3, size: 2 },
      runningText: { visible: true, order: 4, size: 2 },
    };
    const active = [
      { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 2 },
    ];
    const api = makeApi('', [], active, layout);
    const audio = makeAudio();
    renderBoard(api, audio);

    // nowServing.hidden → no nowServing panel wrapper, no "Menunggu" idle
    // copy, no "PERGI KE COUNTER" eyebrow (the panel is truly absent — no
    // structural placeholder is needed in the flex-column model). A-005 may
    // still appear in the counters-serving panel (visible=true), which is
    // expected and not asserted here.
    await screen.findByText('Sedang Melayani');
    expect(screen.queryByTestId('tv-board__panel--nowServing')).not.toBeInTheDocument();
    expect(screen.queryByText('Menunggu panggilan berikutnya…')).not.toBeInTheDocument();
    expect(screen.queryByText('PERGI KE COUNTER')).not.toBeInTheDocument();
  });

  it('renders panels in a custom order (callHistory first)', async () => {
    const layout: TvPanelLayoutMap = {
      nowServing: { visible: true, order: 2, size: 4 },
      waitingQueue: { visible: true, order: 1, size: 2 },
      callHistory: { visible: true, order: 0, size: 2 },
      countersServing: { visible: true, order: 3, size: 2 },
      runningText: { visible: false, order: 4, size: 2 },
    };
    const active = [
      { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 2 },
    ];
    const api = makeApi('', [], active, layout);
    const audio = makeAudio();
    renderBoard(api, audio);

    await screen.findByTestId('tv-board__panel--callHistory');
    // callHistory(0) → waitingQueue(1) → nowServing(2) → countersServing(3).
    const order = Array.from(
      document.querySelectorAll('[data-testid^="tv-board__panel--"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'tv-board__panel--callHistory',
      'tv-board__panel--waitingQueue',
      'tv-board__panel--nowServing',
      'tv-board__panel--countersServing',
    ]);
  });

  it('a panel wrapper carries inline flex: <size> 1 0 (proportional height share)', async () => {
    const layout: TvPanelLayoutMap = {
      nowServing: { visible: true, order: 0, size: 3 },
      waitingQueue: { visible: true, order: 1, size: 1 },
      callHistory: { visible: true, order: 2, size: 2 },
      countersServing: { visible: false, order: 3, size: 2 },
      runningText: { visible: false, order: 4, size: 2 },
    };
    const active = [
      { ticketId: 't1', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'CALLING', counterId: 2 },
    ];
    const api = makeApi('', [], active, layout);
    const audio = makeAudio();
    renderBoard(api, audio);

    await screen.findByTestId('tv-board__panel--nowServing');
    const nowServingPanel = screen.getByTestId('tv-board__panel--nowServing');
    expect(nowServingPanel.getAttribute('style')).toContain('flex: 3 1 0');
    const waitingPanel = screen.getByTestId('tv-board__panel--waitingQueue');
    expect(waitingPanel.getAttribute('style')).toContain('flex: 1 1 0');
    const historyPanel = screen.getByTestId('tv-board__panel--callHistory');
    expect(historyPanel.getAttribute('style')).toContain('flex: 2 1 0');
  });

  it('renders the empty-state status when all content panels are hidden', async () => {
    const layout: TvPanelLayoutMap = {
      nowServing: { visible: false, order: 0, size: 4 },
      waitingQueue: { visible: false, order: 1, size: 2 },
      callHistory: { visible: false, order: 2, size: 2 },
      countersServing: { visible: false, order: 3, size: 2 },
      runningText: { visible: true, order: 4, size: 2 },
    };
    const api = makeApi('', [], [], layout);
    const audio = makeAudio();
    renderBoard(api, audio);

    // The empty-state status div renders when no content panel is visible.
    // Use a regex matcher (the em-dash in the literal string trips the exact
    // text matcher); scope to the panels-empty class to disambiguate from the
    // connection-status badge (also role="status").
    const emptyStatus = await screen.findByText(/Tidak ada panel yang ditampilkan/);
    expect(emptyStatus).toHaveClass('tv-board__panels-empty');
    expect(emptyStatus.textContent).toContain('aktifkan panel di Tampilan TV');
    // No panel wrappers render.
    expect(document.querySelector('[data-testid^="tv-board__panel--"]')).toBeNull();
    // The runningText footer still renders (visibility-only).
    expect(screen.getByRole('marquee')).toBeInTheDocument();
  });
});
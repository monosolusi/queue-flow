import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { TvStoreProvider } from './tv-store';
import { TvBoardPage } from '../pages/TvBoardPage';
import type { ITvApi } from '../api/tv-api';
import type { AudioProvider } from '../audio/audio-provider';
import type { QueueLifecycleWireEvent, TvTicketDto } from '../api/types';

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
): ITvApi {
  return {
    getSystemConfig: vi.fn(() =>
      Promise.resolve({ isInitialSetupCompleted: true, storeName: 'Apotek Sehat', brandColor }),
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

  it('clears now-serving on SYSTEM_RESET and returns to the idle standby', async () => {
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
    // nowServing clears → the idle standby panel returns (FR-TV-03) and the
    // now-serving number leaves the board. SYSTEM_RESET clears history too, so
    // A-005 must be gone from the DOM ENTIRELY — unlike the COMPLETED path (where
    // the hidden active layer legitimately retains history and the assertion is
    // scoped to the standby), this asserts globally so a regression that fails
    // to clear history on reset is caught.
    expect(await screen.findByTestId('standby')).toBeInTheDocument();
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();
  });

  it('clears now-serving when the ticket completes and returns to idle standby', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');

    fire(ws, statusEvent('t1', 'CALLING', 'COMPLETED'));
    expect(await screen.findByTestId('standby')).toBeInTheDocument();
    // Both layers stay mounted (AC6); the completed A-005 is retained in the
    // hidden active layer's history, so it must be absent from the standby panel
    // specifically — a global queryByText would match the hidden history item.
    expect(within(screen.getByTestId('standby')).queryByText('A-005')).not.toBeInTheDocument();
  });

  it('retains a completed ticket in history on the quiet-store path (FR-TV-01)', async () => {
    // The common single-counter flow is call → serve → complete → call next.
    // The completed ticket must enter "Riwayat Panggilan" even though no other
    // call displaced it while it was on the board (the quiet-store case that
    // left history empty before the retention fix). The retention is observed
    // when the next call brings the active board back; while idle the board is
    // replaced by the standby panel (FR-TV-03).
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');

    // Serve → complete. nowServing clears → idle standby; A-005 leaves the
    // board but is retained in history.
    fire(ws, statusEvent('t1', 'CALLING', 'SERVING'));
    fire(ws, statusEvent('t1', 'SERVING', 'COMPLETED'));
    expect(await screen.findByTestId('standby')).toBeInTheDocument();
    // A-005 is retained in the hidden active layer's history (see above) — scope
    // to the standby panel so the global query doesn't match it.
    expect(within(screen.getByTestId('standby')).queryByText('A-005')).not.toBeInTheDocument();

    // The next call brings the active board back; A-005 must appear exactly
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
    // nowServing clears → idle standby; a skipped ticket is recallable via
    // "Panggil Ulang" and is not retained in history (only COMPLETED tickets are).
    expect(await screen.findByTestId('standby')).toBeInTheDocument();
    expect(within(screen.getByTestId('standby')).queryByText('A-005')).not.toBeInTheDocument();

    // Bring the active board back with a new call; the skipped ticket must not
    // appear in history.
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
    expect(await screen.findByTestId('standby')).toBeInTheDocument();
    expect(within(screen.getByTestId('standby')).queryByText('A-005')).not.toBeInTheDocument();

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

describe('TvBoardPage idle/active switching (FR-TV-03)', () => {
  it('shows the standby media + running text when idle, switches to the active board on a call, and returns to standby when the call completes', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    // Idle: the standby panel renders the promo media + the running-text
    // greeting (the {storeName} placeholder resolved against the boot-loaded
    // store name). Both layers stay mounted (AC6); the active layer carries the
    // `--hidden` modifier and the standby is visible.
    const standby = await screen.findByTestId('standby');
    expect(standby).toBeInTheDocument();
    expect(standby).not.toHaveClass('standby--hidden');
    expect(screen.getByTestId('board-active')).toHaveClass('tv-board__active--hidden');
    // The active footer marquee renders the same running text, so scope to the
    // standby to avoid a double match under the both-mounted model.
    const standbyCopies = within(standby).getAllByText(/Selamat datang di Apotek Sehat/);
    expect(standbyCopies).toHaveLength(2);
    // AC7: the prominent standby marquee holds two copies (seamless loop), the
    // duplicate hidden from AT so the announcement is read once.
    const standbyMarquee = standbyCopies[0].closest('.marquee__track')!;
    expect(standbyMarquee.querySelectorAll('span')).toHaveLength(2);
    expect(standbyCopies[0]).not.toHaveAttribute('aria-hidden', 'true');
    expect(standbyCopies[1]).toHaveAttribute('aria-hidden', 'true');
    expect(standbyCopies[1]).toHaveClass('marquee__dup');
    // The standby media <img> is present (bundled placeholder banner).
    expect(standby.querySelector('img, video')).not.toBeNull();

    // A call arrives → the standby hides and the now-serving board appears. Both
    // layers stay mounted (AC6); the standby now carries `--hidden`.
    fire(ws, calledEvent('t1', 'A-005', 2));
    expect(await screen.findByText('A-005')).toBeInTheDocument();
    expect(screen.getByTestId('standby')).toHaveClass('standby--hidden');
    expect(screen.getByTestId('board-active')).not.toHaveClass('tv-board__active--hidden');
    expect(screen.getByText('Riwayat Panggilan')).toBeInTheDocument();

    // Complete the ticket → nowServing clears → the idle standby returns.
    fire(ws, statusEvent('t1', 'CALLING', 'COMPLETED'));
    expect(await screen.findByTestId('standby')).toBeInTheDocument();
    expect(screen.getByTestId('board-active')).toHaveClass('tv-board__active--hidden');
    // A-005 is retained in the hidden active layer's history — scope to the
    // standby so the global query doesn't match it (see COMPLETED-path note).
    expect(within(screen.getByTestId('standby')).queryByText('A-005')).not.toBeInTheDocument();
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

    // The waiting panel renders the fetched rows alongside the now-serving hero
    // (the active layer is mounted but hidden via the --hidden modifier; css:false
    // means findByText still resolves the text in the DOM). The standby layer
    // also renders a non-live WaitingQueue duplicate (the crossfade needs both
    // layers mounted), so each waiting row/text appears twice — use
    // findAllByText/getAllByText and assert the count.
    expect(await screen.findAllByText('B-001')).toHaveLength(2);
    expect(screen.getAllByText('A-002')).toHaveLength(2);
    expect(screen.getAllByText(/Menunggu: 2 tiket/)).toHaveLength(2);
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

    // The now-serving hero shows the restored ticket + counter — the active
    // board layer is visible (not the standby). The active layer's now-serving
    // card renders the ticket number; assert it appears (the standby layer is
    // hidden via the --hidden modifier and does not render a now-serving hero).
    expect(await screen.findByText('A-005')).toBeInTheDocument();
    expect(screen.getByText('Counter 2')).toBeInTheDocument();
    // The active board layer is visible (not hidden) — nowServing is non-null.
    expect(screen.getByTestId('board-active')).not.toHaveClass('tv-board__active--hidden');
    expect(screen.getByTestId('standby')).toHaveClass('standby--hidden');
    expect(api.getBoardState).toHaveBeenCalledTimes(1);
  });

  it('boot leaves nowServing null when the active slice is empty (standby)', async () => {
    const api = makeApi('', [], []);
    const audio = makeAudio();
    renderBoard(api, audio);

    // No active ticket → the standby panel is visible.
    expect(await screen.findByTestId('standby')).toBeInTheDocument();
    expect(screen.getByTestId('board-active')).toHaveClass('tv-board__active--hidden');
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

    // The newer call (B-007 at counter 2) wins as nowServing.
    expect(await screen.findByText('B-007')).toBeInTheDocument();
    expect(screen.getByText('Counter 2')).toBeInTheDocument();
  });

  it('BOARD_LOADED dedupes history against the restored nowServing', async () => {
    // Seed: boot with no active ticket (standby). Fire a TICKET_CALLED so a
    // ticket enters nowServing, then fire a second call that pushes the first
    // into history, then complete the second call (nowServing clears, history
    // retains it), then trigger a refetch whose active slice restores the
    // first ticket as nowServing — it must be removed from history (no
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

    // Complete t2 → nowServing clears → standby. A refetch with active=[t1]
    // restores t1 as nowServing and must remove it from history.
    fire(ws, statusEvent('t2', 'CALLING', 'COMPLETED'));
    expect(await screen.findByTestId('standby')).toBeInTheDocument();

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
    // history (the hidden active layer retains it under css:false), so
    // findByText would resolve immediately from the stale history item before
    // the debounced refetch fires. Wait real time past the debounce instead.
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
    // active board layer is visible (not the standby).
    expect(screen.getByTestId('board-active')).not.toHaveClass('tv-board__active--hidden');
    expect(screen.getByText('Counter 2')).toBeInTheDocument();
    // A-005 must NOT appear in history (deduped against the restored
    // nowServing). The CallHistory section is the only place history renders.
    const history = screen.getByText('Riwayat Panggilan').closest('section');
    expect(within(history!).queryByText('A-005')).not.toBeInTheDocument();
  });

  it('a board-state-fetch failure degrades gracefully — board still boots, waiting stays []', async () => {
    const api: ITvApi = {
      getSystemConfig: vi.fn(() =>
        Promise.resolve({ isInitialSetupCompleted: true, storeName: 'Apotek Sehat', brandColor: '' }),
      ),
      getCategories: vi.fn(() => Promise.resolve([{ id: 'cat-a', code: 'A', name: 'CS' }])),
      getBoardState: vi.fn(() => Promise.reject(new Error('boom'))),
    };
    const audio = makeAudio();
    renderBoard(api, audio);

    // Config still loaded — board boots.
    expect(await screen.findByText('Apotek Sehat')).toBeInTheDocument();
    // Empty waiting state — no rows, zero count. Both layers (active + standby)
    // render the empty panel, so each empty-state text appears twice.
    expect(screen.getAllByText('Belum ada antrian menunggu.')).toHaveLength(2);
    expect(screen.getAllByText(/Menunggu: 0 tiket/)).toHaveLength(2);
  });

  it('SYSTEM_RESET clears the waiting list immediately for snappy UX', async () => {
    const waiting = [
      { ticketId: 't1', ticketNumber: 'B-001', categoryId: 'cat-b', status: 'WAITING', counterId: null },
    ];
    const api = makeApi('', waiting);
    const audio = makeAudio();
    renderBoard(api, audio);
    // Both layers (active + standby) render the waiting row.
    expect(await screen.findAllByText('B-001')).toHaveLength(2);
    const ws = FakeWebSocket.instances[0];

    // Bring up a call so the active layer is the visible one, then reset.
    fire(ws, calledEvent('t2', 'A-005', 2));
    expect(await screen.findByText('A-005')).toBeInTheDocument();

    fire(ws, {
      type: 'SYSTEM_RESET',
      aggregateId: 'system',
      occurredAt: 3,
      version: 3,
      payload: { resetTo: 1, date: '2026-07-31' },
    });
    // The waiting list is cleared locally immediately — B-001 leaves both
    // layers' waiting panels (the debounced refetch confirms an empty list with
    // the mock's initial seed; here the mock stays at one row so we only assert
    // the local clear before the debounce fires). queryAllByText returns [] when
    // none remain (the duplicate is gone from both layers).
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

    // The waiting rows render in BOTH the active + standby layers (crossfade
    // keeps both mounted), so each row appears twice. The key assertion is
    // that they render AT ALL under StrictMode — pre-fix, `mountedRef` was
    // stuck `false` and the boot `refetchBoard` resolution was dropped.
    expect(await screen.findAllByText('B-001')).toHaveLength(2);
    expect(screen.getAllByText('A-002')).toHaveLength(2);
    expect(screen.getAllByText(/Menunggu: 2 tiket/)).toHaveLength(2);
    expect(api.getBoardState).toHaveBeenCalledTimes(1);
  });
});
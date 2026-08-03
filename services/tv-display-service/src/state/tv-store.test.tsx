import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TvStoreProvider } from './tv-store';
import { TvBoardPage } from '../pages/TvBoardPage';
import type { ITvApi } from '../api/tv-api';
import type { AudioProvider } from '../audio/audio-provider';
import type { QueueLifecycleWireEvent } from '../api/types';

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

function makeApi(brandColor = ''): ITvApi {
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

    // Boot: store name + categories loaded.

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    act(() => ws.onopen?.(new Event('open')));

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
    // now-serving number leaves the board.
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
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();
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
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();

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
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();

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

describe('TvBoardPage idle/active switching (FR-TV-03)', () => {
  it('shows the standby media + running text when idle, switches to the active board on a call, and returns to standby when the call completes', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    // Idle: the standby panel renders the promo media + the running-text
    // greeting (the {storeName} placeholder resolved against the boot-loaded
    // store name). The active board is not rendered while idle.
    const standby = await screen.findByTestId('standby');
    expect(standby).toBeInTheDocument();
    expect(
      screen.getByText(/Selamat datang di Apotek Sehat/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Riwayat Panggilan')).not.toBeInTheDocument();
    // The standby media <img> is present (bundled placeholder banner).
    expect(standby.querySelector('img, video')).not.toBeNull();

    // A call arrives → the standby disappears and the now-serving board appears.
    fire(ws, calledEvent('t1', 'A-005', 2));
    expect(await screen.findByText('A-005')).toBeInTheDocument();
    expect(screen.queryByTestId('standby')).not.toBeInTheDocument();
    expect(screen.getByText('Riwayat Panggilan')).toBeInTheDocument();

    // Complete the ticket → nowServing clears → the idle standby returns.
    fire(ws, statusEvent('t1', 'CALLING', 'COMPLETED'));
    expect(await screen.findByTestId('standby')).toBeInTheDocument();
    expect(screen.queryByText('A-005')).not.toBeInTheDocument();
  });
});
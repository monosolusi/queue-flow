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

function makeApi(): ITvApi {
  return {
    getSystemConfig: vi.fn(() =>
      Promise.resolve({ isInitialSetupCompleted: true, storeName: 'Apotek Sehat' }),
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
    expect(await screen.findByText('Apotek Sehat')).toBeInTheDocument();

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws.onopen?.(new Event('open'));

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

  it('clears now-serving on SYSTEM_RESET', async () => {
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
    expect(await screen.findByText(/Menunggu panggilan berikutnya/i)).toBeInTheDocument();
  });

  it('clears now-serving when the ticket completes or is skipped', async () => {
    const api = makeApi();
    const audio = makeAudio();
    renderBoard(api, audio);
    await screen.findByText('Apotek Sehat');
    const ws = FakeWebSocket.instances[0];

    fire(ws, calledEvent('t1', 'A-005', 2));
    await screen.findByText('A-005');

    fire(ws, statusEvent('t1', 'CALLING', 'COMPLETED'));
    expect(await screen.findByText(/Menunggu panggilan berikutnya/i)).toBeInTheDocument();
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
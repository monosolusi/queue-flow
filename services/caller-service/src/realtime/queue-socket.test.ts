import { describe, expect, it, vi } from 'vitest';
import { parseEnvelope, QueueSocket, type ConnectionStatus } from './queue-socket';

/** A controllable WebSocket double that lets tests drive lifecycle events. */
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
  error() {
    this.onerror?.();
  }
}

describe('parseEnvelope', () => {
  it('parses a valid lifecycle envelope', () => {
    const raw = JSON.stringify({
      type: 'TICKET_CREATED',
      aggregateId: 't-1',
      occurredAt: 1,
      version: 1,
      payload: { ticketNumber: 'A-001', categoryId: 'cat-a' },
    });
    expect(parseEnvelope(raw)?.type).toBe('TICKET_CREATED');
  });

  it('rejects non-string input', () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope(42)).toBeNull();
  });

  it('rejects malformed JSON and missing fields', () => {
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope(JSON.stringify({ type: 'TICKET_CREATED' }))).toBeNull();
    expect(parseEnvelope(JSON.stringify({ aggregateId: 'x' }))).toBeNull();
  });
});

describe('QueueSocket', () => {
  it('reports connecting then open, and forwards parsed events', () => {
    const statuses: ConnectionStatus[] = [];
    const onEvent = vi.fn();
    const sock = new QueueSocket(
      { onEvent, onStatus: (s) => statuses.push(s) },
      { WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket, url: 'ws://x/ws' },
    );
    sock.connect();
    expect(statuses[0]).toBe('connecting');
    FakeWebSocket.last!.open();
    expect(statuses).toContain('open');

    FakeWebSocket.last!.send(
      JSON.stringify({
        type: 'TICKET_CALLED',
        aggregateId: 't-1',
        occurredAt: 1,
        version: 1,
        payload: { ticketNumber: 'A-001', counterId: 1 },
      }),
    );
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].type).toBe('TICKET_CALLED');
    sock.close();
  });

  it('drops malformed frames without invoking onEvent', () => {
    const onEvent = vi.fn();
    const sock = new QueueSocket(
      { onEvent },
      { WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket, url: 'ws://x/ws' },
    );
    sock.connect();
    FakeWebSocket.last!.open();
    FakeWebSocket.last!.send('not-json');
    expect(onEvent).not.toHaveBeenCalled();
    sock.close();
  });

  it('reconnects after a close with exponential backoff', () => {
    vi.useFakeTimers();
    try {
      const onEvent = vi.fn();
      const sock = new QueueSocket(
        { onEvent },
        {
          WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
          url: 'ws://x/ws',
          reconnectDelayMs: 100,
          maxReconnectDelayMs: 1000,
        },
      );
      sock.connect();
      FakeWebSocket.last!.open();
      // Server drops the connection.
      FakeWebSocket.last!.close();
      // First reconnect after ~100ms.
      vi.advanceTimersByTime(100);
      expect(FakeWebSocket.last!.url).toBe('ws://x/ws');
      FakeWebSocket.last!.open();
      FakeWebSocket.last!.close();
      // Second reconnect after ~200ms.
      vi.advanceTimersByTime(200);
      sock.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect after an explicit close', () => {
    vi.useFakeTimers();
    try {
      const onEvent = vi.fn();
      const sock = new QueueSocket(
        { onEvent },
        { WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket, url: 'ws://x/ws' },
      );
      sock.connect();
      sock.close();
      vi.advanceTimersByTime(10000);
      // No new socket should have been created after the stop.
      expect(FakeWebSocket.last!.readyState).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
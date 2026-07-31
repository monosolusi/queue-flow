import type { QueueLifecycleWireEvent } from '../api/types';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

// WebSocket readyState constants (the spec values). Defined locally rather
// than read off the global `WebSocket` so the socket works under jsdom (which
// has no WebSocket implementation) with an injected constructor.
const READYSTATE_CONNECTING = 0;
const READYSTATE_OPEN = 1;

export interface QueueSocketHandlers {
  /** Called with each parsed broadcast envelope. */
  onEvent: (event: QueueLifecycleWireEvent) => void;
  /** Optional connection-state callback for the UI status indicator. */
  onStatus?: (status: ConnectionStatus) => void;
}

export interface QueueSocketOptions {
  /** ws:// URL; defaults to a relative `/ws` URL derived from the page origin. */
  url?: string;
  /** Injectable WebSocket constructor — tests pass a fake. */
  WebSocketCtor?: typeof WebSocket;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

/**
 * Native WebSocket client for the core-api lifecycle broadcaster (FR-ENG-04),
 * duplicated here for the TV board (no shared package — per the ISP convention
 * each frontend owns its own wire slice + transport). NOT socket.io — core-api
 * uses `@nestjs/platform-ws` (raw `ws`), so this speaks plain WebSocket.
 * Auto-reconnects with exponential backoff so the board recovers when the local
 * server restarts (offline resilience). The socket is dumb: it only parses
 * envelopes and forwards them; all projection + audio logic lives in the store.
 */
export class QueueSocket {
  private readonly handlers: QueueSocketHandlers;
  private readonly opts: Required<QueueSocketOptions>;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(handlers: QueueSocketHandlers, opts: QueueSocketOptions = {}) {
    this.handlers = handlers;
    this.opts = {
      url: opts.url ?? defaultWsUrl(),
      WebSocketCtor: opts.WebSocketCtor ?? WebSocket,
      reconnectDelayMs: opts.reconnectDelayMs ?? 1000,
      maxReconnectDelayMs: opts.maxReconnectDelayMs ?? 15000,
    };
  }

  /** Opens the connection (or re-opens after a stop). Idempotent while open. */
  connect(): void {
    this.stopped = false;
    if (this.ws && (this.ws.readyState === READYSTATE_OPEN || this.ws.readyState === READYSTATE_CONNECTING)) {
      return;
    }
    this.open();
  }

  /** Stops the socket and suppresses reconnect. Safe to call repeatedly. */
  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === READYSTATE_OPEN || this.ws.readyState === READYSTATE_CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.emitStatus('closed');
  }

  /** Injects a single parsed event (test seam — bypasses the transport). */
  emitTestEvent(event: QueueLifecycleWireEvent): void {
    this.handlers.onEvent(event);
  }

  private open(): void {
    this.emitStatus('connecting');
    const ws = new this.opts.WebSocketCtor(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.emitStatus('open');
    };
    ws.onmessage = (ev: MessageEvent) => {
      const parsed = parseEnvelope(ev.data);
      if (parsed) {
        this.handlers.onEvent(parsed);
      }
    };
    ws.onerror = () => {
      // The close handler will schedule a reconnect; errors are logged by the
      // browser. Do not throw — a transient socket failure must not crash the
      // board.
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.stopped) {
        this.scheduleReconnect();
      } else {
        this.emitStatus('closed');
      }
    };
  }

  private scheduleReconnect(): void {
    this.emitStatus('closed');
    const delay = Math.min(
      this.opts.maxReconnectDelayMs,
      this.opts.reconnectDelayMs * 2 ** this.attempt,
    );
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private emitStatus(status: ConnectionStatus): void {
    this.handlers.onStatus?.(status);
  }
}

/** Derives the relative /ws URL from the page origin (works behind NGINX + Vite proxy). */
function defaultWsUrl(): string {
  const loc = window.location;
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/ws`;
}

/** Parses a raw socket frame into a wire event, or returns null on malformed input. */
export function parseEnvelope(data: unknown): QueueLifecycleWireEvent | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as QueueLifecycleWireEvent;
    if (parsed && typeof parsed.type === 'string' && typeof parsed.aggregateId === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
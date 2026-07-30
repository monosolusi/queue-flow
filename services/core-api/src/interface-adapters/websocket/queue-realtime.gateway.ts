import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { QueueLifecycleWireEvent } from './dto/wire-event';

/**
 * Minimal structural view of the `ws` server/client the platform adapter
 * injects. Kept local (rather than importing `ws`) so the gateway depends only
 * on `@nestjs/websockets` and stays decoupled from the transport library — the
 * runtime server is whatever {@link WsAdapter} creates.
 */
interface WsClient {
  /** `ws.WebSocket.readyState`; 1 === OPEN. */
  readonly readyState: number;
  send(data: string): void;
}

interface WsServer {
  readonly clients: Set<WsClient>;
}

/** `ws.WebSocket` readyState value for an open connection. */
const READY_STATE_OPEN = 1;

/**
 * Local WebSocket gateway for queue lifecycle events (FR-ENG-04 / NFR-PERF-02).
 * LAN clients — TV display, caller panel, admin monitor — connect to `ws://…/ws`
 * and receive every broadcast envelope. Uses the `ws` platform adapter (native
 * WebSocket, no engine.io overhead) on the same port as the HTTP server.
 *
 * The gateway owns only connection lifecycle and the `broadcast` primitive; it
 * knows nothing about domain events. {@link WireEventMapper} + the publisher
 * turn domain events into the envelopes broadcast here.
 */
@WebSocketGateway({ path: '/ws' })
export class QueueRealtimeGateway
  implements OnGatewayInit<WsServer>, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(QueueRealtimeGateway.name);

  @WebSocketServer()
  private server!: WsServer;

  afterInit(): void {
    this.logger.log('Queue realtime WebSocket gateway listening at /ws');
  }

  handleConnection(): void {
    this.logger.log(`Client connected — ${this.server.clients.size} connected`);
  }

  handleDisconnect(): void {
    this.logger.log(`Client disconnected — ${this.server.clients.size} connected`);
  }

  /**
   * Pushes one wire envelope to every open client. Fire-and-forget per client:
   * a closed/broken receiver is skipped, never thrown, so a dropped TV display
   * cannot stall the caller's hot path (NFR-PERF-02).
   */
  public broadcast(envelope: QueueLifecycleWireEvent): void {
    const data = JSON.stringify(envelope);
    for (const client of this.server.clients) {
      if (client.readyState === READY_STATE_OPEN) {
        client.send(data);
      }
    }
  }
}
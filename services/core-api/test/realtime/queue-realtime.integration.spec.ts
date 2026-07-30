import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { WebSocket } from 'ws';
import { AppModule } from '../../src/app.module';
import { QueueEventDispatcher } from '../../src/application/queue/queue-event-dispatcher';
import { QueueTicket, TicketNumber, ticketIdGenerate } from '../../src/domain/queue';
import { StateMachine } from '../../src/domain/store-config/state-machine';

/**
 * End-to-end: a real `ws` client connects to the running Nest app's `/ws`
 * endpoint and receives the broadcast envelopes after the application seam
 * drains a `QueueTicket`'s domain events. Verifies AC — "Service client dapat
 * subscribe dan merespons event" — and the consistent wire schema, with no
 * internet (all localhost, NFR-REL-01).
 */
describe('Queue realtime WebSocket broadcaster (integration)', () => {
  let app: INestApplication;
  let dispatcher: QueueEventDispatcher;
  let port: number;
  const now = 1_700_000_000_000;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    dispatcher = app.get(QueueEventDispatcher);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Opens a client, runs `action`, and resolves the first `count` messages. */
  async function collectMessages(
    count: number,
    action: () => Promise<void>,
  ): Promise<unknown[]> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: unknown[] = [];

    const opened = new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const received = new Promise<unknown[]>((resolve) => {
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length >= count) {
          resolve(messages);
        }
      });
    });

    await opened;
    await action();
    let timeout: NodeJS.Timeout;
    const fallback = new Promise<unknown[]>((resolve) => {
      timeout = setTimeout(() => resolve(messages), 500);
    });
    const result = await Promise.race([received, fallback]);
    clearTimeout(timeout!);
    ws.close();
    return result;
  }

  it('broadcasts TICKET_CREATED to a connected client', async () => {
    const ticket = QueueTicket.create(
      ticketIdGenerate(),
      TicketNumber.of('A', 1),
      'CAT-A',
      now,
    );
    const received = (await collectMessages(1, () => dispatcher.dispatch(ticket))) as Array<{
      type: string;
      aggregateId: string;
      occurredAt: number;
      version: number;
      payload: Record<string, unknown>;
    }>;

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'TICKET_CREATED',
      aggregateId: ticket.id.value,
      occurredAt: now,
      version: 1,
      payload: { ticketNumber: 'A-001', categoryId: 'CAT-A' },
    });
  });

  it('broadcasts TICKET_CALLED and STATUS_UPDATED when a ticket is called', async () => {
    const ticket = QueueTicket.create(
      ticketIdGenerate(),
      TicketNumber.of('B', 7),
      'CAT-B',
      now,
    );
    // Drain the TICKET_CREATED event so only the call events are collected.
    await dispatcher.dispatch(ticket);
    ticket.markCalling(3, StateMachine.DEFAULT, now + 1);

    const received = (await collectMessages(2, () => dispatcher.dispatch(ticket))) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;

    const types = received.map((m) => m.type);
    expect(types).toContain('TICKET_CALLED');
    expect(types).toContain('STATUS_UPDATED');

    const called = received.find((m) => m.type === 'TICKET_CALLED');
    expect(called?.payload).toEqual({ ticketNumber: 'B-007', counterId: 3 });

    const status = received.find((m) => m.type === 'STATUS_UPDATED');
    expect(status?.payload).toEqual({
      from: 'WAITING',
      to: 'CALLING',
      actionLabel: 'Panggil Berikutnya',
    });
  });
});
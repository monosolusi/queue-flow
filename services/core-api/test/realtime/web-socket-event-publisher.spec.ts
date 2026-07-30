import { WebSocketEventPublisher } from '../../src/infrastructure/realtime/web-socket-event-publisher';
import { WireEventMapper } from '../../src/interface-adapters/websocket/wire-event.mapper';
import type { QueueRealtimeGateway } from '../../src/interface-adapters/websocket/queue-realtime.gateway';
import {
  TicketCalledEvent,
  TicketCreatedEvent,
} from '../../src/domain/queue';

describe('WebSocketEventPublisher', () => {
  let broadcast: jest.Mock;
  let publisher: WebSocketEventPublisher;

  beforeEach(() => {
    broadcast = jest.fn();
    const gateway = { broadcast } as unknown as QueueRealtimeGateway;
    publisher = new WebSocketEventPublisher(gateway, new WireEventMapper());
  });

  it('broadcasts one mapped envelope per event', async () => {
    await publisher.publish([
      new TicketCreatedEvent('agg-1', 'A-001', 'CAT-A', 1),
      new TicketCalledEvent('agg-1', 'A-001', 2, 2),
    ]);

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'TICKET_CREATED',
      payload: { ticketNumber: 'A-001', categoryId: 'CAT-A' },
    });
    expect(broadcast.mock.calls[1][0]).toMatchObject({
      type: 'TICKET_CALLED',
      payload: { ticketNumber: 'A-001', counterId: 2 },
    });
  });

  it('broadcasts nothing for an empty event list', async () => {
    await publisher.publish([]);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
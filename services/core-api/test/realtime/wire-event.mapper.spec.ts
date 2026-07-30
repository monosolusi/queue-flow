import { DomainEvent } from '../../src/domain/shared/domain-event';
import { Identifier } from '../../src/domain/shared';
import {
  DailyQueueResetEvent,
  TicketCalledEvent,
  TicketCreatedEvent,
  TicketStatusChangedEvent,
} from '../../src/domain/queue';
import { WireEventMapper } from '../../src/interface-adapters/websocket/wire-event.mapper';

describe('WireEventMapper', () => {
  const mapper = new WireEventMapper();
  const id = Identifier.generate().value;
  const now = 1_700_000_000_000;

  it('maps TicketCreatedEvent to a TICKET_CREATED envelope', () => {
    const wire = mapper.toWire(new TicketCreatedEvent(id, 'A-001', 'CAT-A', now));
    expect(wire).toEqual({
      type: 'TICKET_CREATED',
      aggregateId: id,
      occurredAt: now,
      version: 1,
      payload: { ticketNumber: 'A-001', categoryId: 'CAT-A' },
    });
  });

  it('maps TicketCalledEvent to a TICKET_CALLED envelope', () => {
    const wire = mapper.toWire(new TicketCalledEvent(id, 'A-001', 2, now));
    expect(wire).toEqual({
      type: 'TICKET_CALLED',
      aggregateId: id,
      occurredAt: now,
      version: 1,
      payload: { ticketNumber: 'A-001', counterId: 2 },
    });
  });

  it('maps TicketStatusChangedEvent to a STATUS_UPDATED envelope', () => {
    const wire = mapper.toWire(
      new TicketStatusChangedEvent(id, 'WAITING', 'CALLING', 'Panggil Berikutnya', now),
    );
    expect(wire).toEqual({
      type: 'STATUS_UPDATED',
      aggregateId: id,
      occurredAt: now,
      version: 1,
      payload: { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
    });
  });

  it('maps DailyQueueResetEvent to a SYSTEM_RESET envelope', () => {
    const wire = mapper.toWire(new DailyQueueResetEvent(id, 1, '2026-07-30', now));
    expect(wire).toEqual({
      type: 'SYSTEM_RESET',
      aggregateId: id,
      occurredAt: now,
      version: 1,
      payload: { resetTo: 1, date: '2026-07-30' },
    });
  });

  it('throws on an unsupported domain event type', () => {
    class UnknownEvent extends DomainEvent {
      constructor() {
        super('agg-1', 'UNKNOWN_TYPE');
      }
    }
    expect(() => mapper.toWire(new UnknownEvent())).toThrow(
      'Unsupported domain event type: UNKNOWN_TYPE',
    );
  });
});
import { Identifier } from '../../src/domain/shared';
import {
  DailyQueueResetEvent,
  TicketCalledEvent,
  TicketCreatedEvent,
  TicketStatusChangedEvent,
} from '../../src/domain/queue';

describe('Queue domain events', () => {
  const id = Identifier.generate().value;
  const now = 1_700_000_000_000;

  it('TicketCreatedEvent carries the broadcast type TICKET_CREATED', () => {
    const e = new TicketCreatedEvent(id, 'A-001', 'CAT-A', now);
    expect(e.type).toBe('TICKET_CREATED');
    expect(e.aggregateId).toBe(id);
    expect(e.ticketNumber).toBe('A-001');
    expect(e.categoryId).toBe('CAT-A');
  });

  it('TicketCalledEvent carries the broadcast type TICKET_CALLED', () => {
    const e = new TicketCalledEvent(id, 'A-001', 2, now);
    expect(e.type).toBe('TICKET_CALLED');
    expect(e.counterId).toBe(2);
  });

  it('TicketStatusChangedEvent carries the broadcast type STATUS_UPDATED', () => {
    const e = new TicketStatusChangedEvent(id, 'WAITING', 'CALLING', 'Panggil Berikutnya', now);
    expect(e.type).toBe('STATUS_UPDATED');
    expect(e.from).toBe('WAITING');
    expect(e.to).toBe('CALLING');
    expect(e.actionLabel).toBe('Panggil Berikutnya');
  });

  it('DailyQueueResetEvent carries the broadcast type SYSTEM_RESET', () => {
    const e = new DailyQueueResetEvent(id, 1, '2026-07-30', now);
    expect(e.type).toBe('SYSTEM_RESET');
    expect(e.resetTo).toBe(1);
    expect(e.date).toBe('2026-07-30');
  });
});
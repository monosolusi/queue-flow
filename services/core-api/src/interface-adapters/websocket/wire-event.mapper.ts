import type { DomainEvent } from '../../domain/shared/domain-event';
import {
  DailyQueueResetEvent,
  TicketCalledEvent,
  TicketCreatedEvent,
  TicketStatusChangedEvent,
  TicketTransferredEvent,
} from '../../domain/queue';
import type { QueueLifecycleWireEvent } from './dto/wire-event';

/**
 * Translates a recorded {@link DomainEvent} into the broadcast
 * {@link QueueLifecycleWireEvent} envelope. This is the only place that knows
 * how domain events project onto the wire schema, so the gateway and publisher
 * stay free of domain-specific mapping logic.
 *
 * Mapping keys off `instanceof` (not `event.type`) so the compiler proves every
 * payload field is sourced from a typed event — the wire `type` is then
 * derived from the class rather than re-typed by hand.
 */
export class WireEventMapper {
  public toWire(event: DomainEvent): QueueLifecycleWireEvent {
    const base = {
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
      version: event.version,
    };

    if (event instanceof TicketCreatedEvent) {
      return {
        type: 'TICKET_CREATED',
        ...base,
        payload: { ticketNumber: event.ticketNumber, categoryId: event.categoryId },
      };
    }
    if (event instanceof TicketCalledEvent) {
      return {
        type: 'TICKET_CALLED',
        ...base,
        payload: { ticketNumber: event.ticketNumber, counterId: event.counterId },
      };
    }
    if (event instanceof TicketStatusChangedEvent) {
      return {
        type: 'STATUS_UPDATED',
        ...base,
        payload: {
          from: event.from,
          to: event.to,
          actionLabel: event.actionLabel,
        },
      };
    }
    if (event instanceof DailyQueueResetEvent) {
      return {
        type: 'SYSTEM_RESET',
        ...base,
        payload: { resetTo: event.resetTo, date: event.date },
      };
    }
    if (event instanceof TicketTransferredEvent) {
      return {
        type: 'TICKET_TRANSFERRED',
        ...base,
        payload: {
          fromCategoryId: event.fromCategoryId,
          toCategoryId: event.toCategoryId,
          fromTicketNumber: event.fromTicketNumber,
          toTicketNumber: event.toTicketNumber,
        },
      };
    }

    // Exhaustiveness guard: if a new lifecycle event is added to the domain
    // without a wire mapping, this fails loudly instead of silently dropping.
    throw new Error(`Unsupported domain event type: ${event.type}`);
  }
}
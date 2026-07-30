import type { QueueTicket } from '../../domain/queue';

/**
 * Transport-agnostic projection of a {@link QueueTicket}'s state, returned by
 * the queue control use cases. Use cases never return the aggregate itself —
 * only this DTO, which the interface-adapter layer maps to HTTP or WebSocket
 * (DIP / no domain leakage). Shared by the recall / skip / serve / complete use
 * cases since they all expose the same post-action state.
 */
export interface TicketStateDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly status: string;
  readonly counterId: number | null;
}

/**
 * Projects a {@link QueueTicket} into a {@link TicketStateDto}. The single
 * place that knows how the aggregate maps to the shared DTO, so every use case
 * returns an identically-shaped result.
 */
export function projectTicketState(ticket: QueueTicket): TicketStateDto {
  return {
    ticketId: ticket.id.value,
    ticketNumber: ticket.ticketNumber.formatted(),
    categoryId: ticket.categoryId,
    status: ticket.currentStatus,
    counterId: ticket.counterId,
  };
}
import { Identifier } from '../../shared/identifier';

/**
 * The unique identity of a {@link QueueTicket}. Branded so the compiler
 * rejects passing a `Category`, `CounterRoutingRule`, or
 * `SystemConfiguration` id where a ticket id is expected — preventing the
 * cross-aggregate ID confusion CLAUDE.md calls out.
 */
export type TicketId = Identifier & { readonly __brand: 'TicketId' };

export function ticketIdOf(value: string): TicketId {
  return Identifier.of(value) as TicketId;
}

export function ticketIdGenerate(): TicketId {
  return Identifier.generate() as TicketId;
}
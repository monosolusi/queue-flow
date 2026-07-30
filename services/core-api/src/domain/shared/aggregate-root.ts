import { Entity } from './entity';
import type { DomainEvent } from './domain-event';
import type { Identifier } from './identifier';

/**
 * Base for aggregate roots. An aggregate root is the single entry point through
 * which a cluster of related entities and value objects is mutated. It records
 * the domain events that its behavior produced so the infrastructure layer can
 * publish them after the transaction commits (outbox-style).
 */
export abstract class AggregateRoot<TId extends Identifier = Identifier> extends Entity<TId> {
  private readonly _events: DomainEvent[] = [];

  constructor(id: TId) {
    super(id);
  }

  protected record(event: DomainEvent): void {
    this._events.push(event);
  }

  /** Returns and clears the events queued on this aggregate. */
  public pullDomainEvents(): DomainEvent[] {
    const events = [...this._events];
    this._events.length = 0;
    return events;
  }

  public clearEvents(): void {
    this._events.length = 0;
  }

  public get pendingEventCount(): number {
    return this._events.length;
  }
}
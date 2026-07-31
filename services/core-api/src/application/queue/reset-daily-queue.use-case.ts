import type { ISequenceRepository } from '../../domain/queue';
import { DailyQueueResetEvent, SYSTEM_AGGREGATE_ID } from '../../domain/queue';
import { QueueEventDispatcher } from './queue-event-dispatcher';
import { toDateKey } from './create-ticket.use-case';

/**
 * Command for the daily reset operation (FR-ENG-05). Rolls the per-category
 * sequence back to its start value so the next kiosk ticket is `<code>-001`
 * again. The caller supplies `resetTo` (sourced from the active
 * `DailyResetPolicy`); the use case derives `date` from its injected clock so the
 * date convention stays in the application layer (out of the domain) and is
 * deterministic in tests.
 *
 * Anti-corruption: this command carries only the scalar `resetTo`. The use case
 * never imports the Store-Config context — the interface-adapter layer (the
 * controller / scheduler) reads `DailyResetPolicy` and translates it into this
 * command. That keeps the Queue bounded context free of Store-Config internals.
 */
export interface ResetDailyQueueCommand {
  readonly resetTo: number;
}

/** Outcome of a daily reset: the sequence was rolled back for `date`. */
export type ResetDailyQueueResult = {
  readonly status: 'reset';
  readonly date: string;
  readonly resetTo: number;
};

/**
 * The daily reset engine (FR-ENG-05). Rolls the per-category, per-day sequence
 * back to `resetTo` via {@link ISequenceRepository.resetDaily} and emits a
 * {@link DailyQueueResetEvent} (broadcasts as `SYSTEM_RESET`) so the TV display
 * and any audit consumer are notified.
 *
 * The reset is a system-level operation — it is not owned by any single
 * `QueueTicket` aggregate — so the event is published via
 * {@link QueueEventDispatcher.dispatchEvents} (which accepts free-standing
 * domain events) rather than {@link QueueEventDispatcher.dispatch} (which drains
 * events off an `AggregateRoot`).
 *
 * Depends only on ports + the application-layer event seam (DIP): no ORM, HTTP
 * framework, or I/O library, and no Store-Config import (anti-corruption).
 * Durability (reset + the archived-day snapshot in one DB transaction) is the
 * future PostgreSQL repository's job (QUE-28); the in-memory impl is dev/tests.
 */
export class ResetDailyQueueUseCase {
  constructor(
    private readonly sequences: ISequenceRepository,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: ResetDailyQueueCommand): Promise<ResetDailyQueueResult> {
    const now = this.clock();
    const date = toDateKey(now);

    await this.sequences.resetDaily(date, command.resetTo);
    await this.dispatcher.dispatchEvents([
      new DailyQueueResetEvent(SYSTEM_AGGREGATE_ID, command.resetTo, date, now),
    ]);

    return { status: 'reset', date, resetTo: command.resetTo };
  }
}
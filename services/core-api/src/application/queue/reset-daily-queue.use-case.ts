import type { ISequenceRepository } from '../../domain/queue';
import { DailyQueueResetEvent, SYSTEM_AGGREGATE_ID } from '../../domain/queue';
import { AuditAction } from '../../domain/audit';
import {
  type ITransactionManager,
  NoOpTransactionManager,
} from '../../domain/shared';
import { type RecordAuditEntryUseCase } from '../audit/record-audit-entry.use-case';
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
 * `actor` is present **only** for a manual, human-triggered reset (the admin
 * surface). When present, the reset is recorded in the audit log as
 * `MANUAL_RESET` (NFR-SEC-02). The automatic cron-driven reset omits `actor` and
 * is therefore **not** audited — matching NFR-SEC-02, which scopes the audit
 * requirement to manual resets only. This keeps the manual and automatic paths
 * in one use case while distinguishing them cleanly by the presence of `actor`.
 *
 * Anti-corruption: this command carries only scalars. The use case never imports
 * the Store-Config context — the interface-adapter layer (the controller /
 * scheduler) reads `DailyResetPolicy` and translates it into this command. That
 * keeps the Queue bounded context free of Store-Config internals.
 */
export interface ResetDailyQueueCommand {
  readonly resetTo: number;
  /** When set, the reset is manual and audited (NFR-SEC-02). */
  readonly actor?: string;
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
 * **Atomicity + audit (NFR-REL-02 / NFR-SEC-02):** the sequence reset (and, for
 * the manual path, the audit append) run inside one
 * {@link ITransactionManager.runInTransaction} block. The repositories enlist on
 * the ambient transaction client, so a power cut between the reset and the audit
 * write leaves neither half-committed. The `SYSTEM_RESET` event is dispatched
 * **after** the transaction commits — a rolled-back reset is never broadcast.
 *
 * `recordAudit` and `txManager` are **optional** with no-op defaults, so the
 * existing unit specs that construct this use case directly (with only sequences
 * + dispatcher + clock) keep working unchanged.
 *
 * Depends only on ports + the application-layer event seam (DIP): no ORM, HTTP
 * framework, or I/O library, and no Store-Config import (anti-corruption).
 */
export class ResetDailyQueueUseCase {
  constructor(
    private readonly sequences: ISequenceRepository,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
    private readonly recordAudit: RecordAuditEntryUseCase | null = null,
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
  ) {}

  public async execute(command: ResetDailyQueueCommand): Promise<ResetDailyQueueResult> {
    const now = this.clock();
    const date = toDateKey(now);

    await this.txManager.runInTransaction(async () => {
      await this.sequences.resetDaily(date, command.resetTo);
      if (command.actor && this.recordAudit) {
        await this.recordAudit.execute({
          actor: command.actor,
          action: AuditAction.MANUAL_RESET,
          before: null,
          after: { date, resetTo: command.resetTo },
        });
      }
    });

    await this.dispatcher.dispatchEvents([
      new DailyQueueResetEvent(SYSTEM_AGGREGATE_ID, command.resetTo, date, now),
    ]);

    return { status: 'reset', date, resetTo: command.resetTo };
  }
}
import type { ISequenceRepository, ITicketArchivePort } from '../../domain/queue';
import { DailyQueueResetEvent, SYSTEM_AGGREGATE_ID } from '../../domain/queue';
import { AuditAction } from '../../domain/audit';
import {
  type ITransactionManager,
  NoOpTransactionManager,
} from '../../domain/shared';
import { type RecordAuditEntryUseCase } from '../audit/record-audit-entry.use-case';
import { QueueEventDispatcher } from './queue-event-dispatcher';
import { toDateKey, startOfLocalDay } from './create-ticket.use-case';

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
 * `archivePreviousDay` (sourced from `DailyResetPolicy.archivePreviousDayData`,
 * FR-WZD-05 / QUE-16) relocates prior-day active tickets to the archive store
 * before the sequence reset. The archive step shares the manual/automatic audit
 * scoping: an `ARCHIVE_PREVIOUS_DAY` audit entry is written only when `actor` is
 * set, exactly like `MANUAL_RESET`.
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
  /**
   * When true, prior-day active tickets are relocated to the archive store
   * before the sequence reset (FR-WZD-05 / QUE-16). Defaults to false so
   * existing callers that omit it are unaffected.
   */
  readonly archivePreviousDay?: boolean;
}

/** Outcome of a daily reset: the sequence was rolled back for `date`. */
export type ResetDailyQueueResult = {
  readonly status: 'reset';
  readonly date: string;
  readonly resetTo: number;
  /**
   * Number of prior-day tickets relocated to the archive store. Present only
   * when the archive step ran (i.e. `archivePreviousDay` was true).
   */
  readonly archivedCount?: number;
};

/**
 * The daily reset engine (FR-ENG-05). Rolls the per-category, per-day sequence
 * back to `resetTo` via {@link ISequenceRepository.resetDaily} and emits a
 * {@link DailyQueueResetEvent} (broadcasts as `SYSTEM_RESET`) so the TV display
 * and any audit consumer are notified.
 *
 * When `archivePreviousDay` is set (FR-WZD-05 / QUE-16), the engine first
 * relocates prior-day active tickets to the archive store via
 * {@link ITicketArchivePort.archiveTicketsBefore}. The "previous day" boundary
 * is local midnight today ({@link startOfLocalDay}) — anything older than the
 * start of today is a previous day and is archived; today's tickets stay in the
 * active store. Disabling archiving is a no-op: prior-day tickets then remain in
 * the active store (the pre-QUE-16 behavior).
 *
 * The reset is a system-level operation — it is not owned by any single
 * `QueueTicket` aggregate — so the event is published via
 * {@link QueueEventDispatcher.dispatchEvents} (which accepts free-standing
 * domain events) rather than {@link QueueEventDispatcher.dispatch} (which drains
 * events off an `AggregateRoot`).
 *
 * **Atomicity + audit (NFR-REL-02 / NFR-SEC-02):** the archive, the sequence
 * reset, and (for the manual path) the audit appends all run inside one
 * {@link ITransactionManager.runInTransaction} block. The repositories enlist on
 * the ambient transaction client, so a power cut between any of these steps
 * leaves none half-committed. The `SYSTEM_RESET` event is dispatched **after**
 * the transaction commits — a rolled-back reset is never broadcast.
 *
 * `recordAudit`, `txManager`, and `ticketArchive` are **optional** with no-op
 * defaults, so the existing unit specs that construct this use case directly
 * (with only sequences + dispatcher + clock) keep working unchanged.
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
    private readonly ticketArchive: ITicketArchivePort | null = null,
  ) {}

  public async execute(command: ResetDailyQueueCommand): Promise<ResetDailyQueueResult> {
    const now = this.clock();
    const date = toDateKey(now);

    const archivedCount = await this.txManager.runInTransaction(async () => {
      let archived = 0;
      if (command.archivePreviousDay && this.ticketArchive) {
        // Relocate prior-day active tickets to the archive store *before*
        // resetting the sequence, both inside this transaction so a power cut
        // leaves neither half-committed (NFR-REL-02). The threshold is local
        // midnight today — anything older is a previous day (FR-WZD-05 / QUE-16).
        archived = await this.ticketArchive.archiveTicketsBefore(startOfLocalDay(now));
        if (command.actor && this.recordAudit) {
          await this.recordAudit.execute({
            actor: command.actor,
            action: AuditAction.ARCHIVE_PREVIOUS_DAY,
            before: null,
            after: { date, archivedCount: archived },
          });
        }
      }
      await this.sequences.resetDaily(date, command.resetTo);
      if (command.actor && this.recordAudit) {
        await this.recordAudit.execute({
          actor: command.actor,
          action: AuditAction.MANUAL_RESET,
          before: null,
          after: { date, resetTo: command.resetTo },
        });
      }
      return archived;
    });

    await this.dispatcher.dispatchEvents([
      new DailyQueueResetEvent(SYSTEM_AGGREGATE_ID, command.resetTo, date, now),
    ]);

    return command.archivePreviousDay
      ? { status: 'reset', date, resetTo: command.resetTo, archivedCount }
      : { status: 'reset', date, resetTo: command.resetTo };
  }
}
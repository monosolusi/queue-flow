/**
 * NestJS DI token for {@link ITicketArchivePort}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather
 * than by type metadata. A plain language builtin — no framework import — so
 * it does not compromise domain purity (NFR-MNT-01), mirroring the
 * {@link QUEUE_REPOSITORY} pattern. The concrete {@link IQueueRepository}
 * implementation also implements this port; NestJS binds the token via
 * `useExisting: QUEUE_REPOSITORY` so one repo instance serves both.
 */
export const TICKET_ARCHIVE_PORT = Symbol('TICKET_ARCHIVE_PORT');

/**
 * Retention port for the daily-reset archive step (FR-WZD-05 / QUE-16). Kept
 * separate from {@link IQueueRepository} (ISP): the daily-reset use case needs
 * only the archive operation, not the full read/write surface of the queue
 * repository, so depending on this small port keeps its surface minimal.
 *
 * The port is Queue-context (tickets are a queue aggregate); it is **not** a
 * Reporting read model — `DailyQueueReport` / `IReportQueryPort` are deferred to
 * QUE-26. Archiving relocates prior-day active tickets to a retention store;
 * QUE-26 may later build read models over the archived rows.
 */
export interface ITicketArchivePort {
  /**
   * Relocate every ticket in the active store whose `createdAt` (epoch-ms) is
   * strictly before `thresholdMs` (regardless of status — WAITING, COMPLETED,
   * SKIPPED, … all move) into the archive store, and return the number moved.
   * Here "active" means "in the active tickets table" (vs the archive table),
   * not "non-terminal status". The boundary is a scalar timestamp (the start of
   * today, local) computed by the application layer — the date convention stays
   * out of the domain. Must enlist on any ambient transaction so archive +
   * sequence-reset commit atomically (NFR-REL-02).
   */
  archiveTicketsBefore(thresholdMs: number): Promise<number>;

  /**
   * Permanently delete every archived ticket whose `createdAt` (epoch-ms) is
   * strictly before `thresholdMs`, and return the number deleted (QUE-25 /
   * FR-ADM-02). This is the eviction step that keeps `archived_tickets` from
   * growing unbounded as each daily reset relocates prior-day tickets into it.
   * It operates on the **archive store only** — the active tickets table and
   * the `audit_log` table are never touched (the audit trail is the compliance
   * record, NFR-SEC-02, and is preserved indefinitely). The threshold is a
   * scalar epoch-ms computed by the application layer so the date convention
   * stays out of the domain. Must enlist on any ambient transaction so the
   * purge + the cleanup audit record commit atomically (NFR-REL-02).
   */
  purgeArchivedBefore(thresholdMs: number): Promise<number>;
}
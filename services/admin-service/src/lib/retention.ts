/**
 * Client-side retention-window validation for the transaction-log cleanup
 * override (FR-ADM-02 / QUE-25). Mirrors the backend
 * `CleanupTransactionLogUseCase` guardrail — an integer of at least
 * {@link MIN_RETENTION_DAYS} days — so the admin panel never submits a value
 * the backend would reject with 400 `INVALID_ARGUMENT`. Following the
 * CLAUDE.md rule: mirror the use-case invariant in client validation AND keep
 * invalid states unconstructable (the cleanup button stays disabled while the
 * field is invalid), rather than relying on a backend 400 round-trip.
 *
 * The floor is a deliberate business guardrail, not a configurable setting —
 * the audit trail is never purged and archived transactions are kept for at
 * least this long. Keep this value in sync with core-api's
 * `MIN_RETENTION_DAYS`.
 */
export const MIN_RETENTION_DAYS = 7;

/**
 * @returns an Indonesian error string when the retention window is invalid, or
 * `null` when valid (an integer of at least {@link MIN_RETENTION_DAYS}).
 */
export function validateRetentionDays(value: number): string | null {
  if (!Number.isInteger(value)) {
    return 'Retensi harus berupa bilangan bulat hari.';
  }
  if (value < MIN_RETENTION_DAYS) {
    return `Retensi minimal ${MIN_RETENTION_DAYS} hari.`;
  }
  return null;
}
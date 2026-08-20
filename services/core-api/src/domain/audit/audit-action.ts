/**
 * The set of system mutations that **must** be recorded in the local audit log
 * (NFR-SEC-02). Each maps to a manager-controlled operation:
 *
 * - `MANUAL_RESET` — an ad-hoc / manual daily-queue reset triggered via the
 *   admin surface (the automatic cron-driven reset is **not** audited — only
 *   the human-initiated one).
 * - `STATE_SCHEMA_CHANGE` — editing the state machine (states / transitions /
 *   action labels) via the wizard / admin panel.
 * - `ROUTING_CHANGE` — changing counter→category routing assignments or the
 *   priority policy, or editing the category master data.
 * - `ARCHIVE_PREVIOUS_DAY` — relocating prior-day active tickets to the
 *   archive store during a daily reset (honors `DailyResetPolicy.archivePrevi-
 *   ousDayData`). Audited on the manual path only, like `MANUAL_RESET`: the
 *   automatic cron-driven reset/archive is not audited.
 * - `TRANSACTION_LOG_CLEANUP` — permanently deleting archived queue
 *   transactions older than a manager-chosen retention window (QUE-25 /
 *   FR-ADM-02). There is no automatic/cron path, so the presence of `actor` is
 *   the manual marker — mirroring `MANUAL_RESET`. The `audit_log` table itself
 *   is never purged; only `archived_tickets` is.
 * - `DAILY_RESET_POLICY_CHANGE` — editing the daily-reset policy (mode, cron
 *   expression, reset target, or archive flag) via the wizard / admin panel
 *   (QUE-32 / NFR-SEC-02). Recorded inside the same tx as the config save, but
 *   **only when the policy actually changed** (before/after scalar snapshot) —
 *   unlike `STATE_SCHEMA_CHANGE` / `ROUTING_CHANGE`, which are recorded on
 *   every save. Pairs with the dynamic scheduler re-arm so a policy edit is
 *   both observable (audit) and immediately effective (re-arm) without restart.
 * - `LICENSE_ACTIVATED` — a license file was accepted and made active. The
 *   before/after snapshot carries the license id, customer, type and window —
 *   never the token itself. With no license server to query, this log is the
 *   only local record of when a store's entitlement changed.
 * - `LICENSE_REJECTED` — an upload was refused (bad signature, wrong
 *   installation, unreadable). Audited as deliberately as an acceptance:
 *   repeated rejections are what tampering looks like, and an attacker probing
 *   the endpoint should leave a trail rather than silence.
 *
 * Keeping this as a closed enum (rather than a free string) makes the audit
 * surface auditable itself: every recorded action is one of these known kinds.
 */
export enum AuditAction {
  MANUAL_RESET = 'MANUAL_RESET',
  STATE_SCHEMA_CHANGE = 'STATE_SCHEMA_CHANGE',
  ROUTING_CHANGE = 'ROUTING_CHANGE',
  ARCHIVE_PREVIOUS_DAY = 'ARCHIVE_PREVIOUS_DAY',
  TRANSACTION_LOG_CLEANUP = 'TRANSACTION_LOG_CLEANUP',
  DAILY_RESET_POLICY_CHANGE = 'DAILY_RESET_POLICY_CHANGE',
  LICENSE_ACTIVATED = 'LICENSE_ACTIVATED',
  LICENSE_REJECTED = 'LICENSE_REJECTED',
}
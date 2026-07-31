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
 *
 * Keeping this as a closed enum (rather than a free string) makes the audit
 * surface auditable itself: every recorded action is one of these known kinds.
 */
export enum AuditAction {
  MANUAL_RESET = 'MANUAL_RESET',
  STATE_SCHEMA_CHANGE = 'STATE_SCHEMA_CHANGE',
  ROUTING_CHANGE = 'ROUTING_CHANGE',
}
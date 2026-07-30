/**
 * The five states of the default state machine (PRD §7). Custom states such as
 * PREPARING / PAYMENT are configurable via the wizard; those arrive as plain
 * string values through the active {@link ITransitionPolicy}, so this enum
 * captures only the always-present canonical states plus a generic escape
 * hatch via {@link TicketStatus.isCanonical}.
 */
export enum TicketStatus {
  WAITING = 'WAITING',
  CALLING = 'CALLING',
  SERVING = 'SERVING',
  SKIPPED = 'SKIPPED',
  COMPLETED = 'COMPLETED',
}

export type StatusValue = `${TicketStatus}` | (string & {});

export const CANONICAL_STATUSES: ReadonlySet<string> = new Set<string>(
  Object.values(TicketStatus),
);

export function isCanonicalStatus(value: string): boolean {
  return CANONICAL_STATUSES.has(value);
}
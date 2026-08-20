import type { Entitlements } from './value-objects/entitlements';
import type { FingerprintVerdict } from './value-objects/host-fingerprint';
import type { LicenseType } from './value-objects/license-type';

/**
 * The graded enforcement ladder. Only `RESTRICTED` withholds anything; every
 * other state is fully functional and differs only in how loudly the UI warns.
 *
 * A queue system sits in a physical shop with customers standing at the
 * counter. Cutting it dead mid-morning punishes the wrong people and lands the
 * complaint on the vendor, so even `RESTRICTED` keeps the in-flight queue
 * draining — see `restrictsNewTickets`.
 */
export enum LicenseState {
  VALID = 'VALID',
  /** Valid, but within EXPIRING_SOON_DAYS of the end. Admin banner only. */
  EXPIRING_SOON = 'EXPIRING_SOON',
  /** Past expiry, inside the grace window. Full function, banner everywhere. */
  GRACE = 'GRACE',
  /** Host mismatch, inside its grace window. Full function, banner everywhere. */
  MISMATCH_GRACE = 'MISMATCH_GRACE',
  /** No usable licence. New tickets refused; the existing queue still drains. */
  RESTRICTED = 'RESTRICTED',
}

export enum LicenseIssue {
  NONE = 'NONE',
  /** No licence installed at all — a fresh install before activation. */
  ABSENT = 'ABSENT',
  /** Present but unreadable, or signed by a key we do not trust. */
  INVALID = 'INVALID',
  /** A genuine licence, but issued to a different installation. */
  WRONG_INSTALLATION = 'WRONG_INSTALLATION',
  EXPIRED = 'EXPIRED',
  HOST_MISMATCH = 'HOST_MISMATCH',
}

export interface LicenseStatus {
  readonly state: LicenseState;
  readonly issue: LicenseIssue;
  /** Operator-facing explanation. English here; the UI renders Indonesian. */
  readonly detail: string;

  readonly type: LicenseType | null;
  readonly customerName: string | null;
  readonly expiresAt: Date | null;
  readonly supportUntil: Date | null;
  /** Whole days until `expiresAt`; negative once past it. `null` when it never expires. */
  readonly daysUntilExpiry: number | null;
  /** When the current grace window runs out, if one is running. */
  readonly graceEndsAt: Date | null;

  /**
   * Advisory only — NEVER restricts. A perpetual licence keeps running at full
   * function past its maintenance window; what lapses is the right to upgrade
   * to the next major version. The lever there is commercial (the vendor does
   * not hand over the upgrade), not technical, which is how perpetual licensing
   * works everywhere it is honestly implemented.
   */
  readonly supportActive: boolean;
  /** Advisory only, same reasoning: this build's major version vs the licence's. */
  readonly versionCovered: boolean;

  readonly fingerprint: FingerprintVerdict | null;
  readonly entitlements: Entitlements;
}

/** New tickets are the revenue-bearing action, so this is what gets withheld. */
export function restrictsNewTickets(status: LicenseStatus): boolean {
  return status.state === LicenseState.RESTRICTED;
}

/**
 * Whether the store should be nagged. Everything except a clean `VALID` — the
 * activation page has to be reachable and the banner visible in every state
 * that is not fully healthy.
 */
export function needsAttention(status: LicenseStatus): boolean {
  return status.state !== LicenseState.VALID;
}

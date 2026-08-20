import { EXPIRING_SOON_DAYS, License } from './license';
import { LicenseIssue, LicenseState, type LicenseStatus } from './license-status';
import { Entitlements } from './value-objects/entitlements';
import { FingerprintOutcome, type FingerprintVerdict } from './value-objects/host-fingerprint';
import type { InstallationId } from './value-objects/installation-id';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface LicenseEvaluationInput {
  /** `null` when nothing is installed, or when the stored token failed verification. */
  readonly license: License | null;
  /** Set when a stored token exists but did not verify — distinguishes INVALID from ABSENT. */
  readonly tokenPresentButUnverifiable?: boolean;
  readonly installationId: InstallationId;
  /** Claim digests read from this host, already junk-filtered and hashed. */
  readonly observedClaims: Readonly<Record<string, string>>;
  /**
   * When a host mismatch was FIRST observed, persisted by the caller. A
   * mismatch has no date of its own — the licence cannot know when the hardware
   * changed — so the grace window has to be anchored to an observation the
   * installation records for itself.
   */
  readonly mismatchSince: Date | null;
  /**
   * "Now", already advanced past the persisted high-water mark by the caller.
   * Passing a raw wall clock here would let a trial be revived by winding the
   * mini PC's clock back, and an offline box has no NTP to contradict it.
   */
  readonly now: Date;
  /** Major version of the running build, for the advisory `versionCovered` flag. */
  readonly runningMajorVersion: number;
}

/**
 * Decides what a licence permits right now. Pure — no clock, no IO, no
 * persistence. Every input that could vary is passed in, which is what makes
 * the whole enforcement ladder unit-testable without a database or a fake timer.
 *
 * Severity order, most severe first: no usable licence → wrong installation →
 * expired past grace → mismatch past grace → expired in grace → mismatch in
 * grace → expiring soon → valid. Expiry outranks mismatch when both apply,
 * because expiry carries a date the operator can act on.
 */
export function evaluateLicense(input: LicenseEvaluationInput): LicenseStatus {
  const { license, installationId, observedClaims, mismatchSince, now, runningMajorVersion } = input;

  if (license === null) {
    const invalid = input.tokenPresentButUnverifiable === true;
    return restricted(
      invalid ? LicenseIssue.INVALID : LicenseIssue.ABSENT,
      invalid
        ? 'The installed license could not be verified. It is corrupt, was edited, or was not ' +
            'issued for this product.'
        : 'No license is installed.',
    );
  }

  // Wrong installation gets no grace: this is not a licence for this machine at
  // all, so there is nothing to be lenient about. Distinguished from a host
  // mismatch, where the licence IS ours and only the hardware moved.
  if (!license.isFor(installationId)) {
    return restricted(
      LicenseIssue.WRONG_INSTALLATION,
      `This license was issued for installation ${license.installationId.toString()}, but this ` +
        `installation is ${installationId.toString()}.`,
      license,
      null,
    );
  }

  const fingerprint = license.host.match(observedClaims);
  const isMismatch = fingerprint.outcome === FingerprintOutcome.MISMATCH;

  const expiresAt = license.expiresAt;
  const daysUntilExpiry =
    expiresAt === null ? null : Math.floor((expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
  const isExpired = expiresAt !== null && now.getTime() > expiresAt.getTime();

  const expiryGraceEndsAt =
    expiresAt === null ? null : new Date(expiresAt.getTime() + license.graceExpiryDays * MS_PER_DAY);
  const mismatchGraceEndsAt =
    isMismatch && mismatchSince !== null
      ? new Date(mismatchSince.getTime() + license.graceMismatchDays * MS_PER_DAY)
      : null;

  const expiredPastGrace =
    isExpired && expiryGraceEndsAt !== null && now.getTime() > expiryGraceEndsAt.getTime();
  // A mismatch with no recorded start is being seen for the first time in this
  // very evaluation: the caller has not persisted `mismatchSince` yet. Treat it
  // as freshly in grace rather than as immediately out of it.
  const mismatchPastGrace =
    isMismatch && mismatchGraceEndsAt !== null && now.getTime() > mismatchGraceEndsAt.getTime();

  const base = {
    type: license.type,
    customerName: license.customer.name,
    expiresAt,
    supportUntil: license.supportUntil,
    daysUntilExpiry,
    supportActive:
      license.supportUntil === null || now.getTime() <= license.supportUntil.getTime(),
    versionCovered: runningMajorVersion <= license.majorVersion,
    fingerprint,
    entitlements: license.entitlements,
  };

  if (expiredPastGrace) {
    return {
      ...base,
      state: LicenseState.RESTRICTED,
      issue: LicenseIssue.EXPIRED,
      detail: `The license expired on ${iso(expiresAt)} and its ${license.graceExpiryDays}-day grace period has ended.`,
      graceEndsAt: expiryGraceEndsAt,
    };
  }

  if (mismatchPastGrace) {
    return {
      ...base,
      state: LicenseState.RESTRICTED,
      issue: LicenseIssue.HOST_MISMATCH,
      detail: `This license was activated on different hardware (${describeMismatch(fingerprint)}) and its ${license.graceMismatchDays}-day grace period has ended.`,
      graceEndsAt: mismatchGraceEndsAt,
    };
  }

  if (isExpired) {
    return {
      ...base,
      state: LicenseState.GRACE,
      issue: LicenseIssue.EXPIRED,
      detail: `The license expired on ${iso(expiresAt)}. It keeps working until ${iso(expiryGraceEndsAt)}.`,
      graceEndsAt: expiryGraceEndsAt,
    };
  }

  if (isMismatch) {
    return {
      ...base,
      state: LicenseState.MISMATCH_GRACE,
      issue: LicenseIssue.HOST_MISMATCH,
      detail:
        `This license was activated on different hardware (${describeMismatch(fingerprint)}). ` +
        (mismatchGraceEndsAt === null
          ? `It keeps working for ${license.graceMismatchDays} more days.`
          : `It keeps working until ${iso(mismatchGraceEndsAt)}.`),
      graceEndsAt: mismatchGraceEndsAt,
    };
  }

  if (daysUntilExpiry !== null && daysUntilExpiry <= EXPIRING_SOON_DAYS) {
    return {
      ...base,
      state: LicenseState.EXPIRING_SOON,
      issue: LicenseIssue.NONE,
      detail: `The license expires on ${iso(expiresAt)} (${daysUntilExpiry} days).`,
      graceEndsAt: null,
    };
  }

  return {
    ...base,
    state: LicenseState.VALID,
    issue: LicenseIssue.NONE,
    detail: 'The license is valid.',
    graceEndsAt: null,
  };
}

function restricted(
  issue: LicenseIssue,
  detail: string,
  license: License | null = null,
  fingerprint: FingerprintVerdict | null = null,
): LicenseStatus {
  return {
    state: LicenseState.RESTRICTED,
    issue,
    detail,
    type: license?.type ?? null,
    customerName: license?.customer.name ?? null,
    expiresAt: license?.expiresAt ?? null,
    supportUntil: license?.supportUntil ?? null,
    daysUntilExpiry: null,
    graceEndsAt: null,
    supportActive: false,
    versionCovered: false,
    fingerprint,
    // A restricted store gets no entitlements to spend. Uncapped would be the
    // dangerous default here: an unlicensed install must not be able to add
    // counters that a later valid licence would then be over its cap on.
    entitlements: Entitlements.of({ maxCounters: 1, maxCategories: 1 }),
  };
}

function describeMismatch(verdict: FingerprintVerdict): string {
  const parts: string[] = [];
  if (verdict.changed.length > 0) parts.push(`changed: ${verdict.changed.join(', ')}`);
  if (verdict.unreadable.length > 0) parts.push(`unreadable: ${verdict.unreadable.join(', ')}`);
  if (verdict.matched.length > 0) parts.push(`still matching: ${verdict.matched.join(', ')}`);
  return parts.join('; ') || 'no matching host claims';
}

function iso(date: Date | null): string {
  return date === null ? 'unknown' : date.toISOString().slice(0, 10);
}

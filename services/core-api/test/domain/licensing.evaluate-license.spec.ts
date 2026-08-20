import { evaluateLicense } from '../../src/domain/licensing/evaluate-license';
import { License } from '../../src/domain/licensing/license';
import { LicenseIssue, LicenseState, restrictsNewTickets } from '../../src/domain/licensing/license-status';
import { installationIdOf } from '../../src/domain/licensing/value-objects/installation-id';

const OURS = installationIdOf('11111111-2222-4333-8444-555555555555');
const THEIRS = installationIdOf('99999999-8888-4777-a666-555555555555');

const BOARD = 'a'.repeat(64);
const MACHINE = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

const NOW = new Date('2026-06-01T00:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

function licenseOf(overrides: Record<string, unknown> = {}): License {
  return License.fromPayload({
    licenseId: '7f3c1d2e-9a4b-4c5d-8e6f-0a1b2c3d4e5f',
    issuedAt: '2026-01-01T00:00:00.000Z',
    customer: { name: 'Toko Uji', ref: null },
    product: { id: 'qms', majorVersion: 1 },
    type: 'perpetual',
    installationId: OURS.toString(),
    expiresAt: null,
    supportUntil: days(200).toISOString(),
    host: { bind: true, claims: { boardUuid: BOARD, machineId: MACHINE }, weights: { boardUuid: 2, machineId: 1 } },
    entitlements: { maxCounters: 8, maxCategories: 10, features: [] },
    grace: { expiryDays: 14, mismatchDays: 30 },
    ...overrides,
  });
}

function evaluate(
  license: License | null,
  extra: Partial<Parameters<typeof evaluateLicense>[0]> = {},
) {
  return evaluateLicense({
    license,
    installationId: OURS,
    observedClaims: { boardUuid: BOARD, machineId: MACHINE },
    mismatchSince: null,
    now: NOW,
    runningMajorVersion: 1,
    ...extra,
  });
}

describe('evaluateLicense — no usable licence', () => {
  it('restricts a store with no licence at all', () => {
    const status = evaluate(null);
    expect(status.state).toBe(LicenseState.RESTRICTED);
    expect(status.issue).toBe(LicenseIssue.ABSENT);
    expect(restrictsNewTickets(status)).toBe(true);
  });

  it('distinguishes a corrupt licence from a missing one', () => {
    // Different remediation: ABSENT means "activate", INVALID means "the file
    // you uploaded is not usable" — the operator must be told which.
    expect(evaluate(null, { tokenPresentButUnverifiable: true }).issue).toBe(LicenseIssue.INVALID);
  });

  it('gives a restricted store minimal entitlements, not unlimited ones', () => {
    // Uncapped here would let an unlicensed install create counters that a
    // later valid licence would then already be over its cap on.
    expect(evaluate(null).entitlements.maxCounters).toBe(1);
  });

  it('restricts a licence issued for another installation, with no grace', () => {
    const status = evaluate(licenseOf({ installationId: THEIRS.toString() }));
    expect(status.state).toBe(LicenseState.RESTRICTED);
    expect(status.issue).toBe(LicenseIssue.WRONG_INSTALLATION);
    expect(status.graceEndsAt).toBeNull();
  });
});

describe('evaluateLicense — perpetual', () => {
  it('is VALID on the machine it was activated on', () => {
    const status = evaluate(licenseOf());
    expect(status.state).toBe(LicenseState.VALID);
    expect(status.entitlements.maxCounters).toBe(8);
  });

  // The defining property of the tier, and the answer to "perpetual based on
  // what": perpetual against the VERSION, not against time.
  it('keeps running at full function after the support window lapses', () => {
    const status = evaluate(licenseOf({ supportUntil: days(-1).toISOString() }));
    expect(status.state).toBe(LicenseState.VALID);
    expect(status.supportActive).toBe(false);
    expect(restrictsNewTickets(status)).toBe(false);
  });

  it('flags an uncovered major version as advisory, never as a restriction', () => {
    // A newer major version is something the VENDOR installed. Cutting the shop
    // off for it would punish the customer for the vendor's own upgrade.
    const status = evaluate(licenseOf(), { runningMajorVersion: 2 });
    expect(status.state).toBe(LicenseState.VALID);
    expect(status.versionCovered).toBe(false);
  });

  it('never reports EXPIRING_SOON — it has no expiry to approach', () => {
    expect(evaluate(licenseOf()).daysUntilExpiry).toBeNull();
  });
});

describe('evaluateLicense — trial expiry ladder', () => {
  const trial = (expiresInDays: number) =>
    licenseOf({ type: 'trial', supportUntil: null, expiresAt: days(expiresInDays).toISOString() });

  it('is VALID well before expiry', () => {
    expect(evaluate(trial(60)).state).toBe(LicenseState.VALID);
  });

  it('warns within 30 days', () => {
    const status = evaluate(trial(10));
    expect(status.state).toBe(LicenseState.EXPIRING_SOON);
    expect(status.daysUntilExpiry).toBe(10);
  });

  it('keeps full function during the grace window after expiry', () => {
    const status = evaluate(trial(-3));
    expect(status.state).toBe(LicenseState.GRACE);
    expect(status.issue).toBe(LicenseIssue.EXPIRED);
    expect(restrictsNewTickets(status)).toBe(false);
  });

  it('restricts once the grace window has passed', () => {
    const status = evaluate(trial(-20));
    expect(status.state).toBe(LicenseState.RESTRICTED);
    expect(status.issue).toBe(LicenseIssue.EXPIRED);
  });

  it('treats the last day of grace as still in grace', () => {
    // An off-by-one here bills as "the shop died a day early".
    expect(evaluate(trial(-14)).state).toBe(LicenseState.GRACE);
  });
});

describe('evaluateLicense — host mismatch ladder', () => {
  const cloned = { observedClaims: { boardUuid: OTHER, machineId: OTHER } };

  it('never restricts immediately, even on a total mismatch', () => {
    // A first sighting has no recorded start date yet; the caller persists one
    // as a result of this very evaluation.
    const status = evaluate(licenseOf(), { ...cloned, mismatchSince: null });
    expect(status.state).toBe(LicenseState.MISMATCH_GRACE);
    expect(restrictsNewTickets(status)).toBe(false);
  });

  it('stays in grace inside the mismatch window', () => {
    const status = evaluate(licenseOf(), { ...cloned, mismatchSince: days(-10) });
    expect(status.state).toBe(LicenseState.MISMATCH_GRACE);
  });

  it('restricts after the mismatch window closes', () => {
    const status = evaluate(licenseOf(), { ...cloned, mismatchSince: days(-40) });
    expect(status.state).toBe(LicenseState.RESTRICTED);
    expect(status.issue).toBe(LicenseIssue.HOST_MISMATCH);
  });

  it('does not restrict when the host is simply unreadable', () => {
    // A forgotten bind-mount must not read as a clone.
    const status = evaluate(licenseOf(), { observedClaims: {}, mismatchSince: days(-90) });
    expect(status.state).toBe(LicenseState.VALID);
  });

  it('reports expiry ahead of mismatch when both have lapsed', () => {
    // Expiry carries a date the operator can act on; mismatch does not.
    const status = evaluate(
      licenseOf({ type: 'trial', supportUntil: null, expiresAt: days(-20).toISOString() }),
      { ...cloned, mismatchSince: days(-40) },
    );
    expect(status.issue).toBe(LicenseIssue.EXPIRED);
  });

  it('names which claim changed, so the operator can tell a swap from a clone', () => {
    const status = evaluate(licenseOf(), {
      observedClaims: { boardUuid: BOARD, machineId: OTHER },
    });
    // boardUuid still matches (weight 2 of 3) — this is a reinstall, not a move.
    expect(status.state).toBe(LicenseState.VALID);
    expect(status.fingerprint?.changed).toEqual(['machineId']);
  });
});

describe('evaluateLicense — clock handling', () => {
  it('honours the effective time it is given rather than reading a clock', () => {
    // Purity is what makes the rollback defence possible: the caller passes
    // max(wallClock, lastSeenAt), so winding the mini PC back cannot revive an
    // expired trial. If this function read Date.now() itself, it could not.
    const trial = licenseOf({ type: 'trial', supportUntil: null, expiresAt: days(-20).toISOString() });
    const rolledBack = evaluate(trial, { now: days(-60) });
    const monotonic = evaluate(trial, { now: NOW });

    expect(rolledBack.state).toBe(LicenseState.VALID);
    expect(monotonic.state).toBe(LicenseState.RESTRICTED);
  });
});

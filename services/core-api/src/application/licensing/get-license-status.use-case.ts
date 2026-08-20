import { evaluateLicense } from '../../domain/licensing/evaluate-license';
import type { IHostFingerprintReader } from '../../domain/licensing/host-fingerprint-reader.port';
import { License } from '../../domain/licensing/license';
import type { LicenseStatus } from '../../domain/licensing/license-status';
import type { ILicenseTokenVerifier } from '../../domain/licensing/license-token-verifier.port';
import type { IInstallationRepository } from '../../domain/licensing/repositories/installation.repository';
import type { ILicenseRepository } from '../../domain/licensing/repositories/license.repository';
import { FingerprintOutcome } from '../../domain/licensing/value-objects/host-fingerprint';
import type { InstallationId } from '../../domain/licensing/value-objects/installation-id';

/** Major version of this build, for the advisory `versionCovered` flag. */
export const PRODUCT_MAJOR_VERSION = 1;

export interface LicenseStatusResult {
  readonly status: LicenseStatus;
  readonly installationId: InstallationId;
  /** Claim digests read from this host — the activation request needs them too. */
  readonly observedClaims: Readonly<Record<string, string>>;
}

/**
 * Resolves what the installed licence permits right now.
 *
 * All the decision-making lives in the pure `evaluateLicense`; this use case
 * only gathers the inputs and persists the two pieces of state that the
 * evaluation cannot derive for itself — the monotonic clock high-water mark and
 * the date a host mismatch began.
 */
export class GetLicenseStatusUseCase {
  constructor(
    private readonly installations: IInstallationRepository,
    private readonly licenses: ILicenseRepository,
    private readonly verifier: ILicenseTokenVerifier,
    private readonly fingerprints: IHostFingerprintReader,
    private readonly clock: () => number = () => Date.now(),
    private readonly productMajorVersion: number = PRODUCT_MAJOR_VERSION,
  ) {}

  public async execute(): Promise<LicenseStatusResult> {
    const now = new Date(this.clock());
    const installation = await this.installations.getOrCreate(now);

    /**
     * The clock-rollback defence. An offline mini PC has no NTP, so its wall
     * clock is the customer's to set — winding it back a month would otherwise
     * revive a lapsed trial. Expiry is judged against the later of "now" and
     * the highest time this installation has ever seen, so time can only ever
     * move forward from the licence's point of view. A clock set FORWARD is
     * left alone: it is indistinguishable from time actually passing, and
     * penalising it would punish a legitimately mis-set machine.
     */
    const effectiveNow = new Date(
      Math.max(now.getTime(), installation.lastSeenAt.getTime()),
    );
    await this.installations.touch(now);

    const stored = await this.licenses.getActive();
    let license: License | null = null;
    let tokenPresentButUnverifiable = false;
    if (stored !== null) {
      const verification = this.verifier.verify(stored.token);
      if (verification.valid) {
        try {
          license = License.fromPayload(verification.payload);
        } catch {
          // A correctly signed token we cannot parse means we issued something
          // this build does not understand. Report it as unusable rather than
          // letting the exception escape and take the boot path down with it.
          tokenPresentButUnverifiable = true;
        }
      } else {
        tokenPresentButUnverifiable = true;
      }
    }

    const observedClaims = await this.fingerprints.read();

    const status = evaluateLicense({
      license,
      tokenPresentButUnverifiable,
      installationId: installation.installationId,
      observedClaims,
      mismatchSince: installation.hostMismatchSince,
      now: effectiveNow,
      runningMajorVersion: this.productMajorVersion,
    });

    await this.recordMismatchWindow(status, installation.hostMismatchSince, effectiveNow);

    return { status, installationId: installation.installationId, observedClaims };
  }

  /**
   * A mismatch has no date of its own — a licence cannot know when the hardware
   * changed — so the grace window is anchored to the first observation. Opening
   * it AFTER the evaluation means the very first sighting reports a grace with
   * no end date yet, which is why `evaluateLicense` treats a null
   * `mismatchSince` as freshly-in-grace rather than as already expired.
   *
   * Closing it matters just as much: a store that fails the check while a
   * bind-mount is missing, then has it restored, must get its full window back
   * rather than resuming a countdown that started during the misconfiguration.
   */
  private async recordMismatchWindow(
    status: LicenseStatus,
    current: Date | null,
    now: Date,
  ): Promise<void> {
    const mismatching = status.fingerprint?.outcome === FingerprintOutcome.MISMATCH;
    if (mismatching && current === null) {
      await this.installations.setHostMismatchSince(now);
    } else if (!mismatching && current !== null) {
      await this.installations.setHostMismatchSince(null);
    }
  }
}

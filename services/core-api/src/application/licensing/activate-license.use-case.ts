import { AuditAction } from '../../domain/audit/audit-action';
import { License } from '../../domain/licensing/license';
import type { LicenseStatus } from '../../domain/licensing/license-status';
import {
  VerificationFailure,
  type ILicenseTokenVerifier,
} from '../../domain/licensing/license-token-verifier.port';
import type { ILicenseRepository } from '../../domain/licensing/repositories/license.repository';
import { NoOpTransactionManager, type ITransactionManager } from '../../domain/shared/unit-of-work.port';
import type { RecordAuditEntryUseCase } from '../audit/record-audit-entry.use-case';
import { GetLicenseStatusUseCase } from './get-license-status.use-case';

export enum LicenseRejectionReason {
  /** Not a licence file, or the bytes are damaged. */
  MALFORMED = 'MALFORMED',
  /** Well-formed, but not signed by a key this build trusts. */
  UNTRUSTED = 'UNTRUSTED',
  /** Genuine and trusted, but issued to a different installation. */
  WRONG_INSTALLATION = 'WRONG_INSTALLATION',
  /** Signed and ours, but for a different product. */
  WRONG_PRODUCT = 'WRONG_PRODUCT',
}

/**
 * Verifier failure code → the remediation the manager is shown. An exhaustive
 * `Record` rather than a conditional, so adding a `VerificationFailure` member
 * fails to compile here instead of silently defaulting to "damaged file".
 */
const REJECTION_BY_FAILURE: Record<VerificationFailure, LicenseRejectionReason> = {
  [VerificationFailure.MALFORMED]: LicenseRejectionReason.MALFORMED,
  [VerificationFailure.UNTRUSTED_KEY]: LicenseRejectionReason.UNTRUSTED,
  [VerificationFailure.BAD_SIGNATURE]: LicenseRejectionReason.UNTRUSTED,
  // "This build trusts nothing" is a vendor build error, not a bad file, but
  // UNTRUSTED is the closest honest thing to tell the person holding the file:
  // it was not signed by a key we accept.
  [VerificationFailure.NO_TRUSTED_KEYS]: LicenseRejectionReason.UNTRUSTED,
};

export type ActivateLicenseResult =
  | { readonly ok: true; readonly status: LicenseStatus }
  | {
      readonly ok: false;
      readonly reason: LicenseRejectionReason;
      /** Diagnostic detail, English. The UI renders its own Indonesian copy per `reason`. */
      readonly detail: string;
    };

export interface ActivateLicenseCommand {
  readonly token: string;
  /** Authenticated principal's username, or `'system'` on the pre-setup path. */
  readonly actor: string;
}

/**
 * Installs an uploaded licence file.
 *
 * Returns a verdict rather than throwing on rejection: a manager uploading the
 * wrong file is an ordinary outcome of an activation screen, not an exceptional
 * one, and the screen needs a reason code it can render Indonesian copy for.
 * Genuine faults (a database failure) still propagate.
 */
export class ActivateLicenseUseCase {
  constructor(
    private readonly licenses: ILicenseRepository,
    private readonly verifier: ILicenseTokenVerifier,
    private readonly getStatus: GetLicenseStatusUseCase,
    private readonly transactions: ITransactionManager = new NoOpTransactionManager(),
    private readonly recordAudit: RecordAuditEntryUseCase | null = null,
    private readonly expectedProductId: string = 'qms',
  ) {}

  public async execute(command: ActivateLicenseCommand): Promise<ActivateLicenseResult> {
    // The installation id is needed before anything can be accepted, and
    // getOrCreate is what mints it on a first-ever boot — so an activation on a
    // brand-new store still has an identity to check the licence against.
    const { installationId } = await this.getStatus.execute();

    const checked = this.validate(command.token, installationId.toString());
    if (!checked.ok) {
      await this.audit(command.actor, AuditAction.LICENSE_REJECTED, {
        reason: checked.reason,
        detail: checked.detail,
      });
      return checked;
    }
    // Carried out of `validate` rather than re-verified and re-parsed. The old
    // second pass went through an unchecked `as { valid: true }` cast that would
    // have thrown on `undefined` if the verifier ever disagreed with itself.
    const { license } = checked;

    /**
     * The write and its audit record commit together. `activate` is itself two
     * statements (deactivate the old row, insert the new one) that must not tear
     * — a crash between them would leave the store with no active licence
     * moments after a successful upload (NFR-REL-02).
     */
    await this.transactions.runInTransaction(async () => {
      await this.licenses.activate(command.token, command.actor);
      await this.audit(command.actor, AuditAction.LICENSE_ACTIVATED, {
        // Never the token itself: the audit log is readable by any admin, and
        // the token is the bearer credential for this entitlement.
        licenseId: license.id.toString(),
        customer: license.customer.name,
        type: license.type,
        expiresAt: license.expiresAt?.toISOString() ?? null,
        supportUntil: license.supportUntil?.toISOString() ?? null,
        hostBound: license.host.bind,
      });
    });

    // Re-evaluate against the licence just stored. This also clears any
    // recorded host-mismatch window, so a replacement licence issued for new
    // hardware starts clean instead of inheriting the old countdown.
    const { status } = await this.getStatus.execute();
    return { ok: true, status };
  }

  /** Verifies, parses and checks the licence, returning it on success. */
  private validate(
    token: string,
    installationId: string,
  ): { ok: true; license: License } | (ActivateLicenseResult & { ok: false }) {
    const verification = this.verifier.verify(token);
    if (!verification.valid) {
      return {
        ok: false,
        reason: REJECTION_BY_FAILURE[verification.failure],
        detail: verification.reason,
      };
    }

    let license: License;
    try {
      license = License.fromPayload(verification.payload);
    } catch (error) {
      return {
        ok: false,
        reason: LicenseRejectionReason.MALFORMED,
        detail: (error as Error).message,
      };
    }

    if (license.productId !== this.expectedProductId) {
      return {
        ok: false,
        reason: LicenseRejectionReason.WRONG_PRODUCT,
        detail: `license is for product '${license.productId}', not '${this.expectedProductId}'`,
      };
    }

    if (license.installationId.toString() !== installationId) {
      return {
        ok: false,
        reason: LicenseRejectionReason.WRONG_INSTALLATION,
        detail: `license is for installation ${license.installationId.toString()}, this one is ${installationId}`,
      };
    }

    return { ok: true, license };
  }

  private async audit(
    actor: string,
    action: AuditAction,
    after: Record<string, unknown>,
  ): Promise<void> {
    if (this.recordAudit === null) return;
    await this.recordAudit.execute({ actor, action, before: null, after });
  }
}

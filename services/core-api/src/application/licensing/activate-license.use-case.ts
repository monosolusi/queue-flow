import { AuditAction } from '../../domain/audit/audit-action';
import { License } from '../../domain/licensing/license';
import {
  ActivationTransportFailure,
  type ILicenseActivationClient,
} from '../../domain/licensing/license-activation-client.port';
import type { LicenseStatus } from '../../domain/licensing/license-status';
import {
  VerificationFailure,
  type ILicenseTokenVerifier,
} from '../../domain/licensing/license-token-verifier.port';
import type { ILicenseRepository } from '../../domain/licensing/repositories/license.repository';
import { LicenseKey } from '../../domain/licensing/value-objects/license-key';
import { NoOpTransactionManager, type ITransactionManager } from '../../domain/shared/unit-of-work.port';
import type { RecordAuditEntryUseCase } from '../audit/record-audit-entry.use-case';
import { GetLicenseStatusUseCase, PRODUCT_MAJOR_VERSION } from './get-license-status.use-case';

export enum LicenseRejectionReason {
  /** The key itself is not a key — wrong length, bad symbol, failed checksum. */
  KEY_MALFORMED = 'KEY_MALFORMED',
  /** Could not reach the activation server. Almost always "no internet here". */
  OFFLINE = 'OFFLINE',
  /** Reached the server, but it did not answer in time. */
  TIMEOUT = 'TIMEOUT',
  /** The activation server failed on its own side, or spoke nonsense. */
  SERVER_ERROR = 'SERVER_ERROR',
  /** The server has no such key. */
  KEY_UNKNOWN = 'KEY_UNKNOWN',
  /** Real key, already bound to a different installation. */
  KEY_ALREADY_USED = 'KEY_ALREADY_USED',
  /** Real key, withdrawn by the vendor before it was redeemed. */
  KEY_REVOKED = 'KEY_REVOKED',
  /** Real key, but its redemption window closed. */
  KEY_EXPIRED = 'KEY_EXPIRED',
  /** The returned token is not a licence file, or the bytes are damaged. */
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
  // "This build trusts nothing" is a vendor build error, not a bad reply, but
  // UNTRUSTED is the closest honest thing to say: it was not signed by a key we
  // accept. The vendor-side signal for it is the boot log and the release gate.
  [VerificationFailure.NO_TRUSTED_KEYS]: LicenseRejectionReason.UNTRUSTED,
};

/**
 * Transport failure → the remediation the manager is shown. Exhaustive for the
 * same reason as {@link REJECTION_BY_FAILURE}: a new member of the transport
 * enum must not quietly become "server error" when it deserves its own screen.
 */
const REJECTION_BY_TRANSPORT: Record<ActivationTransportFailure, LicenseRejectionReason> = {
  [ActivationTransportFailure.OFFLINE]: LicenseRejectionReason.OFFLINE,
  [ActivationTransportFailure.TIMEOUT]: LicenseRejectionReason.TIMEOUT,
  [ActivationTransportFailure.SERVER_ERROR]: LicenseRejectionReason.SERVER_ERROR,
  [ActivationTransportFailure.KEY_UNKNOWN]: LicenseRejectionReason.KEY_UNKNOWN,
  [ActivationTransportFailure.KEY_ALREADY_USED]: LicenseRejectionReason.KEY_ALREADY_USED,
  [ActivationTransportFailure.KEY_REVOKED]: LicenseRejectionReason.KEY_REVOKED,
  [ActivationTransportFailure.KEY_EXPIRED]: LicenseRejectionReason.KEY_EXPIRED,
  [ActivationTransportFailure.PRODUCT_MISMATCH]: LicenseRejectionReason.WRONG_PRODUCT,
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
  /** As typed by the manager — normalisation and checking belong to the VO. */
  readonly key: string;
  /** Authenticated principal's username, or `'system'` on the pre-setup path. */
  readonly actor: string;
}

/**
 * Redeems an activation key and installs the licence it returns.
 *
 * This is the only moment in the product's life that needs the internet. The
 * activation server binds the key to this installation and signs a token; from
 * then on every evaluation reads that stored token locally, so the shop runs
 * with the WAN cable unplugged forever after.
 *
 * **The reply is not trusted because of where it came from.** It goes through
 * the same {@link ILicenseTokenVerifier} as any token, so a hostile or spoofed
 * activation server produces nothing usable — it would have to sign with a
 * private key the vendor never published.
 *
 * Returns a verdict rather than throwing on rejection: a mistyped key or a shop
 * with no signal is an ordinary outcome of an activation screen, not an
 * exceptional one, and the screen needs a reason code it can render Indonesian
 * copy for. Genuine faults (a database failure) still propagate.
 */
export class ActivateLicenseUseCase {
  constructor(
    private readonly licenses: ILicenseRepository,
    private readonly verifier: ILicenseTokenVerifier,
    private readonly activation: ILicenseActivationClient,
    private readonly getStatus: GetLicenseStatusUseCase,
    private readonly transactions: ITransactionManager = new NoOpTransactionManager(),
    private readonly recordAudit: RecordAuditEntryUseCase | null = null,
    private readonly expectedProductId: string = 'qms',
    private readonly productMajorVersion: number = PRODUCT_MAJOR_VERSION,
  ) {}

  public async execute(command: ActivateLicenseCommand): Promise<ActivateLicenseResult> {
    // Checked before anything else so a slipped finger costs nothing: no
    // network round trip, and no failed redemption recorded against a customer
    // whose key was fine.
    let key: LicenseKey;
    try {
      key = LicenseKey.of(command.key);
    } catch (error) {
      return this.reject(command, LicenseRejectionReason.KEY_MALFORMED, (error as Error).message);
    }

    // The installation id is needed before anything can be accepted, and
    // getOrCreate is what mints it on a first-ever boot — so an activation on a
    // brand-new store still has an identity to bind the licence to.
    const { installationId, observedClaims } = await this.getStatus.execute();

    const redemption = await this.activation.redeem({
      key: key.toString(),
      installationId: installationId.toString(),
      claims: { ...observedClaims },
      productId: this.expectedProductId,
      majorVersion: this.productMajorVersion,
    });
    if (!redemption.ok) {
      return this.reject(command, REJECTION_BY_TRANSPORT[redemption.failure], redemption.detail);
    }

    const token = redemption.armoredToken;
    const checked = this.validate(token, installationId.toString());
    if (!checked.ok) {
      return this.reject(command, checked.reason, checked.detail);
    }
    // Carried out of `validate` rather than re-verified and re-parsed. The old
    // second pass went through an unchecked `as { valid: true }` cast that would
    // have thrown on `undefined` if the verifier ever disagreed with itself.
    const { license } = checked;

    /**
     * The write and its audit record commit together. `activate` is itself two
     * statements (deactivate the old row, insert the new one) that must not tear
     * — a crash between them would leave the store with no active licence
     * moments after a successful redemption (NFR-REL-02). This is also what
     * makes re-activation safe after the vendor releases a seat: replacing an
     * existing licence is the same two statements, never a window with none.
     */
    await this.transactions.runInTransaction(async () => {
      await this.licenses.activate(token, command.actor);
      await this.audit(command.actor, AuditAction.LICENSE_ACTIVATED, {
        // Never the token itself: the audit log is readable by any admin, and
        // the token is the bearer credential for this entitlement. The key is
        // masked for the same reason, keeping just enough to match a support
        // conversation against a row.
        keySuffix: suffixOf(key),
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

  /** Verifies, parses and checks the returned token, returning the licence. */
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

  private async reject(
    command: ActivateLicenseCommand,
    reason: LicenseRejectionReason,
    detail: string,
  ): Promise<ActivateLicenseResult> {
    await this.audit(command.actor, AuditAction.LICENSE_REJECTED, { reason, detail });
    return { ok: false, reason, detail };
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

/** Last group only — enough to match a support call, useless to a thief. */
function suffixOf(key: LicenseKey): string {
  const groups = key.toString().split('-');
  return `…-${groups[groups.length - 1]}`;
}

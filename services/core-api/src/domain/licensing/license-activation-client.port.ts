/**
 * NestJS DI token for {@link ILicenseActivationClient}. A plain language
 * builtin, so domain purity (NFR-MNT-01) holds.
 */
export const LICENSE_ACTIVATION_CLIENT = Symbol('LICENSE_ACTIVATION_CLIENT');

/**
 * Why a redemption did not come back with a token, as a CODE the application
 * layer can branch on — the same discipline as {@link VerificationFailure}, and
 * for the same reason: the Indonesian screen a manager sees must not depend on
 * the wording of an HTTP error string.
 *
 * The split between `OFFLINE` and the `KEY_*` members is the one that matters
 * most in the field. "There is no internet here" and "this key is already in
 * use at another branch" are the two overwhelmingly likely outcomes of a failed
 * activation, they have completely different remedies, and telling a technician
 * the wrong one costs a return trip.
 */
export enum ActivationTransportFailure {
  /** Could not reach the activation server at all — no internet, DNS, refused. */
  OFFLINE = 'OFFLINE',
  /** Reached it, but it did not answer in time. */
  TIMEOUT = 'TIMEOUT',
  /** Reached it and it failed on its own side, or spoke nonsense. */
  SERVER_ERROR = 'SERVER_ERROR',
  /** No such key. Almost always a typo the checksum happened not to catch. */
  KEY_UNKNOWN = 'KEY_UNKNOWN',
  /** Genuine, but already bound to a different installation. */
  KEY_ALREADY_USED = 'KEY_ALREADY_USED',
  /** Genuine, but withdrawn by the vendor before it was ever redeemed. */
  KEY_REVOKED = 'KEY_REVOKED',
  /** Genuine, but its redemption window closed before anyone used it. */
  KEY_EXPIRED = 'KEY_EXPIRED',
  /** Genuine, but issued for a different product than the one asking. */
  PRODUCT_MISMATCH = 'PRODUCT_MISMATCH',
}

/**
 * What this installation tells the activation server about itself.
 *
 * Exactly the data the old `QMSREQ1-…` blob carried by hand over WhatsApp —
 * the channel changed, the payload did not. Host claims are ALREADY hashed by
 * {@link IHostFingerprintReader}, so no raw hardware identifier ever leaves the
 * building, and an empty claim map is a legitimate state (a VM, a missing
 * bind-mount) that yields a licence with host binding switched off rather than
 * an error.
 */
export interface ActivationRedemption {
  readonly key: string;
  readonly installationId: string;
  readonly claims: Readonly<Record<string, string>>;
  readonly productId: string;
  readonly majorVersion: number;
}

export type RedemptionResult =
  | { readonly ok: true; readonly armoredToken: string }
  | {
      readonly ok: false;
      readonly failure: ActivationTransportFailure;
      /** Free-text diagnostic for logs and support. Never branched on. */
      readonly detail: string;
    };

/**
 * Exchanges an activation key for a signed licence token (DIP). Keeps `fetch`
 * — network IO, forbidden in `src/domain/` — in infrastructure while the policy
 * that consumes it stays here.
 *
 * Returns a verdict rather than throwing: a store with no internet is an
 * expected condition of an activation screen, not an exceptional one.
 *
 * **The token this returns is not trusted because of where it came from.** It
 * goes through {@link ILicenseTokenVerifier} exactly like any other token, so
 * pointing `QMS_LICENSE_ACTIVATION_URL` at a hostile server yields nothing: the
 * reply still has to carry a signature from a key compiled into this build.
 * That is also why the URL is an ordinary environment variable while the
 * trusted keys are not.
 *
 * Implementations must NOT retry on their own. Redeeming can consume a seat on
 * the server, so a second attempt is a decision for the person pressing the
 * button, not something a client library makes on their behalf.
 */
export interface ILicenseActivationClient {
  redeem(request: ActivationRedemption): Promise<RedemptionResult>;
}

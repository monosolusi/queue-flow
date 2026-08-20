/**
 * NestJS DI token for {@link ILicenseTokenVerifier}. A plain language builtin,
 * so domain purity (NFR-MNT-01) holds.
 */
export const LICENSE_TOKEN_VERIFIER = Symbol('LICENSE_TOKEN_VERIFIER');

/**
 * Why verification failed, as a CODE the application layer can branch on.
 *
 * `reason` alone was not enough: classifying by `reason.includes('signing key')`
 * made the choice between two Indonesian remediation screens depend on the
 * wording of one infrastructure implementation. Rewording a message would
 * silently reclassify "we did not sign this" as "your file is damaged" — two
 * different things to tell a customer. The verifier knows which branch it took
 * at every return site, so it should say so.
 */
export enum VerificationFailure {
  /** Not a licence file, or the bytes are damaged. */
  MALFORMED = 'MALFORMED',
  /** Well-formed, but the `kid` names a key this build does not know. */
  UNTRUSTED_KEY = 'UNTRUSTED_KEY',
  /** Known key, but the signature does not verify — edited after issue. */
  BAD_SIGNATURE = 'BAD_SIGNATURE',
  /** This build has no signing key compiled in at all. */
  NO_TRUSTED_KEYS = 'NO_TRUSTED_KEYS',
}

export type LicenseVerification =
  | { readonly valid: true; readonly payload: unknown }
  | {
      readonly valid: false;
      readonly failure: VerificationFailure;
      /** Free-text diagnostic for logs and support. Never branched on. */
      readonly reason: string;
    };

/**
 * Signature-verification port (DIP), the same shape as `IPasswordHasher`: it
 * exists so `node:crypto` — forbidden in `src/domain/` by dep-cruiser — stays
 * in infrastructure while the policy that consumes it stays here.
 *
 * Returns a verdict rather than throwing: an invalid licence is an expected
 * input, not an exceptional one, and the store still has to boot and show an
 * activation page when one is presented.
 *
 * The implementation must verify the token's exact signed bytes and only then
 * parse them. Re-serialising a parsed payload to check it would reintroduce the
 * canonical-JSON agreement problem the wire format was designed to avoid.
 */
export interface ILicenseTokenVerifier {
  verify(armoredToken: string): LicenseVerification;
}

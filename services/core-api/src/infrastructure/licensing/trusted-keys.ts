/**
 * Ed25519 public keys whose signatures this build accepts.
 *
 * **Compiled in on purpose — never read from an environment variable.** An env
 * var sits in `docker-compose.yml`, which the customer owns: swapping in their
 * own public key and self-signing a licence would be a one-line edit. Baking
 * the value into the bundle means defeating it requires editing JavaScript
 * inside a built image. Neither is unbreakable — the customer has root — but
 * the difference in effort is the entire point of the exercise.
 *
 * An ARRAY, not a single key, so a key can be rotated without invalidating
 * licences already in the field: add the new key, keep the old one until every
 * customer has been re-issued, then drop it. The token's `kid` header selects
 * which entry to check.
 *
 * ## Before the first release
 *
 * This table ships EMPTY, which makes every licence fail as INVALID and leaves
 * every store on the activation screen. That is the correct default — a
 * placeholder key would be a key an attacker also has. Generate the real one and
 * paste the line it prints:
 *
 *   node tools/license-generator/bin/qms-license.mjs keygen
 *
 * The private half never enters this repo; `npm run verify` fails if it does.
 */
export interface TrustedSigningKey {
  readonly keyId: string;
  /** SPKI DER, base64 (what `keygen` prints). */
  readonly publicKeyDerB64: string;
}

export const TRUSTED_SIGNING_KEYS: readonly TrustedSigningKey[] = [
  // { keyId: '…', publicKeyDerB64: '…' },
];

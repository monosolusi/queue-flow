import { Ed25519LicenseTokenVerifier } from './ed25519-license-token-verifier';
import { TRUSTED_SIGNING_KEYS, type TrustedSigningKey } from './trusted-keys';

/**
 * Format: `"<keyId> <base64SpkiPublicKey>"` — exactly the line
 * `qms-license keygen` writes to `public-key.txt`, so the file can be piped
 * straight into the variable.
 */
export const TRUSTED_KEY_ENV = 'QMS_LICENSE_TRUSTED_KEY';

/**
 * Builds the licence verifier, optionally trusting one EXTRA key supplied by
 * the environment.
 *
 * Why an env key at all, when the whole point of compiling
 * {@link TRUSTED_SIGNING_KEYS} in is that a customer cannot swap it: because
 * the acceptance suite has to exercise the genuine Ed25519 path rather than a
 * fake verifier, and `@nestjs/testing` — which would let a test override the
 * provider — is not a dependency of this service and is not worth adding for
 * one seam. It also gives the vendor a way to rehearse a staging key without a
 * rebuild.
 *
 * Requires `NODE_ENV !== 'production'`, which the Dockerfile pins, so it does
 * nothing in a shipped image as configured. It is friction, not a wall: the
 * customer owns `docker-compose.yml` and can override `NODE_ENV` — but anyone
 * willing to do that is already willing to edit the image's JavaScript, so this
 * adds no meaningful attack surface. See the threat model in
 * tools/license-generator/README.md.
 *
 * The compiled list is ALWAYS trusted; the env key is only ever ADDED to it,
 * never a replacement — so a misconfigured variable cannot make a genuine
 * licence stop working.
 */
export function createLicenseTokenVerifier(): Ed25519LicenseTokenVerifier {
  return new Ed25519LicenseTokenVerifier([...TRUSTED_SIGNING_KEYS, ...envKey()]);
}

function envKey(): TrustedSigningKey[] {
  if (process.env.NODE_ENV === 'production') return [];

  const raw = process.env[TRUSTED_KEY_ENV];
  if (raw === undefined || raw.trim().length === 0) return [];

  const [keyId, publicKeyDerB64] = raw.trim().split(/\s+/);
  if (!keyId || !publicKeyDerB64) return [];

  return [{ keyId, publicKeyDerB64 }];
}

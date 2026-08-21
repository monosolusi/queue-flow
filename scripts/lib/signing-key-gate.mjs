import { readFileSync } from 'node:fs';

const TRUSTED_KEYS_FILE =
  'services/core-api/src/infrastructure/licensing/trusted-keys.ts';

/**
 * Is a licensing public key compiled into this build?
 *
 * A build with an empty `TRUSTED_SIGNING_KEYS` table refuses every activation,
 * so every store running it is stuck on the activation screen with an error
 * that blames their key. That is a release mistake the vendor must not be able
 * to make silently — and it is silent, because it looks fine until a customer
 * is standing in front of it.
 *
 * Shared by `run-verify.mjs` (warns, or fails under `QMS_RELEASE=1`) and
 * `release.mjs` (always fails). One copy, because two copies of a release gate
 * drift and the drift is only discovered by shipping.
 */
export function isSigningKeyConfigured(root) {
  const source = readFileSync(`${root}/${TRUSTED_KEYS_FILE}`, 'utf8');
  // Any uncommented entry in the array literal counts as configured.
  return /^\s*\{\s*keyId:/m.test(source);
}

export const SIGNING_KEY_MISSING_MESSAGE =
  'no signing key in trusted-keys.ts — this build cannot activate any license.\n' +
  "    Paste the licensing product's PUBLIC signing key into\n" +
  `    ${TRUSTED_KEYS_FILE}\n` +
  '    See docs/LICENSE-SERVER-CONTRACT.md.';

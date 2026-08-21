import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

import {
  VerificationFailure,
  type ILicenseTokenVerifier,
  type LicenseVerification,
} from '../../domain/licensing/license-token-verifier.port';
import { TRUSTED_SIGNING_KEYS, type TrustedSigningKey } from './trusted-keys';

const ARMOR_BEGIN = '-----BEGIN QMS LICENSE-----';
const ARMOR_END = '-----END QMS LICENSE-----';

/** Must match the generator's TOKEN_VERSION. */
const TOKEN_VERSION = 1;

/**
 * Verifies licence tokens minted by the licensing product.
 *
 * This is the deliberate TWIN of that tool's `src/token.mjs`. They are
 * duplicated rather than shared because the repo has no workspaces and a
 * cross-tree import would drag `tools/` into core-api's Docker build context —
 * the one place the signing tool must never reach. The committed
 * `golden.lic` fixture, verified by both suites, is what keeps them in step:
 * change the encoding on either side and a test fails here, rather than a
 * licence failing at a store with no network to push a fix over.
 *
 * The signature covers the ASCII bytes `headerB64 + "." + payloadB64` exactly as
 * they appear in the file. Those bytes are verified BEFORE anything is parsed,
 * and the parsed payload is never re-serialised for checking — that is what
 * removes the "signer and verifier disagree on key order or whitespace" failure
 * mode entirely.
 */
export class Ed25519LicenseTokenVerifier implements ILicenseTokenVerifier {
  private readonly trustedKeys: readonly TrustedSigningKey[];

  /** Keys are injectable so tests can exercise the real crypto path with a test key. */
  constructor(trustedKeys: readonly TrustedSigningKey[] = TRUSTED_SIGNING_KEYS) {
    this.trustedKeys = trustedKeys;
  }

  public verify(armoredToken: string): LicenseVerification {
    if (this.trustedKeys.length === 0) {
      return {
        valid: false,
        failure: VerificationFailure.NO_TRUSTED_KEYS,
        reason:
          'this build has no trusted signing key compiled in — see ' +
          'src/infrastructure/licensing/trusted-keys.ts',
      };
    }

    let compact: string;
    try {
      compact = dearmor(armoredToken);
    } catch (error) {
      return { valid: false, failure: VerificationFailure.MALFORMED, reason: (error as Error).message };
    }

    const parts = compact.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      return { valid: false, failure: VerificationFailure.MALFORMED, reason: 'malformed license token' };
    }
    const [headerB64, payloadB64, signatureB64] = parts;

    let header: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return { valid: false, failure: VerificationFailure.MALFORMED, reason: 'malformed license token header' };
    }

    if (header.alg !== 'Ed25519') {
      return {
        valid: false,
        failure: VerificationFailure.MALFORMED,
        reason: `unsupported algorithm '${String(header.alg)}'`,
      };
    }
    if (header.v !== TOKEN_VERSION) {
      return {
        valid: false,
        failure: VerificationFailure.MALFORMED,
        reason: `unsupported license token version '${String(header.v)}'`,
      };
    }

    const trusted = this.trustedKeys.find((key) => key.keyId === header.kid);
    if (trusted === undefined) {
      return {
        valid: false,
        failure: VerificationFailure.UNTRUSTED_KEY,
        reason: `unknown signing key '${String(header.kid)}'`,
      };
    }

    let signatureOk: boolean;
    try {
      signatureOk = cryptoVerify(
        null,
        Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
        createPublicKey({
          key: Buffer.from(trusted.publicKeyDerB64, 'base64'),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(signatureB64, 'base64url'),
      );
    } catch (error) {
      // A malformed public key or signature buffer throws rather than returning
      // false. Report it as "not verified" — a licence failing to verify must
      // never be able to crash the boot path.
      return {
        valid: false,
        failure: VerificationFailure.BAD_SIGNATURE,
        reason: `signature check failed: ${(error as Error).message}`,
      };
    }

    if (!signatureOk) {
      return { valid: false, failure: VerificationFailure.BAD_SIGNATURE, reason: 'signature does not verify' };
    }

    // Only now is the payload trustworthy enough to parse.
    try {
      return { valid: true, payload: JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) };
    } catch {
      return {
        valid: false,
        failure: VerificationFailure.MALFORMED,
        reason: 'malformed license token payload',
      };
    }
  }
}

/**
 * Extracts the compact token from the armored file, stripping every whitespace
 * character between the markers so a licence that was re-wrapped by a mail
 * client, pasted through a chat app, or saved with CRLF endings still verifies.
 * Text outside the markers is ignored and cannot influence the result.
 */
function dearmor(text: string): string {
  const begin = text.indexOf(ARMOR_BEGIN);
  const end = text.indexOf(ARMOR_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('not a QMS license file: BEGIN/END markers missing');
  }
  return text.slice(begin + ARMOR_BEGIN.length, end).replace(/\s+/g, '');
}

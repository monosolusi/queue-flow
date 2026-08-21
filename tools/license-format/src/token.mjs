/**
 * QMS license token — encode / sign / verify.
 *
 * Wire format (JWS-style, PEM-armored so the file is self-describing):
 *
 *   -----BEGIN QMS LICENSE-----
 *   <base64url(headerJson)>.<base64url(payloadJson)>.<base64url(signature)>
 *   -----END QMS LICENSE-----
 *
 * The signature covers the ASCII bytes of `headerB64 + "." + payloadB64` — NOT
 * the parsed objects. The verifier checks those exact bytes and only then
 * parses them. That removes the entire "signer and verifier disagree on key
 * order / whitespace / number formatting" class of bug, which is the usual way
 * a home-grown licensing scheme ends up rejecting its own valid licenses in
 * production. Nothing here may canonicalize JSON, and nothing may re-serialize
 * a parsed payload and expect the signature to still match.
 *
 * This module is the TWIN of core-api's verifier
 * (services/core-api/src/infrastructure/licensing/). They are deliberately
 * duplicated rather than shared: the repo has no workspaces, and a cross-tree
 * import from a service into tools/ would drag tools/ into that service's
 * Docker build context. The committed golden fixture is what keeps them in
 * lock-step — see test/token.test.mjs and core-api's verifier spec.
 */

import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const ARMOR_BEGIN = '-----BEGIN QMS LICENSE-----';
export const ARMOR_END = '-----END QMS LICENSE-----';

/** Bump only for a breaking wire change; the verifier rejects versions it does not know. */
export const TOKEN_VERSION = 1;

const ARMOR_WRAP_COLUMNS = 64;

export function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function b64urlToBuffer(value) {
  return Buffer.from(value, 'base64url');
}

/**
 * `kid` is derived from the key itself rather than assigned by hand, so the
 * value printed by `keygen` and the value stamped into every token can never
 * drift apart, and re-deriving it from a public key alone always works.
 */
export function keyIdFor(publicKeyDerB64) {
  return createHash('sha256').update(publicKeyDerB64).digest('hex').slice(0, 16);
}

export function generateSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyDerB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKeyPem, publicKeyDerB64, keyId: keyIdFor(publicKeyDerB64) };
}

export function publicKeyFromDerB64(publicKeyDerB64) {
  return createPublicKey({
    key: Buffer.from(publicKeyDerB64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function armor(compact) {
  const lines = [];
  for (let i = 0; i < compact.length; i += ARMOR_WRAP_COLUMNS) {
    lines.push(compact.slice(i, i + ARMOR_WRAP_COLUMNS));
  }
  return [ARMOR_BEGIN, ...lines, ARMOR_END, ''].join('\n');
}

/**
 * Pull the compact token out of an armored file. Every whitespace character
 * between the markers is stripped, so a licence that survived a round trip
 * through WhatsApp, a mail client that re-wrapped it, or a Windows editor that
 * rewrote the line endings still verifies.
 */
export function dearmor(text) {
  const begin = text.indexOf(ARMOR_BEGIN);
  const end = text.indexOf(ARMOR_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('not a QMS license file: BEGIN/END markers missing');
  }
  return text.slice(begin + ARMOR_BEGIN.length, end).replace(/\s+/g, '');
}

export function encodeToken({ payload, privateKey, keyId }) {
  const header = { alg: 'Ed25519', kid: keyId, v: TOKEN_VERSION };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
  const signature = sign(null, signingInput, privateKey);
  return armor(`${headerB64}.${payloadB64}.${b64url(signature)}`);
}

/**
 * Structural parse only — NO signature check. Split out from `verifyToken` so
 * that `inspect` can still show what a rejected file claims to be, which is the
 * first thing you need when a customer says "it does not work".
 */
export function parseToken(text) {
  const compact = dearmor(text);
  const parts = compact.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new Error('malformed license token: expected three non-empty dot-separated segments');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8'));
    payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8'));
  } catch {
    throw new Error('malformed license token: header or payload is not valid JSON');
  }
  return {
    header,
    payload,
    signature: b64urlToBuffer(signatureB64),
    signingInput: Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
  };
}

/**
 * @param {string} text armored license file contents
 * @param {Array<{keyId: string, publicKeyDerB64: string}>} trustedKeys
 * @returns {{valid: boolean, reason?: string, header?: object, payload?: object}}
 *
 * Returns a verdict rather than throwing: a bad license is an expected input
 * here, not an exceptional one. Structural problems still throw via parseToken,
 * because those mean "this is not a license file at all".
 */
export function verifyToken(text, trustedKeys) {
  const { header, payload, signature, signingInput } = parseToken(text);

  if (header.alg !== 'Ed25519') {
    return { valid: false, reason: `unsupported algorithm '${header.alg}'`, header, payload };
  }
  if (header.v !== TOKEN_VERSION) {
    return { valid: false, reason: `unsupported token version '${header.v}'`, header, payload };
  }

  const trusted = trustedKeys.find((k) => k.keyId === header.kid);
  if (trusted === undefined) {
    return { valid: false, reason: `unknown signing key '${header.kid}'`, header, payload };
  }

  const ok = verify(null, signingInput, publicKeyFromDerB64(trusted.publicKeyDerB64), signature);
  return ok
    ? { valid: true, header, payload }
    : { valid: false, reason: 'signature does not verify', header, payload };
}

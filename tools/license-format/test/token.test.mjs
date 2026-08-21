import assert from 'node:assert/strict';
import { createHash, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  encodeToken,
  generateSigningKeyPair,
  keyIdFor,
  parseToken,
  verifyToken,
} from '../src/token.mjs';
import {
  buildPayload,
  endOfDayUtc,
  normalizeClaims,
} from '../src/payload.mjs';
import { GOLDEN } from './fixtures/make-golden.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function testKey() {
  const [keyId, publicKeyDerB64] = readFileSync(join(fixtures, 'test-public-key.txt'), 'utf8')
    .trim()
    .split(/\s+/);
  const privateKey = createPrivateKey(readFileSync(join(fixtures, 'test-signing-key.pem'), 'utf8'));
  return { keyId, publicKeyDerB64, privateKey, trusted: [{ keyId, publicKeyDerB64 }] };
}

function samplePayload(overrides = {}) {
  return buildPayload({
    installationId: '11111111-2222-4333-8444-555555555555',
    claims: { boardUuid: 'a'.repeat(64), machineId: 'b'.repeat(64) },
    customerName: 'Toko Uji',
    type: 'perpetual',
    supportUntilOn: '2027-08-18',
    ...overrides,
  });
}

// --------------------------------------------------------------- sign/verify

test('a freshly issued license verifies against its own key', () => {
  const { privateKey, keyId, trusted } = testKey();
  const armored = encodeToken({ payload: samplePayload(), privateKey, keyId });
  const result = verifyToken(armored, trusted);
  assert.equal(result.valid, true);
  assert.equal(result.payload.customer.name, 'Toko Uji');
});

test('flipping a single payload byte invalidates the signature', () => {
  const { privateKey, keyId, trusted } = testKey();
  const armored = encodeToken({ payload: samplePayload(), privateKey, keyId });

  // Rewrite the entitlement cap in the decoded payload and re-armor it, i.e.
  // exactly what a customer editing their own license would attempt.
  const { header, payload } = parseToken(armored);
  const forged = { ...payload, entitlements: { ...payload.entitlements, maxCounters: 999 } };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(forged)).toString('base64url');
  const signatureB64 = parseToken(armored).signature.toString('base64url');
  const tampered = `-----BEGIN QMS LICENSE-----\n${headerB64}.${payloadB64}.${signatureB64}\n-----END QMS LICENSE-----\n`;

  const result = verifyToken(tampered, trusted);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature does not verify');
  // The contents are still reported, so support can see what was claimed.
  assert.equal(result.payload.entitlements.maxCounters, 999);
});

test('text around the armor cannot change what gets verified', () => {
  const { privateKey, keyId, trusted } = testKey();
  const armored = encodeToken({ payload: samplePayload(), privateKey, keyId });

  // A .lic that arrives with a chat signature stapled on, or a note typed above
  // it, still reads correctly — only the bytes between the markers are ever
  // parsed, so nothing outside them can influence the verdict or the payload.
  const surrounded = `Pak, ini lisensinya ya\n${armored}\n-- dikirim dari HP\n`;
  const result = verifyToken(surrounded, trusted);
  assert.equal(result.valid, true);
  assert.equal(result.payload.customer.name, 'Toko Uji');
});

test('a file with no armor at all is rejected', () => {
  assert.throws(() => verifyToken('just some text', testKey().trusted), /BEGIN\/END markers missing/);
});

test('a license re-wrapped by a mail client or CRLF editor still verifies', () => {
  const { privateKey, keyId, trusted } = testKey();
  const armored = encodeToken({ payload: samplePayload(), privateKey, keyId });
  // Re-wrap the base64 body at a different column and add CRLF + trailing
  // spaces, leaving the marker lines intact — what a mail client or a Windows
  // editor actually does to a pasted license.
  const lines = armored.trim().split('\n');
  const body = lines.slice(1, -1).join('').replace(/(.{37})/g, '$1  \r\n  ');
  const mangled = `${lines[0]}\r\n${body}\r\n${lines.at(-1)}\r\n`;

  assert.notEqual(mangled, armored);
  assert.equal(verifyToken(mangled, trusted).valid, true);
});

test('a signature from an untrusted key is rejected by key id, not by crypto', () => {
  const other = generateSigningKeyPair();
  const armored = encodeToken({
    payload: samplePayload(),
    privateKey: createPrivateKey(other.privateKeyPem),
    keyId: other.keyId,
  });
  const result = verifyToken(armored, testKey().trusted);
  assert.equal(result.valid, false);
  assert.match(result.reason, /unknown signing key/);
});

test('a valid signature from a key that is not in the trust list is rejected', () => {
  // Same kid as the trusted key, but signed by a different private key: proves
  // the verdict comes from the signature check and not from the kid lookup.
  const { keyId, trusted } = testKey();
  const other = generateSigningKeyPair();
  const armored = encodeToken({
    payload: samplePayload(),
    privateKey: createPrivateKey(other.privateKeyPem),
    keyId,
  });
  const result = verifyToken(armored, trusted);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature does not verify');
});

test('an unknown token version is rejected', () => {
  const { privateKey, keyId, trusted } = testKey();
  const armored = encodeToken({ payload: samplePayload(), privateKey, keyId });
  const bumped = armored.replace(
    /-----BEGIN QMS LICENSE-----\n([\s\S]*?)\n-----END/,
    (_m, body) => {
      const [h, p, s] = body.replace(/\s+/g, '').split('.');
      const header = JSON.parse(Buffer.from(h, 'base64url').toString());
      header.v = 99;
      const rewritten = Buffer.from(JSON.stringify(header)).toString('base64url');
      return `-----BEGIN QMS LICENSE-----\n${rewritten}.${p}.${s}\n-----END`;
    },
  );
  assert.match(verifyToken(bumped, trusted).reason, /unsupported token version/);
});

// -------------------------------------------------------------- golden fixture

test('the committed golden license still verifies byte for byte', () => {
  const { trusted } = testKey();
  const result = verifyToken(readFileSync(join(fixtures, 'golden.lic'), 'utf8'), trusted);

  assert.equal(result.valid, true, `golden.lic no longer verifies: ${result.reason}`);
  // Pin the decoded shape too. If the payload schema drifts, this fails here
  // rather than at a customer site — and core-api's verifier spec reads the
  // same file, so the two implementations cannot diverge silently.
  assert.deepEqual(result.payload, {
    licenseId: GOLDEN.licenseId,
    issuedAt: GOLDEN.issuedAt,
    customer: { name: 'Toko Contoh Sejahtera', ref: 'INV-2026-0001' },
    product: { id: 'qms', majorVersion: 1 },
    type: 'perpetual',
    installationId: GOLDEN.installationId,
    expiresAt: null,
    supportUntil: '2027-01-15T23:59:59.999Z',
    host: {
      bind: true,
      claims: {
        boardUuid: createHash('sha256').update(`boardUuid:${GOLDEN.boardUuid}`).digest('hex'),
        machineId: createHash('sha256').update(`machineId:${GOLDEN.machineId}`).digest('hex'),
      },
      weights: { boardUuid: 2, machineId: 1 },
    },
    entitlements: { maxCounters: 8, maxCategories: 10, features: [] },
    grace: { expiryDays: 14, mismatchDays: 30 },
  });
});

// ---------------------------------------------------------- payload validation

test('a perpetual license may not carry an expiry', () => {
  assert.throws(
    () => samplePayload({ expiresOn: '2027-01-01' }),
    /perpetual license must not have --expires/,
  );
});

test('a perpetual license requires a support window', () => {
  assert.throws(() => samplePayload({ supportUntilOn: null }), /requires --support-until/);
});

test('a trial license requires an expiry and rejects a support window', () => {
  assert.throws(
    () => samplePayload({ type: 'trial', supportUntilOn: null }),
    /trial license requires --expires/,
  );
  assert.throws(
    () => samplePayload({ type: 'trial', expiresOn: '2026-09-17' }),
    /trial license must not have --support-until/,
  );
});

test('a free license must cap something', () => {
  assert.throws(
    () => samplePayload({ type: 'free', supportUntilOn: null }),
    /needs at least one entitlement cap/,
  );
  assert.doesNotThrow(() =>
    samplePayload({ type: 'free', supportUntilOn: null, maxCounters: 2 }),
  );
});

test('host binding without usable claims fails at issue time, not at the store', () => {
  assert.throws(() => samplePayload({ claims: {} }), /carried no usable host claims/);
  // ...but the vendor can deliberately opt out.
  assert.doesNotThrow(() => samplePayload({ claims: {}, bindHost: false }));
});

test('weights follow the claims actually present', () => {
  const payload = samplePayload({ claims: { machineId: 'c'.repeat(64) } });
  assert.deepEqual(payload.host.weights, { machineId: 1 });
});

test('an end date resolves to the last instant of that day, never the first', () => {
  assert.equal(endOfDayUtc('2027-08-18'), '2027-08-18T23:59:59.999Z');
  assert.throws(() => endOfDayUtc('18-08-2027'), /expected a YYYY-MM-DD date/);
  assert.throws(() => endOfDayUtc('2027-02-30'), /would roll over to 2027-03-02/);
  // A non-leap-year Feb 29 is the typo most likely to be made by hand.
  assert.throws(() => endOfDayUtc('2026-02-29'), /would roll over to 2026-03-01/);
  assert.equal(endOfDayUtc('2028-02-29'), '2028-02-29T23:59:59.999Z');
});

test('claims that are not sha256 digests are dropped, never carried as placeholders', () => {
  assert.deepEqual(
    normalizeClaims({
      boardUuid: 'a'.repeat(64),
      machineId: 'Default string',
      diskSerial: '',
      weird: 42,
    }),
    { boardUuid: 'a'.repeat(64) },
  );
  assert.deepEqual(normalizeClaims(null), {});
  assert.deepEqual(normalizeClaims(['a']), {});
});

// -------------------------------------------------------- activation requests


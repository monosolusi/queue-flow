/**
 * Regenerates golden.lic. Run ONLY when the token format changes on purpose:
 *
 *   node tools/license-format/test/fixtures/make-golden.mjs
 *
 * The committed golden is the drift gate between this format definition and
 * core-api's independent verifier. Both sides check the same committed bytes,
 * so an encoding change on either one fails a test instead of failing at a
 * customer site — where there is no network to push a fix over.
 *
 * There used to be a second golden, `golden.req`, pinning the `QMSREQ1-…`
 * activation blob a customer copied off the screen. That format no longer
 * exists: activation is an online key redemption, and the device identity
 * travels inside a request no human ever handles.
 *
 * Every input below is pinned (licenseId, issuedAt, claim digests) so the
 * output is byte-stable: a regeneration that changes nothing produces no diff.
 */

import { createHash, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeToken, keyIdFor } from '../../src/token.mjs';
import { buildPayload } from '../../src/payload.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const claim = (name, value) => createHash('sha256').update(`${name}:${value}`).digest('hex');

export const GOLDEN = {
  licenseId: '7f3c1d2e-9a4b-4c5d-8e6f-0a1b2c3d4e5f',
  issuedAt: '2026-01-15T03:04:05.000Z',
  installationId: '11111111-2222-4333-8444-555555555555',
  boardUuid: '4c4c4544-0037-5a10-8054-b7c04f4d5632',
  machineId: 'd9f1a0c4b7e2436fa1c8e5d3b60947fe',
};

const payload = buildPayload({
  licenseId: GOLDEN.licenseId,
  issuedAt: GOLDEN.issuedAt,
  installationId: GOLDEN.installationId,
  claims: {
    boardUuid: claim('boardUuid', GOLDEN.boardUuid),
    machineId: claim('machineId', GOLDEN.machineId),
  },
  customerName: 'Toko Contoh Sejahtera',
  customerRef: 'INV-2026-0001',
  type: 'perpetual',
  majorVersion: 1,
  supportUntilOn: '2027-01-15',
  maxCounters: 8,
  maxCategories: 10,
});

const [, publicKeyDerB64] = readFileSync(join(here, 'test-public-key.txt'), 'utf8').trim().split(/\s+/);
const privateKey = createPrivateKey(readFileSync(join(here, 'test-signing-key.pem'), 'utf8'));

writeFileSync(
  join(here, 'golden.lic'),
  encodeToken({ payload, privateKey, keyId: keyIdFor(publicKeyDerB64) }),
  'utf8',
);

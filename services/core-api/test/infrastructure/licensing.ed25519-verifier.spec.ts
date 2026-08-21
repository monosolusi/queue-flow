import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { License } from '../../src/domain/licensing/license';
import { LicenseType } from '../../src/domain/licensing/value-objects/license-type';
import { Ed25519LicenseTokenVerifier } from '../../src/infrastructure/licensing/ed25519-license-token-verifier';
import type { TrustedSigningKey } from '../../src/infrastructure/licensing/trusted-keys';

/**
 * Read from the generator's own fixtures rather than from a copy.
 *
 * A copy could drift; a single file cannot. This suite and
 * `tools/license-format/test/token.test.mjs` verify the SAME bytes with two
 * independent implementations, which is the only thing standing between a
 * format change and a license that fails at a customer site with no network to
 * push a fix over. The fixtures are test-only and never enter any Docker build
 * context (core-api's Dockerfile copies `src/` alone).
 */
const FIXTURES = join(__dirname, '../../../../tools/license-format/test/fixtures');

function testKey(): TrustedSigningKey {
  const [keyId, publicKeyDerB64] = readFileSync(join(FIXTURES, 'test-public-key.txt'), 'utf8')
    .trim()
    .split(/\s+/);
  return { keyId, publicKeyDerB64 };
}

const golden = (): string => readFileSync(join(FIXTURES, 'golden.lic'), 'utf8');
const verifier = (): Ed25519LicenseTokenVerifier => new Ed25519LicenseTokenVerifier([testKey()]);

describe('Ed25519LicenseTokenVerifier — cross-implementation contract', () => {
  it('verifies the license the generator produced', () => {
    expect(verifier().verify(golden()).valid).toBe(true);
  });

  /**
   * The gate that matters. Verifying the signature only proves the bytes are
   * intact; it says nothing about whether the FIELDS the generator writes are
   * the fields the domain can read. This walks the verified payload all the way
   * into a `License`, so a rename, a type change, or a stricter domain
   * invariant fails here — in CI — instead of at an activation counter.
   *
   * It has already earned its place: the generator accepted any UUID-shaped
   * installationId while `Identifier.isValid` requires a v4, and nothing short
   * of parsing the payload into the domain would have surfaced that.
   */
  it('parses the generator payload into a domain License with the expected values', () => {
    const result = verifier().verify(golden());
    if (!result.valid) throw new Error(`golden.lic did not verify: ${result.reason}`);

    const license = License.fromPayload(result.payload);

    expect(license.customer.name).toBe('Toko Contoh Sejahtera');
    expect(license.customer.ref).toBe('INV-2026-0001');
    expect(license.type).toBe(LicenseType.PERPETUAL);
    expect(license.productId).toBe('qms');
    expect(license.majorVersion).toBe(1);
    expect(license.installationId.toString()).toBe('11111111-2222-4333-8444-555555555555');
    expect(license.expiresAt).toBeNull();
    expect(license.supportUntil?.toISOString()).toBe('2027-01-15T23:59:59.999Z');
    expect(license.entitlements.maxCounters).toBe(8);
    expect(license.entitlements.maxCategories).toBe(10);
    expect(license.graceExpiryDays).toBe(14);
    expect(license.graceMismatchDays).toBe(30);
    expect(license.host.bind).toBe(true);
    expect([...license.host.claimNames].sort()).toEqual(['boardUuid', 'machineId']);
  });
});

describe('Ed25519LicenseTokenVerifier — rejection', () => {
  it('rejects a payload edited to widen its entitlements', () => {
    const lines = golden().trim().split('\n');
    const [header, payload, signature] = lines.slice(1, -1).join('').split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as object),
        entitlements: { maxCounters: 999, maxCategories: 999, features: [] },
      }),
    ).toString('base64url');

    const result = verifier().verify(
      ['-----BEGIN QMS LICENSE-----', `${header}.${forged}.${signature}`, '-----END QMS LICENSE-----', ''].join('\n'),
    );

    expect(result.valid).toBe(false);
    expect(result).toHaveProperty('reason', 'signature does not verify');
  });

  it('rejects a license whose key id this build does not know', () => {
    const untrusted = new Ed25519LicenseTokenVerifier([
      { keyId: 'deadbeefdeadbeef', publicKeyDerB64: testKey().publicKeyDerB64 },
    ]);
    expect(untrusted.verify(golden()).valid).toBe(false);
  });

  it('rejects everything when no signing key is compiled in, and says why', () => {
    // The shipped default until `keygen` has been run. Failing closed is right;
    // failing closed WITHOUT an explanation would be a support nightmare.
    const result = new Ed25519LicenseTokenVerifier([]).verify(golden());
    expect(result.valid).toBe(false);
    expect(result).toHaveProperty('reason', expect.stringContaining('no trusted signing key'));
  });

  /**
   * The verifier runs on the boot path and behind an upload endpoint, so any
   * input that makes it throw is an outage or a crash-on-demand. It must always
   * return a verdict.
   */
  it.each([
    ['empty', ''],
    ['plain text', 'halo pak, ini lisensinya'],
    ['markers only', '-----BEGIN QMS LICENSE----------END QMS LICENSE-----'],
    ['one segment', '-----BEGIN QMS LICENSE-----abc-----END QMS LICENSE-----'],
    ['non-base64 body', '-----BEGIN QMS LICENSE-----!!!.???.***-----END QMS LICENSE-----'],
    ['markers reversed', '-----END QMS LICENSE-----x-----BEGIN QMS LICENSE-----'],
    ['empty segments', '-----BEGIN QMS LICENSE----- . . -----END QMS LICENSE-----'],
  ])('returns a verdict instead of throwing for %s input', (_label, input) => {
    let result: ReturnType<Ed25519LicenseTokenVerifier['verify']> | undefined;
    expect(() => {
      result = verifier().verify(input);
    }).not.toThrow();
    expect(result?.valid).toBe(false);
  });
});

describe('Ed25519LicenseTokenVerifier — transport tolerance', () => {
  it('accepts a license mangled in transit, and ignores text around the armor', () => {
    // A .lic realistically arrives pasted into a chat with a note attached and
    // its line endings rewritten. None of that is inside the signed bytes.
    const lines = golden().trim().split('\n');
    const rewrapped = lines
      .slice(1, -1)
      .join('')
      .replace(/(.{31})/g, '$1  \r\n ');
    const mangled = [
      'Pak ini lisensinya ya',
      lines[0],
      rewrapped,
      lines[lines.length - 1],
      '-- dikirim dari HP',
      '',
    ].join('\r\n');

    expect(mangled).not.toBe(golden());
    expect(verifier().verify(mangled).valid).toBe(true);
  });
});

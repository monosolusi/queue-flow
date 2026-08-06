import { describe, expect, it } from '@jest/globals';
import { PasswordHash } from '../../src/domain/identity';
import { ScryptPasswordHasher } from '../../src/infrastructure/auth/scrypt-password-hasher';

/**
 * Unit: `ScryptPasswordHasher` (QUE-43) — the `node:crypto.scrypt`-backed
 * `IPasswordHasher` impl. Verifies the hash→verify round-trip, wrong-password
 * rejection, and the encoding-shape guard on `verify`. The scrypt cost
 * (N=2^14) makes each test ~50–100ms; the suite is small to keep it fast.
 */
describe('ScryptPasswordHasher (QUE-43)', () => {
  const hasher = new ScryptPasswordHasher();

  it('produces a `scrypt:<saltHex>:<hashHex>`-encoded PasswordHash', async () => {
    const hash = await hasher.hash('secret123');
    expect(hash.value).toMatch(/^scrypt:[0-9a-f]+:[0-9a-f]+$/i);
  });

  it('verifies the correct password (round-trip)', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    await expect(hasher.verify('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hasher.hash('secret123');
    await expect(hasher.verify('wrong', hash)).resolves.toBe(false);
  });

  it('uses a fresh random salt per hash (two hashes of the same password differ)', async () => {
    const a = await hasher.hash('same-password');
    const b = await hasher.hash('same-password');
    expect(a.value).not.toBe(b.value); // different salts → different encoded hashes
    // Both still verify the same password.
    await expect(hasher.verify('same-password', a)).resolves.toBe(true);
    await expect(hasher.verify('same-password', b)).resolves.toBe(true);
  });

  it('verify returns false (not throw) for a corrupt stored hash', async () => {
    // Wrong prefix / shape — the guard in `verify` returns false, never throws.
    const corrupt = PasswordHash.of('scrypt:ab:cd'); // hash segment not KEY_LEN hex
    await expect(hasher.verify('secret123', corrupt)).resolves.toBe(false);
  });
});
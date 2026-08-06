import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { type IPasswordHasher, PasswordHash } from '../../domain/identity';

/**
 * Promisified `node:crypto.scrypt` — the callback-based API does not return a
 * Promise natively. Kept local to the hasher (no shared util) per the
 * minimal-dependency ethos.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * `IPasswordHasher` impl backed by `node:crypto.scrypt` (QUE-43). Memory-hard,
 * modern, and built into Node 20 — no native build step for `node:20-alpine`
 * and no new npm runtime dep (NFR-REL-01 + minimal-dependency ethos). The
 * encoded form is `scrypt:<saltHex>:<hashHex>`; the `scrypt:` prefix lets a
 * future hasher (argon2/bcrypt) dispatch on it without a migration.
 *
 * Cost: `N = 2^14` (16384), `r = 8`, `p = 1` — the OWASP-recommended moderate
 * preset for interactive login. Login is infrequent (a handful per day per
 * device), so the ~50–100ms hash time is comfortably within the p99<100ms API
 * budget for the *rest* of the request and irrelevant to the LAN WS round-trip
 * (NFR-PERF-01/02). `verify` re-derives with the stored salt and
 * `timingSafeEqual`s the result (constant-time — no early-exit on a mismatch).
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export class ScryptPasswordHasher implements IPasswordHasher {
  public async hash(plain: string): Promise<PasswordHash> {
    const salt = randomBytes(SALT_LEN);
    const derived = await scryptAsync(plain, salt, KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return PasswordHash.of(`scrypt:${salt.toString('hex')}:${derived.toString('hex')}`);
  }

  public async verify(plain: string, hash: PasswordHash): Promise<boolean> {
    const parts = hash.value.split(':');
    // Format: scrypt:<saltHex>:<hashHex>.
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length === 0 || expected.length !== KEY_LEN) return false;
    const derived = await scryptAsync(plain, salt, KEY_LEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    // `timingSafeEqual` throws on length mismatch; both are KEY_LEN so this is
    // safe, but guard defensively anyway (a corrupt stored hash could diverge).
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  }
}
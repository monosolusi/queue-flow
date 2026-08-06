import type { PasswordHash } from './value-objects/password-hash';

/**
 * NestJS DI token for {@link IPasswordHasher}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather than
 * by type metadata. A plain language builtin — no framework import — so domain
 * purity (NFR-MNT-01) holds.
 */
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

/**
 * Password hashing port (DIP). Keeps `node:crypto.scrypt` (an I/O-ish built-in
 * used for CPU-bound work) out of the domain/application layers — the concrete
 * `ScryptPasswordHasher` lives in infrastructure. `hash` encodes the plain
 * password into a `PasswordHash` (`scrypt:<salt>:<hash>`); `verify` re-derives
 * and constant-time-compares. Both are async (scrypt is deliberately slow).
 */
export interface IPasswordHasher {
  hash(plain: string): Promise<PasswordHash>;
  verify(plain: string, hash: PasswordHash): Promise<boolean>;
}
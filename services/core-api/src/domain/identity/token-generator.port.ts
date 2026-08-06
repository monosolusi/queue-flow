/**
 * NestJS DI token for {@link ITokenGenerator}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather than
 * by type metadata. A plain language builtin — no framework import — so domain
 * purity (NFR-MNT-01) holds.
 */
export const TOKEN_GENERATOR = Symbol('TOKEN_GENERATOR');

/**
 * Opaque session token generator (DIP). Keeps `node:crypto` (randomBytes +
 * sha256) out of the domain/application layers — the concrete
 * `CryptoTokenGenerator` lives in infrastructure. Returns the raw bearer token
 * (returned to the client **once** at login) alongside its SHA-256 hash (the
 * only form persisted in the `sessions` table). Real revocation: the stored
 * hash is deleted on logout, invalidating the token without a JWT blocklist.
 */
export interface ITokenGenerator {
  /** Mint a fresh opaque token + its persisted SHA-256 hash (login). */
  generate(): { token: string; tokenHash: string };
  /**
   * Derive the persisted hash from a raw bearer token (logout / get-session).
   * Deterministic — `hash(generate().token) === generate().tokenHash` — so the
   * guard/logout can resolve a presented token to the stored row.
   */
  hash(token: string): string;
}
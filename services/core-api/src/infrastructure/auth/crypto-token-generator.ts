import { createHash, randomBytes } from 'node:crypto';
import { type ITokenGenerator } from '../../domain/identity';

/**
 * `ITokenGenerator` impl backed by `node:crypto` (QUE-43). Mints a 32-byte
 * opaque bearer token (256 bits of entropy — collision-resistant) and returns
 * it alongside its SHA-256 hash. Only the hash is persisted in the `sessions`
 * table; the raw token is returned to the client **once** at login. `hash` is
 * deterministic, so `hash(generate().token) === generate().tokenHash` — the
 * guard/logout derive the stored hash from a presented token. No new npm dep
 * (NFR-REL-01 + minimal-dependency ethos).
 */
export class CryptoTokenGenerator implements ITokenGenerator {
  public generate(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString('hex');
    return { token, tokenHash: this.hash(token) };
  }

  public hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
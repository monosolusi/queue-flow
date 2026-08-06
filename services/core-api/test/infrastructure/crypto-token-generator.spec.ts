import { describe, expect, it } from '@jest/globals';
import { CryptoTokenGenerator } from '../../src/infrastructure/auth/crypto-token-generator';

/**
 * Unit: `CryptoTokenGenerator` (QUE-43) — the `node:crypto`-backed opaque
 * session token + SHA-256 hash generator. The raw token is 256 bits of entropy
 * (collision-resistant); `hash` is deterministic so the guard/logout can
 * resolve a presented token to the stored row.
 */
describe('CryptoTokenGenerator (QUE-43)', () => {
  it('generates a 64-char hex token (32 bytes) + its SHA-256 hash', () => {
    const gen = new CryptoTokenGenerator();
    const { token, tokenHash } = gen.generate();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(tokenHash); // the hash is not the token
  });

  it('hash(generate().token) === generate().tokenHash (deterministic)', () => {
    const gen = new CryptoTokenGenerator();
    const { token, tokenHash } = gen.generate();
    expect(gen.hash(token)).toBe(tokenHash);
  });

  it('generates unique tokens across many calls (256-bit entropy)', () => {
    const gen = new CryptoTokenGenerator();
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) tokens.add(gen.generate().token);
    expect(tokens.size).toBe(1000); // no collisions
  });

  it('hash is deterministic for the same input across instances', () => {
    const a = new CryptoTokenGenerator();
    const b = new CryptoTokenGenerator();
    expect(a.hash('fixed-token')).toBe(b.hash('fixed-token'));
  });
});
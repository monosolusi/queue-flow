import { describe, expect, it } from '@jest/globals';
import {
  PasswordHash,
  Role,
  User,
  Username,
  roleOf,
  userIdGenerate,
} from '../../src/domain/identity';
import { InvalidValueObjectException } from '../../src/domain/shared/errors';

/**
 * Unit: Identity bounded context domain value objects + the `User` entity
 * (QUE-43). Construction failures must throw `InvalidValueObjectException` (a
 * `DomainError` → 400 via `DomainExceptionFilter`), never a bare `Error` → 500
 * — the source-owns-construction-failure rule (QUE-31 precedent).
 */
describe('Identity domain — value objects + User entity (QUE-43)', () => {
  describe('Username', () => {
    it('accepts 3–32 chars of [a-zA-Z0-9_.-]', () => {
      expect(Username.of('abc').value).toBe('abc');
      expect(Username.of('A_1-2.x').value).toBe('A_1-2.x');
      expect(Username.of('a'.repeat(32)).value).toBe('a'.repeat(32));
    });

    it.each([
      ['ab', 'too short (<3)'],
      ['a'.repeat(33), 'too long (>32)'],
      ['has space', 'contains a space'],
      ['dollar$', 'contains a disallowed char'],
      ['', 'empty'],
    ])('rejects %p (%s) with InvalidValueObjectException', (bad) => {
      expect(() => Username.of(bad)).toThrow(InvalidValueObjectException);
    });

    it('reconstitute bypasses validation (trusted DB read)', () => {
      // A stored username that would fail `of()` is still reconstitutable — the
      // DB is the trusted source. This keeps a legacy/corrupt row loadable.
      expect(Username.reconstitute('x').value).toBe('x');
    });
  });

  describe('PasswordHash', () => {
    it('accepts the scrypt:<saltHex>:<hashHex> encoding', () => {
      expect(PasswordHash.of('scrypt:ab:cd').value).toBe('scrypt:ab:cd');
    });

    it.each([
      ['plain:ab:cd', 'wrong prefix'],
      ['scrypt:ab', 'missing hash segment'],
      ['scrypt:ab:cd:ef', 'too many segments'],
      ['scrypt:ZZ:cd', 'non-hex salt'],
    ])('rejects %p (%s) with InvalidValueObjectException', (bad) => {
      expect(() => PasswordHash.of(bad)).toThrow(InvalidValueObjectException);
    });

    it('reconstitute bypasses validation (trusted DB read)', () => {
      expect(PasswordHash.reconstitute('anything').value).toBe('anything');
    });
  });

  describe('Role / roleOf', () => {
    it('exposes ADMIN + CALLER_STAFF as the closed role set', () => {
      expect(Role.ADMIN).toBe('admin');
      expect(Role.CALLER_STAFF).toBe('caller-staff');
    });

    it('coerces a valid role string', () => {
      expect(roleOf('admin')).toBe(Role.ADMIN);
      expect(roleOf('caller-staff')).toBe(Role.CALLER_STAFF);
    });

    it('rejects an unknown role with InvalidValueObjectException', () => {
      expect(() => roleOf('superuser')).toThrow(InvalidValueObjectException);
    });
  });

  describe('User entity', () => {
    const fixedClock = () => 1_000_000;

    it('create mints an id + timestamps from the clock', () => {
      const user = User.create({
        username: Username.of('manager'),
        passwordHash: PasswordHash.of('scrypt:ab:cd'),
        role: Role.ADMIN,
        clock: fixedClock,
      });
      expect(user.id.value).toMatch(/^[0-9a-f-]{36}$/); // v4 UUID
      expect(user.username.value).toBe('manager');
      expect(user.role).toBe(Role.ADMIN);
      expect(user.createdAt).toBe(1_000_000);
      expect(user.updatedAt).toBe(1_000_000);
    });

    it('create accepts an explicit id (for re-seeding a known user)', () => {
      const id = userIdGenerate();
      const user = User.create({
        username: Username.of('manager'),
        passwordHash: PasswordHash.of('scrypt:ab:cd'),
        role: Role.ADMIN,
        clock: fixedClock,
        id,
      });
      expect(user.id.value).toBe(id.value);
    });

    it('reconstitute restores all fields without re-validation', () => {
      const user = User.reconstitute({
        id: userIdGenerate().value,
        username: 'legacy_name', // would fail Username.of — trusted DB read
        passwordHash: 'legacy', // would fail PasswordHash.of
        role: Role.CALLER_STAFF,
        createdAt: 100,
        updatedAt: 200,
      });
      expect(user.username.value).toBe('legacy_name');
      expect(user.passwordHash.value).toBe('legacy');
      expect(user.role).toBe(Role.CALLER_STAFF);
      expect(user.createdAt).toBe(100);
      expect(user.updatedAt).toBe(200);
    });

    it('changePassword replaces the hash and bumps updatedAt', () => {
      const user = User.create({
        username: Username.of('manager'),
        passwordHash: PasswordHash.of('scrypt:ab:cd'),
        role: Role.ADMIN,
        clock: fixedClock,
      });
      user.changePassword(PasswordHash.of('scrypt:ef:12'), () => 2_000_000);
      expect(user.passwordHash.value).toBe('scrypt:ef:12');
      expect(user.updatedAt).toBe(2_000_000);
      expect(user.createdAt).toBe(1_000_000); // unchanged
    });

    it('toSnapshot round-trips the persistence shape', () => {
      const id = userIdGenerate();
      const user = User.create({
        username: Username.of('manager'),
        passwordHash: PasswordHash.of('scrypt:ab:cd'),
        role: Role.ADMIN,
        clock: fixedClock,
        id,
      });
      expect(user.toSnapshot()).toEqual({
        id: id.value,
        username: 'manager',
        passwordHash: 'scrypt:ab:cd',
        role: Role.ADMIN,
        createdAt: 1_000_000,
        updatedAt: 1_000_000,
      });
    });
  });
});
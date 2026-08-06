import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  type IPasswordHasher,
  type ITokenGenerator,
  PasswordHash,
  Role,
  User,
  Username,
} from '../../src/domain/identity';
import {
  CreateUserUseCase,
  DeleteUserUseCase,
  GetSessionUserUseCase,
  ListUsersUseCase,
  LoginUseCase,
  LogoutUseCase,
  SetupInitialAdminUseCase,
} from '../../src/application/identity';
import {
  InMemorySessionRepository,
  InMemoryUserRepository,
} from '../../src/infrastructure/persistence/in-memory';
import {
  DuplicateUserException,
  EntityNotFoundException,
  InvalidArgumentException,
  InvalidCredentialsException,
  InvalidValueObjectException,
} from '../../src/domain/shared/errors';
import { userIdGenerate } from '../../src/domain/identity';

/**
 * Deterministic fake hasher for fast unit tests (the real `ScryptPasswordHasher`
 * — with its `timingSafeEqual` + scrypt cost — has its own spec). Encodes the
 * plain password as `scrypt:<sha256hex>:<sha256hex>` so the `PasswordHash` VO
 * shape is valid; `verify` re-derives and string-compares.
 */
class FakeHasher implements IPasswordHasher {
  private encode(plain: string): PasswordHash {
    const h = createHash('sha256').update(plain).digest('hex');
    return PasswordHash.of(`scrypt:${h}:${h}`);
  }
  public async hash(plain: string): Promise<PasswordHash> {
    return this.encode(plain);
  }
  public async verify(plain: string, hash: PasswordHash): Promise<boolean> {
    return this.encode(plain).value === hash.value;
  }
}

/** Deterministic fake token generator: `tok-<n>` → `hash-tok-<n>` (consistent). */
class FakeTokenGenerator implements ITokenGenerator {
  private counter = 0;
  public generate(): { token: string; tokenHash: string } {
    const token = `tok-${++this.counter}`;
    return { token, tokenHash: this.hash(token) };
  }
  public hash(token: string): string {
    return `hash-${token}`;
  }
}

/** Creates + persists a user with a known password via the fake hasher. */
async function seedUser(
  repo: InMemoryUserRepository,
  hasher: IPasswordHasher,
  username: string,
  password: string,
  role: Role,
  clock = () => 1_000_000,
): Promise<User> {
  const user = User.create({
    username: Username.of(username),
    passwordHash: await hasher.hash(password),
    role,
    clock,
  });
  await repo.save(user);
  return user;
}

/**
 * Unit: Identity application use cases (QUE-43). All depend only on ports + a
 * clock — wired here with the in-memory repos + fakes (DIP, NFR-MNT-01).
 */
describe('Identity application use cases (QUE-43)', () => {
  describe('LoginUseCase', () => {
    it('returns a token + user projection on valid credentials and persists a session', async () => {
      const users = new InMemoryUserRepository();
      const sessions = new InMemorySessionRepository();
      const hasher = new FakeHasher();
      const tokenGen = new FakeTokenGenerator();
      await seedUser(users, hasher, 'manager', 'secret123', Role.ADMIN);

      const login = new LoginUseCase(users, hasher, sessions, tokenGen, () => 5000, 3600_000);
      const result = await login.execute({ username: 'manager', password: 'secret123' });

      expect(result.token).toBe('tok-1');
      expect(result.user).toEqual({ id: expect.any(String), username: 'manager', role: Role.ADMIN });
      // The session row stores the hash (not the raw token) + the computed expiry.
      const session = await sessions.findActiveByTokenHash(tokenGen.hash('tok-1'), 5000);
      expect(session).not.toBeNull();
      expect(session!.userId).toBe(result.user.id);
      expect(session!.expiresAt).toBe(5000 + 3600_000);
    });

    it('throws InvalidCredentialsException for an unknown username (no enumeration)', async () => {
      const login = new LoginUseCase(
        new InMemoryUserRepository(),
        new FakeHasher(),
        new InMemorySessionRepository(),
        new FakeTokenGenerator(),
      );
      await expect(login.execute({ username: 'nobody', password: 'secret123' })).rejects.toThrow(
        InvalidCredentialsException,
      );
    });

    it('throws InvalidCredentialsException for a wrong password (same error as unknown user)', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      await seedUser(users, hasher, 'manager', 'secret123', Role.ADMIN);
      const login = new LoginUseCase(users, hasher, new InMemorySessionRepository(), new FakeTokenGenerator());

      await expect(login.execute({ username: 'manager', password: 'wrong' })).rejects.toThrow(
        InvalidCredentialsException,
      );
    });

    it('does not create a session on a failed login', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      const sessions = new InMemorySessionRepository();
      await seedUser(users, hasher, 'manager', 'secret123', Role.ADMIN);
      const login = new LoginUseCase(users, hasher, sessions, new FakeTokenGenerator());

      await expect(login.execute({ username: 'manager', password: 'wrong' })).rejects.toThrow();
      // findActiveByTokenHash on the one minted token hash would find a row only
      // if a session were created — none was, so the map is empty.
      expect(await sessions.findActiveByTokenHash('hash-tok-1', 0)).toBeNull();
    });
  });

  describe('CreateUserUseCase', () => {
    it('creates a user and persists it (no password hash leaked in the DTO)', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      const create = new CreateUserUseCase(users, hasher, () => 1000);

      const dto = await create.execute({ username: 'staff1', password: 'secret123', role: 'caller-staff' });

      expect(dto).toEqual({
        id: expect.any(String),
        username: 'staff1',
        role: Role.CALLER_STAFF,
        createdAt: 1000,
      });
      const persisted = await users.findByUsername('staff1');
      expect(persisted).not.toBeNull();
      // The password hash is persisted but never appears in the returned DTO.
      expect(JSON.stringify(dto)).not.toContain('scrypt');
      // FakeHasher encodes 'secret123' as scrypt:<sha256(secret123)>:<sha256(secret123)>.
      const expected = createHash('sha256').update('secret123').digest('hex');
      expect(persisted!.passwordHash.value).toBe(`scrypt:${expected}:${expected}`);
    });

    it('rejects a duplicate username with DuplicateUserException BEFORE hashing (no CPU burn)', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      await seedUser(users, hasher, 'manager', 'secret123', Role.ADMIN);
      // Install the spy AFTER seeding so only the duplicate-execute path is observed.
      const hashSpy = jest.spyOn(hasher, 'hash');
      const create = new CreateUserUseCase(users, hasher);

      await expect(
        create.execute({ username: 'manager', password: 'secret123', role: 'caller-staff' }),
      ).rejects.toThrow(DuplicateUserException);
      // The duplicate guard runs before `hasher.hash` — a duplicate must not burn scrypt CPU.
      expect(hashSpy).not.toHaveBeenCalled();
    });

    it('rejects a malformed username with InvalidValueObjectException', async () => {
      const create = new CreateUserUseCase(new InMemoryUserRepository(), new FakeHasher());
      await expect(
        create.execute({ username: 'x', password: 'secret123', role: 'admin' }),
      ).rejects.toThrow(InvalidValueObjectException);
    });

    it('rejects an unknown role with InvalidValueObjectException', async () => {
      const create = new CreateUserUseCase(new InMemoryUserRepository(), new FakeHasher());
      await expect(
        create.execute({ username: 'staff1', password: 'secret123', role: 'superuser' }),
      ).rejects.toThrow(InvalidValueObjectException);
    });
  });

  describe('DeleteUserUseCase', () => {
    it('deletes a user and revokes their outstanding sessions', async () => {
      const users = new InMemoryUserRepository();
      const sessions = new InMemorySessionRepository();
      const hasher = new FakeHasher();
      const tokenGen = new FakeTokenGenerator();
      // Two admins so the delete isn't blocked by the last-admin guard.
      const a1 = await seedUser(users, hasher, 'admin1', 'secret123', Role.ADMIN);
      const a2 = await seedUser(users, hasher, 'admin2', 'secret123', Role.ADMIN);
      // Log in admin1 to create a session.
      const login = new LoginUseCase(users, hasher, sessions, tokenGen);
      await login.execute({ username: 'admin1', password: 'secret123' });

      // a2 is the acting admin (caller); a1 is the target — distinct so the
      // self-delete guard does not trip.
      const del = new DeleteUserUseCase(users, sessions);
      await del.execute({ id: a1.id.value, callerUserId: a2.id.value });

      expect(await users.findById(a1.id.value)).toBeNull();
      // The session was revoked — the token no longer resolves.
      expect(await sessions.findActiveByTokenHash(tokenGen.hash('tok-1'), 0)).toBeNull();
    });

    it('rejects a self-delete (an admin cannot delete their own account)', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      const me = await seedUser(users, hasher, 'admin1', 'secret123', Role.ADMIN);
      const del = new DeleteUserUseCase(users, new InMemorySessionRepository());

      await expect(del.execute({ id: me.id.value, callerUserId: me.id.value })).rejects.toThrow(
        InvalidArgumentException,
      );
      // The self-delete was refused before any write — the account survives.
      expect(await users.findById(me.id.value)).not.toBeNull();
    });

    it('rejects deleting the last remaining admin (lockout guard) with InvalidArgumentException', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      const only = await seedUser(users, hasher, 'admin1', 'secret123', Role.ADMIN);
      const del = new DeleteUserUseCase(users, new InMemorySessionRepository());

      // Caller is a distinct (non-existent) id so only the last-admin guard trips.
      await expect(del.execute({ id: only.id.value, callerUserId: userIdGenerate().value })).rejects.toThrow(
        InvalidArgumentException,
      );
      // The admin was not deleted.
      expect(await users.findById(only.id.value)).not.toBeNull();
    });

    it('rejects an unknown user id with EntityNotFoundException', async () => {
      const del = new DeleteUserUseCase(new InMemoryUserRepository(), new InMemorySessionRepository());
      await expect(
        del.execute({ id: userIdGenerate().value, callerUserId: userIdGenerate().value }),
      ).rejects.toThrow(EntityNotFoundException);
    });

    it('allows deleting a caller-staff even when only one admin remains', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      const admin = await seedUser(users, hasher, 'admin1', 'secret123', Role.ADMIN);
      const staff = await seedUser(users, hasher, 'staff1', 'secret123', Role.CALLER_STAFF);
      const del = new DeleteUserUseCase(users, new InMemorySessionRepository());

      await expect(del.execute({ id: staff.id.value, callerUserId: admin.id.value })).resolves.toBeUndefined();
      expect(await users.findById(staff.id.value)).toBeNull();
    });
  });

  describe('SetupInitialAdminUseCase', () => {
    it('creates the initial admin user', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      const setup = new SetupInitialAdminUseCase(users, hasher, () => 1000);

      const dto = await setup.execute({ username: 'admin', password: 'secret123' });

      expect(dto.role).toBe(Role.ADMIN);
      expect(dto.username).toBe('admin');
      expect(await users.countByRole(Role.ADMIN)).toBe(1);
    });

    it('idempotently replaces the password on re-run (lockout-free partial-setup recovery)', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      const setup = new SetupInitialAdminUseCase(users, hasher, () => 1000);

      await setup.execute({ username: 'admin', password: 'first' });
      // A partial first run succeeded here but the config save failed; re-run
      // with a new password. The existing admin is kept, its password replaced.
      const dto = await setup.execute({ username: 'admin', password: 'second' });

      expect(dto.id).toBe((await users.findByUsername('admin'))!.id.value);
      expect(await users.countByRole(Role.ADMIN)).toBe(1); // no duplicate admin
      const persisted = await users.findByUsername('admin');
      const expected = createHash('sha256').update('second').digest('hex');
      expect(persisted!.passwordHash.value).toBe(`scrypt:${expected}:${expected}`);
    });
  });

  describe('LogoutUseCase', () => {
    it('deletes the session bound to the token (real revocation)', async () => {
      const users = new InMemoryUserRepository();
      const sessions = new InMemorySessionRepository();
      const hasher = new FakeHasher();
      const tokenGen = new FakeTokenGenerator();
      await seedUser(users, hasher, 'manager', 'secret123', Role.ADMIN);
      const login = new LoginUseCase(users, hasher, sessions, tokenGen);
      const { token } = await login.execute({ username: 'manager', password: 'secret123' });

      await new LogoutUseCase(sessions, tokenGen).execute({ token });

      expect(await sessions.findActiveByTokenHash(tokenGen.hash(token), 0)).toBeNull();
    });

    it('is idempotent — a second logout (or logout after expiry) is a no-op', async () => {
      const sessions = new InMemorySessionRepository();
      const tokenGen = new FakeTokenGenerator();
      const logout = new LogoutUseCase(sessions, tokenGen);

      await expect(logout.execute({ token: 'never-issued' })).resolves.toBeUndefined();
      await expect(logout.execute({ token: 'never-issued' })).resolves.toBeUndefined();
    });
  });

  describe('GetSessionUserUseCase', () => {
    async function setupLogin() {
      const users = new InMemoryUserRepository();
      const sessions = new InMemorySessionRepository();
      const hasher = new FakeHasher();
      const tokenGen = new FakeTokenGenerator();
      await seedUser(users, hasher, 'manager', 'secret123', Role.ADMIN);
      const login = new LoginUseCase(users, hasher, sessions, tokenGen, () => 1000, 3600_000);
      const { token } = await login.execute({ username: 'manager', password: 'secret123' });
      return { users, sessions, tokenGen, token };
    }

    it('resolves the principal for a valid, non-expired token', async () => {
      const { users, sessions, tokenGen, token } = await setupLogin();
      const getSession = new GetSessionUserUseCase(users, sessions, tokenGen, () => 2000);
      const principal = await getSession.execute({ token });
      expect(principal).toEqual({ userId: expect.any(String), username: 'manager', role: Role.ADMIN });
    });

    it('returns null for an expired token', async () => {
      const { users, sessions, tokenGen, token } = await setupLogin();
      // Session expiry was 1000 + 3600_000; advance past it.
      const getSession = new GetSessionUserUseCase(users, sessions, tokenGen, () => 1000 + 3600_000 + 1);
      expect(await getSession.execute({ token })).toBeNull();
    });

    it('returns null for an unknown token', async () => {
      const { users, sessions, tokenGen } = await setupLogin();
      const getSession = new GetSessionUserUseCase(users, sessions, tokenGen, () => 2000);
      expect(await getSession.execute({ token: 'tok-999' })).toBeNull();
    });

    it('returns null when the user was deleted after the session was issued', async () => {
      const { users, sessions, tokenGen, token } = await setupLogin();
      // Delete the user directly (bypass the use case so the session isn't cleaned up).
      const user = await users.findByUsername('manager');
      await users.deleteById(user!.id.value);
      const getSession = new GetSessionUserUseCase(users, sessions, tokenGen, () => 2000);
      expect(await getSession.execute({ token })).toBeNull();
    });
  });

  describe('ListUsersUseCase', () => {
    it('returns the summary projection (no password hashes) sorted by createdAt', async () => {
      const users = new InMemoryUserRepository();
      const hasher = new FakeHasher();
      await seedUser(users, hasher, 'admin1', 'secret123', Role.ADMIN, () => 1000);
      await seedUser(users, hasher, 'staff1', 'secret123', Role.CALLER_STAFF, () => 2000);
      const list = new ListUsersUseCase(users);

      const summaries = await list.execute();
      expect(summaries).toEqual([
        { id: expect.any(String), username: 'admin1', role: Role.ADMIN, createdAt: 1000 },
        { id: expect.any(String), username: 'staff1', role: Role.CALLER_STAFF, createdAt: 2000 },
      ]);
      // No password hash in the projection.
      expect(JSON.stringify(summaries)).not.toContain('scrypt');
    });
  });
});
import {
  type IPasswordHasher,
  type ISessionRepository,
  type ITokenGenerator,
  type IUserRepository,
  PasswordHash,
  Role,
} from '../../domain/identity';
import { InvalidCredentialsException } from '../../domain/shared/errors';
import { Identifier } from '../../domain/shared/identifier';

/** Command for the login operation (QUE-43). */
export interface LoginCommand {
  readonly username: string;
  readonly password: string;
}

/** The authenticated user projection returned to the client. */
export interface AuthUserDto {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
}

/**
 * Outcome of a successful login: the opaque bearer token (returned **once** —
 * the client stores it and sends it as `Authorization: Bearer <token>`) plus
 * the user projection. Never returns the password hash.
 */
export interface LoginResultDto {
  readonly token: string;
  readonly user: AuthUserDto;
}

/**
 * Default session lifetime: 12 hours. A single on-premise store workday fits
 * comfortably; the manager re-logs in the next day. Overrideable via the use
 * case constructor for tests. Lives in the application layer (a use-case-level
 * policy, not a domain VO) — mirrors the `MIN_RETENTION_DAYS` precedent.
 */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A shape-valid dummy hash fed to `hasher.verify` on the unknown-username
 * branch so that branch spends the same ~50–100ms scrypt cost as the
 * wrong-password branch. Without it, an attacker can distinguish "user does
 * not exist" (instant `InvalidCredentialsException`) from "user exists, wrong
 * password" (slow scrypt) by response timing — a username-enumeration side
 * channel. The hash is a 16-byte all-zero salt + 64-byte all-zero expected
 * digest so `ScryptPasswordHasher.verify` runs the full scrypt derivation (it
 * short-circuits `false` only on a malformed/too-short expected digest) and
 * returns `false`; the result is discarded. Declared before the class per the
 * TDZ rule (CLAUDE.md) — `PasswordHash.of` runs at module init.
 */
const DUMMY_VERIFY_HASH = PasswordHash.of(`scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`);

/**
 * Authenticates a user and starts an opaque session (QUE-43).
 *
 * 1. Looks up the user by username. An unknown username and a wrong password
 *    both throw {@link InvalidCredentialsException} with the same message (no
 *    username-enumeration leak) **and** the same response timing — the
 *    unknown-username branch runs a dummy `hasher.verify` against a shape-valid
 *    hash so it spends the same scrypt cost as a real wrong-password verify
 *    (no timing side channel either).
 * 2. Verifies the password via {@link IPasswordHasher.verify} (constant-time).
 * 3. Mints an opaque token + its SHA-256 hash and persists a session row
 *    (`tokenHash` + `expiresAt`). The raw token is returned once; only the hash
 *    is stored, so a DB leak cannot authenticate a session.
 *
 * Depends only on ports (DIP) + a clock — no framework/ORM/IO (NFR-MNT-01).
 */
export class LoginUseCase {
  constructor(
    private readonly userRepo: IUserRepository,
    private readonly hasher: IPasswordHasher,
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenGen: ITokenGenerator,
    private readonly clock: () => number = () => Date.now(),
    private readonly sessionTtlMs: number = DEFAULT_SESSION_TTL_MS,
  ) {}

  public async execute(command: LoginCommand): Promise<LoginResultDto> {
    const user = await this.userRepo.findByUsername(command.username);
    if (!user) {
      // Run a dummy verify against a shape-valid hash so this branch takes the
      // same scrypt time as the wrong-password branch below — closes the
      // username-enumeration timing side channel. The result is discarded.
      await this.hasher.verify(command.password, DUMMY_VERIFY_HASH);
      throw new InvalidCredentialsException();
    }
    const ok = await this.hasher.verify(command.password, user.passwordHash);
    if (!ok) {
      throw new InvalidCredentialsException();
    }

    const { token, tokenHash } = this.tokenGen.generate();
    const expiresAt = this.clock() + this.sessionTtlMs;
    await this.sessionRepo.create({
      id: Identifier.generate().value,
      userId: user.id.value,
      tokenHash,
      expiresAt,
    });

    return {
      token,
      user: { id: user.id.value, username: user.username.value, role: user.role },
    };
  }
}
import {
  type IPasswordHasher,
  type IUserRepository,
  Role,
  User,
  Username,
  roleOf,
} from '../../domain/identity';
import { DuplicateUserException } from '../../domain/shared/errors';

/** Command for an admin creating a new user (QUE-43). */
export interface CreateUserCommand {
  readonly username: string;
  readonly password: string;
  readonly role: string;
}

/** Projection of a created user (no password hash — never leaked). */
export interface UserDto {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly createdAt: number;
}

/**
 * Creates a new user (admin-only, QUE-43). Validates the username + role (VO
 * construction throws `InvalidValueObjectException` → 400 on a bad shape),
 * rejects a taken username with {@link DuplicateUserException} (→ 409) **before**
 * hashing (so a duplicate burns no CPU on scrypt), hashes the password, and
 * persists. Depends only on ports (DIP) + a clock.
 */
export class CreateUserUseCase {
  constructor(
    private readonly userRepo: IUserRepository,
    private readonly hasher: IPasswordHasher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: CreateUserCommand): Promise<UserDto> {
    const username = Username.of(command.username);
    const role = roleOf(command.role);

    const existing = await this.userRepo.findByUsername(username.value);
    if (existing) {
      throw new DuplicateUserException(username.value);
    }

    const passwordHash = await this.hasher.hash(command.password);
    const user = User.create({ username, passwordHash, role, clock: this.clock });
    await this.userRepo.save(user);
    return {
      id: user.id.value,
      username: user.username.value,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
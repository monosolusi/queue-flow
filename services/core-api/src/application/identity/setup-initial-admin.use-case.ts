import {
  type IPasswordHasher,
  type IUserRepository,
  Role,
  User,
  Username,
} from '../../domain/identity';
import type { UserDto } from './create-user.use-case';

/** Command for the first-run wizard seeding the initial admin (QUE-43). */
export interface SetupInitialAdminCommand {
  readonly username: string;
  readonly password: string;
}

/**
 * Idempotently upserts the initial `admin` user during first-run setup
 * (QUE-43). Called by the wizard **before** `SaveSystemConfigurationUseCase`
 * (while `isInitialSetupCompleted` is still false). The controller gates this
 * endpoint on setup-status (403 once setup is complete) — anti-corruption: this
 * use case imports no Store-Config type, mirroring `SystemAdminController`
 * reading `DailyResetPolicy` at the controller boundary.
 *
 * **Idempotence (lockout-free):** if a username already exists (a prior
 * partial setup run that succeeded here but failed on the config save), its
 * password is replaced and the user is kept — so the wizard can re-run after a
 * partial failure without orphans. A different username on re-run creates a
 * second admin (acceptable — the manager can delete it later; the last-admin
 * guard prevents lockout). Depends only on ports (DIP) + a clock.
 */
export class SetupInitialAdminUseCase {
  constructor(
    private readonly userRepo: IUserRepository,
    private readonly hasher: IPasswordHasher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: SetupInitialAdminCommand): Promise<UserDto> {
    const username = Username.of(command.username);
    const passwordHash = await this.hasher.hash(command.password);

    const existing = await this.userRepo.findByUsername(username.value);
    if (existing) {
      existing.changePassword(passwordHash, this.clock);
      await this.userRepo.save(existing);
      return {
        id: existing.id.value,
        username: existing.username.value,
        role: existing.role,
        createdAt: existing.createdAt,
      };
    }

    const user = User.create({
      username,
      passwordHash,
      role: Role.ADMIN,
      clock: this.clock,
    });
    await this.userRepo.save(user);
    return {
      id: user.id.value,
      username: user.username.value,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
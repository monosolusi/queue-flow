import {
  type AuthenticatedPrincipal,
  type ISessionRepository,
  type ITokenGenerator,
  type IUserRepository,
} from '../../domain/identity';

/** Command: the raw bearer token from the `Authorization` header. */
export interface GetSessionUserCommand {
  readonly token: string;
}

/**
 * Resolves the {@link AuthenticatedPrincipal} for a presented bearer token
 * (QUE-43). Called by `AuthGuard` on every protected request: hash the token,
 * look up an active (non-expired) session, load the user, and return the
 * principal the guard attaches to `req.user`. Returns `null` when the token is
 * missing, expired, or bound to a deleted user — the guard maps that to 401.
 *
 * Depends only on ports (DIP) + a clock — no framework/ORM/IO (NFR-MNT-01).
 */
export class GetSessionUserUseCase {
  constructor(
    private readonly userRepo: IUserRepository,
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenGen: ITokenGenerator,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: GetSessionUserCommand): Promise<AuthenticatedPrincipal | null> {
    const tokenHash = this.tokenGen.hash(command.token);
    const session = await this.sessionRepo.findActiveByTokenHash(tokenHash, this.clock());
    if (!session) {
      return null;
    }
    const user = await this.userRepo.findById(session.userId);
    if (!user) {
      // The user was deleted after the session was issued (cascade should have
      // removed the session, but defend against a stale row). Treat as invalid.
      return null;
    }
    return {
      userId: user.id.value,
      username: user.username.value,
      role: user.role,
    };
  }
}
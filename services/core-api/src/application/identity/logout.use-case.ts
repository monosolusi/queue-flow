import { type ISessionRepository, type ITokenGenerator } from '../../domain/identity';

/** Command for the logout operation (QUE-43) — the raw bearer token. */
export interface LogoutCommand {
  readonly token: string;
}

/**
 * Ends the session bound to the presented token (QUE-43). Hashes the token and
 * deletes the session row — real revocation (the token is immediately invalid
 * for subsequent requests). Idempotent: a missing/already-deleted session is a
 * no-op (the controller maps this to 204, not 404), so a double-logout or a
 * logout after expiry is safe. Depends only on ports (DIP).
 */
export class LogoutUseCase {
  constructor(
    private readonly sessionRepo: ISessionRepository,
    private readonly tokenGen: ITokenGenerator,
  ) {}

  public async execute(command: LogoutCommand): Promise<void> {
    const tokenHash = this.tokenGen.hash(command.token);
    await this.sessionRepo.deleteByTokenHash(tokenHash);
  }
}
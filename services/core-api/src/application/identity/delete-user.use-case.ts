import {
  type ISessionRepository,
  type IUserRepository,
  Role,
} from '../../domain/identity';
import { NoOpTransactionManager, type ITransactionManager } from '../../domain/shared';
import { EntityNotFoundException, InvalidArgumentException } from '../../domain/shared/errors';

/** Command for an admin deleting a user (QUE-43). */
export interface DeleteUserCommand {
  readonly id: string;
  /** The authenticated admin's user id — used for the self-delete guard. */
  readonly callerUserId: string;
}

/**
 * Deletes a user (admin-only, QUE-43). Guards against three lockout/footgun
 * scenarios before any write:
 *
 * 1. **Self-delete** — an admin cannot delete their own account
 *    (`InvalidArgumentException` → 400). Without this, the deleting admin's
 *    own session is revoked mid-request (the `deleteByUserId` cascade) and the
 *    store could lose its only signed-in admin. Checked first, before any read,
 *    so an illegal self-delete burns no rows (NFR-REL-02 pattern).
 * 2. **Last admin** — rejecting the delete of the only remaining `admin`
 *    prevents the store from being permanently locked out of the admin surface
 *    (`InvalidArgumentException` → 400). `countByRole(ADMIN)` is checked before
 *    the delete so an illegal delete burns no rows.
 * 3. **Unknown user** — `EntityNotFoundException` → 404.
 *
 * The last-admin count check + the user delete + the session revoke run inside
 * one `txManager.runInTransaction(...)` callback. This closes a TOCTOU race:
 * without the envelope, a second admin could be deleted between the
 * `countByRole` check and the `deleteById`, deleting the last admin. Under the
 * Postgres profile the count + deletes share one transaction (serializable
 * w.r.t. concurrent deletes); under the in-memory profile the no-op manager is
 * a pass-through (dev-only — gap-free durability is the Postgres repo's job).
 *
 * After the delete, the user's sessions are revoked (`deleteByUserId`) so a
 * deleted user's outstanding token stops working immediately. Depends only on
 * ports (DIP) — the transaction manager is a domain port with a no-op default.
 */
export class DeleteUserUseCase {
  constructor(
    private readonly userRepo: IUserRepository,
    private readonly sessionRepo: ISessionRepository,
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
  ) {}

  public async execute(command: DeleteUserCommand): Promise<void> {
    if (command.id === command.callerUserId) {
      throw new InvalidArgumentException('cannot delete your own account');
    }
    const user = await this.userRepo.findById(command.id);
    if (!user) {
      throw new EntityNotFoundException('User', command.id);
    }
    await this.txManager.runInTransaction(async () => {
      if (user.role === Role.ADMIN) {
        const adminCount = await this.userRepo.countByRole(Role.ADMIN);
        if (adminCount <= 1) {
          throw new InvalidArgumentException(
            'cannot delete the last remaining admin user — create another admin first',
          );
        }
      }
      await this.userRepo.deleteById(command.id);
      await this.sessionRepo.deleteByUserId(command.id);
    });
  }
}
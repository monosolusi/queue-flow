import { type IUserRepository, type UserSummary } from '../../domain/identity';

/**
 * Lists all users for the admin user-management surface (QUE-43). Returns the
 * {@link UserSummary} projection (id, username, role, createdAt) — no password
 * hashes. Depends only on the {@link IUserRepository} port (DIP).
 */
export class ListUsersUseCase {
  constructor(private readonly userRepo: IUserRepository) {}

  public async execute(): Promise<UserSummary[]> {
    return this.userRepo.list();
  }
}
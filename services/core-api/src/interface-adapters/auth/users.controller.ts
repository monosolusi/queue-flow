import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreateUserUseCase,
  DeleteUserUseCase,
  ListUsersUseCase,
  type UserDto,
} from '../../application/identity';
import { type AuthenticatedPrincipal, Role, type UserSummary } from '../../domain/identity';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';

/** `POST /api/users` body — an admin creating a new user. */
interface CreateUserRequestDto {
  readonly username?: string;
  readonly password?: string;
  readonly role?: string;
}

/** Minimum password length enforced at the transport boundary. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * User-management REST surface (QUE-43), admin-only. CRUD over the Identity
 * `User` entity for the admin panel's user-management page. Class-level
 * `@UseGuards(AuthGuard, RolesGuard)` + `@Roles(Role.ADMIN)` means every route
 * here requires an authenticated `admin` session — a `caller-staff` token gets
 * 403, a missing/invalid token gets 401. Domain errors map to HTTP via the
 * global {@link DomainExceptionFilter}: `DuplicateUserException` → 409 (taken
 * username), `InvalidValueObjectException` → 400 (bad username/role shape),
 * `EntityNotFoundException` → 404 (delete unknown id), and the last-admin guard
 * throws `InvalidArgumentException` → 400.
 */
@Controller('api/users')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class UsersController {
  constructor(
    private readonly listUsersUseCase: ListUsersUseCase,
    private readonly createUserUseCase: CreateUserUseCase,
    private readonly deleteUserUseCase: DeleteUserUseCase,
  ) {}

  /** `GET /api/users` → all users (no password hashes). */
  @Get()
  async list(): Promise<readonly UserSummary[]> {
    return this.listUsersUseCase.execute();
  }

  /**
   * `POST /api/users` → create a user. The username format + role enum are
   * validated by the domain value objects (→ 400); a taken username is rejected
   * by the use case **before** hashing (→ 409). The password is shape-checked
   * here (non-empty, min length) — there is no `Password` value object (only the
   * stored `PasswordHash`), so the boundary owns the input-length guard.
   */
  @Post()
  async create(@Body() body: CreateUserRequestDto): Promise<UserDto> {
    const username = body?.username?.trim();
    const password = body?.password;
    const role = body?.role?.trim();
    if (!username) {
      throw new BadRequestException("body field 'username' must be a non-empty string");
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `body field 'password' must be a string of at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (!role) {
      throw new BadRequestException("body field 'role' must be a non-empty string");
    }
    return this.createUserUseCase.execute({ username, password, role });
  }

  /**
   * `DELETE /api/users/:id` → delete a user (self-delete + last-admin guards in
   * the use case). The authenticated admin's user id is threaded from the
   * principal (`@CurrentUser`) as `callerUserId` so the use case can reject a
   * self-delete — the client mirrors this by disabling the current admin's own
   * row, but the backend is the authority (a direct API call cannot bypass it).
   */
  @Delete(':id')
  @HttpCode(204)
  async delete(@Param('id') id: string, @CurrentUser() principal: AuthenticatedPrincipal): Promise<void> {
    const userId = id?.trim();
    if (!userId) {
      throw new BadRequestException("'id' path param must be a non-empty string");
    }
    await this.deleteUserUseCase.execute({ id: userId, callerUserId: principal.userId });
  }
}
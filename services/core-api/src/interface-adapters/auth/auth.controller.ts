import { DrainCritical } from '../licensing/drain-critical.decorator';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  LoginUseCase,
  LogoutUseCase,
  SetupInitialAdminUseCase,
  type AuthUserDto,
  type LoginResultDto,
} from '../../application/identity';
import { GetSetupStatusUseCase } from '../../application/store-config';
import type { AuthenticatedPrincipal } from '../../domain/identity';
import { AuthGuard, extractBearerToken } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import { Public } from './public.decorator';

/** `POST /api/auth/login` body. */
interface LoginRequestDto {
  readonly username?: string;
  readonly password?: string;
}

/** `POST /api/auth/setup-admin` body (first-run wizard). */
interface SetupAdminRequestDto {
  readonly username?: string;
  readonly password?: string;
}

/** The `/api/auth/me` projection — the principal reshaped to `id` (not `userId`). */
interface MeDto {
  readonly id: string;
  readonly username: string;
  readonly role: AuthUserDto['role'];
}

/** Minimum password length enforced at the transport boundary for user creation. */
const MIN_PASSWORD_LENGTH = 8;

/** Minimal structural shape of an Express request — avoids a `@types/express` dep. */
interface HttpRequest {
  headers?: { authorization?: string };
}

/**
 * Auth REST surface (QUE-43). Owns the login / logout / me + first-run
 * setup-admin endpoints. The class is guarded by {@link AuthGuard} so every
 * route requires a valid bearer session **except** the two `@Public()` routes:
 * `POST /login` (the credential exchange itself — no session yet) and
 * `POST /setup-admin` (the first-run wizard seeding the initial admin before
 * any user exists). Domain auth errors map to HTTP via the global
 * {@link DomainExceptionFilter}: `InvalidCredentialsException` → 401,
 * `DuplicateUserException` → 409, `InvalidValueObjectException` → 400.
 */
@Controller('api/auth')
@UseGuards(AuthGuard)
export class AuthController {
  constructor(
    private readonly loginUseCase: LoginUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly getSetupStatus: GetSetupStatusUseCase,
    private readonly setupInitialAdminUseCase: SetupInitialAdminUseCase,
  ) {}

  /**
   * `POST /api/auth/login` → exchange credentials for an opaque bearer token.
   * A missing/blank username or password is coerced to `''` so it fails the
   * credential check uniformly (401, not a 400 shape error) — the use case
   * throws `InvalidCredentialsException` for both an unknown user and a wrong
   * password with the same message (no enumeration).
   */
  @Post('login')
  @DrainCritical()
  @Public()
  @HttpCode(200)
  async login(@Body() body: LoginRequestDto): Promise<LoginResultDto> {
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    return this.loginUseCase.execute({ username, password });
  }

  /**
   * `POST /api/auth/logout` → revoke the presented session (real invalidation:
   * the token's row is deleted, so it stops working immediately). Idempotent —
   * 204 whether or not the session still existed. The bearer token is read from
   * the `Authorization` header (already validated by {@link AuthGuard}).
   */
  @Post('logout')
  @DrainCritical()
  @HttpCode(204)
  async logout(@Req() request: HttpRequest): Promise<void> {
    const token = extractBearerToken(request.headers?.authorization);
    if (token) {
      await this.logoutUseCase.execute({ token });
    }
  }

  /**
   * `GET /api/auth/me` → the authenticated principal (`AuthGuard` attached it).
   * Reshaped to `{ id, username, role }` so the frontend user menu reads `id`
   * + `username` without touching the principal's internal `userId` field.
   */
  @Get('me')
  me(@CurrentUser() principal: AuthenticatedPrincipal): MeDto {
    return { id: principal.userId, username: principal.username, role: principal.role };
  }

  /**
   * `POST /api/auth/setup-admin` → the first-run wizard seeds the initial admin
   * user. **Self-gating**: 403 once `isInitialSetupCompleted` is true (the
   * controller reads setup status via {@link GetSetupStatusUseCase} —
   * anti-corruption: no Store-Config domain type crosses into the Identity
   * flow). Before setup is complete the endpoint is open (no session exists
   * yet); the wizard calls it **before** `PUT /api/system/config` so the admin
   * exists by the time setup flips to complete. Idempotent: a partial prior run
   * (admin created, config save failed) re-runs cleanly — the use case upserts
   * by username. A blank or too-short password is rejected at the boundary
   * (400); the username format is validated by the `Username` VO (→ 400).
   */
  @Post('setup-admin')
  @Public()
  @HttpCode(200)
  async setupAdmin(@Body() body: SetupAdminRequestDto) {
    const { isInitialSetupCompleted } = await this.getSetupStatus.execute();
    if (isInitialSetupCompleted) {
      throw new ForbiddenException('Initial setup is already complete');
    }
    const username = body?.username?.trim();
    const password = body?.password;
    if (!username) {
      throw new BadRequestException("body field 'username' must be a non-empty string");
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `body field 'password' must be a string of at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    return this.setupInitialAdminUseCase.execute({ username, password });
  }
}
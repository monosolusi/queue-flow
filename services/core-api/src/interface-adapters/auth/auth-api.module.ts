import { Global, Module } from '@nestjs/common';
import { SYSTEM_CONFIGURATION_REPOSITORY } from '../../domain/store-config';
import { GetSetupStatusUseCase } from '../../application/store-config';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { IdentityOperationsModule } from '../identity-operations.module';
import { AuthController } from './auth.controller';
import { UsersController } from './users.controller';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { AdminOrSetupGuard } from './admin-or-setup.guard';

/**
 * Wires the Identity auth REST surface + the cross-cutting auth guards
 * (QUE-43). Declared `@Global()` so the guards are resolvable by
 * `@UseGuards(AuthGuard, …)` on controllers in **any** feature module (queue
 * commands, system-admin, reporting, …) without each module importing this
 * one. Mirrors how the global `DomainExceptionFilter` is app-wide: auth is a
 * cross-cutting concern, not a per-feature import.
 *
 * - {@link IdentityOperationsModule} (also `@Global()`) supplies the
 *   framework-free Identity use cases (login/logout/get-session/create/list/
 *   delete/setup-admin) — global so the guards can inject
 *   `GetSessionUserUseCase` from any controller's module scope.
 * - {@link PersistenceModule} supplies {@link SYSTEM_CONFIGURATION_REPOSITORY}
 *   so this module can wire {@link GetSetupStatusUseCase} (read by
 *   {@link AdminOrSetupGuard} and the `POST /api/auth/setup-admin` self-gate).
 * - The three guards are plain `@Injectable()` classes whose constructor deps
 *   resolve by type token: `GetSessionUserUseCase` + `GetSetupStatusUseCase`
 *   (both globally available) + the core `Reflector` (Nest-provided).
 */
@Global()
@Module({
  imports: [IdentityOperationsModule, PersistenceModule.forRoot()],
  controllers: [AuthController, UsersController],
  providers: [
    AuthGuard,
    RolesGuard,
    AdminOrSetupGuard,
    {
      provide: GetSetupStatusUseCase,
      inject: [SYSTEM_CONFIGURATION_REPOSITORY],
      useFactory: (config) => new GetSetupStatusUseCase(config),
    },
  ],
  exports: [AuthGuard, RolesGuard, AdminOrSetupGuard, GetSetupStatusUseCase],
})
export class AuthApiModule {}
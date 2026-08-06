import { Global, Module } from '@nestjs/common';
import {
  PASSWORD_HASHER,
  SESSION_REPOSITORY,
  TOKEN_GENERATOR,
  USER_REPOSITORY,
} from '../domain/identity';
import { TRANSACTION_MANAGER } from '../domain/shared';
import {
  CreateUserUseCase,
  DeleteUserUseCase,
  GetSessionUserUseCase,
  ListUsersUseCase,
  LoginUseCase,
  LogoutUseCase,
  SetupInitialAdminUseCase,
} from '../application/identity';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';

/**
 * Wires the framework-free Identity use cases (QUE-43). Mirrors
 * {@link QueueOperationsModule}: the use cases are pure classes (no
 * `@Injectable`/`@Inject` — they stay decoupled from Nest, consistent with the
 * application layer), so each is provided via a factory receiving its domain
 * ports — the repository / hasher / token-generator tokens from
 * {@link PersistenceModule}. Each `clock` parameter keeps its `() => Date.now`
 * default (factories omit it) so production reads real time while unit specs
 * construct the use cases directly with a deterministic clock.
 *
 * Centralizing the factories here keeps the wiring DRY: {@link AuthApiModule}
 * (the controllers) consumes these use-case tokens without re-declaring
 * factories. Declared `@Global()` so the {@link AuthGuard} /
 * {@link AdminOrSetupGuard} (provided in the `@Global()` {@link AuthApiModule})
 * can inject {@link GetSessionUserUseCase} from any controller's module scope
 * without each feature module importing this one — auth is a cross-cutting
 * concern, not a per-feature import (mirrors how the global
 * `DomainExceptionFilter` is app-wide).
 */
@Global()
@Module({
  imports: [PersistenceModule.forRoot()],
  providers: [
    {
      provide: LoginUseCase,
      inject: [USER_REPOSITORY, PASSWORD_HASHER, SESSION_REPOSITORY, TOKEN_GENERATOR],
      useFactory: (userRepo, hasher, sessionRepo, tokenGen) =>
        new LoginUseCase(userRepo, hasher, sessionRepo, tokenGen),
    },
    {
      provide: LogoutUseCase,
      inject: [SESSION_REPOSITORY, TOKEN_GENERATOR],
      useFactory: (sessionRepo, tokenGen) => new LogoutUseCase(sessionRepo, tokenGen),
    },
    {
      provide: GetSessionUserUseCase,
      inject: [USER_REPOSITORY, SESSION_REPOSITORY, TOKEN_GENERATOR],
      useFactory: (userRepo, sessionRepo, tokenGen) =>
        new GetSessionUserUseCase(userRepo, sessionRepo, tokenGen),
    },
    {
      provide: CreateUserUseCase,
      inject: [USER_REPOSITORY, PASSWORD_HASHER],
      useFactory: (userRepo, hasher) => new CreateUserUseCase(userRepo, hasher),
    },
    {
      provide: ListUsersUseCase,
      inject: [USER_REPOSITORY],
      useFactory: (userRepo) => new ListUsersUseCase(userRepo),
    },
    {
      provide: DeleteUserUseCase,
      inject: [USER_REPOSITORY, SESSION_REPOSITORY, TRANSACTION_MANAGER],
      useFactory: (userRepo, sessionRepo, txManager) =>
        new DeleteUserUseCase(userRepo, sessionRepo, txManager),
    },
    {
      provide: SetupInitialAdminUseCase,
      inject: [USER_REPOSITORY, PASSWORD_HASHER],
      useFactory: (userRepo, hasher) => new SetupInitialAdminUseCase(userRepo, hasher),
    },
  ],
  exports: [
    LoginUseCase,
    LogoutUseCase,
    GetSessionUserUseCase,
    CreateUserUseCase,
    ListUsersUseCase,
    DeleteUserUseCase,
    SetupInitialAdminUseCase,
  ],
})
export class IdentityOperationsModule {}
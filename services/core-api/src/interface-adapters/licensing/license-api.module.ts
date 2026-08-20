import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RecordAuditEntryUseCase } from '../../application/audit';
import { GetSessionUserUseCase } from '../../application/identity';
import {
  ActivateLicenseUseCase,
  GetActivationRequestUseCase,
  GetLicenseStatusUseCase,
} from '../../application/licensing';
import { AUDIT_LOG_REPOSITORY } from '../../domain/audit';
import {
  HOST_FINGERPRINT_READER,
  INSTALLATION_REPOSITORY,
  LICENSE_REPOSITORY,
  LICENSE_STATUS_PROVIDER,
  LICENSE_TOKEN_VERIFIER,
} from '../../domain/licensing';
import { TRANSACTION_MANAGER } from '../../domain/shared';
import { LicenseStateService } from '../../infrastructure/licensing/license-state.service';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { AdminOrUnlicensedGuard } from './admin-or-unlicensed.guard';
import { LicenseController } from './license.controller';
import { LicenseGuard } from './license.guard';

/**
 * Licensing surface + the app-wide enforcement guard.
 *
 * `@Global` so `LicenseStateService` resolves anywhere without every feature
 * module importing this one — the same reason `AuthApiModule` is global for its
 * guards.
 *
 * This registers the repo's FIRST `APP_GUARD`. An `APP_GUARD` runs before any
 * controller-level `@UseGuards`, which is exactly what "check the license
 * before touching any service" requires: the check lands ahead of
 * authentication and every controller, not beside them.
 *
 * Use cases are framework-free plain classes wired with explicit `useFactory` +
 * `inject`, never `@Injectable` — an `@nestjs/common` import in
 * `src/application/` would fail `application-no-framework-imports`.
 */
@Global()
@Module({
  imports: [PersistenceModule.forRoot()],
  controllers: [LicenseController],
  providers: [
    {
      provide: GetLicenseStatusUseCase,
      inject: [
        INSTALLATION_REPOSITORY,
        LICENSE_REPOSITORY,
        LICENSE_TOKEN_VERIFIER,
        HOST_FINGERPRINT_READER,
      ],
      useFactory: (installations, licenses, verifier, fingerprints) =>
        new GetLicenseStatusUseCase(installations, licenses, verifier, fingerprints),
    },
    {
      provide: RecordAuditEntryUseCase,
      inject: [AUDIT_LOG_REPOSITORY],
      useFactory: (auditLog) => new RecordAuditEntryUseCase(auditLog),
    },
    {
      provide: ActivateLicenseUseCase,
      inject: [
        LICENSE_REPOSITORY,
        LICENSE_TOKEN_VERIFIER,
        GetLicenseStatusUseCase,
        TRANSACTION_MANAGER,
        RecordAuditEntryUseCase,
      ],
      useFactory: (licenses, verifier, getStatus, transactions, recordAudit) =>
        new ActivateLicenseUseCase(licenses, verifier, getStatus, transactions, recordAudit),
    },
    {
      provide: GetActivationRequestUseCase,
      inject: [GetLicenseStatusUseCase],
      useFactory: (getStatus) => new GetActivationRequestUseCase(getStatus),
    },
    LicenseStateService,
    // The enforcement points depend on the read PORT, not on the service that
    // happens to implement it (DIP). `useExisting` keeps it one singleton, so
    // the cached verdict the guard reads is the one activation refreshes.
    { provide: LICENSE_STATUS_PROVIDER, useExisting: LicenseStateService },
    AdminOrUnlicensedGuard,
    { provide: APP_GUARD, useClass: LicenseGuard },
  ],
  exports: [LicenseStateService, LICENSE_STATUS_PROVIDER, GetLicenseStatusUseCase],
})
export class LicenseApiModule {}

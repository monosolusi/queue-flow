import { Module } from '@nestjs/common';
import { REPORT_QUERY_PORT } from '../../domain/reporting';
import { AUDIT_LOG_REPOSITORY } from '../../domain/audit';
import {
  GetCounterPerformanceUseCase,
  GetDailyReportUseCase,
  GetRangeReportUseCase,
} from '../../application/reporting';
import { ListAuditEntriesUseCase } from '../../application/audit';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { ReportingController } from './reporting.controller';
import { AuditLogController } from './audit-log.controller';

/**
 * Wires the analytics + audit-trail read REST surface for the admin dashboard
 * (FR-ADM-03 / QUE-26). Kept as its own module per the per-concern split (SRP):
 * reporting/audit reads are a distinct concern from queue reads (RestApiModule),
 * queue control (QueueCommandsApiModule), system config (SystemConfigApiModule),
 * and the daily-reset surface (SystemApiModule).
 *
 * The three use cases are pure, framework-free classes (no `@Injectable`/
 * `@Inject` — consistent with the application layer), so each is provided via a
 * factory receiving its domain ports from {@link PersistenceModule}. The global
 * {@link DomainExceptionFilter} (registered in RestApiModule, applies app-wide)
 * maps the domain errors these use cases throw (a malformed date →
 * `InvalidValueObjectException` → 400) to HTTP.
 */
@Module({
  imports: [PersistenceModule.forRoot()],
  controllers: [ReportingController, AuditLogController],
  providers: [
    {
      provide: GetDailyReportUseCase,
      inject: [REPORT_QUERY_PORT],
      useFactory: (reportQuery) => new GetDailyReportUseCase(reportQuery),
    },
    {
      provide: GetCounterPerformanceUseCase,
      inject: [REPORT_QUERY_PORT],
      useFactory: (reportQuery) => new GetCounterPerformanceUseCase(reportQuery),
    },
    {
      provide: GetRangeReportUseCase,
      inject: [REPORT_QUERY_PORT],
      useFactory: (reportQuery) => new GetRangeReportUseCase(reportQuery),
    },
    {
      provide: ListAuditEntriesUseCase,
      inject: [AUDIT_LOG_REPOSITORY],
      useFactory: (auditLog) => new ListAuditEntriesUseCase(auditLog),
    },
  ],
})
export class ReportingApiModule {}
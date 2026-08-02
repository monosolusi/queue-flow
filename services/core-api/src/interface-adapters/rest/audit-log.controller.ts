import { Controller, Get } from '@nestjs/common';
import { ListAuditEntriesUseCase, type AuditLogEntryDto } from '../../application/audit';

/**
 * Audit-trail REST surface for the admin analytics dashboard (NFR-SEC-02 /
 * FR-ADM-03 / QUE-26). Surfaces the local audit log — human-initiated mutations
 * (manual reset, state-schema / routing changes, prior-day archive) — oldest
 * first, so the manager can review sensitive administrative actions. The
 * controller only delegates to {@link ListAuditEntriesUseCase}; it is the
 * anti-corruption translation point, not a domain concern.
 */
@Controller('api/audit')
export class AuditLogController {
  constructor(private readonly listAuditEntries: ListAuditEntriesUseCase) {}

  @Get('log')
  async log(): Promise<readonly AuditLogEntryDto[]> {
    return this.listAuditEntries.execute();
  }
}
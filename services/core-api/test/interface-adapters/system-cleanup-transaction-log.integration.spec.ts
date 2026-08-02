import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import {
  type IQueueRepository,
  QUEUE_REPOSITORY,
  QueueTicket,
  TicketNumber,
  ticketIdGenerate,
} from '../../src/domain/queue';
import {
  type ISystemConfigurationRepository,
  SYSTEM_CONFIGURATION_REPOSITORY,
  SystemConfiguration,
} from '../../src/domain/store-config';
import {
  type IAuditLogRepository,
  AUDIT_LOG_REPOSITORY,
  AuditAction,
} from '../../src/domain/audit';
import { Identifier } from '../../src/domain/shared';
import {
  InMemoryAuditLogRepository,
  InMemoryQueueRepository,
  InMemorySystemConfigurationRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { startOfLocalDay } from '../../src/application/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Integration: boots the real Nest app (in-memory persistence) and exercises the
 * system-admin transaction-log cleanup REST surface added in QUE-25
 * (FR-ADM-02). Asserts the endpoint purges only archived transactions older
 * than the retention window, records a TRANSACTION_LOG_CLEANUP audit entry on
 * the manual path, never touches the audit log, and rejects an under-floor
 * retention window with 400 INVALID_ARGUMENT before any row is purged
 * (NFR-REL-02).
 */
describe('System transaction-log cleanup REST surface (integration — QUE-25)', () => {
  let app: INestApplication;
  let queue: IQueueRepository;
  let systemConfig: ISystemConfigurationRepository;
  let auditLog: IAuditLogRepository;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    queue = app.get(QUEUE_REPOSITORY);
    systemConfig = app.get(SYSTEM_CONFIGURATION_REPOSITORY);
    auditLog = app.get(AUDIT_LOG_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    (queue as InMemoryQueueRepository).clear();
    (systemConfig as InMemorySystemConfigurationRepository).clear();
    (auditLog as InMemoryAuditLogRepository).clear();

    // A completed config so the system-admin surface is not in the
    // pre-wizard 409 state (the cleanup endpoint itself does not read the
    // config, but the module boots the same controller).
    const config = SystemConfiguration.create(Identifier.generate(), 'QMS Test Store');
    config.completeInitialSetup();
    await systemConfig.save(config);
  });

  /** Seeds an archived ticket `daysBeforeToday` days old (prior-day → archived). */
  async function seedArchivedDaysOld(daysBeforeToday: number, seq: number) {
    const startOfToday = startOfLocalDay(Date.now());
    const createdAt = startOfToday - daysBeforeToday * DAY_MS;
    const ticket = QueueTicket.create(ticketIdGenerate(), TicketNumber.of('A', seq), 'CAT-A', createdAt);
    await queue.save(ticket);
    // Archive everything older than the start of today (the prior-day tickets).
    await (queue as InMemoryQueueRepository).archiveTicketsBefore(startOfToday);
  }

  it('POST /api/system/cleanup-transaction-log purges archived transactions older than retentionDays', async () => {
    await seedArchivedDaysOld(100, 1); // older than 90 days → purged
    await seedArchivedDaysOld(30, 2); // younger than 90 days → kept
    expect((queue as InMemoryQueueRepository).archivedTickets()).toHaveLength(2);

    const res = await request(app.getHttpServer())
      .post('/api/system/cleanup-transaction-log')
      .send({ retentionDays: 90 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'cleaned', retentionDays: 90, deletedCount: 1 });
    const remaining = (queue as InMemoryQueueRepository)
      .archivedTickets()
      .map((t) => t.ticketNumber.sequence);
    expect(remaining).toEqual([2]);
  });

  it('records a TRANSACTION_LOG_CLEANUP audit entry on the manual path (NFR-SEC-02)', async () => {
    await seedArchivedDaysOld(100, 1);

    const res = await request(app.getHttpServer())
      .post('/api/system/cleanup-transaction-log')
      .send({ retentionDays: 90 });
    expect(res.status).toBe(201);

    const entries = await auditLog.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe(AuditAction.TRANSACTION_LOG_CLEANUP);
    expect(entries[0].actor).toBe('admin');
    expect(entries[0].after.deletedCount).toBe(1);
    expect(entries[0].after.retentionDays).toBe(90);
  });

  it('never purges the audit log — only archived_tickets', async () => {
    // Pre-seed an unrelated audit entry; it must survive the cleanup.
    const auditRepo = auditLog as InMemoryAuditLogRepository;
    // Record a MANUAL_RESET entry directly via the repo by appending a built
    // entry through the recorded-audit path the controller uses.
    await auditRepo.append(
      (await import('../../src/domain/audit')).AuditLogEntry.of({
        actor: 'admin',
        action: AuditAction.MANUAL_RESET,
        before: null,
        after: { resetTo: 1 },
        occurredAt: Date.now(),
      }),
    );
    await seedArchivedDaysOld(100, 1);

    await request(app.getHttpServer())
      .post('/api/system/cleanup-transaction-log')
      .send({ retentionDays: 90 });

    // The pre-existing MANUAL_RESET entry plus the new TRANSACTION_LOG_CLEANUP.
    const entries = await auditLog.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.action)).toContain(AuditAction.MANUAL_RESET);
  });

  it('rejects an under-floor retentionDays with 400 INVALID_ARGUMENT before purging (NFR-REL-02)', async () => {
    await seedArchivedDaysOld(100, 1);

    const res = await request(app.getHttpServer())
      .post('/api/system/cleanup-transaction-log')
      .send({ retentionDays: 1 }); // below the 7-day floor

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ARGUMENT');
    // Nothing was purged and nothing was audited.
    expect((queue as InMemoryQueueRepository).archivedTickets()).toHaveLength(1);
    expect(await auditLog.list()).toHaveLength(0);
  });

  it('rejects a missing retentionDays with 400 INVALID_ARGUMENT', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/system/cleanup-transaction-log')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ARGUMENT');
  });
});
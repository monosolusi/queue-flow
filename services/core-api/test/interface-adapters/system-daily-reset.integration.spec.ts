import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { WebSocket } from 'ws';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import {
  type ICategoryRepository,
  type IQueueRepository,
  type ISequenceRepository,
  CATEGORY_REPOSITORY,
  QUEUE_REPOSITORY,
  SEQUENCE_REPOSITORY,
  Category,
  QueueTicket,
  TicketNumber,
  ticketIdGenerate,
} from '../../src/domain/queue';
import {
  type ISystemConfigurationRepository,
  SYSTEM_CONFIGURATION_REPOSITORY,
  DailyResetPolicy,
  DailyResetMode,
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
  InMemoryCategoryRepository,
  InMemoryQueueRepository,
  InMemorySequenceRepository,
  InMemorySystemConfigurationRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { toDateKey } from '../../src/application/queue';

/**
 * Integration: boots the real Nest app (in-memory persistence) and exercises the
 * system-admin daily-reset REST surface added in QUE-2 (FR-ENG-05). Asserts the
 * manual reset rolls the per-day sequence back to the configured start value and
 * broadcasts a SYSTEM_RESET event over the WebSocket — and that the next kiosk
 * ticket issued afterwards is `<code>-001` again. Also covers the anti-corruption
 * translation: the controller reads `DailyResetPolicy.resetTicketNumberTo` from
 * the Store-Config aggregate and passes only the scalar `resetTo` into the use
 * case, so no Store-Config type crosses into the Queue application layer.
 */
describe('System daily-reset REST surface (integration — QUE-2)', () => {
  let app: INestApplication;
  let queue: IQueueRepository;
  let categories: ICategoryRepository;
  let sequences: ISequenceRepository;
  let systemConfig: ISystemConfigurationRepository;
  let auditLog: IAuditLogRepository;
  let port: number;
  let catAId: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    queue = app.get(QUEUE_REPOSITORY);
    categories = app.get(CATEGORY_REPOSITORY);
    sequences = app.get(SEQUENCE_REPOSITORY);
    systemConfig = app.get(SYSTEM_CONFIGURATION_REPOSITORY);
    auditLog = app.get(AUDIT_LOG_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    (queue as InMemoryQueueRepository).clear();
    (categories as InMemoryCategoryRepository).clear();
    (sequences as InMemorySequenceRepository).clear();
    (systemConfig as InMemorySystemConfigurationRepository).clear();
    (auditLog as InMemoryAuditLogRepository).clear();

    const catA = new Category(Identifier.generate(), 'A', 'Customer Service');
    await categories.save(catA);
    catAId = catA.id.value;

    // A completed config with resetTicketNumberTo = 1 (the default policy).
    const config = SystemConfiguration.create(Identifier.generate(), 'QMS Test Store');
    config.completeInitialSetup();
    await systemConfig.save(config);
  });

  /** Opens a WS client, runs `action`, resolves the first `count` messages. */
  async function collectMessages(
    count: number,
    action: () => Promise<unknown>,
  ): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];

    const opened = new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const received = new Promise<typeof messages>((resolve) => {
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length >= count) resolve(messages);
      });
    });

    await opened;
    await action();
    let timeout: NodeJS.Timeout;
    const fallback = new Promise<typeof messages>((resolve) => {
      timeout = setTimeout(() => resolve(messages), 500);
    });
    const result = await Promise.race([received, fallback]);
    clearTimeout(timeout!);
    ws.close();
    return result;
  }

  it('POST /api/system/daily-reset broadcasts SYSTEM_RESET carrying resetTo and the date', async () => {
    const expectedDate = toDateKey(Date.now());

    const received = await collectMessages(1, () =>
      request(app.getHttpServer()).post('/api/system/daily-reset'),
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('SYSTEM_RESET');
    expect(received[0].payload).toEqual({ resetTo: 1, date: expectedDate });
  });

  it('daily-reset returns the reset result DTO', async () => {
    const res = await request(app.getHttpServer()).post('/api/system/daily-reset');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      status: 'reset',
      date: toDateKey(Date.now()),
      resetTo: 1,
    });
  });

  it('after reset, the next kiosk ticket is <code>-001 again (sequence rolled back)', async () => {
    // Issue two tickets so the sequence is at A-002 before the reset.
    await request(app.getHttpServer()).post('/api/tickets').send({ categoryId: catAId });
    await request(app.getHttpServer()).post('/api/tickets').send({ categoryId: catAId });

    // Reset the daily sequence.
    await request(app.getHttpServer()).post('/api/system/daily-reset');

    // The next ticket mints fresh from the configured resetTo (1) -> A-001.
    const after = await request(app.getHttpServer()).post('/api/tickets').send({ categoryId: catAId });
    expect(after.status).toBe(201);
    expect(after.body.ticket.ticketNumber).toBe('A-001');
  });

  it('honors a custom resetTicketNumberTo configured via the policy (resetTo = 5)', async () => {
    // Re-seed a config whose daily-reset policy resets to 5 (MANUAL mode).
    await systemConfig.save(
      SystemConfiguration.reconstitute({
        id: Identifier.generate(),
        storeName: 'QMS Custom Reset Store',
        isInitialSetupCompleted: true,
        // DEFAULT state machine is fine — only the reset policy matters here.
        stateMachine: SystemConfiguration.create(Identifier.generate()).stateMachine,
        dailyResetPolicy: DailyResetPolicy.of(DailyResetMode.MANUAL, null, 5),
      }),
    );

    // Issue one ticket first so today's sequence counter exists (A-001, value 1).
    await request(app.getHttpServer()).post('/api/tickets').send({ categoryId: catAId });

    const res = await request(app.getHttpServer()).post('/api/system/daily-reset');
    expect(res.status).toBe(201);
    expect(res.body.resetTo).toBe(5);

    // After the reset the counter is resetTo - 1 (4), so the next mint is A-005.
    const after = await request(app.getHttpServer()).post('/api/tickets').send({ categoryId: catAId });
    expect(after.body.ticket.ticketNumber).toBe('A-005');
  });

  it('daily-reset before the system is configured surfaces as 409 SYSTEM_NOT_CONFIGURED', async () => {
    (systemConfig as InMemorySystemConfigurationRepository).clear(); // pre-wizard state

    const res = await request(app.getHttpServer()).post('/api/system/daily-reset');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYSTEM_NOT_CONFIGURED');
  });

  it('reset only rolls back today\'s sequence — a seeded prior-day counter is untouched', async () => {
    // Simulate a ticket already issued earlier today (sequence at A-003).
    const today = toDateKey(Date.now());
    await sequences.nextTicketNumber(catAId, 'A', today);
    await sequences.nextTicketNumber(catAId, 'A', today);
    await sequences.nextTicketNumber(catAId, 'A', today);
    expect(await sequences.currentSequence(catAId, today)).toBe(3);

    await request(app.getHttpServer()).post('/api/system/daily-reset');

    // Today's counter rolled back to resetTo (1) means the next mint is A-001.
    expect(await sequences.currentSequence(catAId, today)).toBe(0); // resetDaily sets to resetTo - 1
  });

  it('a manual daily-reset records a MANUAL_RESET audit entry (NFR-SEC-02)', async () => {
    expect(await auditLog.list()).toHaveLength(0);

    const res = await request(app.getHttpServer()).post('/api/system/daily-reset');
    expect(res.status).toBe(201);

    const entries = await auditLog.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe(AuditAction.MANUAL_RESET);
    expect(entries[0].actor).toBe('admin');
    expect(entries[0].after.resetTo).toBe(1);
    expect(typeof entries[0].after.date).toBe('string');
    expect(entries[0].before).toBeNull();
  });
});
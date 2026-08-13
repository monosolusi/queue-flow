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
  type ICounterRoutingRuleRepository,
  type ISystemConfigurationRepository,
  COUNTER_ROUTING_RULE_REPOSITORY,
  SYSTEM_CONFIGURATION_REPOSITORY,
  CounterRoutingRule,
  BrandColor,
  ServiceThemes,
  TvPanelLayout,
  EdgeRoutingLayout,
  NodeActions,
  NodePositions,
  PrinterConfiguration,
  DailyResetPolicy,
  StateMachine,
  StateSchema,
  StateTransitionRule,
  SystemConfiguration,
} from '../../src/domain/store-config';
import { Identifier } from '../../src/domain/shared';
import { PriorityPolicy } from '../../src/domain/shared/priority-policy';
import {
  InMemoryCategoryRepository,
  InMemoryCounterRoutingRuleRepository,
  InMemoryQueueRepository,
  InMemorySequenceRepository,
  InMemorySystemConfigurationRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { authHeader, bootstrapAuthedAdmin } from '../acceptance/_helpers';

/**
 * Integration: boots the real Nest app (in-memory persistence) and exercises
 * the queue command REST surface added in QUE-2 — call-next, serve, transfer —
 * asserting each lifecycle event actually broadcasts over the WebSocket
 * (FR-ENG-04), and that an illegal transition surfaces as HTTP 409
 * (FR-ENG-02) via the global {@link DomainExceptionFilter}.
 *
 * `QMS_DEV_SEED` is left unset so the dev seed does not run; a completed
 * `SystemConfiguration` (the active state machine the resolver reads) is seeded
 * directly through the `SYSTEM_CONFIGURATION_REPOSITORY` token each test.
 */
describe('Queue command REST surface (integration — QUE-2)', () => {
  let app: INestApplication;
  let queue: IQueueRepository;
  let routingRules: ICounterRoutingRuleRepository;
  let categories: ICategoryRepository;
  let sequences: ISequenceRepository;
  let systemConfig: ISystemConfigurationRepository;
  let port: number;
  let catAId: string;
  let catBId: string;
  let token: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    queue = app.get(QUEUE_REPOSITORY);
    routingRules = app.get(COUNTER_ROUTING_RULE_REPOSITORY);
    categories = app.get(CATEGORY_REPOSITORY);
    sequences = app.get(SEQUENCE_REPOSITORY);
    systemConfig = app.get(SYSTEM_CONFIGURATION_REPOSITORY);
    // QUE-43: every queue command endpoint requires an authenticated admin or
    // caller-staff bearer. Bootstrap the admin once (the Identity repos are not
    // cleared per test — auth state is cross-cutting scaffolding) and reuse the
    // token across tests; the 12h session TTL far outlasts the suite.
    token = await bootstrapAuthedAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    (queue as InMemoryQueueRepository).clear();
    (routingRules as InMemoryCounterRoutingRuleRepository).clear();
    (categories as InMemoryCategoryRepository).clear();
    (sequences as InMemorySequenceRepository).clear();
    (systemConfig as InMemorySystemConfigurationRepository).clear();

    const catA = new Category(Identifier.generate(), 'A', 'Customer Service');
    const catB = new Category(Identifier.generate(), 'B', 'Kasir & Pembayaran');
    await categories.save(catA);
    await categories.save(catB);
    catAId = catA.id.value;
    catBId = catB.id.value;

    await routingRules.save(
      CounterRoutingRule.create(
        Identifier.generate(),
        1,
        'Counter 1 (CS)',
        [catA.id.value],
        PriorityPolicy.FIFO_GLOBAL,
      ),
    );

    await seedDefaultConfig();
  });

  /** Seeds a completed SystemConfiguration with the default state machine. */
  async function seedDefaultConfig(): Promise<void> {
    const config = SystemConfiguration.create(Identifier.generate(), 'QMS Test Store');
    config.completeInitialSetup();
    await systemConfig.save(config);
  }

  /** Seeds a WAITING ticket for `categoryId` with the given code/seq. */
  async function seedWaitingTicket(
    categoryId: string,
    code: string,
    seq: number,
  ): Promise<QueueTicket> {
    const ticket = QueueTicket.create(
      ticketIdGenerate(),
      TicketNumber.of(code, seq),
      categoryId,
      100,
    );
    await queue.save(ticket);
    return ticket;
  }

  /** Opens a WS client, runs `action`, and resolves the first `count` messages. */
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

  it('POST /api/queue/call-next routes + calls the oldest WAITING ticket and broadcasts TICKET_CALLED + STATUS_UPDATED', async () => {
    await seedWaitingTicket(catAId, 'A', 1);

    const received = await collectMessages(2, () =>
      request(app.getHttpServer()).post('/api/queue/call-next').set(authHeader(token)).send({ counterId: 1 }),
    );

    const types = received.map((m) => m.type);
    expect(types).toContain('TICKET_CALLED');
    expect(types).toContain('STATUS_UPDATED');

    const called = received.find((m) => m.type === 'TICKET_CALLED');
    expect(called?.payload).toEqual({ ticketNumber: 'A-001', counterId: 1 });
    const status = received.find((m) => m.type === 'STATUS_UPDATED');
    expect(status?.payload).toMatchObject({ from: 'WAITING', to: 'CALLING' });
  });

  it('call-next returns the called ticket DTO and 201', async () => {
    await seedWaitingTicket(catAId, 'A', 7);

    const res = await request(app.getHttpServer())
      .post('/api/queue/call-next').set(authHeader(token))
      .send({ counterId: 1 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'called',
      ticket: { ticketNumber: 'A-007', categoryId: catAId, counterId: 1 },
    });
    expect(res.body.ticket.ticketId).toEqual(expect.any(String));
  });

  it('call-next returns `empty` (no broadcast) when no WAITING ticket matches the counter', async () => {
    const received = await collectMessages(1, async () => {
      const res = await request(app.getHttpServer())
        .post('/api/queue/call-next').set(authHeader(token))
        .send({ counterId: 1 });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ status: 'empty' });
    });
    // Nothing was broadcast for an empty queue.
    expect(received).toHaveLength(0);
  });

  it('POST /api/queue/:id/serve transitions CALLING -> SERVING and broadcasts STATUS_UPDATED', async () => {
    // Advance a WAITING ticket to CALLING first (call-next drains its events).
    await seedWaitingTicket(catAId, 'A', 1);
    const callRes = await request(app.getHttpServer())
      .post('/api/queue/call-next').set(authHeader(token))
      .send({ counterId: 1 });
    const ticketId = callRes.body.ticket.ticketId;

    const received = await collectMessages(1, () =>
      request(app.getHttpServer()).post(`/api/queue/${ticketId}/serve`).set(authHeader(token)),
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('STATUS_UPDATED');
    expect(received[0].payload).toMatchObject({ from: 'CALLING', to: 'SERVING' });
  });

  it('POST /api/queue/:id/transfer reassigns the category and broadcasts TICKET_TRANSFERRED (transfer-enabled config)', async () => {
    // The default state machine has no transfer edge; re-seed a config whose
    // machine adds CALLING -> WAITING ("Pindah Kategori") — what the wizard
    // configures to enable transfers (FR-CLR-03).
    const transferMachine = new StateMachine(
      StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED']),
      [
        ['WAITING', 'CALLING', 'Panggil Berikutnya'],
        ['CALLING', 'SERVING', 'Mulai Melayani'],
        ['CALLING', 'SKIPPED', 'Lewati / Absen'],
        ['SKIPPED', 'CALLING', 'Panggil Ulang'],
        ['SERVING', 'COMPLETED', 'Selesai Layan'],
        ['CALLING', 'WAITING', 'Pindah Kategori'],
      ].map(([from, to, actionLabel]) => StateTransitionRule.of(from, to, actionLabel)),
    );
    await systemConfig.save(
      SystemConfiguration.reconstitute({
        id: Identifier.generate(),
        storeName: 'QMS Transfer Store',
        isInitialSetupCompleted: true,
        stateMachine: transferMachine,
        dailyResetPolicy: DailyResetPolicy.DEFAULT,
        brandColor: BrandColor.DEFAULT,
        serviceThemes: ServiceThemes.DEFAULT,
        tvPanelLayout: TvPanelLayout.DEFAULT,
        edgeRoutingLayout: EdgeRoutingLayout.DEFAULT,
        nodePositions: NodePositions.DEFAULT,
        nodeActions: NodeActions.DEFAULT,
        printerConfiguration: PrinterConfiguration.DEFAULT,
      }),
    );

    // A CALLING ticket under CAT-A at counter 1.
    const calling = QueueTicket.reconstitute({
      id: ticketIdGenerate(),
      ticketNumber: TicketNumber.of('A', 1),
      categoryId: catAId,
      status: 'CALLING',
      counterId: 1,
      createdAt: 50,
      updatedAt: 50,
      calledAt: 50,
      servedAt: null,
      completedAt: null,
    });
    await queue.save(calling);

    const received = await collectMessages(2, () =>
      request(app.getHttpServer())
        .post(`/api/queue/${calling.id.value}/transfer`)
        .set(authHeader(token))
        .send({ targetCategoryId: catBId }),
    );

    // Transfer is a first-class transition: the aggregate records STATUS_UPDATED
    // (CALLING -> WAITING, "Pindah Kategori") then TICKET_TRANSFERRED.
    const types = received.map((m) => m.type);
    expect(types).toContain('STATUS_UPDATED');
    expect(types).toContain('TICKET_TRANSFERRED');

    const transferred = received.find((m) => m.type === 'TICKET_TRANSFERRED');
    expect(transferred?.payload).toMatchObject({
      fromCategoryId: catAId,
      toCategoryId: catBId,
      fromTicketNumber: 'A-001',
      toTicketNumber: 'B-001',
    });
  });

  it('an illegal transition (skip a WAITING ticket) surfaces as 409 INVALID_STATE_TRANSITION and broadcasts nothing', async () => {
    const ticket = await seedWaitingTicket(catAId, 'A', 1); // WAITING has no -> SKIPPED edge

    const received = await collectMessages(1, async () => {
      const res = await request(app.getHttpServer()).post(`/api/queue/${ticket.id.value}/skip`).set(authHeader(token));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    expect(received).toHaveLength(0);
  });

  it('a queue command before the system is configured surfaces as 409 SYSTEM_NOT_CONFIGURED', async () => {
    (systemConfig as InMemorySystemConfigurationRepository).clear(); // pre-wizard state

    const res = await request(app.getHttpServer())
      .post('/api/queue/call-next').set(authHeader(token))
      .send({ counterId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYSTEM_NOT_CONFIGURED');
  });

  it('rejects a missing/invalid counterId on call-next with 400', async () => {
    const res = await request(app.getHttpServer()).post('/api/queue/call-next').set(authHeader(token)).send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/queue/:id/transition applies a custom SERVING -> PREPARING transition and broadcasts STATUS_UPDATED (QUE-33)', async () => {
    // Re-seed a config whose machine adds the custom `SERVING -> PREPARING`
    // ("Siapkan Dokumen") edge — what the wizard configures for an in-progress
    // sub-state the default machine does not model.
    const customMachine = new StateMachine(
      StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'PREPARING', 'SKIPPED', 'COMPLETED']),
      [
        ['WAITING', 'CALLING', 'Panggil Berikutnya'],
        ['CALLING', 'SERVING', 'Mulai Melayani'],
        ['CALLING', 'SKIPPED', 'Lewati / Absen'],
        ['SKIPPED', 'CALLING', 'Panggil Ulang'],
        ['SERVING', 'PREPARING', 'Siapkan Dokumen'],
        ['PREPARING', 'COMPLETED', 'Selesai Layan'],
        ['SERVING', 'COMPLETED', 'Selesai Layan'],
      ].map(([from, to, actionLabel]) => StateTransitionRule.of(from, to, actionLabel)),
    );
    await systemConfig.save(
      SystemConfiguration.reconstitute({
        id: Identifier.generate(),
        storeName: 'QMS Custom Store',
        isInitialSetupCompleted: true,
        stateMachine: customMachine,
        dailyResetPolicy: DailyResetPolicy.DEFAULT,
        brandColor: BrandColor.DEFAULT,
        serviceThemes: ServiceThemes.DEFAULT,
        tvPanelLayout: TvPanelLayout.DEFAULT,
        edgeRoutingLayout: EdgeRoutingLayout.DEFAULT,
        nodePositions: NodePositions.DEFAULT,
        nodeActions: NodeActions.DEFAULT,
        printerConfiguration: PrinterConfiguration.DEFAULT,
      }),
    );

    // A SERVING ticket at counter 1 — the source state for "Siapkan Dokumen".
    const serving = QueueTicket.reconstitute({
      id: ticketIdGenerate(),
      ticketNumber: TicketNumber.of('A', 1),
      categoryId: catAId,
      status: 'SERVING',
      counterId: 1,
      createdAt: 50,
      updatedAt: 60,
      calledAt: 55,
      servedAt: 60,
      completedAt: null,
    });
    await queue.save(serving);

    const received = await collectMessages(1, async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/queue/${serving.id.value}/transition`).set(authHeader(token))
        .send({ targetStatus: 'PREPARING' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'transitioned',
        ticket: { ticketNumber: 'A-001', status: 'PREPARING', counterId: 1, categoryId: catAId },
      });
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('STATUS_UPDATED');
    expect(received[0].payload).toMatchObject({
      from: 'SERVING',
      to: 'PREPARING',
      actionLabel: 'Siapkan Dokumen',
    });

    // The ticket is persisted in the custom state.
    const reloaded = await queue.findById(serving.id);
    expect(reloaded?.currentStatus).toBe('PREPARING');
    expect(reloaded?.counterId).toBe(1); // plain status change preserves the counter
  });

  it('POST /api/queue/:id/transition rejects an illegal target with 409 INVALID_STATE_TRANSITION and broadcasts nothing', async () => {
    // The default state machine has no SERVING -> PREPARING edge.
    const serving = QueueTicket.reconstitute({
      id: ticketIdGenerate(),
      ticketNumber: TicketNumber.of('A', 1),
      categoryId: catAId,
      status: 'SERVING',
      counterId: 1,
      createdAt: 50,
      updatedAt: 60,
      calledAt: 55,
      servedAt: 60,
      completedAt: null,
    });
    await queue.save(serving);

    const received = await collectMessages(1, async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/queue/${serving.id.value}/transition`).set(authHeader(token))
        .send({ targetStatus: 'PREPARING' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    expect(received).toHaveLength(0);
  });

  it('POST /api/queue/:id/transition rejects a missing targetStatus body with 400', async () => {
    const serving = QueueTicket.reconstitute({
      id: ticketIdGenerate(),
      ticketNumber: TicketNumber.of('A', 1),
      categoryId: catAId,
      status: 'SERVING',
      counterId: 1,
      createdAt: 50,
      updatedAt: 60,
      calledAt: 55,
      servedAt: 60,
      completedAt: null,
    });
    await queue.save(serving);

    const res = await request(app.getHttpServer())
      .post(`/api/queue/${serving.id.value}/transition`).set(authHeader(token))
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/queue/:id/transition rejects a canonical target with 400 (use the dedicated endpoint)', async () => {
    // The five PRD-default states each have a dedicated command endpoint whose
    // aggregate owns the lifecycle side effects. A direct API call must not be
    // able to bypass them via the generic endpoint — e.g. reaching COMPLETED
    // here would leave `completedAt` null and corrupt the analytics data model.
    const serving = QueueTicket.reconstitute({
      id: ticketIdGenerate(),
      ticketNumber: TicketNumber.of('A', 1),
      categoryId: catAId,
      status: 'SERVING',
      counterId: 1,
      createdAt: 50,
      updatedAt: 60,
      calledAt: 55,
      servedAt: 60,
      completedAt: null,
    });
    await queue.save(serving);

    const res = await request(app.getHttpServer())
      .post(`/api/queue/${serving.id.value}/transition`).set(authHeader(token))
      .send({ targetStatus: 'COMPLETED' });
    expect(res.status).toBe(400);
    // The ticket is unchanged — no bypass occurred.
    const reloaded = await queue.findById(serving.id);
    expect(reloaded?.currentStatus).toBe('SERVING');
    expect(reloaded?.completedAt).toBeNull();
  });
});
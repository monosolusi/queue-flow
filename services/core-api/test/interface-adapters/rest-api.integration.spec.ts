import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import {
  type ICategoryRepository,
  type IQueueRepository,
  QUEUE_REPOSITORY,
  CATEGORY_REPOSITORY,
  Category,
  QueueTicket,
  TicketNumber,
  ticketIdGenerate,
} from '../../src/domain/queue';
import {
  type ICounterRoutingRuleRepository,
  CounterRoutingRule,
  COUNTER_ROUTING_RULE_REPOSITORY,
} from '../../src/domain/store-config';
import { Identifier } from '../../src/domain/shared';
import { PriorityPolicy } from '../../src/domain/shared/priority-policy';
import {
  InMemoryCategoryRepository,
  InMemoryCounterRoutingRuleRepository,
  InMemoryQueueRepository,
} from '../../src/infrastructure/persistence/in-memory';

/**
 * Integration: boots the real Nest app with the in-memory persistence module
 * and exercises the read-only REST surface the caller and kiosk workspaces
 * depend on (QUE-19 + QUE-17). `QMS_DEV_SEED` is left unset so the dev seed
 * does not run; data is seeded directly through the repository tokens.
 */
describe('Read-only REST surface (integration — QUE-19 + QUE-17)', () => {
  let app: INestApplication;
  let queue: IQueueRepository;
  let routingRules: ICounterRoutingRuleRepository;
  let categories: ICategoryRepository;
  let catAId: string;
  let catBId: string;

  beforeAll(async () => {
    // AppModule wires the WS gateway, so the ws adapter must be bound to the
    // HTTP server before init — the REST surface does not use the socket, but
    // Nest connects all gateways during startup.
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    queue = app.get(QUEUE_REPOSITORY);
    routingRules = app.get(COUNTER_ROUTING_RULE_REPOSITORY);
    categories = app.get(CATEGORY_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Reset the shared in-memory stores so each test starts clean, then seed.
    (queue as InMemoryQueueRepository).clear();
    (routingRules as InMemoryCounterRoutingRuleRepository).clear();
    (categories as InMemoryCategoryRepository).clear();

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
    await routingRules.save(
      CounterRoutingRule.create(
        Identifier.generate(),
        2,
        'Counter 2 (Serbaguna)',
        [catA.id.value, catB.id.value],
        PriorityPolicy.CATEGORY_PRIORITY,
      ),
    );

    // Two waiting CAT-A tickets + one already CALLING at counter 1.
    await queue.save(
      QueueTicket.create(ticketIdGenerate(), TicketNumber.of('A', 1), catA.id.value, 100),
    );
    await queue.save(
      QueueTicket.create(ticketIdGenerate(), TicketNumber.of('A', 2), catA.id.value, 200),
    );
    await queue.save(
      QueueTicket.reconstitute({
        id: ticketIdGenerate(),
        ticketNumber: TicketNumber.of('A', 3),
        categoryId: catA.id.value,
        status: 'CALLING',
        counterId: 1,
        createdAt: 50,
        updatedAt: 50,
        calledAt: 50,
        servedAt: null,
        completedAt: null,
      }),
    );
  });

  it('GET /api/counters returns the configured counters with assigned categories', async () => {
    const res = await request(app.getHttpServer()).get('/api/counters');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      counterId: 1,
      counterName: 'Counter 1 (CS)',
      priorityPolicy: 'FIFO_GLOBAL',
    });
    expect(res.body[0].assignedCategories).toEqual([
      { id: catAId, code: 'A', name: 'Customer Service' },
    ]);
    expect(res.body[1].counterId).toBe(2);
    expect(res.body[1].assignedCategories.map((c: { code: string }) => c.code)).toEqual([
      'A',
      'B',
    ]);
  });

  it('GET /api/categories returns the active categories for the kiosk screen (QUE-17)', async () => {
    const res = await request(app.getHttpServer()).get('/api/categories');

    expect(res.status).toBe(200);
    // Seeded categories are A (Customer Service) and B (Kasir & Pembayaran).
    expect(res.body).toHaveLength(2);
    expect(res.body).toEqual([
      { id: catAId, code: 'A', name: 'Customer Service' },
      { id: catBId, code: 'B', name: 'Kasir & Pembayaran' },
    ]);
  });

  it('GET /api/categories returns an empty list when no categories are configured', async () => {
    (categories as InMemoryCategoryRepository).clear();

    const res = await request(app.getHttpServer()).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /api/queue?counterId=1 returns the active ticket and waiting queue for counter 1', async () => {
    const res = await request(app.getHttpServer()).get('/api/queue?counterId=1');

    expect(res.status).toBe(200);
    expect(res.body.counterId).toBe(1);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0]).toMatchObject({
      ticketNumber: 'A-003',
      status: 'CALLING',
      counterId: 1,
    });
    expect(res.body.waiting.map((t: { ticketNumber: string }) => t.ticketNumber)).toEqual([
      'A-001',
      'A-002',
    ]);
    expect(res.body.waitingCount).toBe(2);
  });

  it('GET /api/queue without counterId is a 400 client error', async () => {
    const res = await request(app.getHttpServer()).get('/api/queue');
    expect(res.status).toBe(400);
  });

  it('GET /api/queue?counterId=not-a-number is a 400 client error', async () => {
    const res = await request(app.getHttpServer()).get('/api/queue?counterId=abc');
    expect(res.status).toBe(400);
  });

  it('GET /api/queue for an unknown counter surfaces as 404 via the domain exception filter', async () => {
    const res = await request(app.getHttpServer()).get('/api/queue?counterId=999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ENTITY_NOT_FOUND');
  });

  it('GET /api/queue/board returns every active ticket + every WAITING ticket across all categories', async () => {
    // The beforeEach seed created A-001 (100) and A-002 (200) WAITING plus A-003 CALLING.
    // Add a WAITING CAT-B ticket older than both to assert cross-category FIFO.
    await queue.save(
      QueueTicket.create(ticketIdGenerate(), TicketNumber.of('B', 1), catBId, 50),
    );

    const res = await request(app.getHttpServer()).get('/api/queue/board');

    expect(res.status).toBe(200);
    // The active slice carries the seeded CALLING ticket (A-003 at counter 1).
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0]).toMatchObject({
      ticketNumber: 'A-003',
      status: 'CALLING',
      counterId: 1,
    });
    // The waiting slice is cross-category FIFO by createdAt.
    expect(res.body.waiting.map((t: { ticketNumber: string }) => t.ticketNumber)).toEqual([
      'B-001',
      'A-001',
      'A-002',
    ]);
    expect(res.body.waitingCount).toBe(3);
    // Each row reuses the shared TicketStateDto shape.
    expect(res.body.waiting[0]).toMatchObject({
      ticketNumber: 'B-001',
      categoryId: catBId,
      status: 'WAITING',
      counterId: null,
    });
  });

  it('GET /api/queue/board returns an empty zero-state when no tickets are WAITING/active', async () => {
    (queue as InMemoryQueueRepository).clear();
    // Re-seed only a COMPLETED ticket so the store is non-empty but no active/waiting rows.
    await queue.save(
      QueueTicket.reconstitute({
        id: ticketIdGenerate(),
        ticketNumber: TicketNumber.of('A', 1),
        categoryId: catAId,
        status: 'COMPLETED',
        counterId: 1,
        createdAt: 10,
        updatedAt: 20,
        calledAt: 10,
        servedAt: 15,
        completedAt: 20,
      }),
    );

    const res = await request(app.getHttpServer()).get('/api/queue/board');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: [], waiting: [], waitingCount: 0 });
  });
});
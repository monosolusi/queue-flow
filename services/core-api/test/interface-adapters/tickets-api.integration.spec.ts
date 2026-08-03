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
} from '../../src/domain/queue';
import { Identifier } from '../../src/domain/shared';
import {
  InMemoryCategoryRepository,
  InMemoryQueueRepository,
  InMemorySequenceRepository,
} from '../../src/infrastructure/persistence/in-memory';

/**
 * Integration: boots the real Nest app with the in-memory persistence module
 * and exercises the kiosk ticket-creation REST surface (QUE-9). `QMS_DEV_SEED`
 * is left unset so the dev seed does not run; categories are seeded directly
 * through the repository tokens, and the in-memory stores are reset in
 * `beforeEach` (including the sequence store, so each test starts at `A-001`).
 */
describe('Kiosk ticket-creation REST surface (integration — QUE-9)', () => {
  let app: INestApplication;
  let queue: IQueueRepository;
  let categories: ICategoryRepository;
  let sequences: ISequenceRepository;
  let catAId: string;
  let catBId: string;
  let port: number;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    queue = app.get(QUEUE_REPOSITORY);
    categories = app.get(CATEGORY_REPOSITORY);
    sequences = app.get(SEQUENCE_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    (queue as InMemoryQueueRepository).clear();
    (categories as InMemoryCategoryRepository).clear();
    (sequences as InMemorySequenceRepository).clear();

    const catA = new Category(Identifier.generate(), 'A', 'Customer Service');
    const catB = new Category(Identifier.generate(), 'B', 'Kasir & Pembayaran');
    await categories.save(catA);
    await categories.save(catB);
    catAId = catA.id.value;
    catBId = catB.id.value;
  });

  it('POST /api/tickets mints A-001 (201) then A-002 for the same category', async () => {
    const r1 = await request(app.getHttpServer())
      .post('/api/tickets')
      .send({ categoryId: catAId });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({
      status: 'created',
      ticket: { ticketNumber: 'A-001', categoryId: catAId, status: 'WAITING' },
    });
    expect(r1.body.ticket.ticketId).toEqual(expect.any(String));

    const r2 = await request(app.getHttpServer())
      .post('/api/tickets')
      .send({ categoryId: catAId });
    expect(r2.status).toBe(201);
    expect(r2.body.ticket.ticketNumber).toBe('A-002');
    // FR-KSK-03: the second same-category ticket sees one person already ahead.
    expect(r1.body.ticket.waitingAhead).toBe(0);
    expect(r2.body.ticket.waitingAhead).toBe(1);
  });

  it('isolates the sequence per category (A-001 and B-001)', async () => {
    const ra = await request(app.getHttpServer())
      .post('/api/tickets')
      .send({ categoryId: catAId });
    const rb = await request(app.getHttpServer())
      .post('/api/tickets')
      .send({ categoryId: catBId });
    expect(ra.body.ticket.ticketNumber).toBe('A-001');
    expect(rb.body.ticket.ticketNumber).toBe('B-001');
  });

  it('rejects a missing categoryId with 400', async () => {
    const res = await request(app.getHttpServer()).post('/api/tickets').send({});
    expect(res.status).toBe(400);
  });

  it('rejects an empty/whitespace categoryId with 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/tickets')
      .send({ categoryId: '   ' });
    expect(res.status).toBe(400);
  });

  it('surfaces an unknown category as 404 ENTITY_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/tickets')
      .send({ categoryId: Identifier.generate().value });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ENTITY_NOT_FOUND');
  });

  it('broadcasts a TICKET_CREATED wire event over /ws when a ticket is taken', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: unknown[] = [];
    const opened = new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const received = new Promise<unknown[]>((resolve) => {
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length >= 1) resolve(messages);
      });
    });

    await opened;
    await request(app.getHttpServer()).post('/api/tickets').send({ categoryId: catAId });

    let timeout: NodeJS.Timeout;
    const fallback = new Promise<unknown[]>((resolve) => {
      timeout = setTimeout(() => resolve(messages), 500);
    });
    const result = (await Promise.race([received, fallback])) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;
    clearTimeout(timeout!);
    ws.close();

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('TICKET_CREATED');
    expect(result[0].payload).toEqual(
      expect.objectContaining({ ticketNumber: 'A-001', categoryId: catAId }),
    );
  });
});
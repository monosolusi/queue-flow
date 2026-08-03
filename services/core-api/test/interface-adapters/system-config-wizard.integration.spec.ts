import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { type ICategoryRepository, CATEGORY_REPOSITORY } from '../../src/domain/queue';
import {
  type ICounterRoutingRuleRepository,
  type ISystemConfigurationRepository,
  COUNTER_ROUTING_RULE_REPOSITORY,
  SYSTEM_CONFIGURATION_REPOSITORY,
} from '../../src/domain/store-config';
import { type IAuditLogRepository, AUDIT_LOG_REPOSITORY, AuditAction } from '../../src/domain/audit';
import { PriorityPolicy } from '../../src/domain/shared';
import {
  InMemoryAuditLogRepository,
  InMemoryCategoryRepository,
  InMemoryCounterRoutingRuleRepository,
  InMemorySystemConfigurationRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { projectStateMachine, type WizardCategoryDto } from '../../src/application/store-config';
import { StateMachine } from '../../src/domain/store-config';

/**
 * The PRD §7 reference wizard payload — 2 categories, 2 counters, the default
 * state machine, and the default daily-reset policy. The canonical fixture the
 * acceptance suite also seeds against.
 */
function wizardPayload() {
  return {
    storeName: 'Toko Contoh',
    stateMachine: projectStateMachine(StateMachine.DEFAULT),
    dailyReset: {
      mode: 'AUTOMATIC_CRON' as const,
      cronExpression: '0 0 * * *',
      resetTicketNumberTo: 1,
      archivePreviousDayData: true,
    },
    categories: [
      { code: 'A', name: 'Customer Service' },
      { code: 'B', name: 'Kasir & Pembayaran' },
    ] as WizardCategoryDto[],
    routingRules: [
      {
        counterId: 1,
        counterName: 'Loket 1',
        assignedCategoryCodes: ['A'],
        priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
      },
      {
        counterId: 2,
        counterName: 'Loket 2',
        assignedCategoryCodes: ['A', 'B'],
        priorityPolicy: PriorityPolicy.CATEGORY_PRIORITY,
      },
    ],
  };
}

/**
 * Integration: boots the real Nest app (in-memory) and exercises the first-run
 * wizard / system-config REST surface (QUE-30 / FR-WZD-01..06). This is the API
 * half of DoD-2: a clean store reports `isInitialSetupCompleted: false` and
 * queue operations are unavailable (409) until the wizard payload is saved,
 * after which setup completes, the state-machine read surface returns the saved
 * graph, and queue operations succeed.
 */
describe('System-config wizard REST surface (integration — QUE-30 / FR-WZD)', () => {
  let app: INestApplication;
  let config: ISystemConfigurationRepository;
  let categories: ICategoryRepository;
  let routingRules: ICounterRoutingRuleRepository;
  let auditLog: IAuditLogRepository;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    config = app.get(SYSTEM_CONFIGURATION_REPOSITORY);
    categories = app.get(CATEGORY_REPOSITORY);
    routingRules = app.get(COUNTER_ROUTING_RULE_REPOSITORY);
    auditLog = app.get(AUDIT_LOG_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    (config as InMemorySystemConfigurationRepository).clear();
    (categories as InMemoryCategoryRepository).clear();
    (routingRules as InMemoryCounterRoutingRuleRepository).clear();
    (auditLog as InMemoryAuditLogRepository).clear();
  });

  it('GET /api/system/config on a clean store returns isInitialSetupCompleted:false (FR-WZD-01)', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/config');
    expect(res.status).toBe(200);
    expect(res.body.isInitialSetupCompleted).toBe(false);
    // default-shaped so the wizard can prefill the PRD §7 default graph
    expect(res.body.stateMachine.states).toContain('WAITING');
    expect(res.body.stateMachine.transitions.length).toBeGreaterThan(0);
    expect(res.body.categories).toEqual([]);
    expect(res.body.routingRules).toEqual([]);
  });

  it('queue command endpoints 409 SYSTEM_NOT_CONFIGURED before the wizard completes', async () => {
    // call-next resolves the active transition policy first, which throws
    // SystemNotConfiguredException on a clean store — the pre-setup guard.
    const res = await request(app.getHttpServer())
      .post('/api/queue/call-next')
      .send({ counterId: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYSTEM_NOT_CONFIGURED');
  });

  it('GET /api/system/state-machine 409s before setup completes', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/state-machine');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYSTEM_NOT_CONFIGURED');
  });

  it('PUT /api/system/config saves the wizard payload and flips isInitialSetupCompleted (FR-WZD-06)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/system/config')
      .send(wizardPayload());

    expect(res.status).toBe(200);
    expect(res.body.isInitialSetupCompleted).toBe(true);
    expect(res.body.storeName).toBe('Toko Contoh');

    // The config is now persisted.
    const saved = await config.get();
    expect(saved).not.toBeNull();
    expect(saved!.isInitialSetupCompleted).toBe(true);
    expect(saved!.storeName).toBe('Toko Contoh');

    // Categories + routing rules were persisted.
    expect((await categories.getAll()).length).toBe(2);
    expect((await routingRules.getAll()).length).toBe(2);

    // GET now reflects the saved config.
    const getRes = await request(app.getHttpServer()).get('/api/system/config');
    expect(getRes.body.isInitialSetupCompleted).toBe(true);
    expect(getRes.body.storeName).toBe('Toko Contoh');
    expect(getRes.body.categories.map((c: { code: string }) => c.code)).toEqual(['A', 'B']);
    expect(getRes.body.routingRules.map((r: { counterId: number }) => r.counterId)).toEqual([1, 2]);
  });

  it('after the wizard completes, queue endpoints succeed and state-machine read returns the graph', async () => {
    await request(app.getHttpServer()).put('/api/system/config').send(wizardPayload());

    // The state-machine read surface now returns the saved graph.
    const sm = await request(app.getHttpServer()).get('/api/system/state-machine');
    expect(sm.status).toBe(200);
    expect(sm.body.states).toContain('WAITING');
    const callEdge = sm.body.transitions.find(
      (t: { from: string; to: string }) => t.from === 'WAITING' && t.to === 'CALLING',
    );
    expect(callEdge).toBeDefined();
    expect(callEdge.actionLabel).toBe('Panggil Berikutnya');

    // A kiosk ticket now succeeds (category id resolved via the saved master data).
    const catA = (await categories.getAll()).find((c) => c.code === 'A')!;
    const ticket = await request(app.getHttpServer())
      .post('/api/tickets')
      .send({ categoryId: catA.id.value });
    expect(ticket.status).toBe(201);
    expect(ticket.body.ticket.ticketNumber).toBe('A-001');
  });

  it('PUT records STATE_SCHEMA_CHANGE + ROUTING_CHANGE audit entries (NFR-SEC-02)', async () => {
    await request(app.getHttpServer()).put('/api/system/config').send(wizardPayload());

    const entries = await auditLog.list();
    const actions = entries.map((e) => e.action);
    expect(actions).toContain(AuditAction.STATE_SCHEMA_CHANGE);
    expect(actions).toContain(AuditAction.ROUTING_CHANGE);
    // every entry is attributed to the admin actor
    expect(entries.every((e) => e.actor === 'admin')).toBe(true);
  });

  it('PUT with a bad state machine (transition references unknown state) is 400', async () => {
    const bad = wizardPayload();
    bad.stateMachine = {
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'NOPE', actionLabel: 'x' }],
    };
    const res = await request(app.getHttpServer()).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
  });

  it('PUT with a routing rule referencing an unknown category code is 400', async () => {
    const bad = wizardPayload();
    bad.routingRules = [
      {
        counterId: 1,
        counterName: 'Loket 1',
        assignedCategoryCodes: ['Z'], // not in categories
        priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
      },
    ];
    const res = await request(app.getHttpServer()).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
  });

  it('PUT with a malformed (non-v4) categories[].id is 400 INVALID_VALUE_OBJECT, not 500', async () => {
    // Regression for QUE-31: a hand-crafted bad `categories[].id` must surface
    // as a domain error (400), not the 500 a plain `Error` escaped the filter
    // as. `Identifier.of` now throws `InvalidValueObjectException` (a
    // `DomainError`) so `DomainExceptionFilter` maps it to 400. Defense-in-depth
    // — the wizard client only echoes v4-validated ids from GET, so a bad id
    // never reaches the PUT in practice.
    const bad = wizardPayload();
    bad.categories = [
      { id: 'not-a-uuid', code: 'A', name: 'Customer Service' },
      { code: 'B', name: 'Kasir & Pembayaran' },
    ];
    const res = await request(app.getHttpServer()).put('/api/system/config').send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    // setup must NOT have silently completed on a rejected payload
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('re-saving fully replaces categories and routing rules (no dangling old rows)', async () => {
    await request(app.getHttpServer()).put('/api/system/config').send(wizardPayload());
    expect((await routingRules.getAll()).length).toBe(2);

    // Re-save with a single counter / single category.
    const replacement = wizardPayload();
    replacement.categories = [{ code: 'A', name: 'Customer Service' }];
    replacement.routingRules = [
      {
        counterId: 1,
        counterName: 'Loket 1',
        assignedCategoryCodes: ['A'],
        priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
      },
    ];
    const res = await request(app.getHttpServer()).put('/api/system/config').send(replacement);
    expect(res.status).toBe(200);

    expect((await categories.getAll()).length).toBe(1);
    expect((await routingRules.getAll()).length).toBe(1);
  });
});
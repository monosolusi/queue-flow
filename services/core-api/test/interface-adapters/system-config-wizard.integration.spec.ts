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
import { authHeader, bootstrapAuthedAdmin } from '../acceptance/_helpers';

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
    brandColor: '#aabbcc',
    serviceThemes: { kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' },
    tvPanelLayout: [
      { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
      { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
      { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
      { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
      { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
    ],
    edgeRoutingLayout: {},
    nodePositions: {},
    nodeActions: {},
    terminalNodes: { start: 'auto', end: 'auto' },
    endSources: [],
    printerConfiguration: { mode: 'chrome', paperWidth: 80, host: '', port: 9100, cutMode: 'partial', baudRate: 9600 },
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
  let token: string;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    config = app.get(SYSTEM_CONFIGURATION_REPOSITORY);
    categories = app.get(CATEGORY_REPOSITORY);
    routingRules = app.get(COUNTER_ROUTING_RULE_REPOSITORY);
    auditLog = app.get(AUDIT_LOG_REPOSITORY);
    // QUE-43: the wizard PUT is pre-setup-tokenless via AdminOrSetupGuard, but
    // the post-setup state-machine + call-next reads need an authenticated
    // bearer, and a *second* PUT after setup completes needs one too. Bootstrap
    // the admin once; sending the bearer on the pre-setup PUT is harmless
    // (AdminOrSetupGuard allows pre-setup regardless, attaching no principal, so
    // the audit actor stays the 'system' sentinel for the first save).
    token = await bootstrapAuthedAdmin(app);
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
    // clean store prefills the wizard's color input with the shared --accent
    // default (not black — a color input cannot represent empty).
    expect(res.body.brandColor).toBe('#2563eb');
  });

  it('queue command endpoints 409 SYSTEM_NOT_CONFIGURED before the wizard completes', async () => {
    // call-next resolves the active transition policy first, which throws
    // SystemNotConfiguredException on a clean store — the pre-setup guard.
    const res = await request(app.getHttpServer())
      .post('/api/queue/call-next')
      .set(authHeader(token))
      .send({ counterId: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYSTEM_NOT_CONFIGURED');
  });

  it('GET /api/system/state-machine 409s before setup completes', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/state-machine').set(authHeader(token));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYSTEM_NOT_CONFIGURED');
  });

  it('PUT /api/system/config saves the wizard payload and flips isInitialSetupCompleted (FR-WZD-06)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/system/config').set(authHeader(token))
      .send(wizardPayload());

    expect(res.status).toBe(200);
    expect(res.body.isInitialSetupCompleted).toBe(true);
    expect(res.body.storeName).toBe('Toko Contoh');
    expect(res.body.brandColor).toBe('#aabbcc');

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
    expect(getRes.body.brandColor).toBe('#aabbcc');
  });

  it('after the wizard completes, queue endpoints succeed and state-machine read returns the graph', async () => {
    await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(wizardPayload());

    // The state-machine read surface now returns the saved graph.
    const sm = await request(app.getHttpServer()).get('/api/system/state-machine').set(authHeader(token));
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
    await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(wizardPayload());

    const entries = await auditLog.list();
    const actions = entries.map((e) => e.action);
    expect(actions).toContain(AuditAction.STATE_SCHEMA_CHANGE);
    expect(actions).toContain(AuditAction.ROUTING_CHANGE);
    // QUE-43: the wizard save runs pre-setup, so AdminOrSetupGuard attaches no
    // principal even when a bearer is sent — the audit actor is the 'system'
    // sentinel (the setup act itself, attributable to the system, not a user).
    // Post-setup re-saves would attribute to the authenticated admin's username.
    expect(entries.every((e) => e.actor === 'system')).toBe(true);
  });

  it('PUT with a bad state machine (transition references unknown state) is 400', async () => {
    const bad = wizardPayload();
    bad.stateMachine = {
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'NOPE', actionLabel: 'x', action: 'UPDATE_STATUS' }],
      descriptions: {},
    };
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
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
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
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
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    // setup must NOT have silently completed on a rejected payload
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('re-saving fully replaces categories and routing rules (no dangling old rows)', async () => {
    await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(wizardPayload());
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
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(replacement);
    expect(res.status).toBe(200);

    expect((await categories.getAll()).length).toBe(1);
    expect((await routingRules.getAll()).length).toBe(1);
  });

  it('PUT with a malformed brand color is 400 (QUE-36)', async () => {
    const bad = wizardPayload();
    bad.brandColor = 'not-a-color';
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    // setup must NOT have silently completed on a rejected payload
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT accepts an oklch brand color (direct-API grammar — QUE-36)', async () => {
    const payload = wizardPayload();
    payload.brandColor = 'oklch(0.7 0.15 200)';
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(payload);
    expect(res.status).toBe(200);
    expect(res.body.brandColor).toBe('oklch(0.7 0.15 200)');

    const getRes = await request(app.getHttpServer()).get('/api/system/config');
    expect(getRes.body.brandColor).toBe('oklch(0.7 0.15 200)');
  });

  it('PUT with a missing required top-level field is 400, not 500 (boundary presence guard)', async () => {
    // A missing field dereferences `undefined` in the use case (e.g.
    // `[...undefined]`, `undefined.trim()`) → a TypeError that is NOT a
    // DomainError, so DomainExceptionFilter lets it surface as 500. The
    // controller guards presence at the boundary so it is 400 instead.
    const { stateMachine: _omit, ...bad } = wizardPayload();
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);

    // Setup must NOT have silently completed on a rejected payload.
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT with a present-but-wrong-type field is 400, not 500 (boundary shape guard)', async () => {
    // A field that is present but the wrong type (e.g. `stateMachine: "WAITING"`)
    // passes the presence guard, then reaches the use case where
    // `[...dto.states]` throws a TypeError (NOT a DomainError) → 500, before
    // the value object can throw a clean InvalidValueObjectException. The
    // controller guards top-level shape at the boundary so it is 400 instead.
    const bad = wizardPayload() as unknown as Record<string, unknown>;
    bad.stateMachine = 'WAITING'; // string instead of { states, transitions }
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);

    // Setup must NOT have silently completed on a rejected payload.
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);

    // A non-iterable categories field (number) would also TypeError in
    // `buildCategories`'s `for...of` — confirm it is 400 too.
    const bad2 = wizardPayload() as unknown as Record<string, unknown>;
    bad2.categories = 1;
    const res2 = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad2);
    expect(res2.status).toBe(400);
  });

  it('PUT with a nested-wrong-type field is 400, not 500 (boundary nested-shape guard)', async () => {
    // A top-level-correct-but-nested-wrong-type payload passes the presence +
    // top-level shape guards, then reaches the use case where a spread / map /
    // .trim() on a non-string/non-iterable sub-field throws a TypeError (NOT a
    // DomainError) → 500, before the value object can throw a clean
    // InvalidValueObjectException. The controller guards nested shapes at the
    // boundary so it is 400 instead. Each case below is one that would 500.
    const cfg0 = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg0.body.isInitialSetupCompleted).toBe(false);

    // stateMachine.states non-iterable → `[...5]` TypeError.
    const badStates = wizardPayload() as unknown as Record<string, unknown>;
    badStates.stateMachine = { states: 5, transitions: [] };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(badStates)).status,
    ).toBe(400);

    // stateMachine.transitions non-array → `(5).map` TypeError.
    const badTrans = wizardPayload() as unknown as Record<string, unknown>;
    badTrans.stateMachine = { states: ['WAITING'], transitions: 5 };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(badTrans)).status,
    ).toBe(400);

    // dailyReset.cronExpression non-string → `(5).trim()` TypeError in
    // isValidCronExpression (AUTOMATIC_CRON mode).
    const badCron = wizardPayload() as unknown as Record<string, unknown>;
    badCron.dailyReset = { mode: 'AUTOMATIC_CRON', cronExpression: 5, resetTicketNumberTo: 1, archivePreviousDayData: true };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(badCron)).status,
    ).toBe(400);

    // routingRules[].assignedCategoryCodes non-array → `(5).map` TypeError.
    const badCodes = wizardPayload() as unknown as Record<string, unknown>;
    badCodes.routingRules = [
      { counterId: 1, counterName: 'Loket 1', assignedCategoryCodes: 5, priorityPolicy: PriorityPolicy.FIFO_GLOBAL },
    ];
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(badCodes)).status,
    ).toBe(400);

    // dailyReset.timezone non-string → `(5).trim()` TypeError in
    // DailyResetPolicy.of (timezone is optional but a non-string crashes).
    const badTz = wizardPayload() as unknown as Record<string, unknown>;
    badTz.dailyReset = { mode: 'AUTOMATIC_CRON', cronExpression: '0 0 * * *', resetTicketNumberTo: 1, archivePreviousDayData: true, timezone: 5 };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(badTz)).status,
    ).toBe(400);

    // categories[].name non-string → `(5).trim()` TypeError in the Category
    // ctor before it can throw InvalidValueObjectException.
    const badCatName = wizardPayload() as unknown as Record<string, unknown>;
    badCatName.categories = [{ code: 'A', name: 5 }];
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(badCatName)).status,
    ).toBe(400);

    // categories: [null] → `null.code` TypeError in the use case.
    const badCatNull = wizardPayload() as unknown as Record<string, unknown>;
    badCatNull.categories = [null];
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(badCatNull)).status,
    ).toBe(400);

    // routingRules: [null] → `null.counterId` TypeError in the use case.
    const badRuleNull = wizardPayload() as unknown as Record<string, unknown>;
    badRuleNull.routingRules = [null];
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(badRuleNull)).status,
    ).toBe(400);

    // None of the rejected payloads silently completed setup.
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT with a missing nodeActions field is 400, not 500 (boundary presence guard)', async () => {
    // nodeActions is now a required top-level field — a missing one must 400
    // (not 500 when the use case dereferences `undefined`).
    const { nodeActions: _omit, ...bad } = wizardPayload();
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT with a malformed nodeActions (non-object / non-array entry / non-string field) is 400 (boundary nested-shape guard)', async () => {
    // nodeActions present but a string → top-level shape guard (object).
    const bad1 = wizardPayload() as unknown as Record<string, unknown>;
    bad1.nodeActions = 'not-an-object';
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad1)).status,
    ).toBe(400);

    // nodeActions entry value not an array → nested-shape guard (would
    // TypeError in the VO's `Array.isArray`/iteration before a clean throw).
    const bad2 = wizardPayload() as unknown as Record<string, unknown>;
    bad2.nodeActions = { WAITING: 'not-an-array' };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad2)).status,
    ).toBe(400);

    // nodeActions action element non-object → nested-shape guard.
    const bad3 = wizardPayload() as unknown as Record<string, unknown>;
    bad3.nodeActions = { WAITING: ['not-an-object'] };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad3)).status,
    ).toBe(400);

    // nodeActions action field non-string (executionType) → nested-shape guard
    // (a non-string enum would TypeError in the VO's `includes` check before
    // it can throw a clean InvalidValueObjectException).
    const bad4 = wizardPayload() as unknown as Record<string, unknown>;
    bad4.nodeActions = { WAITING: [{ executionType: 5, type: 'UPDATE_STATUS', value: 'CALLING' }] };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad4)).status,
    ).toBe(400);

    // nodeActions action field non-string (value) → nested-shape guard.
    const bad5 = wizardPayload() as unknown as Record<string, unknown>;
    bad5.nodeActions = { WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 5 }] };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad5)).status,
    ).toBe(400);

    // None of the rejected payloads silently completed setup.
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT with a nodeActions value that is not a state is 400 (cross-check, INVALID_VALUE_OBJECT)', async () => {
    // WAITING is a real state, but the action target NOPE is not — the use-case
    // value-membership cross-check throws InvalidValueObjectException → 400.
    const bad = wizardPayload() as unknown as Record<string, unknown>;
    bad.nodeActions = { WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'NOPE' }] };
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT saves nodeActions and a re-GET returns them (round-trip, Kaleo parity)', async () => {
    const actions = {
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
      CALLING: [{ executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' }],
    };
    const payload = wizardPayload() as unknown as Record<string, unknown>;
    payload.nodeActions = actions;
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(payload);
    expect(res.status).toBe(200);
    expect(res.body.nodeActions).toEqual(actions);

    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.nodeActions).toEqual(actions);
  });

  it('PUT with a malformed stateMachine.descriptions (non-object / non-string value) is 400 (boundary nested-shape guard)', async () => {
    // descriptions present but a string → nested-shape guard (plain object).
    const bad1 = wizardPayload() as unknown as Record<string, unknown>;
    bad1.stateMachine = { ...(bad1.stateMachine as object), descriptions: 'not-an-object' };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad1)).status,
    ).toBe(400);

    // descriptions present but an array → nested-shape guard (plain object).
    const bad2 = wizardPayload() as unknown as Record<string, unknown>;
    bad2.stateMachine = { ...(bad2.stateMachine as object), descriptions: ['WAITING'] };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad2)).status,
    ).toBe(400);

    // descriptions value non-string → nested-shape guard.
    const bad3 = wizardPayload() as unknown as Record<string, unknown>;
    bad3.stateMachine = { ...(bad3.stateMachine as object), descriptions: { WAITING: 5 } };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad3)).status,
    ).toBe(400);

    // None of the rejected payloads silently completed setup.
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT accepts an absent stateMachine.descriptions (backward-compat, lazy key) and a re-GET returns {}', async () => {
    // A legacy payload that omits `descriptions` from the stateMachine object
    // is accepted (the VO recovers `undefined` to DEFAULT; no SQL migration).
    const payload = wizardPayload();
    const { descriptions: _omit, ...smWithoutDescriptions } = payload.stateMachine;
    void _omit;
    const res = await request(app.getHttpServer())
      .put('/api/system/config')
      .set(authHeader(token))
      .send({ ...payload, stateMachine: smWithoutDescriptions });
    expect(res.status).toBe(200);
    // The PUT result does not echo `stateMachine` (only top-level config
    // fields); the re-GET is the authoritative round-trip check.
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.stateMachine.descriptions).toEqual({});
  });

  it('PUT saves stateMachine.descriptions and a re-GET returns them (round-trip)', async () => {
    const descriptions = {
      WAITING: 'Tiket menunggu dipanggil',
      CALLING: 'Sedang dipanggil ke counter',
    };
    const payload = wizardPayload() as unknown as Record<string, unknown>;
    payload.stateMachine = { ...(payload.stateMachine as object), descriptions };
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(payload);
    expect(res.status).toBe(200);
    // The PUT result does not echo `stateMachine`; the re-GET is the
    // authoritative round-trip check.
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.stateMachine.descriptions).toEqual(descriptions);
  });

  it('PUT with a stateMachine.descriptions key that is not a state is 400 (cross-check, INVALID_VALUE_OBJECT)', async () => {
    // NOPE is not a state in the default state machine — the use-case
    // state-membership cross-check throws InvalidValueObjectException → 400.
    const bad = wizardPayload() as unknown as Record<string, unknown>;
    bad.stateMachine = { ...(bad.stateMachine as object), descriptions: { NOPE: 'A description' } };
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT with a missing terminalNodes field is 400, not 500 (boundary presence guard)', async () => {
    // terminalNodes is now a required top-level field — a missing one must 400
    // (not 500 when the use case dereferences `undefined`).
    const { terminalNodes: _omit, ...bad } = wizardPayload();
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT with a malformed terminalNodes (non-object / array / bad terminal value) is 400 (boundary nested-shape guard)', async () => {
    // terminalNodes present but a string → top-level shape guard (object).
    const bad1 = wizardPayload() as unknown as Record<string, unknown>;
    bad1.terminalNodes = 'not-an-object';
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad1)).status,
    ).toBe(400);

    // terminalNodes present but an array → top-level shape guard (object).
    const bad2 = wizardPayload() as unknown as Record<string, unknown>;
    bad2.terminalNodes = ['auto'];
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad2)).status,
    ).toBe(400);

    // terminalNodes.start a number (not 'auto'/'hidden'/a plain {x,y}) →
    // nested-shape guard (would TypeError in the VO before a clean throw).
    const bad3 = wizardPayload() as unknown as Record<string, unknown>;
    bad3.terminalNodes = { start: 5, end: 'auto' };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad3)).status,
    ).toBe(400);

    // terminalNodes.end.x a non-number → nested-shape guard.
    const bad4 = wizardPayload() as unknown as Record<string, unknown>;
    bad4.terminalNodes = { start: 'auto', end: { x: 'five', y: 0 } };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad4)).status,
    ).toBe(400);

    // None of the rejected payloads silently completed setup.
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT with a bad terminal string (not "auto"/"hidden") is 400 (VO of())', async () => {
    const bad = wizardPayload() as unknown as Record<string, unknown>;
    bad.terminalNodes = { start: 'bad', end: 'auto' };
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT saves terminalNodes (hidden start + pinned end) and a re-GET returns them (round-trip)', async () => {
    const tn = { start: 'hidden', end: { x: 320, y: 240 } };
    const payload = wizardPayload() as unknown as Record<string, unknown>;
    payload.terminalNodes = tn;
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(payload);
    expect(res.status).toBe(200);
    expect(res.body.terminalNodes).toEqual(tn);

    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.terminalNodes).toEqual(tn);
  });

  it('a clean store prefills terminalNodes with { start: "auto", end: "auto" } (derived markers)', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/config');
    expect(res.status).toBe(200);
    expect(res.body.terminalNodes).toEqual({ start: 'auto', end: 'auto' });
  });

  it('PUT with a missing endSources field is 400, not 500 (boundary presence guard)', async () => {
    // endSources is a required top-level field — a missing one must 400 (not 500
    // when the use case dereferences `undefined`).
    const { endSources: _omit, ...bad } = wizardPayload();
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT with a malformed endSources (non-array / non-string entry) is 400 (boundary shape guard)', async () => {
    // endSources present but a string → top-level shape guard (array).
    const bad1 = wizardPayload() as unknown as Record<string, unknown>;
    bad1.endSources = 'WAITING';
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad1)).status,
    ).toBe(400);

    // endSources present but an object → top-level shape guard (array).
    const bad2 = wizardPayload() as unknown as Record<string, unknown>;
    bad2.endSources = { WAITING: true };
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad2)).status,
    ).toBe(400);

    // endSources entry a non-string → nested-shape guard (would TypeError in the
    // VO before a clean throw on a non-string element).
    const bad3 = wizardPayload() as unknown as Record<string, unknown>;
    bad3.endSources = ['WAITING', 5];
    expect(
      (await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad3)).status,
    ).toBe(400);

    // None of the rejected payloads silently completed setup.
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT with an endSources entry that is not a state is 400 (cross-check, INVALID_VALUE_OBJECT)', async () => {
    const bad = wizardPayload() as unknown as Record<string, unknown>;
    bad.endSources = ['NOPE'];
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.isInitialSetupCompleted).toBe(false);
  });

  it('PUT saves endSources (multiple explicit end sources) and a re-GET returns them (round-trip)', async () => {
    const sources = ['WAITING', 'COMPLETED'];
    const payload = wizardPayload() as unknown as Record<string, unknown>;
    payload.endSources = sources;
    const res = await request(app.getHttpServer()).put('/api/system/config').set(authHeader(token)).send(payload);
    expect(res.status).toBe(200);
    expect(res.body.endSources).toEqual(sources);

    const cfg = await request(app.getHttpServer()).get('/api/system/config');
    expect(cfg.body.endSources).toEqual(sources);
  });

  it('a clean store prefills endSources with [] (none recorded)', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/config');
    expect(res.status).toBe(200);
    expect(res.body.endSources).toEqual([]);
  });
});

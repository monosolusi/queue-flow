import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import {
  type ISystemConfigurationRepository,
  SYSTEM_CONFIGURATION_REPOSITORY,
} from '../../src/domain/store-config';
import { type IAuditLogRepository, AUDIT_LOG_REPOSITORY, AuditAction } from '../../src/domain/audit';
import { PriorityPolicy } from '../../src/domain/shared';
import {
  InMemoryAuditLogRepository,
  InMemorySystemConfigurationRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { DailyResetSchedulerService } from '../../src/infrastructure/scheduler/daily-reset-scheduler.service';
import { projectStateMachine } from '../../src/application/store-config';
import { StateMachine } from '../../src/domain/store-config';

/**
 * Integration: boots the real Nest app (in-memory) and exercises the QUE-32
 * dynamic scheduler re-arm + backend cron-format enforcement +
 * `DAILY_RESET_POLICY_CHANGE` audit on the `PUT /api/system/config` surface.
 *
 * The scheduler's `armedCronExpression` (an observability seam on
 * `DailyResetSchedulerService`) and the `SchedulerRegistry` membership are the
 * two observables proving the cron is re-armed / disarmed post-commit without a
 * process restart.
 */
describe('System-config scheduler re-arm + cron enforcement (integration — QUE-32)', () => {
  let app: INestApplication;
  let systemConfig: ISystemConfigurationRepository;
  let auditLog: IAuditLogRepository;
  let scheduler: DailyResetSchedulerService;
  let registry: SchedulerRegistry;

  function wizardPayload(dailyReset: Record<string, unknown> = defaultDailyReset()) {
    return {
      storeName: 'Toko Contoh',
      stateMachine: projectStateMachine(StateMachine.DEFAULT),
      dailyReset,
      categories: [
        { code: 'A', name: 'Customer Service' },
        { code: 'B', name: 'Kasir & Pembayaran' },
      ],
      routingRules: [
        {
          counterId: 1,
          counterName: 'Loket 1',
          assignedCategoryCodes: ['A', 'B'],
          priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
        },
      ],
      brandColor: '#2563eb',
    };
  }

  function defaultDailyReset() {
    return {
      mode: 'AUTOMATIC_CRON' as const,
      cronExpression: '0 0 * * *',
      resetTicketNumberTo: 1,
      archivePreviousDayData: true,
    };
  }

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    systemConfig = app.get(SYSTEM_CONFIGURATION_REPOSITORY);
    auditLog = app.get(AUDIT_LOG_REPOSITORY);
    scheduler = app.get(DailyResetSchedulerService);
    registry = app.get(SchedulerRegistry);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    (systemConfig as InMemorySystemConfigurationRepository).clear();
    (auditLog as InMemoryAuditLogRepository).clear();
    // Re-sync the scheduler to the cleared (unconfigured) state so each test
    // starts from a disarmed, idle scheduler regardless of the previous test.
    await scheduler.reArm();
  });

  it('the boot-time scheduler is idle before the wizard completes (no cron registered)', () => {
    expect(scheduler.armedCronExpression).toBeNull();
    expect(registry.doesExist('cron', 'daily-reset')).toBe(false);
  });

  it('PUT /api/system/config (initial wizard save) arms the cron without a restart', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/system/config')
      .send(wizardPayload());
    expect(res.status).toBe(200);

    expect(scheduler.armedCronExpression).toBe('0 0 * * *');
    expect(registry.doesExist('cron', 'daily-reset')).toBe(true);
  });

  it('changing the cron expression via PUT re-arms to the new expression', async () => {
    await request(app.getHttpServer()).put('/api/system/config').send(wizardPayload());
    expect(scheduler.armedCronExpression).toBe('0 0 * * *');

    const res = await request(app.getHttpServer())
      .put('/api/system/config')
      .send(
        wizardPayload({
          ...defaultDailyReset(),
          cronExpression: '0 1 * * *',
        }),
      );
    expect(res.status).toBe(200);

    expect(scheduler.armedCronExpression).toBe('0 1 * * *');
    expect(registry.doesExist('cron', 'daily-reset')).toBe(true);
  });

  it('switching to MANUAL mode disarms the cron', async () => {
    await request(app.getHttpServer()).put('/api/system/config').send(wizardPayload());
    expect(scheduler.armedCronExpression).toBe('0 0 * * *');

    const res = await request(app.getHttpServer())
      .put('/api/system/config')
      .send(
        wizardPayload({
          mode: 'MANUAL',
          cronExpression: null,
          resetTicketNumberTo: 1,
          archivePreviousDayData: true,
        }),
      );
    expect(res.status).toBe(200);

    expect(scheduler.armedCronExpression).toBeNull();
    expect(registry.doesExist('cron', 'daily-reset')).toBe(false);
  });

  it('a malformed cron expression is rejected with 400 and the cron is NOT re-armed', async () => {
    // Arm a valid cron first so we can prove a rejected save leaves it intact.
    await request(app.getHttpServer()).put('/api/system/config').send(wizardPayload());
    expect(scheduler.armedCronExpression).toBe('0 0 * * *');

    const res = await request(app.getHttpServer())
      .put('/api/system/config')
      .send(
        wizardPayload({
          ...defaultDailyReset(),
          cronExpression: '0 99 * * *', // minute out of range
        }),
      );

    // 400 — the VO rejects the malformed cron at construction (before the tx
    // opens), so the config is not persisted and the scheduler is untouched.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE_OBJECT');
    expect(scheduler.armedCronExpression).toBe('0 0 * * *');
    expect(registry.doesExist('cron', 'daily-reset')).toBe(true);
  });

  it('records a DAILY_RESET_POLICY_CHANGE audit entry when the policy changes, but not when it does not', async () => {
    // Initial save — policy goes from nonexistent to set → audited (before null).
    await request(app.getHttpServer()).put('/api/system/config').send(wizardPayload());

    // Change the cron → audited with before/after.
    await request(app.getHttpServer())
      .put('/api/system/config')
      .send(wizardPayload({ ...defaultDailyReset(), cronExpression: '0 2 * * *' }));

    // Re-save with the SAME policy (only the store name changes) → NOT audited.
    await request(app.getHttpServer())
      .put('/api/system/config')
      .send({ ...wizardPayload({ ...defaultDailyReset(), cronExpression: '0 2 * * *' }), storeName: 'Toko Baru' });

    const policyChanges = (await auditLog.list()).filter(
      (e) => e.action === AuditAction.DAILY_RESET_POLICY_CHANGE,
    );
    expect(policyChanges).toHaveLength(2); // initial setup + the cron change
    expect(policyChanges[0].before).toBeNull();
    expect(policyChanges[0].after).toMatchObject({ cronExpression: '0 0 * * *' });
    expect(policyChanges[1].before).toMatchObject({ cronExpression: '0 0 * * *' });
    expect(policyChanges[1].after).toMatchObject({ cronExpression: '0 2 * * *' });
  });

  it('does not churn the cron when a save leaves the policy unchanged', async () => {
    await request(app.getHttpServer()).put('/api/system/config').send(wizardPayload());
    const armedAfterInitial = scheduler.armedCronExpression;

    // Re-save with an unchanged policy (rename the store only).
    await request(app.getHttpServer())
      .put('/api/system/config')
      .send({ ...wizardPayload(), storeName: 'Toko Lain' });

    expect(scheduler.armedCronExpression).toBe(armedAfterInitial); // still '0 0 * * *'
    expect(registry.doesExist('cron', 'daily-reset')).toBe(true);
  });
});
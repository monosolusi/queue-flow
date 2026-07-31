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
import {
  type ICounterRoutingRuleRepository,
  type ISystemConfigurationRepository,
  COUNTER_ROUTING_RULE_REPOSITORY,
  SYSTEM_CONFIGURATION_REPOSITORY,
  CounterRoutingRule,
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
  InMemoryAuditLogRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { AUDIT_LOG_REPOSITORY } from '../../src/domain/audit';
import type { IQueueEventPublisher } from '../../src/domain/queue';
import { QUEUE_EVENT_PUBLISHER } from '../../src/domain/queue';

/** A booted in-memory app + the ephemeral port it listens on. */
export interface BootedApp {
  readonly app: INestApplication;
  readonly port: number;
}

/** The PRD §7 reference config — store name, 2 categories, 2 routings, the
 * default state machine + daily-reset policy. The authoritative fixture. */
export const PRD_STORE_NAME = 'Toko Utama Surabaya';
export const PRD_CATEGORY_A = { code: 'A', name: 'Customer Service' };
export const PRD_CATEGORY_B = { code: 'B', name: 'Kasir & Pembayaran' };

/** PRD §7 wizard payload (PUT /api/system/config body) — categories referenced
 * by code; the use case resolves codes to ids. Mirrors §7 exactly. */
export function prdWizardPayload() {
  return {
    storeName: PRD_STORE_NAME,
    stateMachine: {
      initial_state: 'WAITING',
      states: ['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
        { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
        { from: 'CALLING', to: 'SKIPPED', actionLabel: 'Lewati / Absen' },
        { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang' },
        { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan' },
      ],
    },
    dailyReset: {
      mode: 'AUTOMATIC_CRON',
      cronExpression: '0 0 * * *',
      resetTicketNumberTo: 1,
      archivePreviousDayData: true,
    },
    categories: [PRD_CATEGORY_A, PRD_CATEGORY_B],
    routingRules: [
      {
        counterId: 1,
        counterName: 'Counter 1 (CS)',
        assignedCategoryCodes: ['A'],
        priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
      },
      {
        counterId: 2,
        counterName: 'Counter 2 (Serbaguna)',
        assignedCategoryCodes: ['A', 'B'],
        priorityPolicy: PriorityPolicy.CATEGORY_PRIORITY,
      },
    ],
    actor: 'admin',
  };
}

/** Boots the real NestJS app against the in-memory persistence profile
 * (QMS_PERSISTENCE unset → in-memory) on an ephemeral port. The WS adapter is
 * attached so /ws shares the HTTP port — the same boot the production
 * `main.ts` uses, minus the fixed port. */
export async function createApp(): Promise<BootedApp> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(0);
  const port = (app.getHttpServer().address() as { port: number }).port;
  return { app, port };
}

/** Clears every in-memory repository so each test starts from a clean store.
 * Casts to the `InMemory*` concretion to reach the test-only `clear()` method. */
export function clearRepos(app: INestApplication): void {
  (app.get(QUEUE_REPOSITORY) as InMemoryQueueRepository).clear();
  (app.get(SEQUENCE_REPOSITORY) as InMemorySequenceRepository).clear();
  (app.get(CATEGORY_REPOSITORY) as InMemoryCategoryRepository).clear();
  (app.get(COUNTER_ROUTING_RULE_REPOSITORY) as InMemoryCounterRoutingRuleRepository).clear();
  (app.get(SYSTEM_CONFIGURATION_REPOSITORY) as InMemorySystemConfigurationRepository).clear();
  (app.get(AUDIT_LOG_REPOSITORY) as InMemoryAuditLogRepository).clear();
}

/** Resolves the repo tokens from a booted app (for direct seeding). */
export function repos(app: INestApplication) {
  return {
    queue: app.get(QUEUE_REPOSITORY) as IQueueRepository,
    sequences: app.get(SEQUENCE_REPOSITORY) as ISequenceRepository,
    categories: app.get(CATEGORY_REPOSITORY) as ICategoryRepository,
    routingRules: app.get(COUNTER_ROUTING_RULE_REPOSITORY) as ICounterRoutingRuleRepository,
    systemConfig: app.get(SYSTEM_CONFIGURATION_REPOSITORY) as ISystemConfigurationRepository,
    publisher: app.get(QUEUE_EVENT_PUBLISHER) as IQueueEventPublisher,
  };
}

/** Seeds the PRD §7 config + 2 categories + 2 routings directly through the
 * repo tokens (Path A — full control, no HTTP). Completes initial setup so the
 * transition-policy resolver yields the default state machine. Returns the
 * generated category ids. */
export async function seedPrdConfig(app: INestApplication): Promise<{
  catAId: string;
  catBId: string;
}> {
  const { categories, routingRules, systemConfig } = repos(app);
  const catA = new Category(Identifier.generate(), 'A', 'Customer Service');
  const catB = new Category(Identifier.generate(), 'B', 'Kasir & Pembayaran');
  await categories.save(catA);
  await categories.save(catB);

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

  const config = SystemConfiguration.create(Identifier.generate(), PRD_STORE_NAME);
  config.completeInitialSetup();
  await systemConfig.save(config);

  return { catAId: catA.id.value, catBId: catB.id.value };
}

/** A supertest agent bound to the booted app's HTTP server. */
export function http(app: INestApplication) {
  return request(app.getHttpServer());
}

/** Wire envelope shape broadcast over /ws. */
export interface WireEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAt: number;
  readonly version: number;
  readonly payload: Record<string, unknown>;
}

/** Opens a WS client on /ws. Resolves once open; rejects on error. */
export function openWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * Opens a WS client, runs `action` (which should drive an endpoint that
 * broadcasts), and resolves the first `count` messages received. Races a
 * `timeoutMs` fallback so a missing broadcast resolves with whatever arrived
 * (usually `[]`) instead of hanging the suite. Mirrors the canonical
 * integration-spec helper.
 */
export async function collectMessages(
  port: number,
  count: number,
  action: () => Promise<void>,
  timeoutMs = 500,
): Promise<WireEvent[]> {
  const ws = await openWs(port);
  const messages: WireEvent[] = [];
  const received = new Promise<WireEvent[]>((resolve) => {
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as WireEvent);
      if (messages.length >= count) resolve(messages);
    });
  });
  await action();
  const fallback = new Promise<WireEvent[]>((resolve) => {
    setTimeout(() => resolve(messages), timeoutMs);
  });
  const result = await Promise.race([received, fallback]);
  ws.close();
  return result;
}
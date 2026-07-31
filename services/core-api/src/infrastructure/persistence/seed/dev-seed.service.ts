import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type ICategoryRepository,
  type IQueueRepository,
  type ISequenceRepository,
  QUEUE_REPOSITORY,
  CATEGORY_REPOSITORY,
  SEQUENCE_REPOSITORY,
  Category,
  QueueTicket,
  ticketIdGenerate,
} from '../../../domain/queue';
import {
  type ICounterRoutingRuleRepository,
  type ISystemConfigurationRepository,
  CounterRoutingRule,
  COUNTER_ROUTING_RULE_REPOSITORY,
  SYSTEM_CONFIGURATION_REPOSITORY,
  SystemConfiguration,
} from '../../../domain/store-config';
import { Identifier } from '../../../domain/shared';
import { PriorityPolicy } from '../../../domain/shared/priority-policy';
import { toDateKey } from '../../../application/queue';

/**
 * DEV-ONLY seed. Populates the in-memory repositories with the PRD §7 reference
 * configuration (two categories, two counters, a few WAITING tickets) so the
 * caller workspace has something to display during local development. Real
 * configuration persistence is QUE-13 / QUE-24; this exists only to give the
 * local runtime sample data before the database lands.
 *
 * Gated by `QMS_DEV_SEED=1` so unit/integration tests that boot {@link AppModule}
 * stay deterministic and do not inherit seed data; tests seed their own data
 * by injecting the repository tokens directly. Idempotent: if any routing rule
 * already exists it leaves the store untouched.
 *
 * Seeded ticket numbers are reserved through {@link ISequenceRepository} (not
 * hardcoded) so the per-category sequence counters advance in lockstep with
 * the seeded tickets — otherwise the first real kiosk ticket (QUE-9
 * `CreateTicketUseCase`) would re-issue `A-001` and collide with a seeded
 * ticket. Tickets are still built via `reconstitute` (no domain events) so
 * seeding does not broadcast over the WS gateway.
 *
 * Also seeds a default *completed* {@link SystemConfiguration} (the default
 * state machine + default daily-reset policy) so the active-policy resolver can
 * return a policy in dev and the caller command endpoints work without the
 * first-run wizard (QUE-13). Real configuration persistence is the wizard's job;
 * this exists only so the local runtime is operable before the wizard lands.
 */
@Injectable()
export class DevSeedService implements OnModuleInit {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: IQueueRepository,
    @Inject(COUNTER_ROUTING_RULE_REPOSITORY)
    private readonly routingRules: ICounterRoutingRuleRepository,
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
    @Inject(SEQUENCE_REPOSITORY) private readonly sequences: ISequenceRepository,
    @Inject(SYSTEM_CONFIGURATION_REPOSITORY)
    private readonly systemConfig: ISystemConfigurationRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.QMS_DEV_SEED !== '1') {
      return;
    }

    // Seed the default system configuration first (idempotent) so the
    // active-policy resolver has a config to read. Done before the routing-rule
    // guard so a partial seed (rules present, config missing) still backfills
    // the config.
    if (!(await this.systemConfig.get())) {
      const config = SystemConfiguration.create(Identifier.generate(), 'QMS Dev Store');
      config.completeInitialSetup();
      await this.systemConfig.save(config);
    }

    if ((await this.routingRules.getAll()).length > 0) {
      return; // already seeded — never clobber existing config
    }

    // PRD §7 categories. Category ids are UUIDs (the entity's Identifier); the
    // routing rules and tickets reference those same UUIDs so the caller read
    // side joins cleanly (ListCountersUseCase maps by category id).
    const catA = new Category(Identifier.generate(), 'A', 'Customer Service');
    const catB = new Category(Identifier.generate(), 'B', 'Kasir & Pembayaran');
    await this.categories.save(catA);
    await this.categories.save(catB);
    const aId = catA.id.value;
    const bId = catB.id.value;

    // PRD §7 routings.
    await this.routingRules.save(
      CounterRoutingRule.create(
        Identifier.generate(),
        1,
        'Counter 1 (CS)',
        [aId],
        PriorityPolicy.FIFO_GLOBAL,
      ),
    );
    await this.routingRules.save(
      CounterRoutingRule.create(
        Identifier.generate(),
        2,
        'Counter 2 (Serbaguna)',
        [aId, bId],
        PriorityPolicy.CATEGORY_PRIORITY,
      ),
    );

    // A few WAITING tickets across both categories so the workspace's waiting
    // list renders immediately on first open. Numbers are reserved via the
    // sequence repo so the counters stay consistent with the seeded tickets;
    // the tickets themselves are reconstituted (no events) so the WS gateway
    // stays quiet during seeding.
    const base = Date.now();
    const dateKey = toDateKey(base);
    const seedPlan = [
      { category: aId, code: 'A', createdAt: base - 30_000 },
      { category: aId, code: 'A', createdAt: base - 20_000 },
      { category: bId, code: 'B', createdAt: base - 10_000 },
    ];
    for (const t of seedPlan) {
      const ticketNumber = await this.sequences.nextTicketNumber(t.category, t.code, dateKey);
      const ticket = QueueTicket.reconstitute({
        id: ticketIdGenerate(),
        ticketNumber,
        categoryId: t.category,
        status: 'WAITING',
        counterId: null,
        createdAt: t.createdAt,
        updatedAt: t.createdAt,
      });
      await this.queue.save(ticket);
    }
  }
}
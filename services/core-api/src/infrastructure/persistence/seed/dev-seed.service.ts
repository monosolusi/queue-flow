import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type ICategoryRepository,
  type IQueueRepository,
  QUEUE_REPOSITORY,
  CATEGORY_REPOSITORY,
  Category,
  QueueTicket,
  TicketNumber,
  ticketIdGenerate,
} from '../../../domain/queue';
import {
  type ICounterRoutingRuleRepository,
  CounterRoutingRule,
  COUNTER_ROUTING_RULE_REPOSITORY,
} from '../../../domain/store-config';
import { Identifier } from '../../../domain/shared';
import { PriorityPolicy } from '../../../domain/shared/priority-policy';

/**
 * DEV-ONLY seed. Populates the in-memory repositories with the PRD §7 reference
 * configuration (two categories, two counters, a few WAITING tickets) so the
 * caller workspace has something to display during local development. Real
 * configuration persistence is QUE-13 / QUE-24 — this exists only because there
 * is no database or `CreateTicket` use case yet (QUE-9 still open).
 *
 * Gated by `QMS_DEV_SEED=1` so unit/integration tests that boot {@link AppModule}
 * stay deterministic and do not inherit seed data; tests seed their own data
 * by injecting the repository tokens directly. Idempotent: if any routing rule
 * already exists it leaves the store untouched.
 */
@Injectable()
export class DevSeedService implements OnModuleInit {
  constructor(
    @Inject(QUEUE_REPOSITORY) private readonly queue: IQueueRepository,
    @Inject(COUNTER_ROUTING_RULE_REPOSITORY)
    private readonly routingRules: ICounterRoutingRuleRepository,
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.QMS_DEV_SEED !== '1') {
      return;
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
    // list renders immediately on first open. Built via `reconstitute` (no
    // domain events) — seeding must not broadcast over the WS gateway.
    const base = Date.now();
    const waitingTickets = [
      { category: aId, code: 'A', seq: 1, createdAt: base - 30_000 },
      { category: aId, code: 'A', seq: 2, createdAt: base - 20_000 },
      { category: bId, code: 'B', seq: 1, createdAt: base - 10_000 },
    ];
    for (const t of waitingTickets) {
      const ticket = QueueTicket.reconstitute({
        id: ticketIdGenerate(),
        ticketNumber: TicketNumber.of(t.code, t.seq),
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
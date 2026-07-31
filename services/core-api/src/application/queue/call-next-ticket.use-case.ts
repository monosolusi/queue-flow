import type { ICounterRoutingRuleRepository } from '../../domain/store-config';
import type {
  IQueueRepository,
  ITransitionPolicy,
  ITransitionPolicyResolver,
  NextTicketQuery,
} from '../../domain/queue';
import { EntityNotFoundException } from '../../domain/shared';
import { QueueEventDispatcher } from './queue-event-dispatcher';

/**
 * Command for the "call next" operation (FR-ENG-03). A counter requests its next
 * ticket; the use case resolves which ticket that is based on the counter's
 * active routing rule.
 */
export interface CallNextTicketCommand {
  readonly counterId: number;
}

/**
 * Projection of the called ticket returned to the interface-adapter layer. Use
 * cases never return the aggregate itself — only a transport-agnostic DTO the
 * controller/presenter maps to HTTP or WebSocket (DIP / no domain leakage).
 */
export interface CalledTicketDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly counterId: number;
}

/**
 * Outcome of "call next". `empty` means no WAITING ticket matched the counter's
 * routing — the caller panel shows "antrian kosong" rather than an error.
 */
export type CallNextTicketResult =
  | { readonly status: 'called'; readonly ticket: CalledTicketDto }
  | { readonly status: 'empty' };

/**
 * The counter routing engine (FR-ENG-03). Orchestrates next-ticket selection:
 *
 * 1. Reads the counter's active {@link CounterRoutingRule} from configuration
 *    (AC#1 — "Counter routing rule dapat dibaca dari konfigurasi aktif").
 * 2. Translates it into a {@link NextTicketQuery} — the anti-corruption boundary
 *    the Queue context exposes so it never imports Store Config internals.
 * 3. Asks the Queue repository for the next WAITING ticket honoring the policy
 *    (AC#2 — `FIFO_GLOBAL` and `CATEGORY_PRIORITY`).
 * 4. Drives the {@link QueueTicket} aggregate's `markCalling` against the active
 *    state machine (the {@link ITransitionPolicy} port), then persists it.
 *
 * Depends only on ports (DIP): no ORM, HTTP framework, or I/O library — the
 * application layer stays framework-free, mirroring the Domain purity rule
 * (NFR-MNT-01). Concrete wiring (NestJS providers, the active `StateMachine`
 * from {@link SystemConfiguration}) is supplied by the interface-adapter layer.
 */
export class CallNextTicketUseCase {
  constructor(
    private readonly routingRules: ICounterRoutingRuleRepository,
    private readonly queue: IQueueRepository,
    private readonly policyResolver: ITransitionPolicyResolver,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async execute(command: CallNextTicketCommand): Promise<CallNextTicketResult> {
    // Resolve the active transition policy per execution (QUE-2). The app boots
    // before the first-run wizard creates a SystemConfiguration, so the policy
    // cannot be resolved eagerly at construction — and the aggregate validates
    // transitions synchronously, so a lazy async proxy is not an option. The use
    // case resolves the (sync) policy here and passes it into the aggregate.
    const transitionPolicy = await this.policyResolver.getActivePolicy();

    const rule = await this.routingRules.getByCounterId(command.counterId);
    if (!rule) {
      // A counter must have a routing rule — counters only serve their assigned
      // categories. Missing rule is a configuration error, not an empty queue.
      throw new EntityNotFoundException('CounterRoutingRule', String(command.counterId));
    }

    // Store-Config -> Queue translation: the Queue context consumes only the
    // NextTicketQuery shape, never the CounterRoutingRule aggregate itself.
    const query: NextTicketQuery = {
      assignedCategoryIds: rule.assignedCategoryIds,
      priorityPolicy: rule.priorityPolicy,
    };

    const ticket = await this.queue.findNextWaiting(query);
    if (!ticket) {
      return { status: 'empty' };
    }

    // NOTE: findNextWaiting -> markCalling -> save is not atomic across counters.
    // Two counters could select the same WAITING ticket concurrently. This is
    // acceptable for the in-memory / single-host scope of QUE-11; the future
    // PostgreSQL repository will enforce atomicity (SELECT ... FOR UPDATE +
    // conditional UPDATE) so a ticket is claimed by exactly one counter.
    ticket.markCalling(command.counterId, transitionPolicy, this.clock());
    await this.queue.save(ticket);
    // Drain the recorded TicketCalledEvent so it actually broadcasts (FR-ENG-04).
    await this.dispatcher.dispatch(ticket);

    return {
      status: 'called',
      ticket: {
        ticketId: ticket.id.value,
        ticketNumber: ticket.ticketNumber.formatted(),
        categoryId: ticket.categoryId,
        counterId: command.counterId,
      },
    };
  }
}
import type {
  CounterRoutingRule,
  ICounterRoutingRuleRepository,
} from '../../domain/store-config';
import type { ICategoryRepository } from '../../domain/queue';
import type { PriorityPolicy } from '../../domain/shared/priority-policy';

/**
 * A category assigned to a counter, projected with the master-data fields a
 * caller panel needs to label its selection (PRD §7).
 */
export interface AssignedCategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * Read-side projection of a {@link CounterRoutingRule} for the caller counter
 * selection screen (FR-CLR-01). Use cases never return the aggregate itself —
 * only this transport-agnostic DTO, which the interface-adapter layer maps to
 * HTTP (DIP / no domain leakage). `priorityPolicy` is the shared-kernel enum
 * string so the caller can show how this counter picks its next ticket.
 */
export interface CounterDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategories: readonly AssignedCategoryDto[];
  readonly priorityPolicy: PriorityPolicy;
}

/**
 * Projects a single {@link CounterRoutingRule} into a {@link CounterDto},
 * joining its assigned category ids to the {@link Category} master data. The
 * single place that knows how the routing rule maps to the caller DTO —
 * mirroring {@link projectTicketState} for the queue side. A category id
 * present on the rule but missing from master data is skipped defensively
 * rather than crashing the whole list (a stale routing rule is a config
 * concern, handled by admin; the caller read side degrades gracefully).
 */
export function projectCounter(
  rule: CounterRoutingRule,
  categoriesById: Map<string, { id: string; code: string; name: string }>,
): CounterDto {
  const assignedCategories: AssignedCategoryDto[] = [];
  for (const id of rule.assignedCategoryIds) {
    const category = categoriesById.get(id);
    if (category) {
      assignedCategories.push({ id: category.id, code: category.code, name: category.name });
    }
  }
  return {
    counterId: rule.counterId,
    counterName: rule.counterName,
    assignedCategories,
    priorityPolicy: rule.priorityPolicy,
  };
}

/**
 * Read-side use case: lists every configured counter with its assigned
 * categories so the caller panel can render the counter selection screen on
 * first open (FR-CLR-01). Depends only on ports (DIP) — no ORM, HTTP
 * framework, or I/O library — so the application layer stays framework-free,
 * mirroring the Domain purity rule (NFR-MNT-01). Concrete repository wiring is
 * supplied by the interface-adapter layer.
 */
export class ListCountersUseCase {
  constructor(
    private readonly routingRules: ICounterRoutingRuleRepository,
    private readonly categories: ICategoryRepository,
  ) {}

  async execute(): Promise<CounterDto[]> {
    const rules = await this.routingRules.getAll();
    if (rules.length === 0) {
      return [];
    }
    const all = await this.categories.getAll();
    const categoriesById = new Map(all.map((c) => [c.id.value, { id: c.id.value, code: c.code, name: c.name }]));
    return rules
      .slice()
      .sort((a, b) => a.counterId - b.counterId)
      .map((rule) => projectCounter(rule, categoriesById));
  }
}
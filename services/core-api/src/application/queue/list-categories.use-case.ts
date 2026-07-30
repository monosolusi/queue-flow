import type { Category } from '../../domain/queue/entities/category';
import type { ICategoryRepository } from '../../domain/queue/repositories/category.repository';

/**
 * Read-side projection of a {@link Category} for the kiosk category-selection
 * screen (FR-KSK-01 / QUE-17). Use cases never return the domain entity itself
 * — only this transport-agnostic DTO, which the interface-adapter layer maps
 * to HTTP (DIP / no domain leakage). The kiosk renders the large touch buttons
 * from `code` + `name`.
 */
export interface CategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * Projects a single {@link Category} into a {@link CategoryDto}. The single
 * place that knows how a category maps to the kiosk read DTO — mirroring
 * {@link projectTicketState} for the queue side and {@link projectCounter} for
 * the counter side.
 */
export function projectCategory(category: Category): CategoryDto {
  return { id: category.id.value, code: category.code, name: category.name };
}

/**
 * Read-side use case: lists every configured category so the kiosk can render
 * its category-selection screen (FR-KSK-01 / QUE-17). "Active categories" are
 * all categories held in master data — the {@link Category} entity carries no
 * active flag, and whether a category is routable is a counter-routing concern
 * (Store Config), not something this Queue-context read should filter on, so
 * the kiosk read stays free of cross-context coupling (bounded-context
 * boundary).
 *
 * Depends only on a port (DIP) — no ORM, HTTP framework, or I/O library — so
 * the application layer stays framework-free, mirroring the Domain purity rule
 * (NFR-MNT-01). Concrete repository wiring is supplied by the interface-adapter
 * layer.
 */
export class ListCategoriesUseCase {
  constructor(private readonly categories: ICategoryRepository) {}

  async execute(): Promise<CategoryDto[]> {
    const all = await this.categories.getAll();
    // Stable, deterministic order (by code) so the kiosk layout does not shift
    // between renders for the same configuration — a public touchscreen must
    // not reorder its buttons unpredictably.
    return all
      .slice()
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(projectCategory);
  }
}
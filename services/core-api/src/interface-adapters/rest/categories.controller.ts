import { Controller, Get } from '@nestjs/common';
import { ListCategoriesUseCase } from '../../application/queue';

/**
 * Read-only REST surface for category master data (FR-KSK-01 / QUE-17). The
 * kiosk touchscreen fetches this list to render the category-selection buttons.
 * This controller owns only that read — the kiosk's take-a-ticket mutation is
 * `POST /api/tickets` in {@link TicketsController} (QUE-9), wired in the
 * separate `TicketsApiModule` so the read surface here stays clean (SRP).
 *
 * Path prefix `api/categories` keeps it under the public `/api/*` REST surface,
 * distinct from the `/ws` WebSocket path and (in deployment) the `/kiosk`
 * static origin fronted by NGINX.
 */
@Controller('api/categories')
export class CategoriesController {
  constructor(private readonly listCategories: ListCategoriesUseCase) {}

  /** `GET /api/categories` → the active categories for the kiosk screen. */
  @Get()
  list() {
    return this.listCategories.execute();
  }
}
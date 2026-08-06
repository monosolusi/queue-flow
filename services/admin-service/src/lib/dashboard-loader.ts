import type { IAdminApi } from '../api/admin-api';
import type {
  ConfigCategoryDto,
  CounterDto,
  QueueBoardStateDto,
  TicketStateDto,
} from '../api/types';

/**
 * Live operational-dashboard loader (FR-ADM-03 / QUE-44). Pure + framework-free:
 * it consumes only the read-side slice of {@link IAdminApi} (the live queue board
 * + the configured counters) and never touches caller/kiosk/tv write surfaces
 * (ISP). The page owns the polling cadence + view state; this module owns the
 * fetch + the pure projections that turn the raw board/counters into the
 * dashboard's three widgets (now-serving, waiting-per-category, counter status).
 *
 * The store {@link SystemConfigurationDto} is threaded in (not re-fetched per
 * tick) so a poll never burns a third round-trip just to label categories — the
 * config is read once at boot and held in a ref by the page. The counters read
 * (`GET /api/counters`) carries live counter names + assigned categories, so
 * counter labels stay fresh even after a routing edit without a config re-fetch.
 */

/** A category row for the waiting-counts grid (config order preserved, zero rows included). */
export interface WaitingCategoryCount {
  readonly categoryId: string;
  readonly code: string;
  readonly name: string;
  readonly count: number;
}

/** One counter's live operational status for the counter-status list. */
export interface CounterStatus {
  readonly counterId: number;
  readonly counterName: string;
  /** `active` = a CALLING/SERVING ticket is at the counter; `idle` = none. */
  readonly status: 'active' | 'idle';
  /** The ticket number being served, or `null` when idle. */
  readonly activeTicketNumber: string | null;
}

/** The fully-loaded live dashboard for one poll tick. */
export interface LiveDashboardData {
  readonly board: QueueBoardStateDto;
  readonly counters: readonly CounterDto[];
  /** Categories in config order (drives the waiting-counts grid order). */
  readonly categories: readonly ConfigCategoryDto[];
}

/**
 * Parallel-fetches the live queue board + the configured counters, joining the
 * threaded config's categories (for the waiting-counts grid labels + order). The
 * two reads are independent so they run concurrently; either failing fails the
 * whole load (no partial view) — the dashboard is read-only, so a transient
 * error is preferable to silently dropping a widget.
 */
export async function loadLiveDashboard(
  api: IAdminApi,
  config: { readonly categories: readonly ConfigCategoryDto[] },
): Promise<LiveDashboardData> {
  const [board, counters] = await Promise.all([api.getQueueBoard(), api.getCounters()]);
  return { board, counters, categories: config.categories };
}

/**
 * Groups the board's waiting tickets by category, in config order. Categories
 * with zero waiting tickets are included (count `0`) so the grid never collapses
 * a configured category out of view — the manager always sees the full set of
 * services they configured. Pure: fed only by the board + the config categories.
 */
export function waitingByCategory(
  board: QueueBoardStateDto,
  categories: readonly ConfigCategoryDto[],
): WaitingCategoryCount[] {
  return categories.map((cat) => ({
    categoryId: cat.id,
    code: cat.code,
    name: cat.name,
    count: board.waiting.filter((t) => t.categoryId === cat.id).length,
  }));
}

/**
 * Derives each counter's live status from the board's active tickets. A counter
 * is `active` when the board carries a CALLING/SERVING ticket at that counter,
 * `idle` otherwise. Counters are returned in `getCounters()` order. Pure: fed
 * only by the counters + the board.
 */
export function counterStatuses(
  counters: readonly CounterDto[],
  board: QueueBoardStateDto,
): CounterStatus[] {
  return counters.map((c) => {
    const active = board.active.find((t) => t.counterId === c.counterId);
    return {
      counterId: c.counterId,
      counterName: c.counterName,
      status: active ? 'active' : 'idle',
      activeTicketNumber: active ? active.ticketNumber : null,
    };
  });
}

/**
 * The now-serving ticket — the most-recently-touched active ticket (the last
 * entry of `board.active`, which the backend orders oldest-updated first). Pure
 * helper so the page + its tests share one definition of "now-serving". Returns
 * `null` when no ticket is active.
 */
export function nowServingTicket(board: QueueBoardStateDto): TicketStateDto | null {
  return board.active.length > 0 ? board.active[board.active.length - 1] : null;
}
import type { CategoryDto } from '../api/types';
import type { WaitingTicket } from '../state/tv-store';

/** Maximum rows rendered (the server may return more; the panel caps the view). */
const VISIBLE_LIMIT = 10;

/**
 * The "Antrian Berikutnya" panel for the TV board. Renders up to
 * {@link VISIBLE_LIMIT} waiting tickets as an ordered list: 1-based position
 * (`--text-muted`), bold ticket number, and category name (resolved from the
 * store's category id→name map). The ticket number already carries the
 * category code as its prefix (e.g. `A-001`), so the code would be redundant
 * — the category name adds the human-readable category (e.g. "Kasir",
 * "Customer Service") instead of repeating the single-letter code. The total
 * `waitingCount` is shown so a customer beyond the visible window still sees
 * the queue depth.
 *
 * The panel is an `aria-live="polite"` region by default so a refreshed list is
 * announced to AT without interrupting the now-serving announcement. Pass
 * `live={false}` for a non-live visual duplicate — used by the standby layer,
 * which is always-mounted alongside the active layer for the crossfade: two
 * `aria-live="polite"` regions would risk double-announcement, so the active
 * instance stays the single live region and the standby instance is a visual
 * mirror only (a non-live region hidden via `visibility:hidden` is not a
 * "hidden live region", unlike an aria-live region that stays mounted while
 * hidden — so the standby duplicate does not queue announcements). The active
 * instance is always-mounted with the active layer; it is not gated on
 * `nowServing` the way the now-serving assertive region is (a minor a11y
 * nuance: some AT may announce the list once on the idle→active transition).
 *
 * The waiting list is sourced from the server's `GET /api/queue/board` read
 * model (the store refetches it after every lifecycle event); this component
 * never projects waiting state from events (SRP — the server owns the read
 * model).
 */
export function WaitingQueue({
  waiting,
  categories,
  live = true,
}: {
  readonly waiting: readonly WaitingTicket[];
  readonly categories: readonly CategoryDto[];
  readonly live?: boolean;
}) {
  const nameByCategoryId = new Map(categories.map((c) => [c.id, c.name]));
  const visible = waiting.slice(0, VISIBLE_LIMIT);

  return (
    <section
      className="waiting-queue"
      {...(live ? { 'aria-live': 'polite' as const } : {})}
      aria-label="Antrian Berikutnya"
    >
      <h3 className="waiting-queue__title">Antrian Berikutnya</h3>
      {visible.length === 0 ? (
        <p className="waiting-queue__empty">Belum ada antrian menunggu.</p>
      ) : (
        <ol className="waiting-queue__list">
          {visible.map((t, idx) => (
            <li key={t.ticketId} className="waiting-queue__item">
              <span className="waiting-queue__position">{idx + 1}.</span>
              <span className="waiting-queue__number">{t.ticketNumber}</span>
              <span className="waiting-queue__category">
                {nameByCategoryId.get(t.categoryId) ?? ''}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="waiting-queue__count">Menunggu: {waiting.length} tiket</p>
    </section>
  );
}
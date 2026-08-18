import type { NowServing } from '../state/tv-store';

/**
 * The big "now serving" number + counter (FR-TV-01).
 *
 * Says "loket", matching the spoken announcement and the `CountersServing`
 * widget. It previously said "COUNTER" while the widget beside it said "Loket" —
 * a mismatch that became audible once the speaker started saying "loket".
 */
export function NowServingCard({ nowServing }: { nowServing: NowServing | null }) {
  if (!nowServing) {
    return (
      <div className="now-serving now-serving--empty">
        <p className="now-serving__empty-text">Menunggu panggilan berikutnya…</p>
      </div>
    );
  }
  return (
    <div
      className="now-serving"
      role="status"
      aria-live="assertive"
      aria-atomic="true"
      // Scoping anchor for tests: "Loket 2" also legitimately appears in the
      // counters-serving widget (that is a counter's configured NAME), and
      // role="status" is shared with the connection badge.
      data-testid="now-serving"
    >
      <h2 className="now-serving__label">SILAKAN KE LOKET</h2>
      <span className="now-serving__number">{nowServing.ticketNumber}</span>
      <span className="now-serving__counter">Loket {nowServing.counterId}</span>
    </div>
  );
}
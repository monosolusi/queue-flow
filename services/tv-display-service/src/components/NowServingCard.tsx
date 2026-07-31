import type { NowServing } from '../state/tv-store';

/** The big "now serving" number + counter (FR-TV-01). */
export function NowServingCard({ nowServing }: { nowServing: NowServing | null }) {
  if (!nowServing) {
    return (
      <div className="now-serving now-serving--empty">
        <p className="now-serving__empty-text">Menunggu panggilan berikutnya…</p>
      </div>
    );
  }
  return (
    <div className="now-serving">
      <span className="now-serving__label">SEDANG DILAYANI</span>
      <span className="now-serving__number">{nowServing.ticketNumber}</span>
      <span className="now-serving__counter">Counter {nowServing.counterId}</span>
    </div>
  );
}
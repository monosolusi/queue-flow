import type { NowServing } from '../state/tv-store';

/** The last (up to 5) previously-called tickets (FR-TV-01). */
export function CallHistory({ history }: { history: readonly NowServing[] }) {
  if (history.length === 0) {
    return (
      <section className="call-history">
        <h2 className="call-history__title">Riwayat Panggilan</h2>
        <p className="call-history__empty">Belum ada riwayat.</p>
      </section>
    );
  }
  return (
    <section className="call-history">
      <h2 className="call-history__title">Riwayat Panggilan</h2>
      <ol className="call-history__list">
        {history.map((h) => (
          <li key={h.ticketId} className="call-history__item">
            <span className="call-history__number">{h.ticketNumber}</span>
            <span className="call-history__counter">Counter {h.counterId}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
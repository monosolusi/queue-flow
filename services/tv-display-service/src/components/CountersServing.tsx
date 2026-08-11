import type { CounterServing } from '../api/types';

/**
 * The "Sedang Melayani" panel for the TV board (FR-TV-01 extension). Lists
 * each counter currently serving a ticket, derived client-side by the TV
 * store from `GET /api/queue/board`'s `active` array joined with the
 * `routingRules` counter-name map. Mirrors `CallHistory`/`WaitingQueue`:
 * surface card, hairline dividers, `role="group"` + `aria-label` for the
 * section. Pure presentational (SRP — no state, no store wiring); fed by the
 * page's `countersServing` slice.
 */
export function CountersServing({
  countersServing,
}: {
  readonly countersServing: readonly CounterServing[];
}) {
  if (countersServing.length === 0) {
    return (
      <section className="counters-serving" role="group" aria-label="Counter Sedang Melayani">
        <h3 className="counters-serving__title">Sedang Melayani</h3>
        <p className="counters-serving__empty">Tidak ada counter yang sedang melayani.</p>
      </section>
    );
  }
  return (
    <section className="counters-serving" role="group" aria-label="Counter Sedang Melayani">
      <h3 className="counters-serving__title">Sedang Melayani</h3>
      <ol className="counters-serving__list">
        {countersServing.map((c) => (
          <li key={c.counterId} className="counters-serving__item">
            <span className="counters-serving__counter">{c.counterName}</span>
            <span className="counters-serving__number">{c.ticketNumber}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
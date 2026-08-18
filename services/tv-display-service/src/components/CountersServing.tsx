import type { CounterServing } from '../api/types';

/**
 * The "Sedang Melayani" panel for the TV board (FR-TV-01 extension). Lists
 * EVERY configured counter, derived client-side by the TV store from
 * `GET /api/queue/board`'s `active` array joined with the `routingRules`
 * counter-name map. A counter currently serving shows its ticket number; an
 * idle counter (no active ticket right now) shows an em dash (—), visually
 * muted via the `counters-serving__item--idle` modifier, with an
 * `aria-label="belum melayani"` on the number span so AT reads the state
 * instead of "em dash". Mirrors `CallHistory`/`WaitingQueue`: surface card,
 * hairline dividers, `role="group"` + `aria-label` for the section. Pure
 * presentational (SRP — no state, no store wiring); fed by the page's
 * `countersServing` slice. The empty-state branch now fires only when there
 * are genuinely no configured counters.
 */
export function CountersServing({
  countersServing,
}: {
  readonly countersServing: readonly CounterServing[];
}) {
  if (countersServing.length === 0) {
    return (
      <section className="counters-serving" role="group" aria-label="Loket Sedang Melayani">
        <h3 className="counters-serving__title">Sedang Melayani</h3>
        <p className="counters-serving__empty">Tidak ada counter yang sedang melayani.</p>
      </section>
    );
  }
  return (
    <section className="counters-serving" role="group" aria-label="Loket Sedang Melayani">
      <h3 className="counters-serving__title">Sedang Melayani</h3>
      <ol className="counters-serving__list">
        {countersServing.map((c) => (
          <li
            key={c.counterId}
            className={`counters-serving__item${c.idle ? ' counters-serving__item--idle' : ''}`}
          >
            <span className="counters-serving__counter">{c.counterName}</span>
            <span
              className="counters-serving__number"
              /* `role="img"` on the idle span so `aria-label` is reliably
               * exposed to AT — a bare <span> has the ARIA `generic` role,
               * which prohibits name-from-author, so aria-label alone is
               * inconsistent across browsers. The em dash is a presentational
               * glyph whose meaning IS the label. */
              role={c.idle ? 'img' : undefined}
              aria-label={c.idle ? 'belum melayani' : undefined}
            >
              {c.ticketNumber}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
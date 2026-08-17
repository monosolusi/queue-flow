/**
 * The JSON "Sumber" view of the Alur Status Tiket graph — a **read-only** text
 * projection of the same {@link StateMachineForm} the
 * {@link StateMachineWorkflow} diagram edits.
 *
 * **Read-only on purpose.** The flow has exactly ONE source of truth: the
 * `StateMachineForm` (whose graph is persisted as the `state_machine` JSONB in
 * core-api and served to the Caller via `GET /api/queue/actions`). This pane is
 * a VIEW over it, never a second editing path — the canvas can already express
 * everything the flow holds (states, transitions, `actionLabel`,
 * `requeuePolicy`, node actions, descriptions, Start/End + `endSources`), so a
 * parallel text editor would only add a second way to say the same thing plus
 * the two-way synchronization it drags along. It exists so the manager can
 * *see* and *copy* the whole flow as text; to change it, use the Diagram view.
 *
 * **What the text is, exactly.** The editable form, minus the client-only
 * `mode` preset (an internal `'default' | 'custom'` marker that never reaches
 * core-api — see `toStateMachineDto` — and would read as noise to a manager).
 * It is therefore a SUPERSET of the persisted `state_machine` object: the graph
 * (`states`/`transitions`/`descriptions`) is saved inside `state_machine`,
 * while `positions`, `nodeActions`, `terminalNodes` and `endSources` travel as
 * sibling top-level wire fields (`nodePositions`, `nodeActions`, …). Showing
 * the whole form is deliberate — this view is for reading the flow the manager
 * is composing, not for previewing a wire payload.
 *
 * **One prop, no divergence.** The component takes the form itself and derives
 * BOTH the text and the connector legend from it. Handing it a pre-serialized
 * string alongside a separate transition list would re-create, one layer down,
 * exactly the two-representations-out-of-sync hazard this view was rebuilt to
 * remove.
 *
 * Purely presentational: a `readOnly` `<textarea>` over the derived text.
 * Because nothing here parses, there is no error state to surface, no save
 * gating, and no cursor/reformat hazard — the text simply tracks the draft.
 *
 * **Connector legend.** Manager feedback: the raw source did not explain which
 * point connects to which (`tidak dijelaskan ini konek pada titik yang mana ke
 * titik yang mana, jadinya ruwet`). Nested JSON spreads a connector's direction
 * across two levels, so this view renders a legend of the connectors — one chip
 * per transition, `from → to · actionLabel` — between the hint and the
 * textarea. The arrow glyph carries the direction; `.sr-only` bridge words keep
 * that direction + the label AT-readable (a screen reader announces "WAITING ke
 * CALLING aksi: Panggil Berikutnya", not "rightwards arrow" run together with
 * the label).
 */
import { isDefaultSides, type StateMachineForm } from '../lib/state-machine';
import './state-machine-workflow.css';

export function StateMachineSource({
  stateMachine,
}: {
  /** The form being edited — the single input both projections derive from. */
  stateMachine: StateMachineForm;
}): JSX.Element {
  // Strip the client-only preset; everything else is the manager's flow.
  const { mode: _mode, ...graph } = stateMachine;
  const sourceText = JSON.stringify(graph, null, 2);
  const connectors = stateMachine.transitions;

  return (
    <div className="sm-source-wrap">
      <label htmlFor="sm-source" className="sm-source__label">
        Sumber JSON alur status (baca saja)
      </label>
      <p className="sm-source__hint" id="sm-source-hint">
        Ini tampilan teks dari alur yang sedang Anda susun — berguna untuk
        memeriksa atau menyalin seluruh alur sekaligus. Isinya{' '}
        <strong>tidak bisa diubah di sini</strong>: untuk menambah status,
        menarik konektor, atau mengganti teks tombol, gunakan tampilan{' '}
        <strong>Diagram</strong>.
      </p>

      {/* Connector legend — the "indikator konektor" (from → to) the manager
          asked for. A read-only map of which point connects to which, derived
          from the same form the textarea serializes. The arrow is decorative
          (aria-hidden); the `.sr-only` "ke" word keeps the direction
          AT-readable. When an edge uses a non-default connection point, the
          sides are appended (`· sourceSide→targetSide`) so the legend shows
          which point connects to which — the manager's "ruwet" feedback. */}
      <ul
        className="sm-source-connectors"
        data-testid="sm-source-connectors"
        aria-label="Daftar konektor transisi (dari titik asal ke titik tujuan)"
      >
        {connectors.map((c, i) => {
          const hasSides = !isDefaultSides(c.sourceSide, c.targetSide);
          return (
            <li
              key={`${c.from}->${c.to}#${i}`}
              className="sm-source-connector"
              data-testid="sm-source-connector"
            >
              <span className="sm-source-connector__from">{c.from}</span>
              <span className="sr-only"> ke </span>
              <span className="sm-source-connector__arrow" aria-hidden="true">→</span>
              <span className="sm-source-connector__to">{c.to}</span>
              <span className="sr-only"> aksi: </span>
              <span className="sm-source-connector__label">{c.actionLabel}</span>
              {hasSides && (
                <>
                  <span className="sr-only"> titik: </span>
                  <span
                    className="sm-source-connector__sides"
                    data-testid="sm-source-connector-sides"
                  >
                    {c.sourceSide ?? 'right'}→{c.targetSide ?? 'left'}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {/* A `readOnly` textarea rather than a `<pre>`: it keeps the `htmlFor`
          label association, stays focusable/selectable for a select-all + copy,
          and scrolls a long flow internally. `readOnly` (not `disabled`) so the
          text is still reachable by keyboard and AT. `aria-describedby` points
          at the hint so a screen-reader user who tabs in hears WHERE the edit
          affordance is — sighted users read that from the hint above. */}
      <textarea
        id="sm-source"
        className="sm-source sm-source--readonly"
        data-testid="sm-source"
        readOnly
        aria-describedby="sm-source-hint"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        value={sourceText}
      />
    </div>
  );
}

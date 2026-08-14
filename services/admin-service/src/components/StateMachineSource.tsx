/**
 * The XML "Source" view of the Alur Status Tiket graph — an editable XML
 * source pane alongside the visual {@link StateMachineWorkflow} diagram
 * (a designer-style visual/source toggle).
 *
 * Purely presentational: it renders a controlled `<textarea>` carrying the
 * serialized graph (a Liferay Kaleo `<workflow-definition>` document — one
 * `<task>`/`<state>` per status with its transitions nested inside, see
 * `state-machine-xml.ts`) plus an inline error region. **All
 * parsing/validation lives in the designer page** — this component never calls
 * `DOMParser` or `xmlToForm`. Keeping the textarea dumb means a half-typed
 * document can never crash it: the designer live-parses on every `onChange`,
 * lifts a valid graph to the shared draft, and on a parse failure sets `error`
 * (shown here) WITHOUT `setState`-ing a broken form, so the diagram view is
 * never clobbered by invalid source. The textarea stays editable and the
 * manager keeps typing toward a valid graph.
 *
 * SRP split vs. the designer: the designer owns the view-toggle state machine
 * (Diagram↔Source), the round-trip lifecycle (re-serialize on Diagram→Source,
 * validate on Source→Diagram), and the draft lift; this component owns only the
 * textarea affordance + its a11y wiring. Mirrors the `StateMachineWorkflow`
 * split (visual editor is presentational over the same `StateMachineForm`).
 *
 * **Connector legend (`connectors`).** Manager feedback: the raw source did
 * not explain which point connects to which (`tidak dijelaskan ini konek pada
 * titik yang mana ke titik yang mana, jadinya ruwet`). In the Kaleo shape the
 * source status is the CONTAINING element and the destination is `<target>`, so
 * a connector's direction is spread across two nesting levels and still not
 * readable at a glance. So this view renders a read-only legend of
 * the connectors — one chip per transition, `from → to · actionLabel` —
 * between the hint and the textarea. The legend is a VIEW over the SAME
 * last-valid draft the diagram shows (passed in as `connectors`); it never
 * parses `sourceText` itself, so a broken textarea can never show a broken
 * graph here — while the manager types invalid XML the legend stays at the
 * last-valid connectors and the inline `error` region explains the divergence.
 * The arrow glyph carries the direction the XML attributes encode; `.sr-only`
 * bridge words keep that direction + the label AT-readable (a screen reader
 * announces "WAITING ke CALLING aksi: Panggil Berikutnya", not "rightwards
 * arrow" run together with the label).
 */
import { isDefaultSides, type Transition } from '../lib/state-machine';
import './state-machine-workflow.css';

export function StateMachineSource({
  sourceText,
  onSourceChange,
  error,
  connectors,
}: {
  /** The current XML source text (controlled). */
  sourceText: string;
  /** Fired on every keystroke with the raw textarea value — the designer parses it. */
  onSourceChange: (next: string) => void;
  /** A single manager-facing (Indonesian) error string, or `null` when valid. */
  error: string | null;
  /**
   * The last-valid graph's transitions, rendered as a read-only connector
   * legend (`from → to · actionLabel`). Mirrors the draft the diagram view
   * shows; stays at the last-valid graph while the textarea holds an invalid
   * parse (the `error` region explains the divergence). Owned by the designer
   * — this component never derives it from `sourceText`.
   */
  connectors: readonly Transition[];
}): JSX.Element {
  return (
    <div className="sm-source-wrap">
      <label htmlFor="sm-source" className="sm-source__label">
        Sumber XML alur status
      </label>
      <p className="sm-source__hint">
        Format mengikuti <strong>Liferay Kaleo</strong> (
        <code>&lt;workflow-definition&gt;</code>). Tiap status jadi satu blok:{' '}
        <code>&lt;task&gt;</code> bila masih punya transisi keluar,{' '}
        <code>&lt;state&gt;</code> bila status akhir — nama statusnya ada di{' '}
        <code>&lt;name&gt;</code>. Tiap transisi adalah{' '}
        <strong>konektor (panah)</strong> yang ditulis <em>di dalam</em> status
        asalnya: <code>&lt;target&gt;</code> menyebut status tujuan, dan{' '}
        <code>&lt;label&gt;</code> adalah teks tombolnya di layar petugas.
        Hal-hal yang tidak punya tempat di Kaleo — posisi di kanvas (
        <code>xy</code>), keterangan status, titik sambungan (
        <code>sourceSide</code>/<code>targetSide</code>:{' '}
        <code>"top"</code>|<code>"right"</code>|<code>"bottom"</code>|
        <code>"left"</code>, default <code>right</code>→<code>left</code>) —
        disimpan sebagai JSON di dalam <code>&lt;metadata&gt;</code>. Mengubah
        sumber ini menyusun alur kustom sendiri.
      </p>

      {/* Connector legend — the "indikator konektor" (from → to) the manager
          asked for. A read-only map of which point connects to which, derived
          from the last-valid draft (passed as `connectors`), NOT re-parsed from
          the textarea. The arrow is decorative (aria-hidden); the `.sr-only`
          "ke" word keeps the direction AT-readable. When an edge uses a
          non-default connection point, the sides are appended
          (`· sourceSide→targetSide`) so the legend shows which point connects
          to which — the manager's "ruwet" feedback. */}
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

      <textarea
        id="sm-source"
        className="sm-source"
        data-testid="sm-source"
        // `aria-invalid` mirrors the visual editor's error-gating story: AT users
        // hear the field is in an error state, and `aria-describedby` wires the
        // inline error region as the explanation (mirrors the wizard's
        // describedBy form-error wiring, QUE-41).
        aria-invalid={error !== null}
        aria-describedby={error !== null ? 'sm-source-error' : undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        value={sourceText}
        onChange={(e) => onSourceChange(e.target.value)}
      />
      {error !== null && (
        <p className="sm-source-error" id="sm-source-error" role="alert" data-testid="sm-source-error">
          {error}
        </p>
      )}
    </div>
  );
}
/**
 * The JSON "Source" view of the Alur Status Tiket graph — a Kaleo-Designer-style
 * editable source pane alongside the visual {@link StateMachineWorkflow} diagram.
 *
 * Purely presentational: it renders a controlled `<textarea>` carrying the
 * serialized graph (`{ states, transitions }` as indented JSON) plus an inline
 * error region. **All parsing/validation lives in the designer page** — this
 * component never calls `JSON.parse` or `jsonToForm`. Keeping the textarea dumb
 * means a half-typed document can never crash it: the designer live-parses on
 * every `onChange`, lifts a valid graph to the shared draft, and on a parse
 * failure sets `error` (shown here) WITHOUT `setState`-ing a broken form, so the
 * diagram view is never clobbered by invalid source. The textarea stays
 * editable and the manager keeps typing toward a valid graph.
 *
 * SRP split vs. the designer: the designer owns the view-toggle state machine
 * (Diagram↔Source), the round-trip lifecycle (re-serialize on Diagram→Source,
 * validate on Source→Diagram), and the draft lift; this component owns only the
 * textarea affordance + its a11y wiring. Mirrors the `StateMachineWorkflow`
 * split (visual editor is presentational over the same `StateMachineForm`).
 */
import './state-machine-workflow.css';

export function StateMachineSource({
  sourceText,
  onSourceChange,
  error,
}: {
  /** The current JSON source text (controlled). */
  sourceText: string;
  /** Fired on every keystroke with the raw textarea value — the designer parses it. */
  onSourceChange: (next: string) => void;
  /** A single manager-facing (Indonesian) error string, or `null` when valid. */
  error: string | null;
}): JSX.Element {
  return (
    <div className="sm-source-wrap">
      <label htmlFor="sm-source" className="sm-source__label">
        Sumber JSON alur status
      </label>
      <p className="sm-source__hint">
        Format: <code>{'{"states": ["…"], "transitions": [{"from","to","actionLabel"}]}'}</code>.
        Mengubah sumber ini menyusun alur kustom sendiri.
      </p>
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
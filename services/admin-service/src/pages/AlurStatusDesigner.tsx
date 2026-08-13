/**
 * Dedicated full-page designer for the "Alur Status Tiket" (ticket status flow /
 * state machine), reachable from the `/admin/config` state-machine section via
 * "Lihat Diagram".
 *
 * Manager feedback: the inline diagram on `/admin/config` was too small and hard
 * to see (`.sm-canvas` was `60vh / min 360px` crammed inside a config card). This
 * page gives the canvas the full `<main>` width + a tall height, and adds a
 * Kaleo-Workflow-Designer-style **Diagram / Source toggle**: a visual editor
 * (React Flow) and an editable XML source view of the same state-machine graph
 * (`<stateMachine>` with `<state>` x/y positions + `<transition>` connection
 * sides + from→to direction). The wire format to core-api stays JSON (via the
 * existing `toStateMachineDto` + `toNodePositionsDto`); the XML source view is
 * just a different VIEW over the same `StateMachineForm`, never a second
 * source of truth.
 *
 * **Shared draft.** The page reads the config draft from {@link useConfigDraft}
 * — the SAME draft the `/admin/config` panel edits. The {@link ConfigDraftProvider}
 * is the `/config` route element (rendering `<Outlet/>`), so navigating
 * `/config ↔ /config/alur-status` keeps the provider mounted and the draft
 * persistent: a store-name edit on `/config` and a transition-label edit here
 * ride ONE full-payload save, and neither is lost on navigation. `save()` is the
 * provider's — identical to the panel's — so on a successful save fired WHILE
 * this page is mounted, `savedAt` bumps and this page navigates back to
 * `/config` (a save that happened on `/config` before mounting does NOT bounce
 * — see the `mountedSavedAt` capture in the effect).
 *
 * **Source-view round-trip guard.** `sourceText` is a local mirror of the draft's
 * state machine, kept in sync by a single effect keyed on the draft's graph
 * signature. A `lastEmittedSig` ref marks changes WE drove (a valid source edit
 * lifts to the draft and stamps the ref before `setState`), so the effect skips
 * our own edits (no re-serialize → the manager's typing/cursor is never
 * clobbered) and only re-serializes on an EXTERNAL draft change (a diagram edit
 * while in Diagram view, or a post-save re-seed). Invalid source text never
 * reaches the draft — `xmlToForm` returns `{ ok: false, error }` and we set the
 * error WITHOUT `setState`-ing, so the diagram (and the shared draft) stays at
 * the last valid graph and the manager keeps typing toward a valid one.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { StateMachineSource } from '../components/StateMachineSource';
import { StateMachineWorkflow } from '../components/StateMachineWorkflow';
import { useConfigDraft } from './admin-config/config-draft-context';
import { computeFormValidity } from './admin-config/validity';
import { graphSignature } from '../lib/state-machine';
import { formToXml, xmlToForm } from '../lib/state-machine-xml';

export function AlurStatusDesigner(): JSX.Element {
  const { state, setState, save, submitting, retry, savedAt } = useConfigDraft();
  const navigate = useNavigate();
  const [view, setView] = useState<'diagram' | 'source'>('diagram');
  // The source-view mirror of the draft's state machine. Kept in sync with the
  // draft by the effect below; the textarea is controlled over this, NOT over
  // `formToXml(draft)` directly (so the manager's in-progress, possibly-invalid
  // typing is preserved between keystrokes — a live `formToXml` would reformat
  // and jump the cursor on every render).
  const [sourceText, setSourceText] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);
  // Signature of the draft change WE last drove from the source view. The sync
  // effect compares the incoming draft signature against this; a match means the
  // change is ours → skip the re-serialize (preserve the manager's text). A
  // mismatch means an external change (diagram edit / re-seed) → re-serialize.
  const lastEmittedSig = useRef<string>('');

  // Keep `sourceText` in sync with the draft's state machine on EXTERNAL changes
  // only. Runs on every `state` change (the draft is the only dep that matters):
  //   - initial load (draft → ready): lastEmittedSig is '' ≠ sig → serialize.
  //   - diagram edit (Diagram view): draft changes, we did NOT emit → serialize.
  //   - valid source edit (Source view): we stamped lastEmittedSig before
  //     setState → sig matches → skip (preserve the manager's text + cursor).
  //   - invalid source edit: no setState → `state` unchanged → effect no-ops.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const sig = graphSignature(state.form.stateMachine);
    if (sig !== lastEmittedSig.current) {
      lastEmittedSig.current = sig;
      setSourceText(formToXml(state.form.stateMachine));
      setSourceError(null);
    }
  }, [state]);

  // After a successful save, the provider bumps `savedAt`; navigate back to the
  // config panel. (The provider stays mounted across the navigation — it is the
  // `/config` route element — so the now-re-seeded draft is what the panel
  // renders.) Capture `savedAt` at mount and navigate only on a CHANGE from it:
  // `savedAt` is monotonic in the shared provider (never reset), so a save
  // performed on `/config` BEFORE this page mounts leaves a non-zero `savedAt` —
  // arriving here must NOT instantly bounce the manager back before they can
  // touch the diagram. The mount tick compares equal → no-op; only a save fired
  // WHILE the designer is mounted bumps `savedAt` and triggers the return.
  const mountedSavedAt = useRef(savedAt);
  useEffect(() => {
    if (savedAt !== mountedSavedAt.current) {
      mountedSavedAt.current = savedAt;
      navigate('/config');
    }
  }, [savedAt, navigate]);

  if (state.status === 'loading') {
    return <div className="alur-status-designer alur-status-designer--loading">Memuat konfigurasi…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="alur-status-designer">
        <p className="admin-panel__error" role="alert">
          Gagal memuat konfigurasi: {state.message}
        </p>
        <button type="button" className="btn btn--primary" onClick={retry} data-testid="designer-retry">
          Coba Lagi
        </button>
      </div>
    );
  }

  const { form } = state;
  const { smErrors, wholeFormValid } = computeFormValidity(form);

  /** Lift a valid source edit to the shared draft; record an invalid one as an error. */
  function handleSourceChange(next: string): void {
    setSourceText(next);
    const result = xmlToForm(next);
    if (result.ok) {
      // Stamp the ref BEFORE setState so the sync effect treats this as our own
      // change and skips the re-serialize (preserves `next` verbatim — no
      // reformat/cursor jump). Mode is forced to 'custom' by `xmlToForm`.
      lastEmittedSig.current = graphSignature(result.form);
      setState({ status: 'ready', form: { ...form, stateMachine: result.form } });
      setSourceError(null);
    } else {
      // Do NOT setState — the draft + diagram stay at the last valid graph. The
      // manager keeps typing; the error shows in the source gutter.
      setSourceError(result.error);
    }
  }

  /** Switch to Source view: re-evaluate the current source text so an abandoned
   *  invalid draft resurfaces its error (the sync effect only re-serializes on a
   *  draft change, so an invalid `sourceText` left from a prior visit is intact
   *  but its error was cleared on the Diagram switch). */
  function switchToSource(): void {
    const result = xmlToForm(sourceText);
    setSourceError(result.ok ? null : result.error);
    setView('source');
  }

  /** Switch to Diagram view. The draft already reflects every VALID source edit
   *  (live-parsed on change); an invalid source edit never reached the draft, so
   *  the diagram shows the last valid graph. Clear `sourceError` so the save
   *  button (gated on `sourceError === null` in Source view) is not stuck when
   *  the manager leaves an invalid source behind — Diagram-view save gating is
   *  `wholeFormValid` only. `sourceText` is preserved for a return to Source. */
  function switchToDiagram(): void {
    setSourceError(null);
    setView('diagram');
  }

  // Save is the provider's full PUT. Disabled while submitting, when the WHOLE
  // form is invalid (a profile/category error on /config blocks the full save),
  // or when the source view holds an invalid parse (Source view only —
  // `sourceError` is cleared on every Diagram switch).
  const saveDisabled = submitting || !wholeFormValid || sourceError !== null;
  // When the state-machine section is valid but some OTHER section is not, tell
  // the manager where the blocking error is (they can fix it back on /config).
  const otherSectionInvalid = !wholeFormValid && smErrors.length === 0 && sourceError === null;

  const saveButton = (
    <button
      type="button"
      className="btn btn--primary"
      onClick={save}
      disabled={saveDisabled}
      data-testid="admin-save"
    >
      {submitting ? 'Menyimpan…' : 'Simpan'}
    </button>
  );

  return (
    <div className="alur-status-designer">
      <PageHeader
        title="Alur Status Tiket"
        subtitle="Konfigurasi Operasional"
        actions={
          <>
            <Link to="/config" className="btn btn--secondary" data-testid="designer-back">
              Kembali
            </Link>
            {saveButton}
          </>
        }
      />

      {/* Diagram / Source segmented toggle (Kaleo-style view switch). */}
      <div className="sm-view-toggle" role="group" aria-label="Tampilan editor alur status">
        <button
          type="button"
          className="sm-view-toggle__btn"
          aria-pressed={view === 'diagram'}
          onClick={switchToDiagram}
          data-testid="sm-view-diagram"
        >
          Diagram
        </button>
        <button
          type="button"
          className="sm-view-toggle__btn"
          aria-pressed={view === 'source'}
          onClick={switchToSource}
          data-testid="sm-view-source"
        >
          Sumber
        </button>
      </div>

      {otherSectionInvalid && (
        <p className="alur-status-designer__hint" role="note">
          Bagian konfigurasi lain belum valid —{' '}
          <Link to="/config" data-testid="designer-fix-elsewhere">
            kembali ke Konfigurasi
          </Link>{' '}
          untuk memperbaikinya.
        </p>
      )}

      {view === 'diagram' ? (
        <StateMachineWorkflow
          value={form.stateMachine}
          onChange={(sm) => setState({ status: 'ready', form: { ...form, stateMachine: sm } })}
          errors={smErrors}
        />
      ) : (
        <StateMachineSource
          sourceText={sourceText}
          onSourceChange={handleSourceChange}
          error={sourceError}
          connectors={form.stateMachine.transitions}
        />
      )}
    </div>
  );
}
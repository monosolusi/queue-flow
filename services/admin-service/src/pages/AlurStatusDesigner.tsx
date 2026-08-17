/**
 * Dedicated full-page designer for the "Alur Status Tiket" (ticket status flow /
 * state machine). Now itself a peer `/config/alur-status` section (a sidebar
 * leaf), not a modal-like detour — it lives on its own route so the canvas can be
 * full-width and large.
 *
 * Manager feedback: the inline diagram on `/admin/config` was too small and hard
 * to see (`.sm-canvas` was `60vh / min 360px` crammed inside a config card). This
 * page gives the canvas the full `<main>` width + a tall height, and adds a
 * a **Diagram / Sumber toggle**: a visual editor (React Flow) and a
 * **read-only** JSON view of the same state-machine graph. The
 * `StateMachineForm` is the one source of truth (its graph is persisted as the
 * `state_machine` JSONB and served to the Caller via `GET /api/queue/actions`);
 * the Sumber view is a VIEW over that form — text to read and copy, never a
 * second editing path. Editing lives entirely on the canvas, which can already
 * express every facet the flow holds, so there is no parse step, no error
 * state, and no two-way synchronization here. (The projected text is the form,
 * not the wire payload — see {@link StateMachineSource} for the exact shape.)
 *
 * **Shared draft.** The page reads the config draft from {@link useConfigDraft}
 * — the SAME draft the `/admin/config` panel edits. The {@link ConfigDraftProvider}
 * is the `/config` route element (rendering `<Outlet/>`), so navigating
 * `/config ↔ /config/alur-status` keeps the provider mounted and the draft
 * persistent: a store-name edit on `/config` and a transition-label edit here
 * ride ONE full-payload save, and neither is lost on navigation. `save()` is the
 * provider's — identical to the panel's — and, like every other `/config/*`
 * section, the designer STAYS on the page after a successful save (no
 * `navigate()`): the provider re-seeds the draft via the post-save re-GET, and
 * the Sumber view — derived, not mirrored — follows that re-seed for free.
 *
 * **No round-trip.** The Sumber view derives its text from the draft it is
 * handed (it takes the form itself, not a pre-serialized string), so nothing is
 * kept in sync here: no mirror state, no `lastEmittedSig` guard, no way for the
 * two views to disagree. That whole machinery existed only because the pane
 * used to be editable; a read-only projection needs none of it.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { StateMachineSource } from '../components/StateMachineSource';
import { StateMachineWorkflow } from '../components/StateMachineWorkflow';
import { useConfigDraft } from './admin-config/config-draft-context';
import { computeFormValidity } from './admin-config/validity';

export function AlurStatusDesigner(): JSX.Element {
  const { state, setState, save, submitting, retry } = useConfigDraft();
  const [view, setView] = useState<'diagram' | 'source'>('diagram');
  // Full-screen editor overlay (manager feedback: "add option to make it full
  // screen"). A CSS `position: fixed` overlay scoped to the designer root — NOT
  // the browser Fullscreen API — so it is reliable on the offline LAN browser
  // (no permission prompt, no `:fullscreen` pseudo-class cross-browser drift),
  // and so the save toast (z-index 60, rendered as a sibling of AppShell) still
  // renders above it (z-index 40). The overlay hides the app shell chrome
  // (sidebar + topbar) and the page caution so the canvas gets the whole
  // viewport; the Diagram/Sumber toggle + Simpan button stay so the manager can
  // still switch views + save while full-screen.
  const [fullscreen, setFullscreen] = useState(false);
  // A11y (WCAG 2.4.3): the overlay is a modal dialog — mirrors the established
  // `TvLayoutEditOverlay` shape (`role="dialog" aria-modal="true"` + a
  // `tabindex={-1}` container that receives focus on open). The trigger (the
  // "Layar Penuh" button) is captured at click time as `returnFocusTo`; on close
  // (the exit button / Esc) focus restores to it. `dialogRef` is always attached
  // to the root so the focus effect can resolve it the moment `fullscreen` flips.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  function enterFullscreen(trigger: HTMLElement): void {
    returnFocusRef.current = trigger;
    setFullscreen(true);
  }
  function exitFullscreen(): void {
    setFullscreen(false);
  }

  // Move focus into the dialog on open; restore it to the trigger on close. Deps
  // `[fullscreen]` ONLY — this effect must NOT re-run when `submitting` flips
  // mid-save (that would yank focus out of the dialog). The cleanup restores
  // focus when `fullscreen` toggles back to false (Esc / the exit button).
  useEffect(() => {
    if (!fullscreen) return;
    dialogRef.current?.focus();
    return () => {
      returnFocusRef.current?.focus?.();
      returnFocusRef.current = null;
    };
  }, [fullscreen]);

  // Esc exits the overlay (mirrors a modal's Escape close), guarded while
  // submitting so a mid-save Escape does not yank the manager out before the
  // toast lands. Re-subscribes when `submitting` flips so the guard reads the
  // live value; the focus effect above is separate so this re-subscription
  // never moves focus.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) exitFullscreen();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen, submitting]);
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

  // Save is the provider's full PUT. Disabled while submitting, or when the
  // WHOLE form is invalid (a profile/category error on /config blocks the full
  // save). The Sumber view never contributes a blocking error.
  const saveDisabled = submitting || !wholeFormValid;
  // When the state-machine section is valid but some OTHER section is not, tell
  // the manager where the blocking error is (they can fix it back on /config).
  const otherSectionInvalid = !wholeFormValid && smErrors.length === 0;

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

  // The full-screen toggle (aria-pressed: a two-state button, not a role=switch
  // — it toggles a presentational overlay, not a setting). Sits next to Simpan
  // in the header actions. Label flips with the state so the affordance reads as
  // the action available, not the current state. The click captures itself as
  // the `returnFocusTo` target BEFORE entering the overlay (mirrors
  // `TvLayoutEditOverlay`'s trigger capture).
  const fullscreenButton = (
    <button
      type="button"
      className="btn"
      aria-pressed={fullscreen}
      onClick={(e) => (fullscreen ? exitFullscreen() : enterFullscreen(e.currentTarget))}
      data-testid="designer-toggle-fullscreen"
    >
      {fullscreen ? 'Keluar dari Layar Penuh' : 'Layar Penuh'}
    </button>
  );

  return (
    <div
      className={`alur-status-designer${fullscreen ? ' alur-status-designer--fullscreen' : ''}`}
      // The overlay is a modal dialog only while full-screen (mirrors
      // `TvLayoutEditOverlay`: `role="dialog" aria-modal="true"` + a
      // `tabindex={-1}` container that receives focus on open). `aria-modal`
      // marks the AppShell chrome (sidebar + topbar, siblings of `<main>`) as
      // non-interactive to AT — the same way `TvLayoutEditOverlay` covers them.
      // Undefined when not full-screen so the page reads as a normal document.
      role={fullscreen ? 'dialog' : undefined}
      aria-modal={fullscreen ? true : undefined}
      aria-label={fullscreen ? 'Editor Alur Status Tiket — Layar Penuh' : undefined}
      tabIndex={fullscreen ? -1 : undefined}
      ref={dialogRef}
    >
      <PageHeader
        title="Alur Status Tiket"
        subtitle="Konfigurasi Operasional"
        actions={
          <>
            {fullscreenButton}
            {saveButton}
          </>
        }
      />

      {/* Live-ticket strand caution — the designer is now the decision point
          where the manager edits the state machine (the old AdminPanel
          state-machine section was removed when the tablist was consolidated
          into the sidebar, so this warning moved here). Always visible in BOTH
          Diagram + Source views: the active alur status is resolved per
          operation, so a ticket sitting in a status this save removes or
          renames has no legal next step — its caller action buttons vanish and
          it can only be cleared by a daily reset. The dropped-standard-status
          caution was removed from the designer (the standar/bawaan distinction
          is no longer surfaced in the UI), so this live-ticket strand caution is
          the only warning the designer renders. Uses the existing
          `.admin-panel__warning` class (the warning-at-decision-point invariant
          — do not remove that CSS rule). */}
      <p className="admin-panel__warning" data-testid="state-machine-warning">
        Perhatian: mengubah atau menghapus status yang sedang dipakai tiket aktif membuat tiket
        tersebut tidak bisa dilanjutkan — tombol aksinya hilang di layar petugas. Ubah alur status
        saat antrian kosong, misalnya setelah reset harian.
      </p>

      {/* Diagram / Source segmented toggle (view switch). */}
      <div className="sm-view-toggle" role="group" aria-label="Tampilan editor alur status">
        <button
          type="button"
          className="sm-view-toggle__btn"
          aria-pressed={view === 'diagram'}
          onClick={() => setView('diagram')}
          data-testid="sm-view-diagram"
        >
          Diagram
        </button>
        <button
          type="button"
          className="sm-view-toggle__btn"
          aria-pressed={view === 'source'}
          onClick={() => setView('source')}
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
        <StateMachineSource stateMachine={form.stateMachine} />
      )}
    </div>
  );
}
import { useMemo } from 'react';
import {
  type StateMachineForm,
  defaultStateMachineForm,
  missingCanonicalStates,
  referencedStates,
  updateState,
  addState,
  removeState,
  updateTransition,
  addTransition,
  removeTransition,
  TRANSITION_ACTION_LABELS,
  TRANSITION_ACTIONS,
} from '../lib/state-machine';
import type { TransitionActionType } from '../api/types';

/** The "aksi" options for a transition row — the shared `TRANSITION_ACTIONS`
 *  list, so the wizard and the designer can never offer different sets. */
const TRANSITION_ACTION_OPTIONS = TRANSITION_ACTIONS;

/**
 * Reusable state-machine editor (DRY extraction from the wizard's step 3, now
 * shared between the first-run wizard and the operational `AdminPanel`). Pure
 * presentational: the parent owns the {@link StateMachineForm} slice and
 * computes the custom-mode `errors` via the shared pure
 * {@link validateCustomStateMachine} helper (single source of truth — the
 * parent's save/Lanjut guard reuses the same list). The editor calls
 * `onChange(next)` with a new form on every mutation; it never mutates in
 * place (the lib helpers are pure).
 *
 * The `mode` preset (`'default' | 'custom'`) is a client-only field never sent
 * to core-api — the parent strips it at save / finalize. Default mode renders
 * the PRD §7 graph read-only; custom mode renders the states + transitions
 * editor with constrained `<select>` dropdowns (structurally prevents the
 * backend's "transition references states not in schema" 400). All
 * `data-testid`s (`sm-mode`, `sm-readonly`, `sm-editor`, `sm-errors`) and
 * class names are preserved verbatim from the original wizard JSX so existing
 * CSS keeps working.
 *
 * **Copy is Indonesian, no internal terms.** The wizard's original "States" /
 * "Transisi N from|to" labels leaked developer vocabulary; the editor now also
 * sits on `/config`, which a non-technical store manager uses daily rather than
 * once at setup, so they read "Status" / "Transisi N dari|ke" (CLAUDE.md:
 * user-visible text must never leak internal terms). "Transisi" is kept over
 * "Perpindahan" for consistency with the shared validation copy in
 * `lib/state-machine` and the wizard's review summary.
 *
 * **The dropped-standard-status caution is owned here, not by the parents.**
 * Unlike `errors` it gates nothing, and it is derivable from `value` alone — so
 * computing it in the editor covers both call sites (the daily-use `AdminPanel`,
 * where the real regression risk lives, and the first-run wizard) without
 * threading a prop through either. See `missingCanonicalStates` for why it is a
 * warning and never a validation error.
 */
export function StateMachineEditor({
  value,
  onChange,
  errors,
}: {
  value: StateMachineForm;
  onChange: (next: StateMachineForm) => void;
  errors: string[];
}): JSX.Element {
  // States referenced by at least one transition — hoisted out of the render
  // loop so the states editor's remove-guard reads one shared set. Default mode
  // never renders the editor, so an empty set is harmless there.
  const referencedStateSet = useMemo(
    () => (value.mode === 'custom' ? referencedStates(value) : new Set<string>()),
    [value],
  );
  // Statuses of the standard flow the edited graph dropped — a non-blocking
  // caution, NOT a validation error (see `missingCanonicalStates`). Derived from
  // `value` alone, so owning it here covers BOTH call sites (the operational
  // panel and the first-run wizard) with no new prop threading; the parent's
  // save/Lanjut gate deliberately does not read it.
  const missingStandardStates = useMemo(() => missingCanonicalStates(value), [value]);
  // Both the error list and the warning describe the editor group; join whatever
  // is present so AT hears each one (the ids exist only while rendered).
  const editorDescribedBy =
    [errors.length > 0 ? 'sm-errors' : null, missingStandardStates.length > 0 ? 'sm-standard-warning' : null]
      .filter((id): id is string => id !== null)
      .join(' ') || undefined;

  return (
    <>
      <fieldset className="radio-group" data-testid="sm-mode">
        <legend>Jenis alur status</legend>
        <label className="radio-group__item">
          <input
            type="radio"
            name="sm-mode"
            value="default"
            checked={value.mode === 'default'}
            onChange={() => onChange(defaultStateMachineForm())}
          />
          Gunakan alur status standar
        </label>
        <label className="radio-group__item">
          <input
            type="radio"
            name="sm-mode"
            value="custom"
            checked={value.mode === 'custom'}
            onChange={() => onChange({ ...value, mode: 'custom' })}
          />
          Susun alur status sendiri
        </label>
      </fieldset>

      {value.mode === 'default' ? (
        <div className="sm-readonly" data-testid="sm-readonly">
          <p className="wizard__hint">Alur status tiket standar (hanya lihat):</p>
          <ul className="entry-list">
            {value.transitions.map((t, i) => (
              <li key={i} className="entry-row entry-row--transition">
                <span className="entry-row__state">{t.from}</span>
                <span className="entry-row__arrow">→</span>
                <span className="entry-row__state">{t.to}</span>
                <span className="entry-row__label">{t.actionLabel}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div
          data-testid="sm-editor"
          role="group"
          aria-label="Editor alur status"
          aria-describedby={editorDescribedBy}
        >
          <h3 className="wizard__subhead">Status</h3>
          <ul className="entry-list">
            {value.states.map((s, i) => {
              const referenced = referencedStateSet.has(s);
              return (
                <li key={i} className="entry-row entry-row--state">
                  <input
                    className="field__input entry-row__state"
                    type="text"
                    value={s}
                    onChange={(e) => onChange(updateState(value, i, e.target.value.toUpperCase()))}
                    aria-label={`Status ${i + 1}`}
                    aria-required="true"
                  />
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => onChange(removeState(value, i))}
                    disabled={referenced}
                    title={referenced ? 'Status sedang dipakai transisi' : 'Hapus status'}
                  >
                    Hapus
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="btn btn--secondary" onClick={() => onChange(addState(value))}>
            + Tambah Status
          </button>

          <h3 className="wizard__subhead">Transisi</h3>
          <ul className="entry-list">
            {value.transitions.map((t, i) => (
              <li key={i} className="entry-row entry-row--transition">
                <select
                  className="field__input entry-row__state"
                  value={t.from}
                  onChange={(e) => onChange(updateTransition(value, i, { from: e.target.value }))}
                  aria-label={`Transisi ${i + 1} dari`}
                  aria-required="true"
                >
                  {value.states.map((s, si) => (
                    <option key={`${si}-${s}`} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <span className="entry-row__arrow">→</span>
                <select
                  className="field__input entry-row__state"
                  value={t.to}
                  onChange={(e) => onChange(updateTransition(value, i, { to: e.target.value }))}
                  aria-label={`Transisi ${i + 1} ke`}
                  aria-required="true"
                >
                  {value.states.map((s, si) => (
                    <option key={`${si}-${s}`} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <input
                  className="field__input entry-row__label"
                  type="text"
                  value={t.actionLabel}
                  onChange={(e) => onChange(updateTransition(value, i, { actionLabel: e.target.value }))}
                  placeholder="Label aksi (Indonesia)"
                  aria-label={`Transisi ${i + 1} label aksi`}
                  aria-required="true"
                />
                {/* What the button DOES. The designer offers the same choice per
                    transition; the wizard must too, or a flow set up here could
                    only ever contain plain status changes and "Pindah Kategori"
                    would be unreachable until the manager opened the designer. */}
                <select
                  className="field__input entry-row__state"
                  value={t.action}
                  onChange={(e) =>
                    onChange(
                      updateTransition(value, i, {
                        action: e.target.value as TransitionActionType,
                      }),
                    )
                  }
                  aria-label={`Transisi ${i + 1} aksi`}
                  aria-required="true"
                >
                  {TRANSITION_ACTION_OPTIONS.map((a) => (
                    <option key={a} value={a}>
                      {TRANSITION_ACTION_LABELS[a]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => onChange(removeTransition(value, i))}
                  disabled={value.transitions.length <= 1}
                >
                  Hapus
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn--secondary" onClick={() => onChange(addTransition(value))}>
            + Tambah Transisi
          </button>

          {errors.length > 0 && (
            <ul className="wizard__errors" id="sm-errors" data-testid="sm-errors">
              {errors.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Dropped-standard-status caution. Rendered OUTSIDE the editor group and
          in the warn tint so it never reads as one of the red `sm-errors` that
          block saving — this one does not block anything. */}
      {missingStandardStates.length > 0 && (
        <div className="sm-warning" id="sm-standard-warning" data-testid="sm-standard-warning">
          <p className="sm-warning__intro">
            Perhatian: alur status yang Anda susun tidak memakai sebagian status dari alur standar.
            Untuk semua tiket berikutnya:
          </p>
          <ul className="sm-warning__list">
            {missingStandardStates.map(({ state, consequence }) => (
              <li key={state}>
                <strong>{state}</strong> tidak ada — {consequence}.
              </li>
            ))}
          </ul>
          <p className="sm-warning__outro">
            Jika ini memang disengaja, konfigurasi tetap bisa disimpan.
          </p>
        </div>
      )}
    </>
  );
}
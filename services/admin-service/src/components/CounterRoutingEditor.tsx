import { useEffect, useMemo, useState } from 'react';
import type { PriorityPolicy } from '../api/types';
import { PRIORITY_POLICY_LABELS, PRIORITY_POLICY_DESCRIPTIONS } from '../lib/labels';
import { SearchableCategorySelect } from './SearchableCategorySelect';

/**
 * Shared presentational editor for the counter↔category routing matrix used
 * by both the wizard's Step 2 (`/admin/wizard`) and the operational admin
 * panel (`/admin`). Unifies the two surfaces on the wizard's table + Edit-modal
 * design (QUE-43): a read-only `<table class="data-table">` whose Edit button
 * opens an overlay modal carrying the editable fields (counter name, priority
 * policy, served categories via {@link SearchableCategorySelect}).
 *
 * **SRP boundary:** the editor is purely presentational + owns only the modal
 * open/close + draft state. It does NOT touch `counterId`, does NOT add or
 * remove rows — those mutations live in the parent (the wizard's
 * `setCounterCount` / the admin's `addRouting`+`removeRouting`). `counterId`
 * is auto-managed by the parent (the backend rejects duplicates; both surfaces
 * already auto-assign `max+1`), and is **not hand-editable** in either surface.
 *
 * **Wire contract unchanged:** the parent still owns the full
 * `routingRules` array (with `counterId` on each row) and PUTs it back via
 * `PUT /api/system/config` — `counterId` travels on the wire, it is just not
 * hand-edited in the UI.
 *
 * The component is **controlled** w.r.t. the rows: `routingRules` + the
 * `onUpdate` / `onAdd` / `onRemove` callbacks are the parent's. `idPrefix`
 * keeps test ids / a11y labels stable; the wizard passes `'routing'` so the
 * step-2 test ids (`routing-edit-*`, `routing-counter-name-*`,
 * `routing-categories-*`, `routing-modal-save`, `routing-priority-desc`) stay
 * identical to the pre-shared-component markup (the two pages never mount
 * together — different routes — so a shared prefix never collides).
 */
export interface RoutingRuleRow {
  counterId: number;
  counterName: string;
  assignedCategoryCodes: readonly string[];
  priorityPolicy: PriorityPolicy;
}

export interface CounterRoutingEditorProps {
  /** Routing rows. `counterId` is the React key (unique — backend rejects dups,
   *  both surfaces auto-assign). */
  routingRules: readonly RoutingRuleRow[];
  /** Full category list for the code→name cell lookup + the modal
   *  `SearchableCategorySelect`. */
  categories: readonly { code: string; name: string }[];
  /** Patch one row (counterName / priorityPolicy / assignedCategoryCodes).
   *  Called from the Edit modal Simpan. */
  onUpdate: (index: number, patch: Partial<RoutingRuleRow>) => void;
  /** Provide to render "+ Tambah Counter". undefined ⇒ no Add button (wizard
   *  step 2 — count is owned by step 1). */
  onAdd?: () => void;
  /** Provide to render a "Hapus" button in the Aksi column. undefined ⇒ no
   *  remove (wizard step 2). */
  onRemove?: (index: number) => void;
  /** Disable the Hapus button for a row (e.g. admin: `routingRules.length <= 1`).
   *  Default: always allowed when `onRemove` is set. */
  canRemove?: () => boolean;
  /** Stable id prefix for test ids / a11y. Default `'routing'`. */
  idPrefix?: string;
}

/**
 * Hand-rolled overlay modal for editing one counter's routing rule. Mirrors
 * the wizard's pre-shared-component `RoutingEditModal` markup exactly so the
 * existing wizard step-2 tests stay green. NOT native `<dialog>` — jsdom does
 * not implement `showModal()`, so an overlay div pattern works identically in
 * tests and real browsers (NFR-MNT-01). A local draft (seeded from `rule`)
 * lets Batal discard; the `key` on the caller re-seeds the draft per counter.
 * Emits a `Partial<RoutingRuleRow>` patch on Save (counterName /
 * priorityPolicy / assignedCategoryCodes).
 */
function RoutingEditModal({
  rule,
  index,
  categories,
  idPrefix,
  returnFocusTo,
  onClose,
  onSave,
}: {
  rule: RoutingRuleRow;
  index: number;
  categories: readonly { code: string; name: string }[];
  idPrefix: string;
  returnFocusTo: HTMLElement | null;
  onClose: () => void;
  onSave: (patch: Partial<RoutingRuleRow>) => void;
}) {
  const [counterName, setCounterName] = useState(rule.counterName);
  const [priorityPolicy, setPriorityPolicy] = useState<PriorityPolicy>(rule.priorityPolicy);
  const [assignedCategoryCodes, setAssignedCategoryCodes] = useState<string[]>([
    ...rule.assignedCategoryCodes,
  ]);

  // A11y (WCAG 2.4.3): return focus to the trigger (the Edit button) when the
  // modal unmounts. `returnFocusTo` was captured by the caller's `onClick`
  // (NOT here via `document.activeElement`, which by mount time has already
  // moved into the modal's `autoFocus` input). Batal / Simpan / Escape /
  // overlay-click all unmount the modal via `key={editingIndex}`.
  useEffect(() => {
    return () => {
      returnFocusTo?.focus?.();
    };
  }, [returnFocusTo]);

  const descId = `${idPrefix}-priority-desc`;
  const titleId = `${idPrefix}-edit-title`;

  return (
    <div
      className="modal__overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h3 className="modal__title" id={titleId}>
          Edit Counter {index + 1}
        </h3>

        <label className="field">
          <span className="field__label">Nama counter</span>
          <input
            className="field__input"
            type="text"
            value={counterName}
            onChange={(e) => setCounterName(e.target.value)}
            placeholder="mis. Loket 1"
            aria-label={`Counter ${index + 1} nama`}
            aria-required="true"
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field__label">Kebijakan prioritas</span>
          <select
            className="field__input"
            value={priorityPolicy}
            onChange={(e) => setPriorityPolicy(e.target.value as PriorityPolicy)}
            aria-label={`Counter ${index + 1} kebijakan prioritas`}
            aria-required="true"
            aria-describedby={descId}
          >
            {(Object.keys(PRIORITY_POLICY_LABELS) as PriorityPolicy[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_POLICY_LABELS[p]}
              </option>
            ))}
          </select>
          {/* The long-form explanation of the picked policy, surfaced as a hint
              under the select so the short option labels stay scannable without
              losing the meaning (feedback: priority copy was too long). Mirrors
              the table-cell info tooltip — same description source. */}
          <span className="field__hint" id={descId} data-testid={`${idPrefix}-priority-desc`}>
            {PRIORITY_POLICY_DESCRIPTIONS[priorityPolicy]}
          </span>
        </label>

        <SearchableCategorySelect
          categories={categories}
          selectedCodes={assignedCategoryCodes}
          onChange={setAssignedCategoryCodes}
          idPrefix={`${idPrefix}-edit`}
        />

        <div className="modal__actions">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Batal
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid={`${idPrefix}-modal-save`}
            onClick={() => onSave({ counterName, priorityPolicy, assignedCategoryCodes })}
          >
            Simpan
          </button>
        </div>
      </div>
    </div>
  );
}

export function CounterRoutingEditor({
  routingRules,
  categories,
  onUpdate,
  onAdd,
  onRemove,
  canRemove,
  idPrefix = 'routing',
}: CounterRoutingEditorProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  // The Edit button that opened the modal, captured at click time (so focus can
  // be returned to it when the modal closes — a11y WCAG 2.4.3). Captured in
  // the button's `onClick` (before `autoFocus` moves focus into the modal) and
  // passed to the modal as `returnFocusTo`; the modal restores focus to it on
  // unmount.
  const [lastTrigger, setLastTrigger] = useState<HTMLElement | null>(null);

  // code→name lookup so the Kategori Dilayani cell shows category names (not
  // raw codes) — the friendly-copy rule. `assignedCategoryCodes` stores codes;
  // this map is the display bridge. Built once per category edit.
  const codeToName = useMemo(
    () => new Map(categories.map((c) => [c.code, c.name])),
    [categories],
  );

  return (
    <>
      <div className="data-table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">No.</th>
              <th scope="col">Nama Counter</th>
              <th scope="col">Kebijakan Prioritas</th>
              <th scope="col">Kategori Dilayani</th>
              <th scope="col">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {routingRules.map((rule, i) => {
              const assignedNames = rule.assignedCategoryCodes.map(
                (code) => codeToName.get(code) ?? code,
              );
              return (
                <tr key={rule.counterId}>
                  <td>{i + 1}</td>
                  <td data-testid={`${idPrefix}-counter-name-${i}`}>
                    {rule.counterName || `Counter ${i + 1}`}
                  </td>
                  <td>
                    <span className="policy-cell">
                      <span className="policy-cell__label">
                        {PRIORITY_POLICY_LABELS[rule.priorityPolicy]}
                      </span>
                      {/* Inline info glyph carries the full explanation as a
                          native `title` tooltip + an AT-readable `aria-label`,
                          so the short label stays narrow without losing the
                          meaning the parenthetical used to inline (feedback:
                          priority copy was too long). */}
                      <span
                        className="policy-cell__info"
                        role="img"
                        aria-label={`Keterangan: ${PRIORITY_POLICY_DESCRIPTIONS[rule.priorityPolicy]}`}
                        title={PRIORITY_POLICY_DESCRIPTIONS[rule.priorityPolicy]}
                      >
                        ℹ
                      </span>
                    </span>
                  </td>
                  <td data-testid={`${idPrefix}-categories-${i}`}>
                    {assignedNames.length > 0 ? assignedNames.join(', ') : 'tidak ada kategori'}
                  </td>
                  <td className="data-table__actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={(e) => {
                        setLastTrigger(e.currentTarget as HTMLElement);
                        setEditingIndex(i);
                      }}
                      aria-label={`Edit counter ${i + 1}`}
                      data-testid={`${idPrefix}-edit-${i}`}
                    >
                      Edit
                    </button>
                    {onRemove && (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => onRemove(i)}
                        disabled={canRemove ? !canRemove() : false}
                      >
                        Hapus
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {onAdd && (
        <button type="button" className="btn btn--secondary" onClick={onAdd}>
          + Tambah Counter
        </button>
      )}

      {editingIndex !== null && routingRules[editingIndex] && (
        <RoutingEditModal
          key={editingIndex}
          rule={routingRules[editingIndex]}
          index={editingIndex}
          categories={categories}
          idPrefix={idPrefix}
          returnFocusTo={lastTrigger}
          onClose={() => setEditingIndex(null)}
          onSave={(patch) => {
            onUpdate(editingIndex, patch);
            setEditingIndex(null);
          }}
        />
      )}
    </>
  );
}
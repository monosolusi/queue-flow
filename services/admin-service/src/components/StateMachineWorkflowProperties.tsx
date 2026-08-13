/**
 * Right-side properties panel for the "Alur Status Tiket" workflow builder
 * ({@link StateMachineWorkflow}). Pure presentational — receives the current
 * selection (`selectedNodeId` / `selectedEdgeId`), the form, the canvas
 * nodes/edges, and the mutation handlers; renders the node editor or the edge
 * editor. No state of its own.
 *
 * Visual-only redesign (manager feedback): the canvas node/edge carry no inline
 * `<input>` and no "Hapus" button — those moved here. The panel renders ONLY
 * when a node or edge is selected on the canvas; the empty-selection view is
 * the PALETTE (node picker), owned and rendered by the parent — this component
 * is mounted only when there IS a selection. A "Kembali ke pilihan status"
 * back button at the top clears the canvas selection (via `onClearSelection`)
 * so the right panel returns to the node-picker view. Touch targets are ≥44px
 * (CLAUDE.md a11y baseline); inputs are labelled with sibling `<label>`
 * elements (ARIA: sibling label, not a wrapping `aria-label`). The node name
 * input uppercases on change (mirroring the form editor convention) and lifts a
 * rename via `onRenameState(oldName, newName)`. The edge action-label input
 * lifts via `onEditTransitionLabel(edgeId, label)`. The edge delete button is
 * disabled when only one transition remains — the ≥1-transition invariant
 * (preserves the existing guard). The panel renders only in custom mode
 * (default mode is read-only canvas only).
 */
import { describeState, type StateMachineForm } from '../lib/state-machine';
import { isDuplicateTransition, type FlowEdge, type FlowNode } from '../lib/state-machine-flow';
import type { WorkflowHandlers } from './StateMachineWorkflowNodes';

export interface WorkflowPropertiesPanelProps {
  mode: 'default' | 'custom';
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  form: StateMachineForm;
  nodes: FlowNode[];
  edges: FlowEdge[];
  handlers: WorkflowHandlers;
  onClearSelection: () => void;
}

/**
 * The right-side panel. Renders one of two views (the empty-selection view is
 * the PALETTE, owned by the parent — this component is mounted only when there
 * IS a selection):
 *  1. Node editor — when a node is selected.
 *  2. Edge editor — when an edge is selected.
 *
 * Both views start with a "Kembali ke pilihan status" back button that calls
 * `onClearSelection` to drop the canvas selection so the right panel returns to
 * the node-picker (palette) view. The panel is hidden in default mode (the
 * parent renders it only in custom mode); this component still guards on
 * `mode` so a mis-wired mount stays presentational and renders nothing rather
 * than editing controls.
 */
export function StateMachineWorkflowProperties({
  mode,
  selectedNodeId,
  selectedEdgeId,
  form,
  nodes,
  edges,
  handlers,
  onClearSelection,
}: WorkflowPropertiesPanelProps): JSX.Element | null {
  // In default mode the canvas is read-only — no panel editing controls.
  if (mode !== 'custom') return <></>;

  const selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;
  const selectedEdge = selectedEdgeId
    ? edges.find((e) => e.id === selectedEdgeId) ?? null
    : null;

  // The back button is the same in both the node-editor and edge-editor views
  // — hoisted once so the JSX is not duplicated. Inline `<svg>` (no external
  // assets — NFR-REL-01) using `currentColor` so it adapts to tokens + light/dark.
  const backButton = (
    <button
      type="button"
      className="sm-properties__back"
      data-testid="sm-panel-back"
      aria-label="Kembali ke pilihan status"
      onClick={onClearSelection}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <path
          d="M15 5l-7 7 7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Kembali ke pilihan status
    </button>
  );

  if (selectedNode) {
    // Canvas-only terminal markers (Start/End) — auto-derived visual
    // affordances, NOT real states. They carry no name/description on the form,
    // so the state editor below would render a spurious editor for `__start`/
    // `__end`. Branch to a read-only marker panel first: a heading naming the
    // marker + a hint explaining what it denotes (entry/exit). No editing
    // controls — the manager cannot rename/delete a marker (it is derived from
    // the topology, not a form entity); the back button returns to the palette.
    if (selectedNode.type === 'start' || selectedNode.type === 'end') {
      const isStart = selectedNode.type === 'start';
      return (
        <aside className="sm-properties" data-testid="sm-properties" aria-label="Properti titik alur">
          {backButton}
          <p className="sm-properties__heading">{isStart ? 'Titik awal alur' : 'Titik akhir alur'}</p>
          <div className="sm-properties__field">
            <p className="sm-properties__hint" data-testid="panel-marker-description">
              {isStart
                ? 'Status awal — status tanpa transisi masuk. Panah keluar dari titik ini ke status pertama.'
                : 'Status akhir — status tanpa transisi keluar. Panah masuk ke titik ini dari status terakhir.'}
            </p>
          </div>
        </aside>
      );
    }
    const name = selectedNode.data.name;
    const description = describeState(form, name);
    // The node's OUTGOING transitions — now reframed as the independent
    // "Transisi keluar" surface (the Caller-button LABELS), decoupled from the
    // Kaleo-style node-level "Aksi" (below). A transition's only domain effect
    // is updating the ticket status to the target, so the action TYPE is fixed
    // "Update Status" — but that is now surfaced in the separate "Aksi" section
    // (node-level, NOT linked to any edge); here the transition is the
    // button-label + target surface. Each row renders an editable "Label aksi"
    // input (the Caller button text — `onEditTransitionLabel`, the same input
    // the standalone edge editor carries) + a "Ke" select (re-point the TARGET
    // via `onRerouteTransition`, source stays this node) + a "Hapus" button
    // (`onDeleteTransition`, disabled when only one transition remains — the
    // ≥1-transition invariant). The edges are read directly from the canvas
    // because the inline editor needs the edge `id` to call the handlers — the
    // outgoing edges are exactly `edges.filter(e => e.source === name)`.
    // Terminal edges (sink→End) are excluded so a sink state with no real
    // outgoing transitions shows the empty hint, not a spurious row. The
    // `actionLabel` STAYS per-Transition on the wire (unchanged) — this is a
    // presentation reframing, not a wire/domain change (the new node-level
    // "Aksi" travel the separate `nodeActions` wire map).
    const outgoing = edges.filter((e) => e.source === name && e.type !== 'terminal');
    // The "+ Tambah transisi" button is disabled when every status on the
    // canvas is already a TARGET of an outgoing edge from this node (no
    // non-duplicate target left — adding would produce a duplicate edge, which
    // the graph invariant rejects). `isDuplicateTransition` is the single
    // source of truth for the duplicate check, shared with onConnect /
    // onRerouteTransition / onAddTransitionFrom.
    const canAddTransition = !form.states.every((s) => isDuplicateTransition(edges, name, s));
    // The node's Kaleo-style node-level actions, NOT linked to any edge. Read
    // from `form.nodeActions[name]` (a persisted, independent list keyed by
    // state name). Panel-only: a node-action edit lifts as a form-only change
    // (no canvas node/edge change — `graphSignature` excludes `nodeActions`).
    const nodeActions = form.nodeActions[name] ?? [];
    return (
      <aside className="sm-properties" data-testid="sm-properties" aria-label="Properti status">
        {backButton}
        <p className="sm-properties__heading">Status terpilih</p>
        <div className="sm-properties__field">
          <label className="sm-properties__label" htmlFor="panel-state-name">
            Nama status
          </label>
          <input
            id="panel-state-name"
            type="text"
            className="sm-properties__input"
            data-testid="panel-state-name"
            value={name}
            aria-describedby="panel-state-name-hint"
            onChange={(e) => handlers.onRenameState(selectedNode.id, e.target.value.toUpperCase())}
          />
          <p id="panel-state-name-hint" className="sm-properties__hint">
            {description}
          </p>
        </div>
        {/* Read-only "Deskripsi" — the derived description (canonical copy for
            a canonical name, or a summary of outgoing transitions for a custom
            name). NOT editable: the wire contract carries no description field,
            so this is a client-side derivation only. Manager feedback: replace
            the read-only "Status" badge + sub-description + consequence block
            with a single labeled "Deskripsi" field. The description is a
            SEPARATE facet from the outgoing "Transisi keluar" panel — it stays
            "N transisi keluar" (unchanged) so the calibrated manager feedback
            holds. */}
        <div className="sm-properties__field">
          <p className="sm-properties__label">Deskripsi</p>
          <p className="sm-properties__hint" data-testid="panel-state-description">
            {description}
          </p>
        </div>
        {/* "Transisi keluar" — the node's OUTGOING transitions, the independent
            Caller-button LABEL surface. Each row is an editable "Label aksi"
            input (the Caller button text) + a "Ke" select (re-point the TARGET
            via onRerouteTransition, source stays this node) + a "Hapus" button
            (onDeleteTransition, disabled when only one transition remains).
            "+ Tambah transisi" adds a new outgoing edge (onAddTransitionFrom).
            The label is ALSO editable via the standalone edge editor (select
            an edge on the canvas) — the kept full-edit path. */}
        <div className="sm-properties__field">
          <p className="sm-properties__label" id="panel-transitions-label">
            Transisi keluar
          </p>
          <p className="sm-properties__hint">
            Tombol di panel caller untuk transisi keluar dari status ini.
          </p>
          {outgoing.length === 0 ? (
            <p className="sm-properties__hint" data-testid="panel-transitions-empty">
              Belum ada transisi keluar. Tambah transisi untuk membuat tombol dari status ini ke status lain.
            </p>
          ) : (
            <ul
              className="sm-properties__actions"
              aria-labelledby="panel-transitions-label"
              data-testid="panel-transitions"
            >
              {outgoing.map((edge) => {
                const labelId = `panel-transition-label-${edge.id}`;
                const toId = `panel-transition-to-${edge.id}`;
                return (
                  <li key={edge.id} className="sm-properties__action">
                    <label className="sm-properties__action-label" htmlFor={labelId}>
                      Label aksi
                    </label>
                    <input
                      id={labelId}
                      type="text"
                      className="sm-properties__input"
                      data-testid={`panel-transition-label-${edge.id}`}
                      placeholder="Label aksi"
                      value={edge.data.actionLabel}
                      aria-describedby="panel-transition-label-hint"
                      onChange={(e) => handlers.onEditTransitionLabel(edge.id, e.target.value)}
                    />
                    <label className="sm-properties__action-label" htmlFor={toId}>
                      Ke
                    </label>
                    <select
                      id={toId}
                      className="sm-properties__input"
                      data-testid={`panel-transition-to-${edge.id}`}
                      value={edge.target}
                      onChange={(e) => handlers.onRerouteTransition(edge.id, name, e.target.value)}
                    >
                      {form.states.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="sm-properties__action-delete"
                      data-testid={`panel-transition-delete-${edge.id}`}
                      aria-label="Hapus transisi"
                      disabled={handlers.transitionsCount <= 1}
                      onClick={() => handlers.onDeleteTransition(edge.id)}
                    >
                      Hapus
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p id="panel-transition-label-hint" className="sm-properties__hint">
            Teks tombol di panel caller.
          </p>
          <button
            type="button"
            className="btn btn--secondary sm-properties__add-action"
            data-testid="panel-add-transition"
            onClick={() => handlers.onAddTransitionFrom(name)}
            disabled={!canAddTransition}
          >
            + Tambah transisi
          </button>
        </div>
        {/* "Aksi" — Kaleo-style node-level actions, NOT linked to any edge.
            Each row is "Saat" (ON_ENTRY/ON_EXIT, when the action fires) + a
            read-only "Update Status" chip (the fixed action type — the only
            QMS action semantic today) + "Nilai" (the target status, an editable
            <select> of all states) + a "Hapus" button. "+ Tambah aksi" adds a
            new node-level action (onAddNodeAction). Panel-only: the canvas
            never reflects these (they are not transitions); a node-action edit
            lifts as a form-only change (no re-seed). */}
        <div className="sm-properties__field">
          <p className="sm-properties__label" id="panel-node-actions-label">
            Aksi
          </p>
          <p className="sm-properties__hint">
            Aksi node-level (Kaleo) — berjalan otomatis saat masuk/keluar status, tidak terkait transisi.
          </p>
          {nodeActions.length === 0 ? (
            <p className="sm-properties__hint" data-testid="panel-node-actions-empty">
              Belum ada aksi node-level. Tambah aksi untuk menjalankan sesuatu saat masuk/keluar status ini.
            </p>
          ) : (
            <ul
              className="sm-properties__actions"
              aria-labelledby="panel-node-actions-label"
              data-testid="panel-node-actions"
            >
              {nodeActions.map((action, i) => {
                const saatId = `panel-node-action-saat-${i}`;
                const toId = `panel-node-action-to-${i}`;
                return (
                  <li key={i} className="sm-properties__action">
                    <label className="sm-properties__action-label" htmlFor={saatId}>
                      Saat
                    </label>
                    <select
                      id={saatId}
                      className="sm-properties__input"
                      data-testid={`panel-node-action-saat-${i}`}
                      value={action.executionType}
                      onChange={(e) =>
                        handlers.onEditNodeAction(name, i, {
                          executionType: e.target.value as 'ON_ENTRY' | 'ON_EXIT',
                        })
                      }
                    >
                      <option value="ON_ENTRY">Saat masuk (ON_ENTRY)</option>
                      <option value="ON_EXIT">Saat keluar (ON_EXIT)</option>
                    </select>
                    <p className="sm-properties__action-label">Aksi</p>
                    <span
                      className="sm-properties__action-type"
                      data-testid={`panel-node-action-type-${i}`}
                    >
                      Update Status
                    </span>
                    <label className="sm-properties__action-label" htmlFor={toId}>
                      Nilai
                    </label>
                    <select
                      id={toId}
                      className="sm-properties__input"
                      data-testid={`panel-node-action-to-${i}`}
                      value={action.value}
                      onChange={(e) => handlers.onEditNodeAction(name, i, { value: e.target.value })}
                    >
                      {form.states.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="sm-properties__action-delete"
                      data-testid={`panel-node-action-delete-${i}`}
                      aria-label="Hapus aksi"
                      onClick={() => handlers.onDeleteNodeAction(name, i)}
                    >
                      Hapus
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            className="btn btn--secondary sm-properties__add-action"
            data-testid="panel-add-node-action"
            onClick={() => handlers.onAddNodeAction(name)}
          >
            + Tambah aksi
          </button>
        </div>
        <button
          type="button"
          className="btn btn--ghost sm-properties__delete"
          data-testid="panel-delete-state"
          aria-label={`Hapus status ${name}`}
          onClick={() => handlers.onDeleteState(selectedNode.id)}
        >
          Hapus status
        </button>
      </aside>
    );
  }

  if (selectedEdge) {
    const from = selectedEdge.source;
    const to = selectedEdge.target;
    const label = selectedEdge.data.actionLabel;
    const onlyTransition = handlers.transitionsCount <= 1;
    return (
      <aside className="sm-properties" data-testid="sm-properties" aria-label="Properti transisi">
        {backButton}
        <p className="sm-properties__heading">Transisi terpilih</p>
        <div className="sm-properties__field" data-testid="panel-transition-route">
          <label className="sm-properties__label" htmlFor="panel-transition-from">
            Dari
          </label>
          <select
            id="panel-transition-from"
            className="sm-properties__input"
            data-testid="panel-transition-from"
            value={from}
            onChange={(e) => handlers.onRerouteTransition(selectedEdge.id, e.target.value, to)}
          >
            {form.states.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span aria-hidden="true" className="sm-properties__route-arrow">→</span>
          <label className="sm-properties__label" htmlFor="panel-transition-to">
            Ke
          </label>
          <select
            id="panel-transition-to"
            className="sm-properties__input"
            data-testid="panel-transition-to"
            value={to}
            onChange={(e) => handlers.onRerouteTransition(selectedEdge.id, from, e.target.value)}
          >
            {form.states.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="sm-properties__field">
          <label className="sm-properties__label" htmlFor="panel-action-label">
            Label aksi
          </label>
          <input
            id="panel-action-label"
            type="text"
            className="sm-properties__input"
            data-testid="panel-action-label"
            placeholder="Label aksi"
            value={label}
            aria-describedby="panel-action-label-hint"
            onChange={(e) => handlers.onEditTransitionLabel(selectedEdge.id, e.target.value)}
          />
          <p id="panel-action-label-hint" className="sm-properties__hint">
            Teks tombol di panel caller.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--ghost sm-properties__delete"
          data-testid="panel-delete-transition"
          aria-label="Hapus transisi"
          onClick={() => handlers.onDeleteTransition(selectedEdge.id)}
          disabled={onlyTransition}
        >
          Hapus transisi
        </button>
        {onlyTransition && (
          <p className="sm-properties__hint">Minimal satu transisi harus tetap ada.</p>
        )}
      </aside>
    );
  }

  // The parent guarantees a selection when it mounts this component (it
  // switches to the palette view when nothing is selected). Keep this
  // defensive so a mis-wired mount stays presentational — return nothing
  // rather than an editor for a selection that no longer maps to a live
  // node/edge (e.g. a delete that cleared selection between render passes).
  return null;
}

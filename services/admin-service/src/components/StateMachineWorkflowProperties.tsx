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
    // The node's INCOMING transitions — reframed as "Aksi masuk" (entry
    // actions): the action shown for a node is the action when transitioning
    // INTO that node. Each incoming edge is one caller button that enters this
    // status (e.g. CALLING shows "Panggil Berikutnya" ←WAITING and "Panggil
    // Ulang" ←SKIPPED). The `actionLabel` STAYS per-Transition on the wire
    // (unchanged) — this is a conceptual framing flip only, not a wire/domain
    // change. Each row renders a "← Dari" prefix, a "Dari" <select> (re-point
    // the SOURCE via onRerouteTransition, target stays this node), a "Label
    // aksi" <input> (onEditTransitionLabel), and a "Hapus" button
    // (onDeleteTransition, disabled when only one transition remains — the
    // ≥1-transition invariant). The edges are read directly from the canvas
    // because the inline editor needs the edge `id` to call the handlers — the
    // incoming edges are exactly `edges.filter(e => e.target === name)`.
    // The node's INCOMING REAL transitions — terminal edges (Start→source) are
    // excluded so a source state with no real incoming transitions shows the
    // empty hint, not a spurious "Dari __start" row.
    const incoming = edges.filter((e) => e.target === name && e.type !== 'terminal');
    // The "Tambah aksi masuk" button is disabled when every status on the
    // canvas is already a SOURCE of an incoming edge into this node (no
    // non-duplicate source left — adding would produce a duplicate edge, which
    // the graph invariant rejects). `isDuplicateTransition` is the single
    // source of truth for the duplicate check, shared with onConnect /
    // onRerouteTransition / onAddTransitionTo.
    const canAddAction = !form.states.every((s) => isDuplicateTransition(edges, s, name));
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
            SEPARATE facet from the entry-action panel — it stays "N transisi
            keluar" (unchanged) so the calibrated manager feedback holds. */}
        <div className="sm-properties__field">
          <p className="sm-properties__label">Deskripsi</p>
          <p className="sm-properties__hint" data-testid="panel-state-description">
            {description}
          </p>
        </div>
        {/* Inline-editable "Aksi masuk" list — the node's INCOMING transitions
            (entry actions). Each row is a card with a "← Dari" prefix, a
            "Dari" select (all statuses on the canvas — re-point the source),
            a "Label aksi" input, and a "Hapus" button. The hint under the label
            clarifies the entry-action framing: each incoming transition is one
            caller button that enters this status. */}
        <div className="sm-properties__field">
          <p className="sm-properties__label" id="panel-state-actions-label">
            Aksi masuk
          </p>
          <p className="sm-properties__hint">
            Tombol caller saat transisi masuk ke status ini. Setiap transisi masuk adalah satu tombol.
          </p>
          {incoming.length === 0 ? (
            <p className="sm-properties__hint" data-testid="panel-state-actions-empty">
              Belum ada aksi masuk. Tambah aksi masuk untuk membuat transisi dari status lain ke status ini.
            </p>
          ) : (
            <ul
              className="sm-properties__actions"
              aria-labelledby="panel-state-actions-label"
              data-testid="panel-state-actions"
            >
              {incoming.map((edge) => {
                const fromId = `panel-action-from-${edge.id}`;
                const labelId = `panel-action-label-${edge.id}`;
                return (
                  <li key={edge.id} className="sm-properties__action">
                    <span className="sm-properties__action-prefix" aria-hidden="true">
                      ← Dari
                    </span>
                    <label className="sm-properties__action-label" htmlFor={fromId}>
                      Dari
                    </label>
                    <select
                      id={fromId}
                      className="sm-properties__input"
                      data-testid={`panel-action-from-${edge.id}`}
                      value={edge.source}
                      onChange={(e) => handlers.onRerouteTransition(edge.id, e.target.value, name)}
                    >
                      {form.states.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <label className="sm-properties__action-label" htmlFor={labelId}>
                      Label aksi
                    </label>
                    <input
                      id={labelId}
                      type="text"
                      className="sm-properties__input"
                      data-testid={`panel-action-label-${edge.id}`}
                      placeholder="Label aksi"
                      value={edge.data.actionLabel}
                      onChange={(e) => handlers.onEditTransitionLabel(edge.id, e.target.value)}
                    />
                    <button
                      type="button"
                      className="sm-properties__action-delete"
                      data-testid={`panel-action-delete-${edge.id}`}
                      aria-label="Hapus aksi"
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
          <button
            type="button"
            className="btn btn--secondary sm-properties__add-action"
            data-testid="panel-add-action"
            onClick={() => handlers.onAddTransitionTo(name)}
            disabled={!canAddAction}
          >
            + Tambah aksi masuk
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

/**
 * Right-side properties panel for the "Alur Status Tiket" workflow builder
 * ({@link StateMachineWorkflow}). Pure presentational — receives the current
 * selection (`selectedNodeId` / `selectedEdgeId`), the form, the canvas
 * nodes/edges, and the mutation handlers; renders the node editor, the edge
 * editor, or an empty hint. No state of its own.
 *
 * Visual-only redesign (manager feedback): the canvas node/edge carry no inline
 * `<input>` and no "Hapus" button — those moved here. Selecting a node or edge
 * on the canvas shows its editable fields in this panel; selecting nothing
 * shows a hint. Touch targets are ≥44px (CLAUDE.md a11y baseline); inputs are
 * labelled with sibling `<label>` elements (ARIA: sibling label, not a wrapping
 * `aria-label`). The node name input uppercases on change (mirroring the form
 * editor convention) and lifts a rename via `onRenameState(oldName, newName)`.
 * The edge action-label input lifts via `onEditTransitionLabel(edgeId, label)`.
 * The edge delete button is disabled when only one transition remains — the
 * ≥1-transition invariant (preserves the existing guard). The panel renders
 * only in custom mode (default mode is read-only canvas only).
 */
import { describeState, type StateMachineForm } from '../lib/state-machine';
import type { FlowEdge, FlowNode } from '../lib/state-machine-flow';
import type { WorkflowHandlers } from './StateMachineWorkflowNodes';

export interface WorkflowPropertiesPanelProps {
  mode: 'default' | 'custom';
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  form: StateMachineForm;
  nodes: FlowNode[];
  edges: FlowEdge[];
  handlers: WorkflowHandlers;
}

/**
 * The right-side panel. Renders one of three views:
 *  1. Node editor — when a node is selected.
 *  2. Edge editor — when an edge is selected.
 *  3. Empty hint — when nothing is selected (or selection no longer maps to a
 *     live node/edge, e.g. after a delete that cleared selection).
 *
 * The panel is hidden in default mode (the parent renders it only in custom
 * mode); this component still guards on `mode` so a mis-wired mount stays
 * presentational and shows the empty hint rather than editing controls.
 */
export function StateMachineWorkflowProperties({
  mode,
  selectedNodeId,
  selectedEdgeId,
  form,
  nodes,
  edges,
  handlers,
}: WorkflowPropertiesPanelProps): JSX.Element {
  // In default mode the canvas is read-only — no panel editing controls.
  if (mode !== 'custom') return <></>;

  const selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;
  const selectedEdge = selectedEdgeId
    ? edges.find((e) => e.id === selectedEdgeId) ?? null
    : null;

  if (selectedNode) {
    const name = selectedNode.data.name;
    const description = describeState(form, name);
    return (
      <aside className="sm-properties" data-testid="sm-properties" aria-label="Properti status">
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
        <p className="sm-properties__heading">Transisi terpilih</p>
        <p className="sm-properties__route" data-testid="panel-transition-route">
          {from} <span aria-hidden="true">→</span> {to}
        </p>
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

  return (
    <aside className="sm-properties sm-properties--empty" data-testid="sm-properties" aria-label="Properti alur status">
      <p className="sm-properties__hint sm-properties__hint--center">
        Pilih status atau transisi untuk mengedit.
      </p>
    </aside>
  );
}

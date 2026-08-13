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
import { canonicalStatusOf, describeState, stateActions, type StateMachineForm } from '../lib/state-machine';
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
    const name = selectedNode.data.name;
    const description = describeState(form, name);
    // The status the node IS, derived from its name (manager feedback: "nama
    // status boleh, tapi status itu state yang harus d hardcode — masukn d
    // properties"). The name is free-editable, but the STATUS is one of the 5
    // hardcoded PRD §7 system identities the queue engine keys off as literals
    // (QueueTicket.create() writes WAITING, complete() writes COMPLETED, …).
    // A true free-name vs. hardcoded-status decoupling would require a domain
    // rewrite (aggregate + repos + DB + wire DTO + all frontends — the engine
    // hardcodes TicketStatus.WAITING/CALLING/SERVING/SKIPPED/COMPLETED with
    // lifecycle timestamps coupled to the literal names), out of scope for this
    // manager-feedback fix. So the status is DERIVED from the name and surfaced
    // READ-ONLY here: a canonical name → "Status standar" badge + the status's
    // sub-description + the consequence (what stops working without it); a
    // custom name → "Status kustom" badge + the derived summary. The manager
    // sees exactly "what status is this node" without the name carrying the
    // burden of being both the display label and the system identity.
    const canonical = canonicalStatusOf(name);
    const statusLabel = canonical ? 'Status standar' : 'Status kustom';
    const subDescription = canonical ? canonical.description : description;
    // The state's "actions" (manager feedback: a state is just a status label;
    // the caller-panel buttons live on the transitions that enter/leave it).
    // The panel lists both directions so the manager can SEE the state's
    // interactions with the ticket without hunting the canvas. Clicking an
    // action jumps the canvas selection to that edge (the edge editor opens).
    const { incoming, outgoing } = stateActions(form, name);
    const edgeIdFor = (from: string, to: string): string | undefined =>
      edges.find((e) => e.source === from && e.target === to)?.id;
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
        {/* Read-only "Status" property — the hardcoded system role the node
            represents (derived from the name). NOT editable: the status is a
            load-bearing system identity, not a free label. The badge names the
            role (standar/kustom), the sub-description says what the status IS,
            and the consequence (canonical only) says what stops working without
            it — so the manager understands the status before editing/dropping. */}
        <div className="sm-properties__field" data-testid="panel-state-status">
          <p className="sm-properties__label">Status</p>
          <p className="sm-properties__badge" data-testid="panel-state-badge">
            {statusLabel}
          </p>
          <p className="sm-properties__subdescription" data-testid="panel-state-subdescription">
            {subDescription}
          </p>
          {canonical && (
            <p className="sm-properties__consequence" data-testid="panel-state-consequence">
              Tanpa status ini, {canonical.consequence}.
            </p>
          )}
        </div>
        <div className="sm-properties__field">
          <p className="sm-properties__label" id="panel-state-actions-label">
            Aksi
          </p>
          <p className="sm-properties__hint" id="panel-state-actions-hint">
            Status hanya sebuah label. Aksi (tombol di panel petugas) diatur pada transisi yang masuk dan keluar.
          </p>
          {incoming.length === 0 && outgoing.length === 0 ? (
            <p className="sm-properties__hint" data-testid="panel-state-actions-empty">
              Belum ada transisi yang terhubung. Tarik garis dari titik status ini ke status lain di kanvas, atau tambah transisi.
            </p>
          ) : (
            <ul className="sm-properties__actions" aria-labelledby="panel-state-actions-label" aria-describedby="panel-state-actions-hint" data-testid="panel-state-actions">
              {outgoing.map((t) => {
                const edgeId = edgeIdFor(t.from, t.to);
                return (
                  <li key={`out-${t.from}->${t.to}`}>
                    <button
                      type="button"
                      className="sm-properties__action"
                      data-testid={`panel-state-action-out-${t.from}->${t.to}`}
                      aria-label={`Pilih transisi ${t.from} ke ${t.to}: ${t.actionLabel || 'Label aksi'}`}
                      disabled={!edgeId}
                      onClick={() => edgeId && handlers.onSelectEdge(edgeId)}
                    >
                      <span aria-hidden="true">→</span> {t.to}
                      <span className="sm-properties__action-label">{t.actionLabel || 'Label aksi'}</span>
                    </button>
                  </li>
                );
              })}
              {incoming.map((t) => {
                const edgeId = edgeIdFor(t.from, t.to);
                return (
                  <li key={`in-${t.from}->${t.to}`}>
                    <button
                      type="button"
                      className="sm-properties__action"
                      data-testid={`panel-state-action-in-${t.from}->${t.to}`}
                      aria-label={`Pilih transisi ${t.from} ke ${t.to}: ${t.actionLabel || 'Label aksi'}`}
                      disabled={!edgeId}
                      onClick={() => edgeId && handlers.onSelectEdge(edgeId)}
                    >
                      {t.from} <span aria-hidden="true">→</span>
                      <span className="sm-properties__action-label">{t.actionLabel || 'Label aksi'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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

/**
 * React Flow custom node + edge components + the handler context that wires
 * them to the parent {@link StateMachineWorkflow}. Kept in a sibling file so the
 * main component owns state/effect/sync while these own only presentation.
 *
 * The node `id` IS the state name (names are unique per `validateCustomStateMachine`),
 * so a rename updates the node `id` + every edge `source`/`target` referencing it
 * (handled in the parent's `onRenameState`). Canonical states (the 5 PRD §7
 * defaults) get a distinct `--accent`-tinted class so the manager sees the
 * standard flow at a glance.
 *
 * Visual-only redesign (manager feedback): the node is an SVG CARD — a glyph on
 * the left, the state name (uppercase, bold) top-right, a short description
 * (muted) bottom-right. No inline `<input>` and no "Hapus" button on the node;
 * those moved to the right-side properties panel (see
 * {@link StateMachineWorkflowProperties}). The transition edge is a clean
 * bezier + a small READ-ONLY label chip showing the action label; editing the
 * label also lives in the panel. The node renders one TYPELESS `<Handle>` per
 * side (4 per node — ids match {@link HANDLE_IDS} exactly so the handle-id
 * regression test passes); the handles are CSS-hidden until the node is
 * hovered or selected (the canvas was too loud — 40 visible dots for the
 * 5-state default graph).
 */
import { createContext, useContext } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react';
import { DEFAULT_STATE_MACHINE, type NodeActionDto } from '../api/types';
import { HANDLE_IDS, type FlowEdgeData, type FlowNodeData } from '../lib/state-machine-flow';

/**
 * Handlers the parent provides via context. Behavior-only — no `form` data
 * field (ISP: the {@link StateNode} reads `data.description` computed by
 * `formToFlow`/`withDescriptions` on the node payload, so the context carries
 * no data, only mutation callbacks). `mode` toggles read-only vs editable; the
 * edge Hapus button is gated on `transitionsCount` to preserve the ≥1-transition
 * invariant. With the panel redesign these handlers are consumed by the
 * properties panel (not the node/edge), but the context type is kept so the
 * panel can share the same handler surface. The panel's "Kembali ke pilihan
 * status" back button is NOT part of this surface — it reaches the parent's
 * `clearSelection` via its own prop (ISP: the canvas node/edge never clear the
 * selection, so the context carries no selection-clearing callback).
 *
 * `onRerouteTransition` serves the panel's state-editor "Transisi keluar" row
 * (the "Ke" select re-points an outgoing edge's target from the node row) AND
 * the edge-editor's "Dari"/"Ke" selects (re-pointing either endpoint from the
 * full-edit path — the manager's "can't connect SERVING to COMPLETED from the
 * panel, only by dragging handles" feedback). The state node/edge components
 * never call it (it is panel-only), but it lives on this surface so the panel
 * shares the same handler context the canvas does.
 *
 * The node-level "Aksi" handlers (`onAddNodeAction` / `onDeleteNodeAction` /
 * `onEditNodeAction`) are the node-level actions, NOT linked to
 * any edge — they edit `form.nodeActions[state]` (a persisted, independent
 * list), never the canvas nodes/edges. They are panel-only (the canvas never
 * calls them), but live on this surface so the panel shares the same handler
 * context. The `patch` on `onEditNodeAction` covers `executionType` + `value`;
 * `type` stays fixed `UPDATE_STATUS` (the only QMS action semantic today).
 */
export interface WorkflowHandlers {
  mode: 'default' | 'custom';
  transitionsCount: number;
  onRenameState: (oldName: string, newName: string) => void;
  onDeleteState: (name: string) => void;
  onEditTransitionLabel: (edgeId: string, label: string) => void;
  onDeleteTransition: (edgeId: string) => void;
  /**
   * Re-point an edge's `from`/`to` endpoints from the properties panel. Guards
   * a duplicate (a different edge already has that source/target pair) by
   * no-op-ing so the controlled `<select>` reverts to the live edge value; the
   * caller's `onChange` is NOT called on a rejected reroute. A no-op when the
   * new pair equals the edge's current endpoints.
   */
  onRerouteTransition: (edgeId: string, from: string, to: string) => void;
  /**
   * Add a new OUTGOING transition from the given source state, picking the
   * first non-duplicate TARGET (a status not already the target of an outgoing
   * edge from this source). No-op when every status is already a target of an
   * outgoing edge from this source. The panel's node-level "Aksi" framing:
   * the action shown for a node is "Update Status ke <Nilai>", so the new
   * edge's `source` IS the selected node and `target` is the first
   * non-duplicate candidate. Mirrors the prior `onAddTransitionTo` structure
   * but anchors the SOURCE to the selected node rather than the target.
   */
  onAddTransitionFrom: (source: string) => void;
  /**
   * Add a node-level action (NOT linked to any edge) to
   * `form.nodeActions[state]`. Seeds a default `{ executionType: 'ON_ENTRY',
   * type: 'UPDATE_STATUS', value: <first non-self state> }`. The parent lifts
   * this as a form-only edit (no canvas node/edge change — `graphSignature`
   * excludes `nodeActions`, so no re-seed).
   */
  onAddNodeAction: (state: string) => void;
  /** Delete the node-level action at `index` for `state`. Form-only lift. */
  onDeleteNodeAction: (state: string, index: number) => void;
  /**
   * Patch the node-level action at `index` for `state`. The `patch` covers
   * `executionType` + `value`; `type` stays fixed `UPDATE_STATUS`. Form-only
   * lift (no canvas change).
   */
  onEditNodeAction: (state: string, index: number, patch: Partial<NodeActionDto>) => void;
  /**
   * Set/trim a per-state description override for `state`. An empty/whitespace
   * `value` clears the override (the key is deleted so `descriptionFor` falls
   * back to the derived canonical copy). Lifts via `lift` (form-only —
   * `graphSignature` excludes `descriptions`, so the sync effect skips the
   * re-seed); the handler calls `setNodes(withDescriptions(...))` BEFORE `lift`
   * so the node card's `data.description` refreshes on the canvas (descriptions
   * are canvas-rendered, unlike `nodeActions` which are panel-only).
   */
  onEditStateDescription: (state: string, value: string) => void;
  /**
   * Reset a terminal marker (Start/End) to the auto-derived position. Non-
   * stamping: the parent calls raw `onChange` so the sync effect re-seeds the
   * canvas (the marker re-derives its position from the real node bounds).
   * `key` is the fixed terminal key (`'start'` | `'end'`), NOT a state name.
   */
  onResetTerminalAuto: (key: 'start' | 'end') => void;
  /**
   * Delete (hide) a terminal marker. Non-stamping (re-seeds; the marker is
   * omitted from the canvas). `key` is `'start'` | `'end'`.
   */
  onDeleteTerminal: (key: 'start' | 'end') => void;
  /**
   * Drop a terminal marker from the palette at a flow position. Non-stamping
   * (re-seeds; the marker is placed at the drop position as a pinned `{x,y}`).
   * `key` is `'start'` | `'end'`.
   */
  onDropTerminal: (key: 'start' | 'end', position: { x: number; y: number }) => void;
  /**
   * Remove an EXPLICIT End connection (a manager-drawn arrow from `source`
   * into the End marker). Non-stamping (re-seeds the canvas; the explicit
   * terminal edge disappears). Used by the End-marker panel's "Transisi masuk"
   * delete button. Auto sink→End arrows are NOT removable here (topology-
   * derived).
   */
  onRemoveEndSource: (source: string) => void;
}

export const WorkflowContext = createContext<WorkflowHandlers | null>(null);

/** The 5 PRD §7 default status names — used to flag canonical nodes visually. */
const CANONICAL_STATES = new Set<string>(DEFAULT_STATE_MACHINE.states);

/**
 * Inline SVG icon — a SINGLE generic STATE glyph (two concentric circles) used
 * on EVERY state node and in the palette (node picker). Per-state glyphs
 * (hourglass/bell/headset/skip/check) were removed per manager feedback: the
 * palette card had no icon while the canvas nodes had distinct ones, which read
 * inconsistent. One generic glyph is the visual anchor that distinguishes a
 * state node from a transition edge at a glance. All inline `<svg>` (no
 * external assets — NFR-REL-01) and `currentColor` so it adapts to the design
 * tokens + light/dark mode. The `size` prop scales the glyph (default 22 for
 * canvas nodes; the palette passes a smaller size).
 */
export function StateIcon({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  );
}

/**
 * A state node: an SVG CARD (icon + title + description) — visual only, no
 * inline `<input>` and no "Hapus" button (those moved to the properties panel).
 * The icon is the single generic {@link StateIcon} glyph (no per-state icon —
 * removed per manager feedback; the canonical-vs-custom distinction is carried
 * by the `--canonical` tint alone). Wrapped by FOUR TYPELESS connection
 * {@link Handle}s — one `source`-typed handle per side (top, right, bottom,
 * left) — so the manager can draw a transition edge in ANY direction (down, up,
 * left, right), not just left-to-right. Under the parent's
 * `ConnectionMode.Loose` every handle BOTH STARTS and RECEIVES a connection
 * (the documented React Flow v12 "typeless handles" pattern — a `source`-typed
 * handle can both begin a drag and accept a drop), so the manager can drag from
 * any point to any point (manager feedback "Buat Alur Status Tiket transisi
 * bisa ditarik dari semua titik ke semua titik"). Because every drag starts at a
 * `source`-typed handle, the START-handle-TYPE arrow-reversal can never fire —
 * the arrow always points where the manager dropped (drag direction, manager
 * feedback "panah sesuai arah tarikan"). The handles are CSS-hidden until the
 * node is hovered or selected (the canvas was too loud — 40 visible dots for
 * the 5-state default graph; 4-per-node at-rest keeps the count the same as
 * the prior 4 visible source handles). In default mode the handles are
 * non-connectable (no edge can be drawn) and React Flow's own hidden-when-not-
 * connectable rule keeps the read-only board clean.
 *
 * The handle `id`s match {@link HANDLE_IDS} exactly (the bare side strings);
 * an edge's `sourceHandle`/`targetHandle` reference them, and React Flow
 * derives the bezier's exit/entry direction from the handle's `Position` — so
 * a vertical edge (top/bottom handle) renders vertically with no edge-component
 * change.
 *
 * The card carries an `aria-label` so the state is announced by assistive
 * tech (the title is a `<span>`, not a heading — the card is a list-like item,
 * not a section). The `data-testid` makes the card a reliable click target in
 * tests (selection is driven via `onNodeClick`/`onEdgeClick` on the parent).
 */
export function StateNode({ data }: NodeProps): JSX.Element {
  const ctx = useContext(WorkflowContext);
  const nodeData = data as FlowNodeData;
  const name = nodeData.name;
  if (!ctx) return <></>;
  const isCanonical = CANONICAL_STATES.has(name);
  const readOnly = ctx.mode === 'default';
  const connectable = !readOnly;
  // The description is a CLIENT-SIDE derivation (never serialized) computed by
  // `formToFlow`/`withDescriptions` on the parent — the node reads it from its
  // payload, with no form dependency (the context stays behavior-only, ISP).
  const description = nodeData.description;
  return (
    <div
      className={`state-node${isCanonical ? ' state-node--canonical' : ''}`}
      data-testid={`sm-node-card-${name}`}
      aria-label={`Status ${name}`}
    >
      <Handle type="source" position={Position.Top} id={HANDLE_IDS.top} isConnectable={connectable} />
      <Handle type="source" position={Position.Right} id={HANDLE_IDS.right} isConnectable={connectable} />
      <Handle type="source" position={Position.Bottom} id={HANDLE_IDS.bottom} isConnectable={connectable} />
      <Handle type="source" position={Position.Left} id={HANDLE_IDS.left} isConnectable={connectable} />
      <span className="state-node__icon" aria-hidden="true">
        <StateIcon />
      </span>
      <span className="state-node__body">
        <span className="state-node__title">{name}</span>
        <span className="state-node__desc">{description}</span>
      </span>
    </div>
  );
}

/**
 * A transition edge: a clean bezier path with a small READ-ONLY label chip
 * showing the action label (the Caller UI button text). Editing the label
 * happens in the properties panel, not on the canvas — the chip is presentational
 * only. In default mode the chip is still shown (read-only board).
 */
export function TransitionEdge(props: EdgeProps): JSX.Element {
  const edgeData = props.data as FlowEdgeData;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const label = edgeData.actionLabel;
  return (
    <>
      {/* Forward the resolved arrowhead url so the closed arrow renders on the
          path — direction reads on back-edges (e.g. SKIPPED → CALLING) and on
          parallel edges, the manager's "garis tidak ada panah" feedback. */}
      <BaseEdge id={props.id} path={edgePath} markerEnd={props.markerEnd} />
      <EdgeLabelRenderer>
        <div
          className="transition-edge__label"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'none',
          }}
        >
          <span className="transition-edge__chip" data-testid={`sm-edge-label-${props.id}`}>
            {label || 'Label aksi'}
          </span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/**
 * A canvas-only Start terminal marker — a compact BPMN-style "play" affordance
 * (▶ glyph) with a "Mulai" label. Auto-derived by `deriveTerminalMarkers` for
 * the graph's real entry states (in-degree 0 AND out-degree > 0 — an isolated,
 * not-yet-wired status is NOT an entry point); NOT in the form/wire/XML. ONE
 * `<Handle type="source" position={Position.Right} id={HANDLE_IDS.right}
 * isConnectable={false} />` — non-interactive (the manager cannot drag a
 * transition from a marker; the marker is a visual entry cue, not a state).
 * The programmatic terminal edges still attach since React Flow renders an
 * edge to a node's handle regardless of the handle's `isConnectable` (the same
 * mechanism that lets the existing read-only default-mode edges render).
 *
 * Inline `<svg>` (no external assets — NFR-REL-01) using `currentColor` so it
 * adapts to the design tokens + light/dark mode. The `data-testid` makes the
 * marker a reliable click target in tests (selection drives the properties
 * panel's marker branch). No description — the marker is not a state.
 */
export function StartNode({ }: NodeProps): JSX.Element {
  return (
    <div
      className="terminal-node terminal-node--start"
      data-testid="sm-node-start"
      aria-label="Titik awal alur"
    >
      <Handle type="source" position={Position.Right} id={HANDLE_IDS.right} isConnectable={false} />
      <span className="terminal-node__glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M8 5l12 7-12 7z" fill="currentColor" />
        </svg>
      </span>
      <span className="terminal-node__label">Mulai</span>
    </div>
  );
}

/**
 * A canvas-only End terminal marker — a bold-ring "stop" affordance (■ glyph)
 * with a "Selesai" label. Auto-derived for the graph's real exit states
 * (out-degree 0 AND in-degree > 0 — an isolated, not-yet-wired status is NOT an
 * exit point) AND a drop target for EXPLICIT manager-drawn End connections
 * (`form.endSources`, multiple allowed). NOT in the wire `transitions` (the
 * terminal edges are filtered at `flowToGraph`). ONE `<Handle type="source"
 * position={Position.Left} id={HANDLE_IDS.left} isConnectable={connectable} />` —
 * the `source`-typed handle on the LEFT is the terminal edge's TARGET (a
 * sink→End or an explicit state→End edge drops onto this handle). Under the
 * parent's `ConnectionMode.Loose` a `source`-typed handle both STARTS and
 * RECEIVES a connection, so the manager can drag from any state's handle and
 * drop onto this handle. `isConnectable` is gated on `mode === 'custom'` so
 * the read-only default-mode canvas stays non-interactive; the programmatic
 * auto terminal edges still attach regardless of `isConnectable` (same
 * mechanism as `StartNode`).
 *
 * Inline `<svg>` (no external assets — NFR-REL-01) using `currentColor`.
 */
export function EndNode({ }: NodeProps): JSX.Element {
  const ctx = useContext(WorkflowContext);
  if (!ctx) return <></>;
  const connectable = ctx.mode === 'custom';
  return (
    <div
      className="terminal-node terminal-node--end"
      data-testid="sm-node-end"
      aria-label="Titik akhir alur"
    >
      <Handle type="source" position={Position.Left} id={HANDLE_IDS.left} isConnectable={connectable} />
      <span className="terminal-node__glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
        </svg>
      </span>
      <span className="terminal-node__label">Selesai</span>
    </div>
  );
}

/**
 * A canvas-only terminal edge (Start→source / sink→End): a clean bezier via
 * {@link getBezierPath} + {@link BaseEdge} (forwarding the `markerEnd` so the
 * arrow reads), wrapped in a `<g className="terminal-edge">` so the CSS can
 * style it as a dashed muted line — visually distinct from a solid transition
 * edge (the markers are visual affordances, not real transitions). NO label
 * chip: terminal edges carry an empty `actionLabel` (no Caller button), so
 * the transition-edge chip would render an empty "Label aksi" placeholder;
 * the terminal edge reads cleaner as a bare dashed arrow.
 */
export function TerminalEdge(props: EdgeProps): JSX.Element {
  const [edgePath] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  return (
    <g className="terminal-edge">
      <BaseEdge id={props.id} path={edgePath} markerEnd={props.markerEnd} />
    </g>
  );
}

/** Stable node/edge type maps (module-level so React Flow doesn't warn). */
export const nodeTypes = { state: StateNode, start: StartNode, end: EndNode };
export const edgeTypes = { transition: TransitionEdge, terminal: TerminalEdge };

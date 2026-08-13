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
 * label also lives in the panel. The node still renders all 8 `<Handle>`s (ids
 * match {@link HANDLE_IDS} exactly so the handle-id regression test passes);
 * the handles are CSS-hidden until the node is hovered or selected (the canvas
 * was too loud — 40 visible dots for the 5-state default graph).
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
import { DEFAULT_STATE_MACHINE } from '../api/types';
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
 */
export interface WorkflowHandlers {
  mode: 'default' | 'custom';
  transitionsCount: number;
  onRenameState: (oldName: string, newName: string) => void;
  onDeleteState: (name: string) => void;
  onEditTransitionLabel: (edgeId: string, label: string) => void;
  onDeleteTransition: (edgeId: string) => void;
}

export const WorkflowContext = createContext<WorkflowHandlers | null>(null);

/** The 5 PRD §7 default status names — used to flag canonical nodes visually. */
const CANONICAL_STATES = new Set<string>(DEFAULT_STATE_MACHINE.states);

/* Handle offset styles — the source/target pair on a side is spread along the
 * side (30% / 70%) so both connection points are independently grabbable and
 * never overlap. Top/bottom sides offset along the node width (`left`); left/
 * right sides offset along the node height (`top`). React Flow centers a
 * handle on its side by default; these inline overrides win. */
const H_TOPBOT_START = { left: '30%' };
const H_TOPBOT_END = { left: '70%' };
const H_LEFTRT_START = { top: '30%' };
const H_LEFTRT_END = { top: '70%' };

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
 * by the `--canonical` tint alone). Wrapped by EIGHT connection {@link Handle}s
 * — source + target on every side (top, right, bottom, left) — so the manager
 * can draw a transition edge in ANY direction (down, up, left, right), not just
 * left-to-right. The handles are CSS-hidden until the node is hovered or
 * selected (the canvas was too loud — 40 visible dots for the 5-state default
 * graph). In default mode the handles are non-connectable (no edge can be
 * drawn) and React Flow's own hidden-when-not-connectable rule keeps the
 * read-only board clean.
 *
 * **Arrow direction = drag direction (manager feedback "panah sesuai arah
 * tarikan").** React Flow assigns an edge's `source` from the handle the drag
 * STARTS at and `target` from the handle it ENDS at — but keyed on the START
 * handle's TYPE: start at a `source` handle → source=startNode, target=dropNode
 * (arrow at the drop node); start at a `target` handle → the two are swapped so
 * the arrow points back at the start node. Because every side carries a `target`
 * handle, grabbing one reversed the arrow. The four `target` handles are
 * therefore made DROP-ONLY (`isConnectableStart={false}`): a `target` handle
 * may RECEIVE a dropped connection but may never START one, so every drag begins
 * at a `source` handle and the arrow always points where the manager dropped.
 * (Receiving stays gated by `isConnectableEnd`, which defaults to `true`.)
 *
 * The handle `id`s match {@link HANDLE_IDS} exactly; an edge's
 * `sourceHandle`/`targetHandle` reference them, and React Flow derives the
 * bezier's exit/entry direction from the handle's `Position` — so a vertical
 * edge (top/bottom handle) renders vertically with no edge-component change.
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
      <Handle type="source" position={Position.Top} id={HANDLE_IDS.topSource} isConnectable={connectable} style={H_TOPBOT_START} />
      <Handle type="target" position={Position.Top} id={HANDLE_IDS.topTarget} isConnectable={connectable} isConnectableStart={false} style={H_TOPBOT_END} />
      <Handle type="source" position={Position.Right} id={HANDLE_IDS.rightSource} isConnectable={connectable} style={H_LEFTRT_START} />
      <Handle type="target" position={Position.Right} id={HANDLE_IDS.rightTarget} isConnectable={connectable} isConnectableStart={false} style={H_LEFTRT_END} />
      <Handle type="source" position={Position.Bottom} id={HANDLE_IDS.bottomSource} isConnectable={connectable} style={H_TOPBOT_START} />
      <Handle type="target" position={Position.Bottom} id={HANDLE_IDS.bottomTarget} isConnectable={connectable} isConnectableStart={false} style={H_TOPBOT_END} />
      <Handle type="target" position={Position.Left} id={HANDLE_IDS.leftTarget} isConnectable={connectable} isConnectableStart={false} style={H_LEFTRT_START} />
      <Handle type="source" position={Position.Left} id={HANDLE_IDS.leftSource} isConnectable={connectable} style={H_LEFTRT_END} />
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

/** Stable node/edge type maps (module-level so React Flow doesn't warn). */
export const nodeTypes = { state: StateNode };
export const edgeTypes = { transition: TransitionEdge };

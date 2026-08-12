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
 * Handlers the parent provides via context. The node/edge components are
 * presentational; every mutation lifts through these so the parent owns the
 * `StateMachineForm` (controlled). `mode` toggles read-only vs editable; the
 * edge Hapus button is gated on `transitionsCount` to preserve the ≥1-transition
 * invariant.
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
 * A state node: an editable name input (uppercased on input, mirroring the form
 * editor) wrapped by EIGHT connection {@link Handle}s — source + target on
 * every side (top, right, bottom, left) — so the manager can draw a transition
 * edge in ANY direction (down, up, left, right), not just left-to-right. The
 * "Hapus" button removes the state and cascades its transitions (parent
 * handler). In default mode the input is read-only and the Hapus button is
 * hidden (handles are non-connectable so no edge can be drawn).
 *
 * The handle `id`s match {@link HANDLE_IDS} exactly; an edge's
 * `sourceHandle`/`targetHandle` reference them, and React Flow derives the
 * bezier's exit/entry direction from the handle's `Position` — so a vertical
 * edge (top/bottom handle) renders vertically with no edge-component change.
 */
export function StateNode({ id, data }: NodeProps): JSX.Element {
  const ctx = useContext(WorkflowContext);
  const nodeData = data as FlowNodeData;
  const name = nodeData.name;
  if (!ctx) return <></>;
  const isCanonical = CANONICAL_STATES.has(name);
  const readOnly = ctx.mode === 'default';
  const connectable = !readOnly;
  return (
    <div className={`state-node${isCanonical ? ' state-node--canonical' : ''}`}>
      <Handle type="source" position={Position.Top} id={HANDLE_IDS.topSource} isConnectable={connectable} style={H_TOPBOT_START} />
      <Handle type="target" position={Position.Top} id={HANDLE_IDS.topTarget} isConnectable={connectable} style={H_TOPBOT_END} />
      <Handle type="source" position={Position.Right} id={HANDLE_IDS.rightSource} isConnectable={connectable} style={H_LEFTRT_START} />
      <Handle type="target" position={Position.Right} id={HANDLE_IDS.rightTarget} isConnectable={connectable} style={H_LEFTRT_END} />
      <Handle type="source" position={Position.Bottom} id={HANDLE_IDS.bottomSource} isConnectable={connectable} style={H_TOPBOT_START} />
      <Handle type="target" position={Position.Bottom} id={HANDLE_IDS.bottomTarget} isConnectable={connectable} style={H_TOPBOT_END} />
      <Handle type="target" position={Position.Left} id={HANDLE_IDS.leftTarget} isConnectable={connectable} style={H_LEFTRT_START} />
      <Handle type="source" position={Position.Left} id={HANDLE_IDS.leftSource} isConnectable={connectable} style={H_LEFTRT_END} />
      <input
        className="state-node__input"
        type="text"
        value={name}
        readOnly={readOnly}
        aria-label={`Status ${name}`}
        onChange={(e) => ctx.onRenameState(id, e.target.value.toUpperCase())}
      />
      {!readOnly && (
        <button
          type="button"
          className="btn btn--ghost state-node__delete"
          onClick={() => ctx.onDeleteState(id)}
          aria-label={`Hapus status ${name}`}
        >
          Hapus
        </button>
      )}
    </div>
  );
}

/**
 * A transition edge: a bezier path with an editable action-label input rendered
 * via {@link EdgeLabelRenderer} at the path midpoint, plus a "Hapus" button
 * (disabled when only one transition remains — the ≥1-transition invariant).
 * In default mode the input is read-only and the Hapus button is hidden.
 */
export function TransitionEdge(props: EdgeProps): JSX.Element {
  const ctx = useContext(WorkflowContext);
  const edgeData = props.data as FlowEdgeData;
  if (!ctx) return <></>;
  const readOnly = ctx.mode === 'default';
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  return (
    <>
      <BaseEdge id={props.id} path={edgePath} />
      <EdgeLabelRenderer>
        <div
          className="transition-edge__label"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
        >
          <input
            className="transition-edge__input"
            type="text"
            value={edgeData.actionLabel}
            readOnly={readOnly}
            placeholder="Label aksi"
            aria-label="Label aksi"
            onChange={(e) => ctx.onEditTransitionLabel(props.id, e.target.value)}
          />
          {!readOnly && (
            <button
              type="button"
              className="btn btn--ghost transition-edge__delete"
              onClick={() => ctx.onDeleteTransition(props.id)}
              disabled={ctx.transitionsCount <= 1}
              aria-label="Hapus transisi"
            >
              Hapus
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** Stable node/edge type maps (module-level so React Flow doesn't warn). */
export const nodeTypes = { state: StateNode };
export const edgeTypes = { transition: TransitionEdge };
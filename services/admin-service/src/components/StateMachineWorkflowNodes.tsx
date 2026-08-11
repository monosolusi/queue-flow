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
import type { FlowEdgeData, FlowNodeData } from '../lib/state-machine-flow';

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

/**
 * A state node: an editable name input (uppercased on input, mirroring the form
 * editor) flanked by left target + right source {@link Handle}s. The "Hapus"
 * button removes the state and cascades its transitions (parent handler). In
 * default mode the input is read-only and the Hapus button is hidden.
 */
export function StateNode({ id, data }: NodeProps): JSX.Element {
  const ctx = useContext(WorkflowContext);
  const nodeData = data as FlowNodeData;
  const name = nodeData.name;
  if (!ctx) return <></>;
  const isCanonical = CANONICAL_STATES.has(name);
  const readOnly = ctx.mode === 'default';
  return (
    <div className={`state-node${isCanonical ? ' state-node--canonical' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={!readOnly} />
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
      <Handle type="source" position={Position.Right} isConnectable={!readOnly} />
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
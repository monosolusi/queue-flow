/**
 * Pure, framework-free mappers between the editable {@link StateMachineForm} and
 * the React Flow canvas model. No React, no `@xyflow/react` imports — fully
 * unit-testable in isolation. The component ({@link StateMachineWorkflow}) is a
 * different VIEW over the same {@link StateMachineForm} + same
 * `lib/state-machine` helpers; these mappers own only the flow-shape
 * translation + deterministic layout, never validation or wire mapping (those
 * stay in `lib/state-machine`).
 *
 * The wire contract is unchanged: the component lifts graph-structure changes
 * to the parent via `onChange(next: StateMachineForm)`, and AdminPanel's
 * existing save path calls `toStateMachineDto` (the single wire-boundary
 * mapper). Positions live only in the component's internal node state — they
 * never reach the wire form.
 */
import { describeState, type StateMachineForm, type Transition } from './state-machine';
import { DEFAULT_STATE_MACHINE } from '../api/types';

/** Node payload: the state name (the node id IS the state name — names are
 *  unique per `validateCustomStateMachine`, so they are valid unique node ids)
 *  + a short manager-facing description derived client-side via
 *  {@link describeState} (canonical copy for the 5 PRD §7 defaults, else a
 *  summary of the outgoing-transition count). The description is CANVAS-ONLY —
 *  {@link flowToGraph} reads just `name` (never `description`), so it never
 *  reaches the wire {@link Transition} / {@link StateMachineDto}. The index
 *  signature makes it assignable to React Flow's `data: Record<string, unknown>`
 *  constraint so `FlowNode` is structurally compatible with `@xyflow/react`'s
 *  `Node` without a cast. */
export interface FlowNodeData {
  name: string;
  description: string;
  [key: string]: unknown;
}

/** A React Flow node, structurally compatible with `@xyflow/react`'s `Node`.
 *  `selected` mirrors React Flow's `Node.selected` flag — set by the parent's
 *  click-to-select handler (see `StateMachineWorkflow`) so the `.selected` class
 *  applies and `onSelectionChange` fires. Optional because the wire-relevant
 *  fields are `id`/`data`/`position`; `selected` is canvas-only. */
export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: FlowNodeData;
  selected?: boolean;
}

/** Edge payload: the transition's action label (the Caller UI button text).
 *  Index signature for `Record<string, unknown>` compatibility (see
 *  {@link FlowNodeData}). */
export interface FlowEdgeData {
  actionLabel: string;
  [key: string]: unknown;
}

/** A React Flow edge, structurally compatible with `@xyflow/react`'s `Edge`.
 *  `sourceHandle`/`targetHandle` reference the connection-point ids on the
 *  source/target nodes (see {@link HANDLE_IDS}). They are CANVAS-ONLY — never
 *  serialized to the wire {@link Transition} (`flowToGraph` drops them) — and
 *  exist so a node with multiple handles per side routes each edge through the
 *  exact handle the manager dragged, not an ambiguous default. `selected`
 *  mirrors `Edge.selected` — set by the parent's click-to-select handler so the
 *  `.selected` class applies and `onSelectionChange` fires. */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  data: FlowEdgeData;
  sourceHandle?: string;
  targetHandle?: string;
  selected?: boolean;
}

/**
 * Connection-point (handle) ids for the custom {@link StateNode}. Each of the
 * four sides carries BOTH a source (outgoing) and a target (incoming) handle,
 * so the manager can draw a transition edge in ANY direction — out any side,
 * into any side (down, up, left, right) — not just left-to-right. The edge's
 * `sourceHandle`/`targetHandle` reference these ids; React Flow derives the
 * bezier's exit/entry direction from the handle's `Position`, so a vertical
 * edge (top/bottom handles) renders vertically with NO edge-component change
 * (`TransitionEdge` already forwards `sourcePosition`/`targetPosition`).
 *
 * Defined here (the framework-free lib) rather than the node component so
 * {@link formToFlow} can seed the default-graph edges with the canonical
 * left-to-right routing (`rightSource` → `leftTarget`) from a single source of
 * truth — the ids MUST match the `id` props on the `Handle` elements in
 * `StateMachineWorkflowNodes.tsx` exactly.
 */
export const HANDLE_IDS = {
  topSource: 'top-source',
  topTarget: 'top-target',
  rightSource: 'right-source',
  rightTarget: 'right-target',
  bottomSource: 'bottom-source',
  bottomTarget: 'bottom-target',
  leftSource: 'left-source',
  leftTarget: 'left-target',
} as const;

/**
 * The default edge routing for a seed/re-seed edge (one with no manager-chosen
 * handle): out the right, into the left — the canonical left-to-right flow the
 * PRD §7 default state machine reads as. A manager-drawn edge carries the
 * actual dragged handle ids (see `onConnect`), so this default only applies to
 * edges rebuilt from a wire {@link Transition} (initial mount + external reset).
 */
export const DEFAULT_SOURCE_HANDLE = HANDLE_IDS.rightSource;
export const DEFAULT_TARGET_HANDLE = HANDLE_IDS.leftTarget;

/** Horizontal gap between ranks (left-to-right flow). */
const X_SPACING = 240;
/** Vertical gap between nodes stacked within a rank. */
const Y_SPACING = 120;

/**
 * Deterministic left-to-right layout. `rank` = longest path from source nodes
 * (nodes with no incoming edge) in the graph with back-edges removed; `x = rank
 * * X_SPACING`. Within a rank, nodes stack vertically by appearance order in
 * `states`, `y = indexInRank * Y_SPACING`. Nodes unreachable from any source
 * (pure cycles, or anything downstream of one) keep rank 0.
 *
 * Back-edges (edges to a node on the DFS stack — the cycle-closing edges, e.g.
 * the default graph's `SKIPPED → CALLING`) are removed for ranking so a cycle
 * never inflates a node's rank; they remain as visual back-arrows on the
 * canvas. Pure cycles (no node with zero in-degree) have no source to seed
 * relaxation from, so every node in them keeps rank 0.
 *
 * Pure + stable: same input ⇒ same output (no `Math.random` / `Date.now`).
 */
export function autoLayout(
  states: readonly string[],
  transitions: readonly { from: string; to: string; actionLabel: string }[],
): Record<string, { x: number; y: number }> {
  const stateSet = new Set(states);
  const adj = new Map<string, string[]>();
  const originalIndeg = new Map<string, number>();
  for (const s of states) {
    adj.set(s, []);
    originalIndeg.set(s, 0);
  }
  for (const t of transitions) {
    // Ignore edges that reference a state not in the schema (defensive — the
    // editor never produces these, but a corrupt prefill could).
    if (!stateSet.has(t.from) || !stateSet.has(t.to)) continue;
    adj.get(t.from)!.push(t.to);
    originalIndeg.set(t.to, (originalIndeg.get(t.to) ?? 0) + 1);
  }

  // DFS classifies back-edges (target on the recursion stack) and builds the
  // acyclic ranking graph `dagAdj` (tree + cross + forward edges; back-edges
  // dropped). Iterative DFS so a degenerate deep chain can't blow the stack.
  const visited = new Set<string>();
  const dagAdj = new Map<string, string[]>();
  for (const s of states) dagAdj.set(s, []);
  for (const root of states) {
    if (visited.has(root)) continue;
    const stack: { node: string; edgeIdx: number }[] = [{ node: root, edgeIdx: 0 }];
    const onStack = new Set<string>([root]);
    visited.add(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const outs = adj.get(top.node) ?? [];
      if (top.edgeIdx < outs.length) {
        const v = outs[top.edgeIdx++];
        if (!visited.has(v)) {
          visited.add(v);
          onStack.add(v);
          stack.push({ node: v, edgeIdx: 0 });
          dagAdj.get(top.node)!.push(v); // tree edge
        } else if (!onStack.has(v)) {
          dagAdj.get(top.node)!.push(v); // cross / forward edge (not a back-edge)
        }
        // else: back-edge (v on stack) — dropped for ranking.
      } else {
        onStack.delete(top.node);
        stack.pop();
      }
    }
  }

  // Longest-path rank via Kahn's relaxation on the DAG, seeded ONLY with
  // original sources (in-degree 0 in the original graph). A node not reachable
  // from any original source (pure cycle, or downstream of one) is never
  // enqueued and keeps its initialized rank 0.
  const dagIndeg = new Map<string, number>();
  for (const s of states) dagIndeg.set(s, 0);
  for (const outs of dagAdj.values()) for (const v of outs) dagIndeg.set(v, (dagIndeg.get(v) ?? 0) + 1);
  const rank = new Map<string, number>();
  for (const s of states) rank.set(s, 0);
  const remaining = new Map(dagIndeg);
  const queue: string[] = states.filter((s) => (originalIndeg.get(s) ?? 0) === 0);
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    for (const v of dagAdj.get(u) ?? []) {
      rank.set(v, Math.max(rank.get(v) ?? 0, (rank.get(u) ?? 0) + 1));
      remaining.set(v, (remaining.get(v) ?? 0) - 1);
      if ((remaining.get(v) ?? 0) === 0) queue.push(v);
    }
  }

  // Group by rank preserving `states` appearance order, then assign positions.
  const byRank = new Map<number, string[]>();
  for (const s of states) {
    const r = rank.get(s) ?? 0;
    const bucket = byRank.get(r) ?? [];
    bucket.push(s);
    byRank.set(r, bucket);
  }
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [r, names] of byRank) {
    names.forEach((name, i) => {
      positions[name] = { x: r * X_SPACING, y: i * Y_SPACING };
    });
  }
  return positions;
}

/**
 * Derive React Flow nodes/edges from the form. Node `id` = the state name.
 * Each node: `{ id: name, type: 'state', position, data: { name, description } }`
 * — the `description` is a client-side derivation via {@link describeState}
 * (canonical copy for the 5 PRD §7 defaults, else `${n} transisi keluar` or
 * `Status kustom`), computed here so the node card renders it with no form
 * dependency (the context stays behavior-only — see `WorkflowHandlers`). Each
 * edge: `{ id: \`${t.from}->${t.to}#${i}\`, source, target, type: 'transition',
 * data: { actionLabel } }`. Positions reuse `positions[name]` when present
 * (surviving state names keep their canvas spot on an external re-seed),
 * otherwise fall back to the `autoLayout` placement. Handle routing reuses
 * `handleMap[\`${from}->${to}\`]` when present (a surviving edge keeps the side
 * the manager dragged it on — vertical stays vertical — across an external
 * re-seed, mirroring the position-preservation pattern), otherwise falls back
 * to the canonical L→R default. `validateCustomStateMachine` forbids duplicate
 * `from->to` edges, so the key is unique per graph.
 */
export function formToFlow(
  value: StateMachineForm,
  positions: Record<string, { x: number; y: number }>,
  handleMap?: Record<string, { sourceHandle?: string; targetHandle?: string }>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const auto = autoLayout(value.states, value.transitions);
  const nodes: FlowNode[] = value.states.map((name) => ({
    id: name,
    type: 'state',
    position: positions[name] ?? auto[name] ?? { x: 0, y: 0 },
    data: { name, description: describeState(value, name) },
  }));
  const edges: FlowEdge[] = value.transitions.map((t, i) => {
    const prev = handleMap?.[`${t.from}->${t.to}`];
    return {
      id: `${t.from}->${t.to}#${i}`,
      source: t.from,
      target: t.to,
      type: 'transition',
      data: { actionLabel: t.actionLabel },
      // Reuse the prior routing when present (surviving edge keeps its side on
      // an external re-seed); else seed the canonical L→R default. A manager-
      // drawn edge carries the actual dragged handle ids (see `onConnect`); the
      // default only applies to edges rebuilt from a wire Transition that
      // carries no handle info (canvas-only).
      sourceHandle: prev?.sourceHandle ?? DEFAULT_SOURCE_HANDLE,
      targetHandle: prev?.targetHandle ?? DEFAULT_TARGET_HANDLE,
    };
  });
  return { nodes, edges };
}

/**
 * The inverse of {@link formToFlow}: graph structure only (no positions).
 * `states` preserves the node array order; `transitions` resolves each edge's
 * `source`/`target` (node ids = state names) back to transition `from`/`to`.
 * Reads only `data.name` (never `data.description`) — the description is
 * CANVAS-ONLY and never reaches the wire {@link Transition}.
 */
export function flowToGraph(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
): { states: string[]; transitions: Transition[] } {
  const idToName = new Map<string, string>();
  for (const n of nodes) idToName.set(n.id, n.data.name);
  const states = nodes.map((n) => n.data.name);
  const transitions: Transition[] = edges.map((e) => ({
    from: idToName.get(e.source) ?? e.source,
    to: idToName.get(e.target) ?? e.target,
    actionLabel: e.data.actionLabel,
  }));
  return { states, transitions };
}

/**
 * Re-stamp each node's `data.description` from the form via {@link describeState}.
 * Pure helper the parent calls inside `commit` so a mutation that changes a
 * state's outgoing-transition count (delete state, delete/add transition) also
 * refreshes the affected node cards' descriptions. The description is
 * CANVAS-ONLY — this never changes the wire form ({@link flowToGraph} ignores it).
 */
export function withDescriptions(nodes: readonly FlowNode[], form: StateMachineForm): FlowNode[] {
  return nodes.map((n) => ({ ...n, data: { ...n.data, description: describeState(form, n.data.name) } }));
}

/**
 * A non-colliding default state name (`STATUS_1`, `STATUS_2`, …) that avoids
 * duplicates with the existing names AND the 5 canonical names, so a manager
 * dragging in a new node never lands on a name the validation would reject as
 * a duplicate. Uppercase to match the state-name convention.
 */
export function nextStateName(existing: readonly string[]): string {
  const used = new Set<string>([...existing, ...DEFAULT_STATE_MACHINE.states]);
  let i = 1;
  while (used.has(`STATUS_${i}`)) i++;
  return `STATUS_${i}`;
}
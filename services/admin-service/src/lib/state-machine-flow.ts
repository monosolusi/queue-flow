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
import type { StateMachineForm, Transition } from './state-machine';
import { DEFAULT_STATE_MACHINE } from '../api/types';

/** Node payload: the state name (the node id IS the state name — names are
 *  unique per `validateCustomStateMachine`, so they are valid unique node ids).
 *  The index signature makes it assignable to React Flow's
 *  `data: Record<string, unknown>` constraint so `FlowNode` is structurally
 *  compatible with `@xyflow/react`'s `Node` without a cast. */
export interface FlowNodeData {
  name: string;
  [key: string]: unknown;
}

/** A React Flow node, structurally compatible with `@xyflow/react`'s `Node`. */
export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: FlowNodeData;
}

/** Edge payload: the transition's action label (the Caller UI button text).
 *  Index signature for `Record<string, unknown>` compatibility (see
 *  {@link FlowNodeData}). */
export interface FlowEdgeData {
  actionLabel: string;
  [key: string]: unknown;
}

/** A React Flow edge, structurally compatible with `@xyflow/react`'s `Edge`. */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  data: FlowEdgeData;
}

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
 * Each node: `{ id: name, type: 'state', position, data: { name } }`. Each
 * edge: `{ id: \`${t.from}->${t.to}#${i}\`, source, target, type: 'transition',
 * data: { actionLabel } }`. Positions reuse `positions[name]` when present
 * (surviving state names keep their canvas spot on an external re-seed),
 * otherwise fall back to the `autoLayout` placement.
 */
export function formToFlow(
  value: StateMachineForm,
  positions: Record<string, { x: number; y: number }>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const auto = autoLayout(value.states, value.transitions);
  const nodes: FlowNode[] = value.states.map((name) => ({
    id: name,
    type: 'state',
    position: positions[name] ?? auto[name] ?? { x: 0, y: 0 },
    data: { name },
  }));
  const edges: FlowEdge[] = value.transitions.map((t, i) => ({
    id: `${t.from}->${t.to}#${i}`,
    source: t.from,
    target: t.to,
    type: 'transition',
    data: { actionLabel: t.actionLabel },
  }));
  return { nodes, edges };
}

/**
 * The inverse of {@link formToFlow}: graph structure only (no positions).
 * `states` preserves the node array order; `transitions` resolves each edge's
 * `source`/`target` (node ids = state names) back to transition `from`/`to`.
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
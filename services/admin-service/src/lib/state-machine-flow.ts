/**
 * Pure, framework-free mappers between the editable {@link StateMachineForm} and
 * the React Flow canvas model. No React, no `@xyflow/react` imports — fully
 * unit-testable in isolation. The component ({@link StateMachineWorkflow}) is a
 * different VIEW over the same {@link StateMachineForm} + same
 * `lib/state-machine` helpers; these mappers own only the flow-shape
 * translation, never validation, wire mapping, OR the default-positions
 * derivation (those stay in `lib/state-machine` — `autoLayout` lives there now
 * and is imported here, so the canvas and the XML Source view share one
 * derivation and can never diverge in node positions).
 *
 * The wire contract is unchanged: the component lifts graph-structure changes
 * to the parent via `onChange(next: StateMachineForm)`, and AdminPanel's
 * existing save path calls `toStateMachineDto` (the single wire-boundary
 * mapper). Positions are now sourced from the form (`value.positions`) and
 * lifted back on a drag-stop via `commit` → `flowToGraph`; they travel the
 * wire in the separate `nodePositions` map (built by `toNodePositionsDto`).
 */
import {
  autoLayout,
  describeState,
  type StateMachineForm,
  type Transition,
} from './state-machine';
import { DEFAULT_STATE_MACHINE, type EdgeSide } from '../api/types';

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

/**
 * The arrowhead config stamped on every transition edge's `markerEnd`. A closed
 * arrow (`MarkerType.ArrowClosed`) at the TARGET end so the edge reads as
 * "from → to" — the manager's "garis tidak ada panah, jadi membingungkan"
 * feedback: direction was ambiguous on back-edges (e.g. the default graph's
 * bottom-up `SKIPPED → CALLING`) and on parallel edges. The `type` literal
 * `'arrowclosed'` is assignable to React Flow's `EdgeMarker.type`
 * (`MarkerType | `${MarkerType}``) via the template-literal form, so this stays
 * framework-free — NO `@xyflow/react` import (the lib must remain pure + unit-
 * testable in isolation, like every other type here). `color` is intentionally
 * OMITTED: React Flow then uses `defaultMarkerColor = '#b1b1b7'`, the SAME gray
 * as the default light-mode edge stroke, so the arrow matches the edge in both
 * QMS themes (light default / dark opt-in — `colorMode` is light-pinned). Like
 * `sourceHandle`/`targetHandle`, `markerEnd` is CANVAS-ONLY: `flowToGraph`
 * drops it (never reaches the wire {@link Transition}).
 */
export interface FlowEdgeMarker {
  type: 'arrowclosed';
  width?: number;
  height?: number;
}

export const EDGE_ARROW_MARKER: FlowEdgeMarker = { type: 'arrowclosed', width: 16, height: 16 };

/** A React Flow edge, structurally compatible with `@xyflow/react`'s `Edge`.
 *  `sourceHandle`/`targetHandle` reference the connection-point ids on the
 *  source/target nodes (see {@link HANDLE_IDS}). They are CANVAS-ONLY — never
 *  serialized to the wire {@link Transition} (`flowToGraph` drops them) — and
 *  record which side each edge was dragged from/to so the bezier routes through
 *  the manager's chosen side, not an ambiguous default. `selected` mirrors
 *  `Edge.selected` — set by the parent's click-to-select handler so the
 *  `.selected` class applies and `onSelectionChange` fires. */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  data: FlowEdgeData;
  sourceHandle?: string;
  targetHandle?: string;
  /** Closed-arrow marker at the target end so an edge reads "from → to" (manager
   *  feedback: no arrow = confusing direction). CANVAS-ONLY — `flowToGraph` drops
   *  it; it never reaches the wire {@link Transition}. A subtype of React Flow's
   *  `EdgeMarker` (literal `'arrowclosed'` via `${MarkerType}`), so `FlowEdge`
   *  stays structurally assignable to `Edge` with no cast + no framework import. */
  markerEnd?: FlowEdgeMarker;
  selected?: boolean;
}

/**
 * Connection-point (handle) ids for the custom {@link StateNode}. Each of the
 * four sides carries ONE TYPELESS connection point — a `source`-typed handle
 * that, under the parent's `ConnectionMode.Loose`, both STARTS and RECEIVES a
 * connection (the documented React Flow v12 "typeless handles" pattern). So
 * the manager can draw a transition edge in ANY direction — out any side, into
 * any side (down, up, left, right) — dragging from any point to any point
 * (manager feedback "Buat Alur Status Tiket transisi bisa ditarik dari semua
 * titik ke semua titik"). Because every drag starts at a `source`-typed
 * handle, the START-handle-TYPE arrow-reversal can never fire — the arrow
 * always points where the manager dropped (drag direction). The edge's
 * `sourceHandle`/`targetHandle` reference these side ids; React Flow derives
 * the bezier's exit/entry direction from the handle's `Position`, so a
 * vertical edge (top/bottom handles) renders vertically with NO edge-component
 * change (`TransitionEdge` already forwards `sourcePosition`/`targetPosition`).
 *
 * The ids are the BARE side strings (`'top'`, `'right'`, …) so the wire/XML
 * `EdgeSide` (the SIDE, not the handle id) round-trips cleanly: `handleToSide`
 * does `handle.split('-')[0]` and validates against the 4 sides, so a handle id
 * of just `'top'` round-trips to side `'top'`. No migration, no wire/XML change.
 *
 * Defined here (the framework-free lib) rather than the node component so
 * {@link formToFlow} can seed the default-graph edges with the canonical
 * left-to-right routing (`right` → `left`) from a single source of truth — the
 * ids MUST match the `id` props on the `Handle` elements in
 * `StateMachineWorkflowNodes.tsx` exactly.
 */
export const HANDLE_IDS = {
  top: 'top',
  right: 'right',
  bottom: 'bottom',
  left: 'left',
} as const;

/**
 * The default edge routing for a seed/re-seed edge (one with no manager-chosen
 * handle): out the right, into the left — the canonical left-to-right flow the
 * PRD §7 default state machine reads as. A manager-drawn edge carries the
 * actual dragged handle ids (see `onConnect`), so this default only applies to
 * edges rebuilt from a wire {@link Transition} (initial mount + external reset).
 */
export const DEFAULT_SOURCE_HANDLE = HANDLE_IDS.right;
export const DEFAULT_TARGET_HANDLE = HANDLE_IDS.left;

/**
 * Maps a connection side to its typeless handle id (e.g. `'bottom'` →
 * `'bottom'`). The form transition's `sourceSide`/`targetSide` is the source of
 * truth; `formToFlow` seeds the React Flow `sourceHandle`/`targetHandle` from
 * it. One function (not separate source/target mappers) because every handle
 * is now a single typeless point per side — the side IS the handle id.
 */
export function sideToHandle(side: EdgeSide): string {
  return HANDLE_IDS[side];
}

/**
 * Inverse of {@link sideToHandle}: extracts the side from a handle id. Handles
 * are the bare side strings (`'top'`, `'right'`, …) → `split('-')[0]` gives the
 * side. Returns `undefined` for a missing/unknown handle so a default edge
 * (handle resolves to a valid side) and an absent handle (undefined → form
 * treats as default) both flow through the form's `isDefaultSides`/
 * `toEdgeRoutingLayoutDto` omit path cleanly. Also backward-compatible with
 * any legacy `'-source'`/`'-target'` ids since it takes the segment before the
 * first dash.
 */
const FLOW_SIDES: readonly EdgeSide[] = ['top', 'right', 'bottom', 'left'];
export function handleToSide(handle: string | undefined): EdgeSide | undefined {
  if (!handle) return undefined;
  const side = handle.split('-')[0];
  return FLOW_SIDES.includes(side as EdgeSide) ? (side as EdgeSide) : undefined;
}

/**
 * Derive React Flow nodes/edges from the form. Node `id` = the state name.
 * Each node: `{ id: name, type: 'state', position, data: { name, description } }`
 * — the `description` is a client-side derivation via {@link describeState}
 * (canonical copy for the 5 PRD §7 defaults, else `${n} transisi keluar` or
 * `Status kustom`), computed here so the node card renders it with no form
 * dependency (the context stays behavior-only — see `WorkflowHandlers`). Each
 * edge: `{ id: \`${t.from}->${t.to}#${i}\`, source, target, type: 'transition',
 * data: { actionLabel } }`.
 *
 * **Position priority** (load-bearing for the re-seed guard): a node's
 * `position` prefers `value.positions[name]` (the form is the source of truth
 * now), then the `positions` arg (the `oldPositions` fallback captured from
 * the prev canvas nodes — so a graph-only source edit keeps surviving nodes'
 * canvas spots when the source omits their positions), then the `autoLayout`
 * placement, then `{0,0}`. So a source edit that DOES carry positions moves the
 * nodes to those positions (re-seed the canvas), while a diagram drag skips
 * the re-seed (`lastEmitted` stamped in `commit` before `onChange`).
 *
 * **Handle routing is sourced from the form.** Each transition's `sourceSide`/
 * `targetSide` is the source of truth — the form is the single owner of handle
 * routing now (previously the component passed a `handleMap` rebuilt from the
 * prior edges, which was lost on every save/reload). A transition with no sides
 * (absent) seeds the canonical L→R default ({@link DEFAULT_SOURCE_HANDLE}/
 * {@link DEFAULT_TARGET_HANDLE}); a transition with `sourceSide: 'bottom'`
 * routes out the bottom. So a redraw always respects the source. `commit` →
 * {@link flowToGraph} captures the canvas handles + positions back into the
 * form, closing the loop. The handles are the typeless side ids (one per side);
 * `sideToHandle` maps the form side to the handle id.
 */
export function formToFlow(
  value: StateMachineForm,
  positions: Record<string, { x: number; y: number }>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const auto = autoLayout(value.states, value.transitions);
  const nodes: FlowNode[] = value.states.map((name) => ({
    id: name,
    type: 'state',
    position: value.positions[name] ?? positions[name] ?? auto[name] ?? { x: 0, y: 0 },
    data: { name, description: describeState(value, name) },
  }));
  const edges: FlowEdge[] = value.transitions.map((t, i) => ({
    id: `${t.from}->${t.to}#${i}`,
    source: t.from,
    target: t.to,
    type: 'transition',
    data: { actionLabel: t.actionLabel },
    // Seed from the form sides (the source of truth); a transition with no
    // sides (absent) gets the canonical L→R default.
    sourceHandle: t.sourceSide !== undefined ? sideToHandle(t.sourceSide) : DEFAULT_SOURCE_HANDLE,
    targetHandle: t.targetSide !== undefined ? sideToHandle(t.targetSide) : DEFAULT_TARGET_HANDLE,
    markerEnd: EDGE_ARROW_MARKER,
  }));
  return { nodes, edges };
}

/**
 * The inverse of {@link formToFlow}: graph structure + positions.
 * `states` preserves the node array order; `transitions` resolves each edge's
 * `source`/`target` (node ids = state names) back to transition `from`/`to`.
 * `positions` is built from the nodes (`n.data.name → n.position`) so a
 * drag-stop's final positions flow back into the form (via `commit` →
 * `onChange`), then `toNodePositionsDto` ships them in the wire map. Reads only
 * `data.name`/`position` (never `data.description`) — the description is
 * CANVAS-ONLY and never reaches the wire {@link Transition}.
 *
 * Captures the connection sides from the edge handles via {@link handleToSide}
 * — the form is the source of truth for handles now, so a manager-drawn edge's
 * chosen side flows back into the form (via `commit` → `onChange`), then
 * `formToXml`/`toEdgeRoutingLayoutDto` omit the default ones → sparse wire.
 */
export function flowToGraph(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
): { states: string[]; transitions: Transition[]; positions: Record<string, { x: number; y: number }> } {
  const idToName = new Map<string, string>();
  for (const n of nodes) idToName.set(n.id, n.data.name);
  const states = nodes.map((n) => n.data.name);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) positions[n.data.name] = { ...n.position };
  const transitions: Transition[] = edges.map((e) => ({
    from: idToName.get(e.source) ?? e.source,
    to: idToName.get(e.target) ?? e.target,
    actionLabel: e.data.actionLabel,
    sourceSide: handleToSide(e.sourceHandle),
    targetSide: handleToSide(e.targetHandle),
  }));
  return { states, transitions, positions };
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

/**
 * True when an edge `source → target` already exists in `edges`. The single
 * source of truth for the duplicate-transition check shared by three sites that
 * each must reject a re-drawn edge identically: `isValidConnection` (live,
 * during the drag), `onConnect` (defensive — a real connection that somehow
 * bypassed the live check), and `addTransitionButton`. The default graph's
 * bottom-up `SKIPPED → CALLING` back-edge is a genuine duplicate when re-drawn,
 * which is the manager's "tidak bisa tarik garis dari bottom ke up, tidak ada
 * error" feedback: the silent guard made a no-op draw look broken. Centralizing
 * the predicate here (framework-free, pure) keeps the decision testable in
 * isolation — the component path (`onConnectEnd` toast) is not exercisable in
 * jsdom (React Flow drags need real pointer geometry), so the logic it consults
 * MUST be unit-testable on its own.
 */
export function isDuplicateTransition(
  edges: readonly FlowEdge[],
  source: string,
  target: string,
): boolean {
  return edges.some((e) => e.source === source && e.target === target);
}

/**
 * The minimal structural slice of React Flow's `FinalConnectionState` the
 * rejection message needs. Defined locally (NOT a `@xyflow/react` type) so the
 * lib stays framework-free; the component maps the real `connectionState` into
 * this shape. `isValid` is `false` only when `isValidConnection` rejected the
 * connection (React Flow's own invalid-handle case surfaces as `null`, not
 * `false`); since our `isValidConnection` rejects ONLY duplicates, `isValid
 * === false` ⟹ duplicate — but the predicate is re-checked so the message stays
 * accurate even if a future rejection reason is added.
 */
export interface ConnectionOutcome {
  isValid: boolean | null;
  fromId: string | null;
  toId: string | null;
}

/**
 * The manager-facing message for a connection that could not be drawn, or
 * `null` when no feedback is warranted (the connection succeeded, or was
 * dropped in empty space with no target node, or no connection was started).
 * Pure + framework-free so the toast decision is unit-testable in isolation
 * (the `onConnectEnd` side effect itself is not exercisable in jsdom). Extracted
 * from the component per SRP: the DECISION (which message, or none) is pure and
 * tested here; the SIDE EFFECT (calling `toast.show`) stays a thin wrapper in
 * the component.
 */
export function rejectionMessageForConnection(
  outcome: ConnectionOutcome,
  edges: readonly FlowEdge[],
): string | null {
  if (outcome.isValid !== false || !outcome.toId) return null;
  const from = outcome.fromId;
  const to = outcome.toId;
  if (from && isDuplicateTransition(edges, from, to)) {
    return `Transisi dari ${from} ke ${to} sudah ada.`;
  }
  return 'Transisi tidak dapat dibuat.';
}

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
  descriptionFor,
  type StateMachineForm,
  type Transition,
} from './state-machine';
import { DEFAULT_STATE_MACHINE, DEFAULT_TERMINAL_NODES, type EdgeSide, type TerminalNodesDto } from '../api/types';

/** Node payload: the state name (the node id IS the state name — names are
 *  unique per `validateCustomStateMachine`, so they are valid unique node ids)
 *  + a short manager-facing description via {@link descriptionFor} (the saved
 *  per-state override when present, else the derived canonical copy for the 5
 *  PRD §7 defaults, else a summary of the outgoing-transition count). The
 *  description is CANVAS-ONLY —
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
  /** Canvas-only: whether the node is draggable. The Start/End terminal
   *  markers set `draggable: false` so the manager cannot move them (their
   *  position is auto-derived from the real topology). Optional — real state
   *  nodes leave it unset (React Flow's `nodesDraggable` prop gates the
   *  canvas-wide default). */
  draggable?: boolean;
  /** Canvas-only: whether the node is selectable. The Start/End markers set
   *  `selectable: true` so clicking one opens the properties-panel marker
   *  branch. Optional — real state nodes leave it unset. */
  selectable?: boolean;
  /**
   * Canvas-only: true when the manager pinned a Start/End terminal marker at an
   *  explicit position (a drag, or a palette drop). `flowToGraph` reads it to
   *  distinguish a pinned `{x,y}` terminal from an auto-derived one (which
   *  round-trips as `'auto'` so the marker re-derives its position from the live
   *  topology on the next re-seed). Optional — auto markers + real state nodes
   *  leave it unset (falsy).
   */
  pinned?: boolean;
}

/** Edge payload: the transition's action label (the Caller UI button text).
 *  Index signature for `Record<string, unknown>` compatibility (see
 *  {@link FlowNodeData}). No `explicit` flag: EVERY incoming End edge is now
 *  manager-drawn (there are no topology-derived End arrows left), so a flag
 *  distinguishing the two kinds would be vacuous. */
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
 * Canvas-only terminal markers (Start/End). Start is AUTO-DERIVED for the
 * graph's real entry states (in-degree 0 AND out-degree > 0; an isolated,
 * not-yet-wired status is not an entry). End is MANUAL-ONLY: it derives no
 * incoming edges from the topology at all — every arrow into it comes from the
 * manager-drawn `form.endSources` (manager feedback: "node masih otomatis
 * linked ke end, seharusnya manual linked"). They are NOT in the form (bar
 * `endSources`), NOT on the wire `transitions`, NOT in the XML `<transition>`s —
 * `flowToGraph` filters them out (see {@link flowToGraph}'s `type === 'state'`
 * / `type === 'transition'` filters), and the XML codec `state-machine-xml.ts`
 * is untouched. They re-derive on every canvas re-seed so the markers always
 * reflect the real graph topology. core-api is unchanged — `actionLabel` stays
 * per-{@link Transition} on the wire.
 *
 * The node ids (`__start` / `__end`) are reserved: a state name is validated by
 * `validateCustomStateMachine` against duplicates + the 5 canonical names, but
 * these ids live only on the canvas model (never in `form.states`), so they
 * never collide. {@link isTerminalNodeId} is the single source of truth for the
 * "is this id a terminal marker" predicate, used by the component's
 * `isValidConnection` defensive guard + the properties-panel marker branch.
 */
export const START_NODE_TYPE = 'start';
export const END_NODE_TYPE = 'end';
export const TERMINAL_EDGE_TYPE = 'terminal';
export const START_NODE_ID = '__start';
export const END_NODE_ID = '__end';

/** True when the id is a canvas-only Start/End terminal marker id. */
export function isTerminalNodeId(id: string): boolean {
  return id === START_NODE_ID || id === END_NODE_ID;
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
 * — the `description` is the effective copy via {@link descriptionFor} (the
 * saved per-state override when present, else the derived canonical copy for
 * the 5 PRD §7 defaults, else `${n} transisi keluar` or `Status kustom`),
 * computed here so the node card renders it with no form
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
    data: { name, description: descriptionFor(value, name) },
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
 * Horizontal gap between a terminal marker (Start/End) and the nearest real
 * state node. Matches `autoLayout`'s `X_SPACING = 240` in `state-machine.ts`
 * (the canonical left-to-right rank gap) so the Start marker sits one rank to
 * the LEFT of the leftmost source and the End marker one rank to the RIGHT of
 * the rightmost end source — the markers read as the graph's entry/exit rank without
 * crowding the real nodes. NOT imported from `state-machine.ts` to keep that
 * module's internal spacing constant private (it is not exported); the value
 * is duplicated here with a comment pointing back to the source of truth.
 */
const TERMINAL_SPACING = 240;

/**
 * Derive the canvas-only Start/End terminal markers + their terminal edges.
 * Pure + framework-free (unit-testable in isolation, like every other mapper
 * here). The two halves derive DIFFERENTLY, on purpose:
 *
 * **Start — auto-derived from topology.**
 * - `sources` = states with in-degree 0 AND out-degree > 0 — a real entry point:
 *   nothing flows in, something flows out. (Degrees count only transitions whose
 *   `from` AND `to` are both in `states` — a transition referencing an unknown
 *   state is ignored, mirroring {@link autoLayout}'s defensive guard.)
 * - An ISOLATED state (degree 0 on BOTH sides) is NOT a source. Without that
 *   exclusion a just-dropped, not-yet-wired status reads as the flow's entry
 *   (the manager's "a stray status with no transisi is automatically linked to
 *   Start and End" feedback) — it has no entry semantics yet.
 * - The Start marker is emitted ONLY when `sources.length > 0`. A pure-cycle
 *   graph (every state has an incoming edge) → no Start marker; a graph of only
 *   isolated states → no Start marker; an empty graph → no markers at all.
 *
 * **End — MANUAL-ONLY, derived from `endSources`.** There is NO topology
 * predicate: a state with no outgoing transition (a "sink") is no longer
 * auto-linked. This is the manager's "node masih otomatis linked ke end,
 * seharusnya manual linked" feedback — wiring a new status into the flow used
 * to silently claim it as the flow's exit. One edge is emitted per VALID
 * `endSources` entry (one that has a real position; repeats are de-duped).
 * - The End marker NODE is emitted for ANY non-empty `states` list, even with
 *   zero `endSources`. That is load-bearing UX, not cosmetics: the marker is the
 *   drop target the manager drags a connection INTO, so withholding it when
 *   nothing is linked yet would make the first manual link impossible. (Marker
 *   PRESENCE is then filtered by `value.terminalNodes.end` in
 *   {@link formToFlowWithMarkers} — `'hidden'` still omits it.)
 *
 * Marker positions are derived from `realPositions` (a `Record<stateName,
 * {x,y}>` of the REAL state node positions, built by the caller from the
 * `formToFlow`-returned state nodes). The X bounds cover the states the marker
 * actually CONNECTS to: Start sits at `minX - TERMINAL_SPACING`, one rank left
 * of the leftmost SOURCE; End at `maxX + TERMINAL_SPACING`, one rank right of
 * the rightmost END SOURCE. (Not the leftmost/rightmost real node: an isolated
 * status dropped to the right of the graph would otherwise drag the End marker
 * past a node it has no edge to.) With NO valid `endSources` the End marker
 * connects to nothing, so it falls back to the max X over ALL real positions and
 * simply parks at the right edge of the diagram. The vertical center
 * `yCenter = (minY + maxY) / 2` stays GRAPH-WIDE — the markers denote the whole
 * diagram's entry/exit. A missing position is skipped and an empty bound list
 * defaults to 0, so a marker never NaNs.
 *
 * Terminal edges: the Start marker emits one `START_NODE_ID → source` edge per
 * source; the End marker emits one `endSource → END_NODE_ID` edge per valid
 * entry. They carry `type: 'terminal'` (filtered by {@link flowToGraph} so they
 * never reach the form/wire), an empty `actionLabel` (no Caller button — they
 * are visual markers, not real transitions), and the canonical L→R handle
 * routing (`right` → `left`) + the {@link EDGE_ARROW_MARKER} so the arrow
 * reads the same as a real transition edge.
 *
 * `endSources` is a REQUIRED parameter with no default: there is exactly one
 * production call site ({@link formToFlowWithMarkers}), and forcing it to pass
 * the form's list keeps a future caller from silently deriving an End marker
 * with no incoming edges it never meant to drop.
 */
export function deriveTerminalMarkers(
  states: readonly string[],
  transitions: readonly { from: string; to: string; actionLabel: string }[],
  realPositions: Record<string, { x: number; y: number }>,
  endSources: readonly string[],
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  if (states.length === 0) return { nodes: [], edges: [] };
  const stateSet = new Set(states);
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const s of states) {
    inDeg.set(s, 0);
    outDeg.set(s, 0);
  }
  for (const t of transitions) {
    // Ignore edges that reference a state not in the schema (defensive — mirrors
    // `autoLayout`'s guard so the markers reflect the REAL graph only).
    if (!stateSet.has(t.from) || !stateSet.has(t.to)) continue;
    inDeg.set(t.to, (inDeg.get(t.to) ?? 0) + 1);
    outDeg.set(t.from, (outDeg.get(t.from) ?? 0) + 1);
  }
  // An ISOLATED state — degree 0 on BOTH sides — is not yet wired into the flow,
  // so it is not an entry point (manager feedback: a stray, just-added status was
  // auto-linked to Start AND End at once). It satisfies the in-degree-0 predicate
  // on its own, so it must be excluded explicitly.
  const isIsolated = (s: string) => (inDeg.get(s) ?? 0) === 0 && (outDeg.get(s) ?? 0) === 0;
  const sources = states.filter((s) => !isIsolated(s) && (inDeg.get(s) ?? 0) === 0);
  // The End incoming set is MANUAL-ONLY — no out-degree predicate. Keep only
  // entries that map to a real positioned node (a stale name from a deleted
  // state draws nothing) and de-dupe repeats (two edges would share one id).
  const endIncoming: string[] = [];
  const seenEndSource = new Set<string>();
  for (const s of endSources) {
    if (seenEndSource.has(s) || realPositions[s] === undefined) continue;
    seenEndSource.add(s);
    endIncoming.push(s);
  }

  // X coords of the given states that have a known position. A missing entry is
  // skipped so a name with no position can never produce a NaN bound.
  const xsOf = (names: readonly string[]): number[] =>
    names.flatMap((s) => {
      const p: { x: number; y: number } | undefined = realPositions[s];
      return p ? [p.x] : [];
    });
  // The X bounds are taken over the states the marker actually CONNECTS to —
  // sources for Start, end sources for End — not over every real node. With
  // isolated states excluded above, a stray status dropped to the RIGHT of the
  // connected states (managers drop into empty space) would otherwise push the
  // End marker past a node it has no edge to, stretching the terminal edge
  // across the canvas. When End connects to NOTHING (no valid `endSources`) it
  // has no such span, so it falls back to every real node and parks at the right
  // edge of the diagram — still a reachable drop target.
  const sourceXs = xsOf(sources);
  const endSourceXs = xsOf(endIncoming);
  const allXs = Object.values(realPositions).map((p) => p.x);
  const endBoundXs = endSourceXs.length ? endSourceXs : allXs;
  const minX = sourceXs.length ? Math.min(...sourceXs) : 0;
  const maxX = endBoundXs.length ? Math.max(...endBoundXs) : 0;
  // The vertical center stays GRAPH-WIDE (every real node) — the markers read as
  // the entry/exit of the whole diagram, so they sit at its vertical middle, not
  // at the middle of the connected subset.
  const real = Object.values(realPositions);
  const minY = real.length ? Math.min(...real.map((p) => p.y)) : 0;
  const maxY = real.length ? Math.max(...real.map((p) => p.y)) : 0;
  const yCenter = (minY + maxY) / 2;

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  if (sources.length > 0) {
    nodes.push({
      id: START_NODE_ID,
      type: START_NODE_TYPE,
      position: { x: minX - TERMINAL_SPACING, y: yCenter },
      data: { name: START_NODE_ID, description: '' },
      draggable: false,
      selectable: true,
    });
    for (const s of sources) {
      edges.push({
        id: `${START_NODE_ID}->${s}`,
        source: START_NODE_ID,
        target: s,
        type: TERMINAL_EDGE_TYPE,
        data: { actionLabel: '' },
        sourceHandle: HANDLE_IDS.right,
        targetHandle: HANDLE_IDS.left,
        markerEnd: EDGE_ARROW_MARKER,
      });
    }
  }
  // The End marker node is UNCONDITIONAL for a non-empty graph (the
  // `states.length === 0` early return above is the only withholding case): it
  // must be on the canvas for the manager to have something to drag a
  // connection INTO, even before any `endSources` entry exists. Its incoming
  // edges are exclusively the manager-drawn ones.
  nodes.push({
    id: END_NODE_ID,
    type: END_NODE_TYPE,
    position: { x: maxX + TERMINAL_SPACING, y: yCenter },
    data: { name: END_NODE_ID, description: '' },
    draggable: false,
    selectable: true,
  });
  for (const s of endIncoming) {
    edges.push({
      id: `${s}->${END_NODE_ID}`,
      source: s,
      target: END_NODE_ID,
      type: TERMINAL_EDGE_TYPE,
      data: { actionLabel: '' },
      sourceHandle: HANDLE_IDS.right,
      targetHandle: HANDLE_IDS.left,
      markerEnd: EDGE_ARROW_MARKER,
    });
  }
  return { nodes, edges };
}

/**
 * {@link formToFlow} + the canvas-only Start/End terminal markers in one call.
 * The marker EDGES come from {@link deriveTerminalMarkers}: Start's are
 * auto-derived from topology (sources = in-degree 0 with out-degree > 0 — an
 * isolated state is not one), End's are exclusively `value.endSources` (manual
 * only — no topology predicate). The marker NODE presence + position come from
 * `value.terminalNodes`:
 *  - `'hidden'` → omit the marker node (and its edges — an edge with no source
 *    node cannot render).
 *  - `'auto'` → derive the position from the real node bounds (the
 *    {@link deriveTerminalMarkers} math), `pinned: false`. Start emits only when
 *    the topology has sources (a pure-cycle graph has none → no auto Start; so
 *    does a graph of only isolated, not-yet-wired states); End emits for ANY
 *    non-empty graph, with or without `endSources` — it is the drop target the
 *    manual link is drawn into, so it can never be withheld for having no
 *    incoming edge yet.
 *  - `{x,y}` → explicit manager-pinned position, `pinned: true`; emit ALWAYS
 *    (the manager willed the marker even on an empty/source-less graph).
 *
 * The markers are positioned from the REAL state node positions returned by
 * {@link formToFlow} (so an auto marker sits at the correct rank offset from
 * the actual layout), NOT from the `positions` arg (which is the `oldPositions`
 * fallback for surviving names). The returned `nodes`/`edges` are the
 * concatenation `[...stateNodes, ...markerNodes]` /
 * `[...transEdges, ...markerEdges]`; {@link flowToGraph} filters the markers
 * back out so the form/wire/XML never see them (but it DOES capture
 * `terminalNodes` back from the marker `pinned` flag + positions).
 */
export function formToFlowWithMarkers(
  value: StateMachineForm,
  positions: Record<string, { x: number; y: number }>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const { nodes: stateNodes, edges: transEdges } = formToFlow(value, positions);
  const realPositions: Record<string, { x: number; y: number }> = {};
  for (const n of stateNodes) realPositions[n.data.name] = n.position;
  // Topology-derived markers: the edge + auto-position derivation engine. We
  // reuse it for the terminal edges + the auto marker positions, then consult
  // `value.terminalNodes` for marker presence + position override + pinned.
  const topo = deriveTerminalMarkers(value.states, value.transitions, realPositions, value.endSources);
  const autoStart = topo.nodes.find((n) => n.id === START_NODE_ID);
  const autoEnd = topo.nodes.find((n) => n.id === END_NODE_ID);
  const startEdges = topo.edges.filter((e) => e.source === START_NODE_ID);

  const markerNodes: FlowNode[] = [];
  const markerEdges: FlowEdge[] = [];
  const { start, end } = value.terminalNodes;

  // Start marker: hidden → omit; auto → emit only when topology has sources;
  // {x,y} → emit always, pinned.
  if (start !== 'hidden') {
    const emitExplicit = typeof start === 'object';
    const emitAuto = start === 'auto' && autoStart !== undefined;
    if (emitExplicit || emitAuto) {
      markerNodes.push({
        id: START_NODE_ID,
        type: START_NODE_TYPE,
        position: emitExplicit ? { x: start.x, y: start.y } : autoStart!.position,
        data: { name: START_NODE_ID, description: '' },
        selectable: true,
        pinned: emitExplicit,
      });
      markerEdges.push(...startEdges);
    }
  }
  // End marker: mirrors the Start branch exactly — hidden → omit; auto → emit
  // the derived marker; {x,y} → emit always, pinned. The only asymmetry is in
  // `deriveTerminalMarkers` itself: `autoEnd` is defined for ANY non-empty
  // graph (the marker is the manual link's drop target, so it is never
  // withheld), and its incoming edges are exclusively `value.endSources`.
  if (end !== 'hidden') {
    const emitExplicit = typeof end === 'object';
    const emitAuto = end === 'auto' && autoEnd !== undefined;
    if (emitExplicit || emitAuto) {
      markerNodes.push({
        id: END_NODE_ID,
        type: END_NODE_TYPE,
        position: emitExplicit ? { x: end.x, y: end.y } : autoEnd!.position,
        data: { name: END_NODE_ID, description: '' },
        selectable: true,
        pinned: emitExplicit,
      });
      markerEdges.push(...topo.edges.filter((e) => e.target === END_NODE_ID));
    }
  }
  return { nodes: [...stateNodes, ...markerNodes], edges: [...transEdges, ...markerEdges] };
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
  prevTerminalNodes: TerminalNodesDto = DEFAULT_TERMINAL_NODES,
): {
  states: string[];
  transitions: Transition[];
  positions: Record<string, { x: number; y: number }>;
  terminalNodes: TerminalNodesDto;
} {
  // Filter the canvas-only terminal markers (Start/End nodes + terminal edges)
  // so they NEVER reach the form/wire/XML. The markers are a visual affordance
  // auto-derived by {@link deriveTerminalMarkers} on each re-seed; round-tripping
  // them would corrupt the form (`__start`/`__end` are not real state names).
  const stateNodes = nodes.filter((n) => n.type === 'state');
  const idToName = new Map<string, string>();
  for (const n of stateNodes) idToName.set(n.id, n.data.name);
  const states = stateNodes.map((n) => n.data.name);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of stateNodes) positions[n.data.name] = { ...n.position };
  const transitions: Transition[] = edges
    .filter((e) => e.type === 'transition')
    .map((e) => ({
      from: idToName.get(e.source) ?? e.source,
      to: idToName.get(e.target) ?? e.target,
      actionLabel: e.data.actionLabel,
      sourceSide: handleToSide(e.sourceHandle),
      targetSide: handleToSide(e.targetHandle),
    }));
  // Capture the terminal-marker states back from the canvas. A present marker
  // with `pinned` → `{x,y}` (manager-pinned); a present marker without `pinned`
  // → `'auto'` (auto-derived position). An ABSENT marker preserves the prior
  // `prevTerminalNodes[key]` — absence is ambiguous (it could mean `'hidden'`
  // OR an auto Start marker dropped because the topology has no sources), so
  // the caller passes the prior terminalNodes to disambiguate.
  const startNode = nodes.find((n) => n.type === START_NODE_TYPE);
  const endNode = nodes.find((n) => n.type === END_NODE_TYPE);
  const capture = (
    marker: FlowNode | undefined,
    prev: TerminalNodesDto['start'],
  ): TerminalNodesDto['start'] =>
    marker
      ? marker.pinned
        ? { x: marker.position.x, y: marker.position.y }
        : 'auto'
      : prev;
  const terminalNodes: TerminalNodesDto = {
    start: capture(startNode, prevTerminalNodes.start),
    end: capture(endNode, prevTerminalNodes.end),
  };
  return { states, transitions, positions, terminalNodes };
}

/**
 * Re-stamp each node's `data.description` from the form via {@link descriptionFor}
 * (the saved per-state override when present, otherwise the derived
 * {@link describeState} fallback). Pure helper the parent calls inside `commit`
 * so a mutation that changes a state's outgoing-transition count (delete state,
 * delete/add transition) OR a description edit (form-only `lift`) also refreshes
 * the affected node cards' descriptions. The description is CANVAS-ONLY — this
 * never changes the wire form ({@link flowToGraph} ignores it).
 */
export function withDescriptions(nodes: readonly FlowNode[], form: StateMachineForm): FlowNode[] {
  // Skip non-state nodes (the canvas-only Start/End terminal markers). They
  // carry no state name in the form, so `descriptionFor(form, name)` would
  // return a spurious summary; pass them through untouched (their
  // `description: ''` placeholder stays).
  return nodes.map((n) =>
    n.type === 'state' ? { ...n, data: { ...n.data, description: descriptionFor(form, n.data.name) } } : n,
  );
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
  // Exclude the canvas-only terminal edges (Start→source / endSource→End) —
  // they share no `from`/`to` pair with a real transition (the markers' ids are
  // reserved `__start`/`__end`), but a defensive `type !== 'terminal'` filter
  // keeps the predicate honest if a future caller passes the full canvas edge
  // list (which now includes the markers). Terminal edges must never cause a
  // false-positive duplicate on a real `source → target` pair.
  return edges.some((e) => e.type !== 'terminal' && e.source === source && e.target === target);
}

/**
 * True when a terminal edge already connects `source` to the End marker
 * (`source → __end`). The single source of truth for the duplicate-End-connection
 * check shared by `isValidConnection` (live, during the drag) + `onConnect`
 * (defensive — a real connection that somehow bypassed the live guard), so a
 * manager cannot draw a SECOND arrow from a state already linked to End.
 *
 * Every End edge is manager-drawn now (`endSources`), so this rejects only a
 * genuine repeat. In particular a state with NO outgoing transition is NOT
 * pre-rejected: it used to carry an auto sink→End arrow, which made the
 * predicate refuse the very link the manager was trying to draw. Terminal-edge-
 * typed only — a real transition edge never trips it.
 */
export function hasEndSource(edges: readonly FlowEdge[], source: string): boolean {
  return edges.some(
    (e) => e.type === TERMINAL_EDGE_TYPE && e.target === END_NODE_ID && e.source === source,
  );
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
  // Dropping onto the End marker is rejected only when the source state is
  // already an End source (a repeat of a link the manager drew before).
  // Surface a manager-facing message naming the source so the manager knows why
  // the drop was refused (mirrors the duplicate-transition message style).
  if (to === END_NODE_ID && from && hasEndSource(edges, from)) {
    return `Status ${from} sudah terhubung ke titik akhir.`;
  }
  if (from && isDuplicateTransition(edges, from, to)) {
    return `Transisi dari ${from} ke ${to} sudah ada.`;
  }
  return 'Transisi tidak dapat dibuat.';
}

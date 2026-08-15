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
  DEFAULT_REQUEUE_POLICY,
  DEFAULT_SOURCE_SIDE,
  type StateMachineForm,
  type Transition,
} from './state-machine';
import {
  DEFAULT_STATE_MACHINE,
  DEFAULT_TERMINAL_NODES,
  type EdgeSide,
  type RequeuePolicyDto,
  type TerminalNodesDto,
} from '../api/types';

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

/** Edge payload: the transition's action label (the Caller UI button text),
 *  round-tripped through the canvas by `flowToGraph` so an edge edit made on the
 *  canvas cannot silently reset it. Index signature for `Record<string, unknown>`
 *  compatibility (see {@link FlowNodeData}). No `explicit` flag: EVERY incoming
 *  End edge is now manager-drawn (there are no topology-derived End arrows left),
 *  so a flag distinguishing the two kinds would be vacuous. */
export interface FlowEdgeData {
  actionLabel: string;
  /** What a `→ WAITING` re-queue does to queue order. Round-tripped through the
   *  canvas by `flowToGraph`, so an edge edit made on the canvas cannot silently
   *  reset it. Terminal marker edges carry `DEFAULT_REQUEUE_POLICY` (canvas-only
   *  decoration with no Caller button, so the value is never read for them). */
  requeuePolicy: RequeuePolicyDto;
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
 * Canvas-only terminal markers (Start/End). BOTH are MANUAL-ONLY now: Start
 * derives no outgoing edges from the topology at all — every arrow from it
 * comes from the manager-drawn `form.startSources` (mirrors End's
 * `form.endSources`; manager feedback: "node masih otomatis linked ke end,
 * seharusnya manual linked" — the same reasoning applies to Start). They are
 * NOT on the wire `transitions`, NOT in the XML `<transition>`s —
 * `flowToGraph` filters them out (see {@link flowToGraph}'s `type === 'state'`
 * / `type === 'transition'` filters), and the XML codec `state-machine-xml.ts`
 * reads `startSources`/`endSources` from the root `<metadata>`. They re-derive
 * on every canvas re-seed so the markers always reflect the manager-drawn
 * connections. core-api is unchanged — `actionLabel` stays per-{@link Transition}
 * on the wire.
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
    data: { actionLabel: t.actionLabel, requeuePolicy: t.requeuePolicy },
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
 * here). The two halves mirror each other — BOTH are MANUAL-ONLY now, on
 * purpose:
 *
 * **Start — MANUAL-ONLY, derived from `startSources`.** There is NO topology
 * predicate: a state with no incoming transition (an "entry") is no longer
 * auto-linked. This mirrors the End marker's manual path exactly (manager
 * feedback: "node masih otomatis linked ke end, seharusnya manual linked" — the
 * same reasoning applies to Start: wiring a new status into the flow should not
 * silently claim it as the flow's entry). One edge is emitted per VALID
 * `startSources` entry (one that has a real position; repeats are de-duped).
 * - The Start marker NODE is emitted for ANY non-empty `states` list, even with
 *   zero `startSources`. That is load-bearing UX, not cosmetics: the marker is
 *   the drag source the manager drags a connection FROM, so withholding it when
 *   nothing is linked yet would make the first manual link impossible. A
 *   `startSources: []` graph renders a BARE Start marker (no outgoing arrow).
 *   (Marker PRESENCE is then filtered by `value.terminalNodes.start` in
 *   {@link formToFlowWithMarkers} — `'hidden'` still omits it.)
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
 * of the leftmost START SOURCE; End at `maxX + TERMINAL_SPACING`, one rank right
 * of the rightmost END SOURCE. (Not the leftmost/rightmost real node: an isolated
 * status dropped to the right of the graph would otherwise drag the End marker
 * past a node it has no edge to.) With NO valid `startSources` the Start marker
 * connects to nothing, so it falls back to the min X over ALL real positions and
 * parks at the left edge of the diagram; with NO valid `endSources` the End
 * marker does the same at the right edge. The vertical center
 * `yCenter = (minY + maxY) / 2` stays GRAPH-WIDE — the markers denote the whole
 * diagram's entry/exit. A missing position is skipped and an empty bound list
 * defaults to 0, so a marker never NaNs.
 *
 * Terminal edges: the Start marker emits one `START_NODE_ID → source` edge per
 * valid start source; the End marker emits one `endSource → END_NODE_ID` edge
 * per valid end source. They carry `type: 'terminal'` (filtered by
 * {@link flowToGraph} so they never reach the form/wire), an empty
 * `actionLabel` (no Caller button — they are visual markers, not real
 * transitions), and the canonical L→R handle routing (`right` → `left`) + the
 * {@link EDGE_ARROW_MARKER} so the arrow reads the same as a real transition
 * edge.
 *
 * `startSources` and `endSources` are REQUIRED parameters with no default:
 * there is exactly one production call site ({@link formToFlowWithMarkers}),
 * and forcing it to pass the form's lists keeps a future caller from silently
 * deriving a marker with no edges it never meant to drop.
 */
export function deriveTerminalMarkers(
  states: readonly string[],
  realPositions: Record<string, { x: number; y: number }>,
  startSources: readonly string[],
  endSources: readonly string[],
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  if (states.length === 0) return { nodes: [], edges: [] };
  // The Start outgoing set is MANUAL-ONLY — no in-degree/out-degree predicate.
  // Keep only entries that map to a real positioned node (a stale name from a
  // deleted state draws nothing) and de-dupe repeats (two edges would share one
  // id). Mirrors the End incoming set below.
  const startOutgoing: string[] = [];
  const seenStartSource = new Set<string>();
  for (const s of startSources) {
    if (seenStartSource.has(s) || realPositions[s] === undefined) continue;
    seenStartSource.add(s);
    startOutgoing.push(s);
  }
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
  // start sources for Start, end sources for End — not over every real node. A
  // stray status dropped to the RIGHT of the connected states (managers drop
  // into empty space) would otherwise push the End marker past a node it has no
  // edge to, stretching the terminal edge across the canvas. When Start connects
  // to NOTHING (no valid `startSources`) it has no such span, so it falls back to
  // every real node and parks at the left edge of the diagram — still a
  // reachable drag source. When End connects to NOTHING it does the same at the
  // right edge — still a reachable drop target.
  const startSourceXs = xsOf(startOutgoing);
  const endSourceXs = xsOf(endIncoming);
  const allXs = Object.values(realPositions).map((p) => p.x);
  const startBoundXs = startSourceXs.length ? startSourceXs : allXs;
  const endBoundXs = endSourceXs.length ? endSourceXs : allXs;
  const minX = startBoundXs.length ? Math.min(...startBoundXs) : 0;
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

  // The Start marker node is UNCONDITIONAL for a non-empty graph (the
  // `states.length === 0` early return above is the only withholding case): it
  // must be on the canvas for the manager to have something to drag a
  // connection FROM, even before any `startSources` entry exists. Its outgoing
  // edges are exclusively the manager-drawn ones (a BARE marker when none).
  nodes.push({
    id: START_NODE_ID,
    type: START_NODE_TYPE,
    position: { x: minX - TERMINAL_SPACING, y: yCenter },
    data: { name: START_NODE_ID, description: '' },
    draggable: false,
    selectable: true,
  });
  for (const s of startOutgoing) {
    edges.push({
      id: `${START_NODE_ID}->${s}`,
      source: START_NODE_ID,
      target: s,
      type: TERMINAL_EDGE_TYPE,
      data: { actionLabel: '', requeuePolicy: DEFAULT_REQUEUE_POLICY },
      sourceHandle: HANDLE_IDS.right,
      targetHandle: HANDLE_IDS.left,
      markerEnd: EDGE_ARROW_MARKER,
    });
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
      data: { actionLabel: '', requeuePolicy: DEFAULT_REQUEUE_POLICY },
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
 * exclusively `value.startSources` (manual only — no topology predicate, mirrors
 * End), End's are exclusively `value.endSources` (manual only — no topology
 * predicate). The marker NODE presence + position come from
 * `value.terminalNodes`:
 *  - `'hidden'` → omit the marker node (and its edges — an edge with no source
 *    node cannot render).
 *  - `'auto'` → derive the position from the real node bounds (the
 *    {@link deriveTerminalMarkers} math), `pinned: false`. Both Start and End
 *    emit for ANY non-empty graph, with or without start/end sources — Start is
 *    the drag source the manual link is drawn from, End is the drop target the
 *    manual link is drawn into, so neither can be withheld for having no edge
 *    yet (a `startSources: []` graph renders a BARE Start marker, no arrow).
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
  // Manual-only markers: the edge + auto-position derivation engine. We reuse
  // it for the terminal edges + the auto marker positions, then consult
  // `value.terminalNodes` for marker presence + position override + pinned.
  const topo = deriveTerminalMarkers(value.states, realPositions, value.startSources, value.endSources);
  const autoStart = topo.nodes.find((n) => n.id === START_NODE_ID);
  const autoEnd = topo.nodes.find((n) => n.id === END_NODE_ID);
  const startEdges = topo.edges.filter((e) => e.source === START_NODE_ID);

  const markerNodes: FlowNode[] = [];
  const markerEdges: FlowEdge[] = [];
  const { start, end } = value.terminalNodes;

  // Start marker: hidden → omit; auto → emit the derived marker (defined for ANY
  // non-empty graph now — Start is the manual link's drag source, so it is never
  // withheld, and a bare marker renders when startSources is empty);
  // {x,y} → emit always, pinned.
  if (start !== 'hidden') {
    const emitExplicit = typeof start === 'object';
    const emitAuto = start === 'auto';
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
  // the derived marker; {x,y} → emit always, pinned. `autoEnd` is defined for
  // ANY non-empty graph (the marker is the manual link's drop target, so it is
  // never withheld), and its incoming edges are exclusively `value.endSources`.
  if (end !== 'hidden') {
    const emitExplicit = typeof end === 'object';
    const emitAuto = end === 'auto';
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
      requeuePolicy: e.data.requeuePolicy,
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
 * True when a terminal edge already connects the Start marker to `target`
 * (`__start → target`). Mirrors {@link hasEndSource}: the single source of
 * truth for the duplicate-Start-connection check shared by `isValidConnection`
 * (live, during the drag) + `onConnect` (defensive — a real connection that
 * somehow bypassed the live guard), so a manager cannot draw a SECOND arrow
 * from Start to a state already linked to Start. Terminal-edge-typed only — a
 * real transition edge never trips it.
 */
export function hasStartSource(edges: readonly FlowEdge[], target: string): boolean {
  return edges.some(
    (e) => e.type === TERMINAL_EDGE_TYPE && e.source === START_NODE_ID && e.target === target,
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
  // Dragging from the Start marker onto a state is rejected only when that
  // state is already a Start source (a repeat of a link the manager drew
  // before). Mirrors the End-marker branch above.
  if (from === START_NODE_ID && to && hasStartSource(edges, to)) {
    return `Status ${to} sudah terhubung ke titik awal.`;
  }
  // A SELF-LOOP duplicate reads as its own case: "Transisi dari X ke X sudah
  // ada" names the same status twice and reads like a typo to a manager.
  if (from && from === to && isDuplicateTransition(edges, from, to)) {
    return duplicateSelfLoopMessage(from);
  }
  if (from && isDuplicateTransition(edges, from, to)) {
    return `Transisi dari ${from} ke ${to} sudah ada.`;
  }
  return 'Transisi tidak dapat dibuat.';
}

/** The manager-facing copy for a self-loop that already exists. Shared by
 *  {@link rejectionMessageForConnection} (React Flow rejected the drop live)
 *  and {@link decideConnectEnd} (the same-handle drop React Flow never
 *  validates), so both paths say the same thing. */
function duplicateSelfLoopMessage(from: string): string {
  return `Status ${from} sudah punya transisi ke dirinya sendiri.`;
}

/**
 * The next side, clockwise, used as the TARGET side of a programmatically
 * created self-loop whose SOURCE side is the side the manager dragged from.
 * Two DISTINCT adjacent sides (never the same one) so the loop has two real
 * endpoints and reads as an arc over the nearest corner of the card — see
 * {@link getSelfLoopPath}, whose adjacent-sides branch arcs around exactly that
 * corner.
 */
const SELF_LOOP_TARGET_SIDE: Record<EdgeSide, EdgeSide> = {
  right: 'top',
  top: 'left',
  left: 'bottom',
  bottom: 'right',
};

/**
 * The minimal structural slice of React Flow's `FinalConnectionState` that the
 * connect-end decision needs, on top of {@link ConnectionOutcome}:
 *  - `fromHandleId` is `connectionState.fromHandle?.id` — the handle the drag
 *    STARTED at, used as the self-loop's source side so the loop leaves the card
 *    where the manager pulled from.
 *  - `pointerNodeId` is the state node the pointer was OVER at release,
 *    resolved from the DOM by the component (see `nodeIdUnderPointer`), or
 *    `null` when the release was not over a node (or could not be resolved).
 *    React Flow only reports `toNode` when the release landed on a HANDLE; the
 *    manager releasing over the middle of their own card is the same intent, so
 *    the decision falls back to this. It is consulted ONLY for the self-loop
 *    branch — never for the rejection message, which must stay keyed on React
 *    Flow's own outcome (a "sudah ada" message only makes sense for a
 *    connection React Flow actually evaluated).
 */
export interface ConnectEndOutcome extends ConnectionOutcome {
  fromHandleId: string | null;
  pointerNodeId: string | null;
}

/**
 * What the canvas should do when a connection drag ends: create a self-loop,
 * show a message, or nothing.
 */
export type ConnectEndDecision =
  | { kind: 'none' }
  | { kind: 'self-loop'; source: string; sourceHandle: string; targetHandle: string }
  | { kind: 'message'; message: string };

/**
 * The PURE decision for `onConnectEnd` — the SELF-LOOP fallback plus the
 * existing rejection-message path. Extracted per SRP: the decision is unit-
 * tested here, the side effects (`commit` / `toast.show`) stay a thin wrapper in
 * the component (a real drag needs pointer geometry jsdom cannot provide).
 *
 * **Why a fallback is needed at all** (verified in `@xyflow/system`'s
 * `isValidHandle`, v0.0.79): under `ConnectionMode.Loose` a drop is valid only
 * when `handleNodeId !== fromNodeId || handleId !== fromHandleId`. Dragging out
 * of a node's `right` handle and back onto that SAME `right` handle — the
 * natural self-loop gesture — fails that test BEFORE our `isValidConnection`
 * ever runs, and `getClosestHandle` deliberately skips the from-handle, so
 * `onConnect` never fires. React Flow does still tell us where the pointer
 * landed WHEN THE RELEASE WAS ON A HANDLE: `isValidHandle` fills
 * `result.toHandle` from the handle under the cursor regardless of validity, so
 * `connectionState.toNode` IS populated on that rejected drop (with `isValid ===
 * null`, not `false` — `isConnectionValid` returns `null` when no closest handle
 * was found).
 *
 * **Releasing over the card BODY reports nothing**, though — no handle under the
 * cursor means `toHandle`/`toNode` stay null. That is the majority of real
 * attempts: the manager's gesture is "drag out, drag back onto the status,
 * release", not "release precisely on the 7px dot I started from". So the drop
 * target is `toId ?? pointerNodeId` — React Flow's answer when it has one, else
 * the node the component resolved from the DOM under the release point.
 *
 * Order of checks (load-bearing):
 *  1. `isValid === true` ⟹ React Flow already committed the connection through
 *     `onConnect` (dropping on a DIFFERENT handle of the same node IS valid
 *     under Loose mode) — return `none` so the self-loop is never created twice.
 *  2. An existing self-loop ⟹ a message, not a second edge.
 *  3. Otherwise create the self-loop from the dragged-from side.
 *
 * The branch is gated on `fromId === dropId`, so it can never hijack a drop onto
 * a DIFFERENT node (React Flow owns that, and it already works). Terminal
 * markers (`__start`/`__end`) are excluded: they are canvas-only and must never
 * gain a transition (a marker cannot even be dragged from — its handle is
 * `isConnectable={false}` — but guard so the rule is local; the DOM fallback
 * CAN resolve a marker's wrapper, since markers are `.react-flow__node` too).
 */
export function decideConnectEnd(
  outcome: ConnectEndOutcome,
  edges: readonly FlowEdge[],
): ConnectEndDecision {
  const { fromId, toId } = outcome;
  // Where the release landed: React Flow's resolved target node when it found a
  // handle there, else the node the pointer was over (DOM-resolved fallback).
  const dropId = toId ?? outcome.pointerNodeId;
  if (fromId && dropId && fromId === dropId && !isTerminalNodeId(fromId)) {
    if (outcome.isValid === true) return { kind: 'none' };
    if (isDuplicateTransition(edges, fromId, fromId)) {
      return { kind: 'message', message: duplicateSelfLoopMessage(fromId) };
    }
    const sourceSide = handleToSide(outcome.fromHandleId ?? undefined) ?? DEFAULT_SOURCE_SIDE;
    return {
      kind: 'self-loop',
      source: fromId,
      sourceHandle: sideToHandle(sourceSide),
      targetHandle: sideToHandle(SELF_LOOP_TARGET_SIDE[sourceSide]),
    };
  }
  const message = rejectionMessageForConnection(outcome, edges);
  return message ? { kind: 'message', message } : { kind: 'none' };
}

/**
 * How far each self-loop control point is pushed from its endpoint, in flow
 * units (px at zoom 1). Used for BOTH the outward (normal) and the sideways
 * (lateral) offset, so the loop's apex lands `0.75 * R` (120px) past the
 * handle it leaves from — comfortably outside a card that is `min-width: 10rem`
 * (160px) wide and ~50px tall, on every one of the 16 handle pairs (the
 * tightest, `top`↔`bottom`, still clears the card edge by 40px). Sized
 * generously on purpose: the manager's report was "self-loop garisnya overlap
 * dan jelek sekali, seharusnya lebih panjang lagi".
 */
export const SELF_LOOP_RADIUS = 160;

/** The outward unit normal implied by a handle side, in SVG coordinates (y
 *  grows DOWNWARD, so `top` points to negative y). Keyed by the bare side
 *  string — the {@link HANDLE_IDS} ids and React Flow's `Position` values are
 *  the same four strings, and typing the lookup as a plain string keeps this
 *  module framework-free (React Flow's `Position` is a string ENUM, which TS
 *  will not assign to a string-literal union). */
const SIDE_NORMALS: Record<string, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/**
 * The SVG path + label anchor for a SELF-LOOP edge (`source === target`), in
 * the same `[path, labelX, labelY]` tuple shape React Flow's `getBezierPath`
 * returns, so the edge component can swap one for the other.
 *
 * `getBezierPath` is degenerate for a self-loop: the two endpoints are less
 * than a card apart, so it draws a short backwards curve THROUGH the node card
 * (edges render beneath nodes) and parks the label chip on top of the card —
 * the manager's "overlap dan jelek sekali" report.
 *
 * Instead each control point is pushed OUT along its endpoint's outward normal
 * by {@link SELF_LOOP_RADIUS} and SIDEWAYS along a lateral unit vector by the
 * same amount. The lateral pair is what decides where the loop swings, and it
 * must be chosen RELATIVE to the other endpoint, not per-endpoint:
 *  - ADJACENT sides (normals perpendicular, e.g. `top` → `right`): each
 *    endpoint's lateral is the OTHER endpoint's normal, so both control points
 *    push toward the corner between the two sides and the loop arcs around it.
 *  - SAME side (`right` → `right`): laterals are ±the normal's perpendicular —
 *    opposite signs, so the loop opens into a symmetric round loop off that side.
 *  - OPPOSITE sides (`right` → `left`, the seeded default routing): both
 *    laterals are the SAME perpendicular, so the loop swings clear over one
 *    side of the card instead of S-curving back through it.
 *
 * The label anchor is the cubic's midpoint `(P0 + 3C1 + 3C2 + P3) / 8` (t=0.5),
 * i.e. the apex of the loop — never on the card.
 */
export function getSelfLoopPath(params: {
  sourceX: number;
  sourceY: number;
  sourcePosition: string;
  targetX: number;
  targetY: number;
  targetPosition: string;
}): [path: string, labelX: number, labelY: number] {
  const { sourceX, sourceY, targetX, targetY } = params;
  const ns = SIDE_NORMALS[params.sourcePosition] ?? SIDE_NORMALS.right;
  const nt = SIDE_NORMALS[params.targetPosition] ?? SIDE_NORMALS.left;
  // 0 = adjacent (perpendicular), 1 = same side, -1 = opposite sides.
  const dot = ns.x * nt.x + ns.y * nt.y;
  let ls: { x: number; y: number };
  let lt: { x: number; y: number };
  if (dot === 0) {
    ls = nt;
    lt = ns;
  } else {
    // `ns` rotated a quarter turn (screen coords): the only direction with a
    // sideways component when the two normals are parallel.
    const p = { x: ns.y, y: -ns.x };
    ls = p;
    lt = dot > 0 ? { x: -p.x, y: -p.y } : p;
  }
  const r = SELF_LOOP_RADIUS;
  const c1x = sourceX + ns.x * r + ls.x * r;
  const c1y = sourceY + ns.y * r + ls.y * r;
  const c2x = targetX + nt.x * r + lt.x * r;
  const c2y = targetY + nt.y * r + lt.y * r;
  const path = `M ${sourceX},${sourceY} C ${c1x},${c1y} ${c2x},${c2y} ${targetX},${targetY}`;
  return [
    path,
    (sourceX + 3 * c1x + 3 * c2x + targetX) / 8,
    (sourceY + 3 * c1y + 3 * c2y + targetY) / 8,
  ];
}

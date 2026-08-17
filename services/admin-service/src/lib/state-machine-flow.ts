/**
 * Pure, framework-free mappers between the editable {@link StateMachineForm} and
 * the React Flow canvas model. No React, no `@xyflow/react` imports — fully
 * unit-testable in isolation. The component ({@link StateMachineWorkflow}) is a
 * different VIEW over the same {@link StateMachineForm} + same
 * `lib/state-machine` helpers; these mappers own only the flow-shape
 * translation, never validation, wire mapping, OR the default-positions
 * derivation (those stay in `lib/state-machine` — `autoLayout` lives there and
 * is imported here, so the canvas's default layout is one deterministic
 * derivation).
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
 * testable in isolation, like every other type here). Like
 * `sourceHandle`/`targetHandle`, `markerEnd` is CANVAS-ONLY: `flowToGraph`
 * drops it (never reaches the wire {@link Transition}).
 *
 * **`color` carries a CSS custom property, on purpose.** React Flow's stylesheet
 * does theme the arrowhead (`.react-flow__arrowhead polyline` reads
 * `--xy-edge-stroke`), but that path is unreachable here: `createMarkerIds`
 * substitutes `defaultMarkerColor` — the hardcoded `#b1b1b7` — for any marker
 * that declares no color, and React Flow renders the result as `<polyline
 * style={{ stroke: color, fill: color }}>`, an INLINE style no rule can beat
 * without `!important`. So omitting `color` pins the arrow to a theme-blind
 * literal, and naming a `var()` is the only way to token-drive it. It also buys
 * the thing the stylesheet hook cannot: a SECOND, differently-colored arrowhead
 * for the muted terminal edges (see {@link TERMINAL_ARROW_MARKER}). The token is
 * declared on `.sm-canvas` in `state-machine-workflow.css`, which is an ancestor
 * of the `<svg class="react-flow__marker">` React Flow renders inside the canvas,
 * so the custom property inherits down to the polyline.
 *
 * The `var()` argument carries NO SPACE after the comma. `getMarkerId` builds the
 * marker's DOM `id` by joining its `key=value` pairs, and that id is referenced
 * as `url('#…')` — an `id` may not contain ASCII whitespace, and the URL parser
 * percent-encodes a space in a fragment, leaving resolution up to the engine.
 *
 * The `currentColor` FALLBACK is not decoration. If the token ever fails to
 * reach the polyline — renamed away, or the marker `<svg>` reparented out of
 * `.sm-canvas` by a React Flow upgrade — the `stroke` declaration would be
 * invalid at computed-value time and fall back to the SVG initial `stroke:
 * none`, i.e. the arrowheads would VANISH rather than turn some wrong color.
 * "Garis tidak ada panah, jadi membingungkan" is a complaint this designer has
 * already had once; degrading to the inherited text color instead keeps the
 * direction readable. `styles.test.ts` still pins the token half of the pair.
 *
 * **`width`/`height` are 11, not 16, and that is load-bearing.** React Flow
 * renders the `<marker>` with `markerUnits="strokeWidth"`, so the arrowhead
 * SCALES WITH THE PATH'S STROKE WIDTH — which the canvas sets via
 * `--xy-edge-stroke-width: 1.5` on `.sm-canvas` (`state-machine-workflow.css`).
 * Against that, `11 × 1.5 ≈ 16.5` reproduces the arrowhead size the old `16 × 1`
 * produced; keeping 16 would render a ~24px arrowhead. Change either half of
 * that pair and the other has to move with it.
 */
export interface FlowEdgeMarker {
  type: 'arrowclosed';
  width?: number;
  height?: number;
  /** Token-driven arrow color — a `var(--…)` reference resolved from the
   *  `.sm-canvas` custom properties (see the note above on why this cannot be a
   *  stylesheet rule). Never a hex literal: that is what made the default
   *  `#b1b1b7` arrow theme-blind. */
  color?: string;
}

export const EDGE_ARROW_MARKER: FlowEdgeMarker = {
  type: 'arrowclosed',
  width: 11,
  height: 11,
  color: 'var(--sm-edge-stroke,currentColor)',
};

/**
 * The arrowhead for a canvas-only TERMINAL edge (Start→source / endSource→End).
 * Spread from {@link EDGE_ARROW_MARKER} so "identical geometry, different color"
 * is structural rather than a pair of copied literals that can drift. The color
 * is keyed to the terminal edge's own muted token, so the arrow stays as
 * recessive as the dashed line it tips; sharing one marker config would tip a
 * deliberately muted dashed line with a full-strength transition arrowhead, and
 * there is no CSS route in (the markers live in a shared `<defs>`, not inside
 * `.terminal-edge`). React Flow de-dupes `<marker>` defs by config, so two
 * configs simply produce two defs.
 */
export const TERMINAL_ARROW_MARKER: FlowEdgeMarker = {
  ...EDGE_ARROW_MARKER,
  color: 'var(--sm-terminal-edge-stroke,currentColor)',
};

/** A React Flow edge, structurally compatible with `@xyflow/react`'s `Edge`.
 *  `sourceHandle`/`targetHandle` reference the connection-point ids on the
 *  source/target nodes (see {@link HANDLE_IDS}). They are CANVAS-ONLY — never
 *  serialized to the wire {@link Transition} (`flowToGraph` drops them) — and
 *  record which side each edge was dragged from/to so the router leaves/enters
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
 * the route's exit/entry direction from the handle's `Position`, so a
 * vertical edge (top/bottom handles) renders vertically with NO edge-component
 * change (`TransitionEdge` already forwards `sourcePosition`/`targetPosition`).
 *
 * The ids are the BARE side strings (`'top'`, `'right'`, …) so the wire
 * `EdgeSide` (the SIDE, not the handle id) round-trips cleanly: `handleToSide`
 * does `handle.split('-')[0]` and validates against the 4 sides, so a handle id
 * of just `'top'` round-trips to side `'top'`. No migration, no wire change.
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
 * NOT on the wire `transitions` —
 * `flowToGraph` filters them out (see {@link flowToGraph}'s `type === 'state'`
 * / `type === 'transition'` filters). They re-derive
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
 *
 * **A SELF-LOOP's default target is the CORNER pair, not the L→R one** (see
 * {@link DEFAULT_SELF_LOOP_TARGET_HANDLE}): `right → top`, matching what a
 * dragged self-loop gets from {@link SELF_LOOP_TARGET_SIDE}, so a loop the
 * manager adds from the panel and one they draw by hand are the same shape.
 * `flowToGraph` then captures `right`/`top` as explicit sides on the next save —
 * intended, not a leak: the routing layout is supposed to record what is drawn.
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
  const edges: FlowEdge[] = value.transitions.map((t, i) => {
    // Seed from the form sides (the source of truth); a transition with no
    // sides (absent) falls back to the default routing for its SHAPE — the
    // canonical L→R for an ordinary edge, the corner pair for a self-loop.
    const fallback = defaultHandlesFor(t.from, t.to);
    return {
      id: `${t.from}->${t.to}#${i}`,
      source: t.from,
      target: t.to,
      type: 'transition',
      data: { actionLabel: t.actionLabel, requeuePolicy: t.requeuePolicy },
      sourceHandle: t.sourceSide !== undefined ? sideToHandle(t.sourceSide) : fallback.sourceHandle,
      targetHandle: t.targetSide !== undefined ? sideToHandle(t.targetSide) : fallback.targetHandle,
      markerEnd: EDGE_ARROW_MARKER,
    };
  });
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
 * {@link TERMINAL_ARROW_MARKER} so the arrow reads the same SHAPE as a real
 * transition edge while staying as muted as the dashed line it tips.
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
      markerEnd: TERMINAL_ARROW_MARKER,
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
      markerEnd: TERMINAL_ARROW_MARKER,
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
 * back out so the form/wire never see them (but it DOES capture
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
 * `toEdgeRoutingLayoutDto` omits the default ones → sparse wire.
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
  // so they NEVER reach the form/wire. The markers are a visual affordance
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
 * Two DISTINCT ADJACENT sides (never the same one, never the opposite one) so
 * the loop brackets the nearest corner of the card — see {@link
 * getSelfLoopPath}, whose adjacent-sides branch is the only one that clears the
 * card BY CONSTRUCTION, with no guess at a card extent it cannot see.
 */
const SELF_LOOP_TARGET_SIDE: Record<EdgeSide, EdgeSide> = {
  right: 'top',
  top: 'left',
  left: 'bottom',
  bottom: 'right',
};

/**
 * The target handle {@link formToFlow} seeds for a SELF-LOOP that declares no
 * sides — the corner partner of {@link DEFAULT_SOURCE_HANDLE}, i.e. `top`.
 *
 * The canonical L→R default ({@link DEFAULT_TARGET_HANDLE}) is wrong for a loop
 * on ONE card: `right → left` is an OPPOSITE pair, so the path has to cross the
 * card's vertical extent — which {@link getSelfLoopPath} cannot measure, only
 * guess at ({@link SELF_LOOP_SPAN}). The corner pair needs no guess. It also
 * makes a panel-added loop ("+ Tambah transisi") identical to a hand-drawn one,
 * which goes through {@link SELF_LOOP_TARGET_SIDE} — one shape, one source of
 * truth for what "the corner partner" means.
 *
 * Declared HERE, next to that map, rather than beside `DEFAULT_TARGET_HANDLE`:
 * a `const` initialized from `SELF_LOOP_TARGET_SIDE` must come after it (TDZ).
 * `formToFlow` reads it from a function body, so module order is safe.
 */
const DEFAULT_SELF_LOOP_TARGET_HANDLE = sideToHandle(SELF_LOOP_TARGET_SIDE[DEFAULT_SOURCE_SIDE]);

/**
 * The routing handles a transition gets when NOBODY chose its sides — the one
 * place that knows a self-loop's default differs from every other edge's.
 *
 * Every creation path funnels through here ({@link formToFlow}'s re-seed, the
 * panel's "+ Tambah transisi", `onConnect`'s fallback), because a self-loop can
 * be born at any of them and all three used to hand it the canonical L→R pair —
 * see {@link DEFAULT_SELF_LOOP_TARGET_HANDLE} for why that pair is the wrong one
 * for a loop.
 */
export function defaultHandlesFor(
  from: string,
  to: string,
): { sourceHandle: string; targetHandle: string } {
  return {
    sourceHandle: DEFAULT_SOURCE_HANDLE,
    targetHandle: from === to ? DEFAULT_SELF_LOOP_TARGET_HANDLE : DEFAULT_TARGET_HANDLE,
  };
}

/**
 * The routing handles an edge keeps when the properties panel re-points one of
 * its endpoints — {@link defaultHandlesFor} for the NEW pair if the edge is
 * still on the default routing, otherwise the sides it already has.
 *
 * The distinction is the point: a manager who dragged this edge out of a
 * particular side must keep it (re-pointing "Ke" is not "forget my routing"),
 * but an edge that never left the default should not be stranded on the DEFAULT
 * OF ITS OLD SHAPE — re-pointing an ordinary edge onto its own source makes a
 * self-loop, and that loop should look like every other loop, not like a
 * left-to-right edge bent back on itself.
 */
export function handlesAfterReroute(
  edge: { source: string; target: string; sourceHandle?: string; targetHandle?: string },
  from: string,
  to: string,
): { sourceHandle: string; targetHandle: string } {
  const current = defaultHandlesFor(edge.source, edge.target);
  // Normalize FIRST, compare second: an edge with no handles at all is on the
  // default routing by definition, and treating it as customized would strand it
  // on the default of the shape it is LEAVING — for an ordinary edge re-pointed
  // onto its own source, exactly the `right → left` loop this rule exists to
  // prevent. (No creation path omits handles today; the contract should not
  // depend on that staying true.)
  const sourceHandle = edge.sourceHandle ?? current.sourceHandle;
  const targetHandle = edge.targetHandle ?? current.targetHandle;
  const onDefaults = sourceHandle === current.sourceHandle && targetHandle === current.targetHandle;
  return onDefaults ? defaultHandlesFor(from, to) : { sourceHandle, targetHandle };
}

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
 * How far a self-loop swings past its handle on the axis it must cross, WHEN THE
 * CALLER SUPPLIES NO CARD SIZE — the fallback for {@link getSelfLoopPoints}'s
 * optional `nodeWidth`/`nodeHeight`, in flow units (px at zoom 1).
 *
 * An ADJACENT pair (the default routing — {@link DEFAULT_SELF_LOOP_TARGET_HANDLE})
 * never needs any of this: each long run sits exactly `offset` outside one face,
 * so it clears the card by construction at any size. An OPPOSITE pair (and the
 * defensive same-side one) has to cross the extent BETWEEN the two faces —
 * `right → left` crosses the card's HEIGHT, `top → bottom` its WIDTH — which two
 * side midpoints cannot reveal. `TransitionEdge` therefore TELLS this function
 * the measured card size and the loop hugs it at `offset` like everything else.
 *
 * These two numbers are the DEFENSIVE path, not a startup path: React Flow does
 * not mount an edge until its nodes are measured (`isNodeInitialized` gates
 * `getEdgePosition`, and `FlowNode` declares no `width`/`initialWidth`), so a
 * production self-loop is always drawn with a real size. They exist because the
 * size is an OPTIONAL input — an absent or zero one must not collapse the
 * crossing run onto the card, and `2 * offset` would not clear even the minimum
 * card's width.
 *
 * They are NOT equally safe, and the difference is worth knowing:
 *  - `y = 60` is bounded by construction. `.state-node__title` and
 *    `.state-node__desc` are both `white-space: nowrap`, so a card is always two
 *    text lines (~50px) however long the text is.
 *  - `x = 120` is a guess. `.state-node` has `min-width: 10rem` and NO
 *    `max-width`, so a long description widens the card without limit; past
 *    ~240px a `top ↔ bottom` fallback loop would cut through it. That is exactly
 *    why the measured size is the primary path and this is only the fallback.
 * Both also sit inside `autoLayout`'s gutters (70px vertical from
 * `Y_SPACING = 120`, 80px horizontal from `X_SPACING = 240`), so a fallback loop
 * does not reach the neighbouring rank.
 */
export const SELF_LOOP_SPAN = { x: 120, y: 60 } as const;

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

/** A point in flow coordinates. Structural, so React Flow's `XYPosition` (or any
 *  `{x, y}`) is assignable with no framework import. */
interface Point {
  x: number;
  y: number;
}

/**
 * Turns an ORTHOGONAL waypoint polyline into an SVG path with rounded corners —
 * `M`/`L`/`Q` only, the same command vocabulary `getSmoothStepPath` emits, so a
 * self-loop is indistinguishable in kind from every other edge on the canvas.
 *
 * Each corner's fillet is `min(|ab| / 2, |bc| / 2, radius)`, the identical clamp
 * `getBend` applies in `@xyflow/system` — a short leg can never have its corner
 * overrun it. A collinear triple or a zero-length leg degrades to a plain `L`
 * (again, exactly what `getBend` does), which is also the NaN guard: `Math.sign`
 * of a zero delta is 0, so a degenerate point can only ever emit itself.
 *
 * The axis-aligned precondition is enforced by tests, NOT by a runtime throw: a
 * throw inside an edge component blanks the whole canvas, and a diagonal leg
 * would merely render as a diagonal — visible, not fatal.
 *
 * Exported for its own unit tests, and for that reason only: the fillet clamp,
 * the collinear-triple case and the degenerate inputs are all unreachable
 * through {@link getSelfLoopPath} (whose waypoints are never collinear and whose
 * legs are never shorter than `offset`), so they can only be pinned here. It has
 * no other caller — a new one would be taking on the axis-aligned precondition
 * above, which nothing enforces at runtime.
 */
export function roundedOrthogonalPath(points: readonly Point[], radius: number): string {
  if (points.length === 0) return '';
  const first = points[0];
  let d = `M ${first.x},${first.y}`;
  if (points.length === 1) return d;
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    const r = Math.min(
      Math.hypot(b.x - a.x, b.y - a.y) / 2,
      Math.hypot(c.x - b.x, c.y - b.y) / 2,
      radius,
    );
    if (collinear || r <= 0) {
      d += ` L ${b.x},${b.y}`;
      continue;
    }
    const inX = b.x - Math.sign(b.x - a.x) * r;
    const inY = b.y - Math.sign(b.y - a.y) * r;
    const outX = b.x + Math.sign(c.x - b.x) * r;
    const outY = b.y + Math.sign(c.y - b.y) * r;
    d += ` L ${inX},${inY} Q ${b.x},${b.y} ${outX},${outY}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x},${last.y}`;
}

/**
 * The point half a polyline's LENGTH along it — the label anchor for a
 * self-loop. Measured on the un-rounded waypoints (the fillets pull the drawn
 * stroke inward by at most `0.29 * borderRadius`, and only at a corner), so the
 * anchor is always on, or within ~2px of, the line the manager sees.
 *
 * Arc-length rather than "the apex" or "the middle waypoint": it is the one rule
 * that works for a 5-point bracket and a 6-point loop alike, and it can never
 * land on the card — for every shape {@link getSelfLoopPoints} builds, half the
 * length is longer than the leaving stub, so the anchor falls on a long run that
 * is `offset` clear of a face.
 */
function polylineMidpoint(points: readonly Point[]): [number, number] {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const len = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(len);
    total += len;
  }
  const first = points[0];
  if (total === 0) return [first.x, first.y];
  const half = total / 2;
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const len = lengths[i - 1];
    if (len > 0 && walked + len >= half) {
      const k = (half - walked) / len;
      const a = points[i - 1];
      const b = points[i];
      return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k];
    }
    walked += len;
  }
  const last = points[points.length - 1];
  return [last.x, last.y];
}

/**
 * The ORTHOGONAL waypoints of a SELF-LOOP edge (`source === target`) — every
 * segment axis-aligned, leaving perpendicular to the source face and entering
 * perpendicular to the target face, exactly like every other edge since the
 * canvas went stepped.
 *
 * Every stock React Flow router is degenerate for a self-loop, because the two
 * endpoints are less than a card apart: `getBezierPath` drew a short backwards
 * curve THROUGH the node card (edges render beneath nodes) and parked the label
 * chip on top of it, and `getSmoothStepPath` collapses the same way, since its
 * gapped points fall inside the card. So the waypoints are hand-rolled — but the
 * SHAPE is the canvas's, not an exception to it (the manager's "self-loop masih
 * pakai bezier" report on the otherwise-orthogonal canvas of PR #115).
 *
 * The function is told two handle points, two side names and the `offset` — NOT
 * the card's rect. Three cases, and only one of them is a guess:
 *  - ADJACENT sides (perpendicular normals, e.g. `right → top` — the DEFAULT for
 *    every self-loop, seeded and dragged alike): stub `offset` out of each
 *    endpoint and join them at the OUTER corner `K` (the source stub's
 *    coordinate on the source axis, the target stub's on the target axis). Clear
 *    of the card BY CONSTRUCTION at any card size: the `A → K` run sits exactly
 *    `offset` outside the source face, `K → B` exactly `offset` outside the
 *    target face, and the two stubs are perpendicular to their own face. Picking
 *    the INNER corner instead would run straight through the card.
 *  - OPPOSITE sides (`right → left`): the loop must cross the extent BETWEEN the
 *    two faces, which the two handle points do not reveal — so it crosses at
 *    `half the card + offset` past the handle when the caller supplies the
 *    measured `nodeWidth`/`nodeHeight` (hugging the card exactly like the corner
 *    bracket), and at {@link SELF_LOOP_SPAN} when it does not. Both excursion
 *    legs reach one shared line, which keeps the crossing run axis-aligned even
 *    when the two handle points are not level. The direction is
 *    the source normal rotated a quarter turn, so it is FIXED by the side pair
 *    (`right → left` swings up, `left → right` down): nothing about the
 *    neighbours is knowable here, so a "pick the emptier side" rule would be a
 *    lie, and a data-dependent one would make the loop flip as the graph mutates.
 *    Swapping the two sides mirrors the loop — that is the manager's lever.
 *  - SAME side (`right → right`): DEFENSIVE only. React Flow resolves both
 *    endpoints to the ONE handle element on that side, so `source === target` as
 *    a point, and an orthogonal path that leaves along `+ns` and returns along
 *    `+ns` to that same point must have its first and last segments collinear.
 *    This shape makes the doubled stroke the minimum possible — exactly `offset`
 *    — and no orthogonal shape avoids it (the alternatives are a curve, or moving
 *    an endpoint, which is not ours to move). Unreachable from the UI:
 *    `decideConnectEnd` always picks {@link SELF_LOOP_TARGET_SIDE}, `formToFlow`
 *    seeds the corner pair, and there is no edge-reconnect handler — it takes a
 *    hand-edited routing-layout payload to get here.
 *
 * An unknown/legacy position string falls back to the `right`/`left` normals, so
 * it degrades to the opposite-sides loop rather than to NaN coordinates (a NaN in
 * a `d` attribute drops the whole path from the canvas).
 *
 * Exported so the tests can assert the geometry that actually matters — no
 * segment touching the card rect, every segment axis-aligned, perpendicular
 * exit/entry — against waypoints instead of a regex over a path string. This
 * mirrors `@xyflow/system`'s own `getPoints` + `getBend` split.
 */
export function getSelfLoopPoints(params: {
  sourceX: number;
  sourceY: number;
  sourcePosition: string;
  targetX: number;
  targetY: number;
  targetPosition: string;
  offset: number;
  /** The measured card size, when the caller has it (React Flow's
   *  `useInternalNode(id).measured`). Consulted ONLY by the branches that cross
   *  the card — the corner bracket never needs it — and each axis falls back to
   *  {@link SELF_LOOP_SPAN} independently when absent or not yet measured. */
  nodeWidth?: number;
  nodeHeight?: number;
}): Point[] {
  const { sourceX, sourceY, targetX, targetY, offset } = params;
  const ns = SIDE_NORMALS[params.sourcePosition] ?? SIDE_NORMALS.right;
  const nt = SIDE_NORMALS[params.targetPosition] ?? SIDE_NORMALS.left;
  const source = { x: sourceX, y: sourceY };
  const target = { x: targetX, y: targetY };
  // The straight run every edge on this canvas gets out of its handle before it
  // may turn — `getSmoothStepPath`'s `offset`, same number, same meaning.
  const a = { x: sourceX + ns.x * offset, y: sourceY + ns.y * offset };
  const b = { x: targetX + nt.x * offset, y: targetY + nt.y * offset };
  // 0 = adjacent (perpendicular), 1 = same side, -1 = opposite sides.
  const dot = ns.x * nt.x + ns.y * nt.y;
  if (dot === 0) {
    // `ns` and `nt` are perpendicular unit axes, so the outer corner is just
    // "A's coordinate on the source axis, B's on the target axis".
    const corner = { x: ns.x !== 0 ? a.x : b.x, y: ns.y !== 0 ? a.y : b.y };
    return [source, a, corner, b, target];
  }
  // `ns` rotated a quarter turn (screen coords) — the only direction with a
  // sideways component when the two normals are parallel.
  const lateral = { x: ns.y, y: -ns.x };
  // How far past the handle the excursion has to sit. A handle is its face's
  // MIDPOINT — that is a property of {@link HANDLE_IDS} (exactly one typeless
  // handle per side, centred by React Flow's own base stylesheet), and this
  // formula depends on it: half the card plus the usual `offset` then puts the
  // run exactly `offset` beyond the far face for an opposite pair — the corner
  // bracket's clearance, reached without guessing. (The same-side branch crosses
  // nothing; there the span only sets how far the lobe swings out past a
  // PERPENDICULAR face.) `SELF_LOOP_SPAN` is the no-size-supplied fallback.
  const crossed = lateral.x !== 0 ? params.nodeWidth : params.nodeHeight;
  const span =
    typeof crossed === 'number' && Number.isFinite(crossed) && crossed > 0
      ? crossed / 2 + offset
      : lateral.x !== 0
        ? SELF_LOOP_SPAN.x
        : SELF_LOOP_SPAN.y;
  const proj = (q: Point): number => q.x * lateral.x + q.y * lateral.y;
  const line = Math.max(proj(a), proj(b)) + span;
  const push = (q: Point): Point => ({
    x: q.x + lateral.x * (line - proj(q)),
    y: q.y + lateral.y * (line - proj(q)),
  });
  if (dot < 0) return [source, a, push(a), push(b), b, target];
  const returnLane = { x: b.x + ns.x * offset, y: b.y + ns.y * offset };
  return [source, a, push(a), push(returnLane), returnLane, target];
}

/**
 * The SVG path + label anchor for a SELF-LOOP edge, in the same
 * `[path, labelX, labelY]` tuple prefix React Flow's path builders return, so
 * the edge component can swap one for the other.
 *
 * `borderRadius` and `offset` are REQUIRED and carry no defaults on purpose:
 * `TransitionEdge` spreads the SAME `STEP_PATH_OPTIONS` object into this call
 * and into `getSmoothStepPath`, so the self-loop's corner rounding and handle
 * clearance can never drift from the rest of the canvas. Geometry in:
 * {@link getSelfLoopPoints}; rounding in {@link roundedOrthogonalPath}; label in
 * `polylineMidpoint`.
 */
export function getSelfLoopPath(params: {
  sourceX: number;
  sourceY: number;
  sourcePosition: string;
  targetX: number;
  targetY: number;
  targetPosition: string;
  borderRadius: number;
  offset: number;
  nodeWidth?: number;
  nodeHeight?: number;
}): [path: string, labelX: number, labelY: number] {
  const points = getSelfLoopPoints(params);
  const [labelX, labelY] = polylineMidpoint(points);
  return [roundedOrthogonalPath(points, params.borderRadius), labelX, labelY];
}

import {
  DEFAULT_NODE_ACTIONS,
  DEFAULT_STATE_MACHINE,
  DEFAULT_TERMINAL_NODES,
  type EdgeRoutingLayoutDto,
  type EdgeSide,
  type EndSourcesDto,
  type NodeActionType,
  type NodeActionsDto,
  type NodePositionsDto,
  type StateMachineDto,
  type StateTransitionDto,
  type TerminalNodesDto,
} from '../api/types';

/**
 * The default connection-point routing for a transition that carries no
 * manager-chosen handle: out the right, into the left — the canonical
 * left-to-right flow the PRD §7 default state machine reads as. Mirrors
 * `DEFAULT_SOURCE_HANDLE`/`DEFAULT_TARGET_HANDLE` in `state-machine-flow.ts`
 * (the handle-id equivalents). Kept here (the form lib) so the form-model
 * helpers (`isDefaultSides`, `toEdgeRoutingLayoutDto`, `graphSignature`)
 * share one source of truth for "what is default routing"; the DOM-dependent
 * XML codec (`state-machine-xml.ts`) reaches them via import.
 */
export const DEFAULT_SOURCE_SIDE: EdgeSide = 'right';
export const DEFAULT_TARGET_SIDE: EdgeSide = 'left';

/** The four valid connection sides — used by `xmlToForm` enum validation at
 *  the parse boundary (sides are layout, not graph structure, so they are not
 *  validated in `validateCustomStateMachine`). Exported so the DOM-dependent
 *  XML codec (`state-machine-xml.ts`) reuses the one enum source of truth. */
export const EDGE_SIDES: readonly EdgeSide[] = ['top', 'right', 'bottom', 'left'];

/** SME-friendly label for each node-action type. A `Record<NodeActionType,
 *  string>` is an EXHAUSTIVE guard: widening the `NodeActionType` union (in
 *  `api/types.ts`) to add e.g. `WEBHOOK` makes this map a compile error until a
 *  label is added — which is exactly the point. This map is the single source
 *  of truth for the properties panel's "Aksi" dropdown options (the options
 *  list is DERIVED from its keys, so the dropdown can never drift from the
 *  union the way a hand-maintained parallel literal could). One entry today;
 *  widening (e.g. a webhook / notify action) is a one-line addition here.
 *  Mirrors core-api's `ACTION_TYPES` closed enum. */
export const NODE_ACTION_TYPE_LABELS: Record<NodeActionType, string> = {
  UPDATE_STATUS: 'Update Status',
};

/** One transition edge in the editable state machine. */
export interface Transition {
  from: string;
  to: string;
  actionLabel: string;
  /**
   * Which side of the source node this edge exits. Optional — absent means
   * the default ({@link DEFAULT_SOURCE_SIDE}). The form is the source of truth
   * for handle routing now; `formToFlow` reads this to seed the React Flow
   * `sourceHandle`, and `flowToGraph` captures it back from the canvas. It is
   * NOT on the wire {@link StateTransitionDto} — it travels in the separate
   * {@link EdgeRoutingLayoutDto} map (built by {@link toEdgeRoutingLayoutDto}).
   */
  sourceSide?: EdgeSide;
  /** Which side of the target node this edge enters (see {@link sourceSide}). */
  targetSide?: EdgeSide;
}

/**
 * True when the sides are both default (or absent, which means default). Used
 * by `formToXml` (omit default sides from the Source XML), `toEdgeRoutingLayoutDto`
 * (omit default edges from the sparse wire map), and `isDefaultGraph` (a
 * default-structure graph with custom routing is custom, not default).
 */
export function isDefaultSides(
  sourceSide: EdgeSide | undefined,
  targetSide: EdgeSide | undefined,
): boolean {
  return (
    (sourceSide ?? DEFAULT_SOURCE_SIDE) === DEFAULT_SOURCE_SIDE &&
    (targetSide ?? DEFAULT_TARGET_SIDE) === DEFAULT_TARGET_SIDE
  );
}

/**
 * The editable state-machine form slice. `mode` is a **client-only preset** —
 * it is never sent to core-api (the PUT payload is always the full
 * `{ states, transitions }` graph). `'default'` locks the form to the PRD §7
 * default graph; `'custom'` opens the states + transitions editor. It is
 * inferred on prefill (deep-equal to {@link DEFAULT_STATE_MACHINE} ⇒ default)
 * so a re-edit of a store that never customized stays in default mode.
 */
export interface StateMachineForm {
  mode: 'default' | 'custom';
  states: string[];
  transitions: Transition[];
  /**
   * State-node canvas positions keyed by state name. `{}` means "use the
   * deterministic `autoLayout`". Positions are now ON the form/wire
   * (mirroring `sourceSide`/`targetSide`): `flowToGraph` captures them from
   * the canvas, `xmlToForm` parses them from the Source XML, and
   * `toNodePositionsDto` ships them in the separate `nodePositions` wire map.
   * A drag-stop lifts them via `commit` → `onChange`, and `graphSignature`
   * includes them so a position change is detectable as an external change.
   */
  positions: Record<string, { x: number; y: number }>;
  /**
   * Node-level actions keyed by state name. Panel-only — NOT
   * canvas-rendered (`flowToGraph`/`formToFlow` ignore it, like `mode`), so a
   * node-action edit never re-seeds the canvas (`graphSignature` excludes
   * it). The properties panel reads `form.nodeActions` directly. Travels the
   * wire in the separate `nodeActions` map (built by `toNodeActionsDto`).
   */
  nodeActions: NodeActionsDto;
  /**
   * Per-state editable descriptions keyed by state name (intrinsic per-state
   * metadata, part of the state-machine definition). Panel-only edit via
   * `lift(updateStateDescription(...))` (form-only, like `nodeActions`), so
   * `graphSignature` excludes `descriptions` (a description edit must not
   * re-seed the canvas). The canvas node card's `data.description` updates via
   * the `formToFlow`/`withDescriptions` memo recompute on form change. Travels
   * the wire INSIDE the `stateMachine` object (`toStateMachineDto` includes
   * `descriptions`), NOT as a top-level field — so no new passthrough site.
   * Empty/whitespace values are stripped (an empty saved description ⇒ the key
   * is absent ⇒ `descriptionFor` falls back to `describeState`).
   */
  descriptions: Record<string, string>;
  /**
   * Start/End terminal-marker states (a fixed-shape `{ start, end }`, NOT keyed
   * by state name — the terminal ids `__start`/`__end` are reserved canvas
   * markers, not state names). `'auto'` derives the marker position from the
   * real node bounds; `{x,y}` is a manager-pinned explicit position; `'hidden'`
   * omits the marker. The terminal EDGES stay auto-derived from topology, so
   * the manager controls marker PRESENCE + POSITION only. Travels the wire in
   * the separate `terminalNodes` field (built by `toTerminalNodesDto`).
   *
   * Canvas-rendered (unlike `nodeActions`): `formToFlowWithMarkers` consults it
   * for marker presence + position, and `flowToGraph` captures it back from the
   * canvas. So `graphSignature` INCLUDES it (a terminal edit re-seeds the
   * canvas), and `updateState`/`removeState` need NO rename/delete propagation
   * (fixed start/end keys, not state-name-keyed).
   */
  terminalNodes: TerminalNodesDto;
  /**
   * Explicit End-marker connections — a flat array of state NAMES the manager
   * dragged a connection from into the End terminal marker (multiple allowed).
   * Canvas-rendered (like `terminalNodes`): `formToFlowWithMarkers` emits an
   * EXPLICIT terminal edge for each entry that is not already a sink, so a
   * change MUST re-seed the canvas → `graphSignature` INCLUDES `endSources`.
   * Travels the wire in the separate top-level `endSources` field (built by
   * {@link toEndSourcesDto}), NOT inside `stateMachine` (the End marker is a
   * canvas-only affordance, NOT a real state — `__end` never reaches the wire
   * `transitions`). The `updateState`/`removeState` helpers cascade a rename/
   * delete to the entry (state-name-keyed by value, mirrors `nodeActions`).
   */
  endSources: string[];
}

/** The PRD §7 default graph prefilled into the editor's default mode. */
export function defaultStateMachineForm(): StateMachineForm {
  return {
    mode: 'default',
    states: [...DEFAULT_STATE_MACHINE.states],
    transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    positions: {},
    nodeActions: { ...DEFAULT_NODE_ACTIONS },
    // No per-state description overrides — the canonical copy (describeState)
    // is the fallback for each of the 5 PRD §7 default statuses.
    descriptions: {},
    terminalNodes: { ...DEFAULT_TERMINAL_NODES },
    // No explicit End connections — the End marker only shows the auto-derived
    // sink→End arrows for the default graph's sinks (COMPLETED).
    endSources: [],
  };
}

/**
 * Structural deep-equal against the PRD §7 default graph (prefill mode inference).
 *
 * Considers connection-point sides AND node positions: a graph that
 * structurally matches the PRD §7 default but has a non-default-routed edge or
 * a non-empty positions map is CUSTOM (the manager touched the handle routing
 * or moved a node), so it loads as `mode: 'custom'` (editable) rather than
 * `mode: 'default'` (read-only). The PRD default transitions carry no sides
 * and the default canvas carries no positions, so an uncustomized graph stays
 * default. The `positions` param defaults to `{}` (backward-compatible) but
 * every caller passes the form's positions so a store with saved positions
 * loads editable, not read-only default.
 */
export function isDefaultGraph(
  states: readonly string[],
  transitions: readonly Transition[],
  positions: Record<string, { x: number; y: number }> = {},
  terminalNodes: TerminalNodesDto = DEFAULT_TERMINAL_NODES,
  endSources: readonly string[] = [],
): boolean {
  if (Object.keys(positions).length > 0) return false;
  // A manager-pinned or hidden terminal marker is a customization (auto/auto
  // is the default-derived UX), so a store with non-auto terminals loads as
  // `mode: 'custom'` (editable), not read-only default.
  if (terminalNodes.start !== 'auto' || terminalNodes.end !== 'auto') return false;
  // An explicit End connection is a customization (the default graph has none
  // — the manager dragged a new arrow into End), so a store with a non-empty
  // `endSources` loads as `mode: 'custom'` (editable), not read-only default.
  if (endSources.length > 0) return false;
  if (states.length !== DEFAULT_STATE_MACHINE.states.length) return false;
  if (transitions.length !== DEFAULT_STATE_MACHINE.transitions.length) return false;
  const sameStates = states.every((s, i) => s === DEFAULT_STATE_MACHINE.states[i]);
  if (!sameStates) return false;
  return transitions.every((t, i) => {
    const d = DEFAULT_STATE_MACHINE.transitions[i];
    return (
      t.from === d.from &&
      t.to === d.to &&
      t.actionLabel === d.actionLabel &&
      isDefaultSides(t.sourceSide, t.targetSide)
    );
  });
}

/**
 * Maps the editable form onto the `PUT /api/system/config` wire shape — the one
 * place that owns "strip the client-only `mode` **and** force the PRD §7 default
 * graph in default mode".
 *
 * The force-reset is not redundant with the editor's default-radio (which today
 * calls {@link defaultStateMachineForm} and so already replaces the graph): if
 * that radio ever preserved the graph and only flipped `mode`, a half-edited
 * custom graph the manager abandoned would silently ship AS the default — the
 * exact leak the "client-only preset stripped at finalize" rule exists to
 * prevent. Both the wizard's `finalize()` and the panel's `save()` go through
 * here so neither surface can drift from the other's defense.
 */
export function toStateMachineDto(form: StateMachineForm): StateMachineDto {
  return form.mode === 'default'
    ? {
        states: [...DEFAULT_STATE_MACHINE.states],
        transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
        // Default mode → no per-state description overrides. The canonical
        // defaults are DERIVED (describeState), not stored — so a store that
        // keeps the default graph ships `{}` regardless of any description
        // text the manager typed before flipping back to default (the
        // force-reset discards it, mirroring how it discards states/
        // transitions/positions/nodeActions).
        descriptions: {},
      }
    : {
        states: form.states,
        // Strip the canvas-only `sourceSide`/`targetSide` — they are NOT on the
        // wire {@link StateTransitionDto}; they travel in the separate
        // {@link EdgeRoutingLayoutDto} map (see {@link toEdgeRoutingLayoutDto}).
        transitions: form.transitions.map((t) => ({ from: t.from, to: t.to, actionLabel: t.actionLabel })),
        // Strip empty/whitespace values defensively so the wire stays lean
        // (`updateStateDescription` already deletes empties, but a corrupt
        // prefill or a direct form edit could leave a blank entry). The VO on
        // the backend also drops empties, so this is belt-and-suspenders.
        descriptions: stripEmptyDescriptions(form.descriptions ?? {}),
      };
}

/**
 * Returns a copy of `descriptions` with empty/whitespace values removed (a
 * cleared description field round-trips as an absent key so `descriptionFor`
 * falls back to the derived canonical copy). Pure helper used by
 * {@link toStateMachineDto} to keep the wire payload lean.
 */
function stripEmptyDescriptions(descriptions: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(descriptions)) {
    if (value.trim().length > 0) out[key] = value;
  }
  return out;
}

/**
 * Merges a sparse wire `edgeRoutingLayout` map into per-transition sides. The
 * inverse of {@link toEdgeRoutingLayoutDto}: a present entry carries the
 * `sourceSide`/`targetSide` onto the matching transition; an absent entry
 * (default routing) yields a transition with no sides (undefined → default).
 * Used by the admin `toForm` and the wizard prefill so both surfaces share one
 * merge owner (no duplicated inline logic + style drift).
 *
 * Uses the explicit-field form (not `...sides`) so a future widening of
 * {@link EdgeSides} can't silently leak extra fields onto a {@link Transition}.
 * The `edgeLayout ?? {}` coercion is belt-and-suspenders (the backend always
 * returns `edgeRoutingLayout`, defaulting to `{}`) — same defensive pattern as
 * `tvPanelLayout ?? DEFAULT_TV_GRID_LAYOUT` in `toForm`.
 */
export function mergeEdgeSides(
  transitions: readonly StateTransitionDto[],
  edgeLayout: EdgeRoutingLayoutDto | undefined,
): Transition[] {
  const layout = edgeLayout ?? {};
  return transitions.map((t) => {
    const sides = layout[`${t.from}->${t.to}`];
    return sides
      ? { from: t.from, to: t.to, actionLabel: t.actionLabel, sourceSide: sides.sourceSide, targetSide: sides.targetSide }
      : { from: t.from, to: t.to, actionLabel: t.actionLabel };
  });
}

/**
 * Builds the sparse edge-routing wire map from the form transitions. For each
 * transition with NON-DEFAULT connection sides, emits `map["from->to"] =
 * { sourceSide, targetSide }`; default-routed edges (right→left, or absent) are
 * OMITTED so `{}` means "all default". The map is the wire {@link
 * EdgeRoutingLayoutDto} — keyed by `from->to` (unique per
 * `validateCustomStateMachine`). In default mode `toStateMachineDto`
 * force-resets the graph, so the form's transitions may still carry sides, but
 * the default graph uses default routing so this map is `{}` regardless — read
 * `form.transitions` directly, do not special-case mode.
 */
export function toEdgeRoutingLayoutDto(form: StateMachineForm): EdgeRoutingLayoutDto {
  const layout: EdgeRoutingLayoutDto = {};
  for (const t of form.transitions) {
    if (isDefaultSides(t.sourceSide, t.targetSide)) continue;
    layout[`${t.from}->${t.to}`] = {
      sourceSide: t.sourceSide ?? DEFAULT_SOURCE_SIDE,
      targetSide: t.targetSide ?? DEFAULT_TARGET_SIDE,
    };
  }
  return layout;
}

/**
 * Builds the node-positions wire map from the form. A shallow copy of
 * `form.positions` (the form is the source of truth — built by `flowToGraph`
 * on a canvas commit, or by `xmlToForm` on a Source edit). `{}` means "use the
 * deterministic `autoLayout`". Mirrors `toEdgeRoutingLayoutDto`'s doc style:
 * read `form.positions` directly, do not special-case mode (default mode
 * force-resets the graph in `toStateMachineDto` and the default canvas carries
 * no positions, so the map is `{}` regardless).
 */
export function toNodePositionsDto(form: StateMachineForm): NodePositionsDto {
  return { ...form.positions };
}

/**
 * Builds the node-actions wire map from the form. A shallow copy of
 * `form.nodeActions` (the form is the source of truth — built by the
 * properties panel's "Aksi" editor). `{}` means "no node-level actions".
 * Mirrors `toNodePositionsDto`'s doc style: read `form.nodeActions` directly,
 * do not special-case mode (default mode force-resets the graph in
 * `toStateMachineDto` and the default canvas carries no node actions, so the
 * map is `{}` regardless).
 */
export function toNodeActionsDto(form: StateMachineForm): NodeActionsDto {
  return { ...form.nodeActions };
}

/**
 * Builds the terminal-marker wire map from the form. A deep copy of
 * `form.terminalNodes` (the form is the source of truth — built by
 * `flowToGraph` on a canvas commit, by the panel/drop terminal handlers on a
 * marker edit, or by `xmlToForm` on a Source edit). `auto/auto` means "derive
 * both markers from the real node bounds". Mirrors `toNodeActionsDto`'s doc
 * style: read `form.terminalNodes` directly, do not special-case mode (default
 * mode force-resets the graph in `toStateMachineDto` and the default canvas
 * carries auto/auto terminals, so the map is `auto/auto` regardless). The
 * `{x,y}` branch is deep-copied so the wire payload never aliases the form's
 * mutable position object.
 */
export function toTerminalNodesDto(form: StateMachineForm): TerminalNodesDto {
  const { start, end } = form.terminalNodes;
  const copyPos = (v: TerminalNodesDto['start']): TerminalNodesDto['start'] =>
    typeof v === 'object' && v !== null ? { x: v.x, y: v.y } : v;
  return { start: copyPos(start), end: copyPos(end) };
}

/**
 * Builds the explicit End-connections wire array from the form. A shallow copy
 * of `form.endSources` (the form is the source of truth — built by the
 * `onConnect`-to-End path + the panel "Transisi masuk" delete, or by
 * `xmlToForm` on a Source edit). `[]` means "no explicit End connections —
 * only the auto-derived sink→End arrows". Mirrors `toTerminalNodesDto`'s doc
 * style: read `form.endSources` directly, do not special-case mode (default
 * mode force-resets the graph in `toStateMachineDto` and the default canvas
 * carries no explicit End connections, so the array is `[]` regardless —
 * `defaultStateMachineForm` seeds `[]` and the default radio calls it).
 */
export function toEndSourcesDto(form: StateMachineForm): EndSourcesDto {
  return [...form.endSources];
}

/** Horizontal gap between ranks (left-to-right flow). */
const X_SPACING = 240;
/** Vertical gap between nodes stacked within a rank. */
const Y_SPACING = 120;

/**
 * The SINGLE canonical "default positions for an empty `positions` map"
 * derivation, shared by BOTH views of the same {@link StateMachineForm}: the
 * React Flow canvas (`formToFlow` in `state-machine-flow.ts`) AND the editable
 * XML Source view (`formToXml` in `state-machine-xml.ts`). Both import this one
 * function, so the diagram the manager sees and the XML they edit can never
 * diverge in node positions — an un-customized graph (`form.positions = {}`)
 * serializes the SAME coordinates the canvas renders, and the XML is the
 * human-editable single source of truth the diagram arranges from.
 *
 * `rank` = longest path from source nodes (nodes with no incoming edge) in the
 * graph with back-edges removed; `x = rank * X_SPACING` (240). Within a rank,
 * nodes stack vertically by appearance order in `states`, `y = indexInRank *
 * Y_SPACING` (120). Nodes unreachable from any source (pure cycles, or anything
 * downstream of one) keep rank 0.
 *
 * Back-edges (edges to a node on the DFS stack — the cycle-closing edges, e.g.
 * the default graph's `SKIPPED → CALLING`) are removed for ranking so a cycle
 * never inflates a node's rank; they remain as visual back-arrows on the
 * canvas. Pure cycles (no node with zero in-degree) have no source to seed
 * relaxation from, so every node in them keeps rank 0.
 *
 * Pure + stable: same input ⇒ same output (no `Math.random` / `Date.now`). It
 * lives here in the form-model lib (not in `state-machine-flow.ts`, the React
 * Flow layer) because "the canonical default positions for an empty positions
 * map" is a form-model concern, not a canvas concern — the DOM-dependent XML
 * codec imports it from here so dependency direction stays clean (DOM layer →
 * pure layer, never the reverse).
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
 * Validate a custom state machine, mirroring the backend invariants
 * (`StateMachine` / `StateSchema` in `core-api`) so the editor never submits a
 * graph the backend would reject with a 400. Returns a list of human-readable
 * (Indonesian) error strings; empty means valid.
 *
 * The copy says "status" / "alur status", never the internal "state" /
 * "state machine" — the editor now lives on `/config`, a surface a
 * non-technical store manager uses daily (CLAUDE.md: user-visible text must
 * never leak internal terms).
 */
export function validateCustomStateMachine(form: StateMachineForm): string[] {
  const errors: string[] = [];
  const { states, transitions } = form;
  if (states.length === 0) errors.push('Alur status harus memiliki minimal satu status.');
  if (transitions.length === 0) errors.push('Alur status harus memiliki minimal satu transisi.');
  const seenStates = new Set<string>();
  for (const s of states) {
    if (!s || !s.trim()) errors.push('Nama status tidak boleh kosong.');
    else if (seenStates.has(s)) errors.push(`Status '${s}' duplikat.`);
    seenStates.add(s);
  }
  const seenEdges = new Set<string>();
  for (const t of transitions) {
    if (!t.actionLabel || !t.actionLabel.trim()) errors.push('Label aksi tidak boleh kosong.');
    if (!seenStates.has(t.from)) errors.push(`Transisi '${t.from}'→'${t.to}': status '${t.from}' tidak dikenal.`);
    if (!seenStates.has(t.to)) errors.push(`Transisi '${t.from}'→'${t.to}': status '${t.to}' tidak dikenal.`);
    const edge = `${t.from}->${t.to}`;
    if (seenEdges.has(edge)) errors.push(`Transisi '${t.from}'→'${t.to}' duplikat.`);
    seenEdges.add(edge);
  }
  // De-duplicate identical messages (e.g. several empty labels).
  return [...new Set(errors)];
}

/**
 * The five PRD §7 canonical system statuses — the "hardcoded" set the queue
 * engine keys off as load-bearing identities (QueueTicket.create() writes
 * WAITING, complete() writes COMPLETED, markCalling() writes CALLING, …; the
 * fixed caller commands AND the lifecycle timestamps are coupled to these
 * literal names — see core-api `TicketStatus`). This catalog is the SINGLE
 * source of truth for the canonical status metadata: the description + the
 * consequence maps and `describeState` all derive from it. Each entry carries:
 *  - `name`: the canonical status name — the system identity, NOT a display
 *    label. Renaming it breaks the engine, so the designer treats canonical
 *    names as fixed system roles (the calibrated "status standar" picker adds
 *    a node under this exact name) while custom statuses keep a free name.
 *  - `description`: a manager-facing sub-description (what the status IS).
 *  - `consequence`: what stops working without it — surfaced by the missing-
 *    status warning AND the properties panel's sub-description so the manager
 *    understands the status's role before editing or dropping it.
 */
export interface CanonicalStatus {
  readonly name: string;
  readonly description: string;
  readonly consequence: string;
}

export const CANONICAL_STATUSES: readonly CanonicalStatus[] = [
  { name: 'WAITING', description: 'Tiket menunggu dipanggil', consequence: 'tiket baru dari kiosk selalu dibuat di status ini, jadi tanpa status ini tiket tidak pernah bisa dipanggil' },
  { name: 'CALLING', description: 'Sedang dipanggil ke counter', consequence: 'tombol "Panggil Berikutnya" di layar petugas berhenti berfungsi' },
  { name: 'SERVING', description: 'Sedang dilayani', consequence: 'tombol "Mulai Melayani" di layar petugas berhenti berfungsi' },
  { name: 'SKIPPED', description: 'Dilewati / absen', consequence: 'tombol "Lewati / Absen" dan "Panggil Ulang" di layar petugas berhenti berfungsi' },
  { name: 'COMPLETED', description: 'Layanan selesai', consequence: 'tombol "Selesai Layan" berhenti berfungsi dan lama layanan tidak tercatat di laporan' },
];

/**
 * Friendly Indonesian short descriptions for the 5 canonical states — derived
 * from {@link CANONICAL_STATUSES} (the single source of truth). The canonical
 * copy shown on the SVG state card and in the properties panel; custom states
 * derive a summary from their outgoing transitions instead (the wire contract
 * carries no description field, so this map is a CLIENT-SIDE derivation — never
 * serialized).
 */
export const CANONICAL_STATE_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  CANONICAL_STATUSES.map((s): [string, string] => [s.name, s.description]),
);

/**
 * Look up the canonical system status a node represents, by name. Returns `null`
 * for a custom (non-canonical) name — the node IS a custom status the manager
 * coined. The name IS the system identity (the queue engine keys off the
 * canonical names as literals), so the status is DERIVED from the name rather
 * than stored as a separate field — a true free-display-name vs. hardcoded-
 * status decoupling would require a domain rewrite (aggregate + repos + DB +
 * wire DTO + all frontends), out of scope for this manager-feedback fix. The
 * properties panel reads this to surface "what status is this node" (manager
 * feedback: "status node itu apa? masukn d properties").
 */
export function canonicalStatusOf(name: string): CanonicalStatus | null {
  return CANONICAL_STATUSES.find((s) => s.name === name) ?? null;
}

/** One status of the standard flow that the edited graph no longer contains. */
export interface MissingCanonicalState {
  /** The status name as it appears in the standard flow (e.g. `COMPLETED`). */
  readonly state: string;
  /** What stops working without it, in manager-facing Indonesian. */
  readonly consequence: string;
}

/**
 * Statuses of the standard flow that the edited graph dropped.
 *
 * **This is a WARNING source, not a validation rule** — deliberately NOT part of
 * {@link validateCustomStateMachine} and deliberately not a save/Lanjut gate. The
 * backend accepts any well-formed graph (`StateSchema` enforces only non-empty /
 * unique / at-least-one; it carries no invariant that the standard statuses
 * survive) and a custom flow may legitimately skip one, so blocking would
 * over-restrict. But core-api's queue engine transitions to these status names
 * as literals — `complete()` writes `COMPLETED` and stamps `completed_at`, the
 * dedicated caller endpoints own those side effects — so dropping one silently
 * breaks that part of the queue for every FUTURE ticket, not just the live ones
 * the panel's other warning covers. The manager has to be told; the decision
 * stays theirs.
 *
 * Default mode always ships the standard graph verbatim ({@link toStateMachineDto}
 * force-resets it), so nothing can be missing there.
 */
export function missingCanonicalStates(form: StateMachineForm): MissingCanonicalState[] {
  if (form.mode === 'default') return [];
  const present = new Set(form.states.map((s) => s.trim()));
  return DEFAULT_STATE_MACHINE.states
    .filter((state) => !present.has(state))
    .map((state) => ({ state, consequence: canonicalStatusOf(state)?.consequence ?? '' }));
}

/** States referenced by at least one transition — removing these would dangle an edge. */
export function referencedStates(form: StateMachineForm): Set<string> {
  const refs = new Set<string>();
  for (const t of form.transitions) {
    refs.add(t.from);
    refs.add(t.to);
  }
  return refs;
}

/**
 * Pure helper: derive a short manager-facing description for a state. Returns
 * the canonical description when the state is one of the 5 PRD §7 defaults (via
 * {@link canonicalStatusOf}); otherwise derives a summary from the number of
 * outgoing transitions (`${n} transisi keluar` when n > 0, else `Status kustom`).
 *
 * This is now the FALLBACK for {@link descriptionFor} when no saved per-state
 * description override is present. The wire carries `descriptions` INSIDE the
 * `stateMachine` object ({@link StateMachineForm.descriptions} →
 * {@link toStateMachineDto}); a saved non-empty override wins over this derived
 * copy. For a canonical status with no override, the properties panel surfaces
 * the richer {@link canonicalStatusOf} record (the status's sub-description AND
 * its consequence) instead of this short copy — this helper stays the SVG-card
 * fallback used when only the name is known (and the edit field's placeholder).
 */
export function describeState(form: StateMachineForm, name: string): string {
  const canonical = canonicalStatusOf(name);
  if (canonical) return canonical.description;
  const outgoing = form.transitions.filter((t) => t.from === name).length;
  if (outgoing > 0) return `${outgoing} transisi keluar`;
  return 'Status kustom';
}

/**
 * The effective description for a state: the saved per-state override when a
 * non-empty one is stored, otherwise the derived {@link describeState} fallback.
 * This is the single source of truth the canvas node card
 * (`formToFlow`/`withDescriptions`) and the properties panel's edit field
 * placeholder read. An empty/whitespace saved description ⇒ the key is absent
 * (`updateStateDescription` deletes empties) ⇒ the derived fallback wins.
 */
export function descriptionFor(form: StateMachineForm, name: string): string {
  const saved = form.descriptions?.[name];
  if (saved !== undefined && saved.trim().length > 0) return saved;
  return describeState(form, name);
}

/**
 * Set/trim a per-state description override. If the new value is empty/
 * whitespace, the key is DELETED (a cleared description field round-trips as an
 * absent key so {@link descriptionFor} falls back to the derived canonical copy
 * and the wire payload stays lean). Returns a new form — pure over the
 * {@link StateMachineForm} slice (the panel lifts this via `lift`, form-only,
 * so `graphSignature` excludes `descriptions` and the canvas never re-seeds).
 */
export function updateStateDescription(
  form: StateMachineForm,
  name: string,
  value: string,
): StateMachineForm {
  const descriptions = { ...(form.descriptions ?? {}) };
  if (value.trim().length === 0) {
    delete descriptions[name];
  } else {
    descriptions[name] = value;
  }
  return { ...form, descriptions };
}

// --- form mutation helpers (pure over the StateMachineForm slice) ------------

export function updateTransition(
  form: StateMachineForm,
  i: number,
  patch: Partial<{ from: string; to: string; actionLabel: string }>,
): StateMachineForm {
  const transitions = form.transitions.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
  return { ...form, transitions };
}

export function addTransition(form: StateMachineForm): StateMachineForm {
  // Seed a new edge from the first state to itself (or empty when no states yet)
  // so the dropdowns always carry a valid value; the manager adjusts from there.
  const firstState = form.states[0] ?? '';
  return {
    ...form,
    transitions: [...form.transitions, { from: firstState, to: firstState, actionLabel: '' }],
  };
}

export function removeTransition(form: StateMachineForm, i: number): StateMachineForm {
  return { ...form, transitions: form.transitions.filter((_, idx) => idx !== i) };
}

export function updateState(form: StateMachineForm, i: number, value: string): StateMachineForm {
  const states = form.states.map((s, idx) => (idx === i ? value : s));
  // Renaming a state must propagate to any transition that referenced the old
  // name, so a rename never leaves a dangling edge (the dropdowns would then
  // show the old value which is no longer in the states list). Spread preserves
  // the canvas-only `sourceSide`/`targetSide` (a rename must not drop the
  // manager-chosen handle routing — regression: the field-list rebuild used to
  // drop them, snapping a vertical edge back to L→R on rename). The positions
  // map is keyed by state name, so the renamed state keeps its canvas spot
  // (the entry is moved to the new key).
  const oldName = form.states[i];
  const transitions = form.transitions.map((t) => ({
    ...t,
    from: t.from === oldName ? value : t.from,
    to: t.to === oldName ? value : t.to,
  }));
  const positions = { ...form.positions };
  if (oldName !== value && positions[oldName] !== undefined) {
    positions[value] = positions[oldName];
    delete positions[oldName];
  }
  // The node-actions map is keyed by state name (mirrors `positions`), so a
  // rename moves the entry to the new key (the manager's node-level actions
  // follow the renamed status, not the old name).
  const nodeActions = { ...form.nodeActions };
  if (oldName !== value && nodeActions[oldName] !== undefined) {
    nodeActions[value] = nodeActions[oldName];
    delete nodeActions[oldName];
  }
  // The descriptions map is keyed by state name (mirrors `positions`/
  // `nodeActions`), so a rename moves the entry to the new key (the manager's
  // edited description follows the renamed status, not the old name).
  const descriptions = { ...(form.descriptions ?? {}) };
  if (oldName !== value && descriptions[oldName] !== undefined) {
    descriptions[value] = descriptions[oldName];
    delete descriptions[oldName];
  }
  // The explicit End-connections array carries state names (not a map, but the
  // same rename-cascade applies): a renamed source must update its entry so the
  // explicit End edge follows the renamed status (mirrors the nodeActions/
  // positions rename propagation).
  const endSources = form.endSources.map((s) => (s === oldName ? value : s));
  return { ...form, states, transitions, positions, nodeActions, descriptions, endSources };
}

export function addState(form: StateMachineForm): StateMachineForm {
  return { ...form, states: [...form.states, ''] };
}

export function removeState(form: StateMachineForm, i: number): StateMachineForm {
  const removedName = form.states[i];
  // Deleting a state must also drop its positions entry (the map is keyed by
  // state name), or the stale position would survive a rename-back / re-add
  // and snap a re-added node to the old spot. Transitions are NOT cascaded here
  // (the diagram's delete path owns the cascade; this helper is the form-only
  // slice used by the form-based editor in the wizard).
  const positions = { ...form.positions };
  delete positions[removedName];
  // Drop the node-actions entry too (the map is keyed by state name, mirrors
  // `positions`), or the stale actions would survive a re-add and silently
  // re-attach to a re-created status under the same name.
  const nodeActions = { ...form.nodeActions };
  delete nodeActions[removedName];
  // Drop the descriptions entry too (the map is keyed by state name, mirrors
  // `positions`/`nodeActions`), or the stale description would survive a
  // re-add and silently re-attach to a re-created status under the same name.
  const descriptions = { ...(form.descriptions ?? {}) };
  delete descriptions[removedName];
  // Drop the explicit End-connections entry too (the array carries state names,
  // mirrors the descriptions rename/delete cascade), or the stale connection
  // would survive a re-add and silently re-attach to a re-created status under
  // the same name — and the canvas would render an End edge to a removed state.
  const endSources = form.endSources.filter((s) => s !== removedName);
  return {
    ...form,
    states: form.states.filter((_, idx) => idx !== i),
    positions,
    nodeActions,
    descriptions,
    endSources,
  };
}

// --- graph signature (change detection for the re-seed / source-sync guards) ---

/**
 * A canonical graph-structure signature for change detection. Used by the
 * visual editor's re-seed guard ({@link StateMachineWorkflow}) and the designer
 * page's source-sync guard ({@link AlurStatusDesigner}) to distinguish an
 * EXTERNAL value change (post-save re-GET, prefill change) from a change WE
 * drove (an in-session edit), so a self-driven round-trip never re-seeds the
 * canvas (which would snap handle routing / positions back to default).
 *
 * Excludes `mode` (the canvas graph = `states`/`transitions` regardless of
 * mode; mode only toggles read-only). Includes a canonicalized `p` field for
 * positions — positions are now ON the form/wire (mirroring sides), so a
 * position change is an external change the guards must detect: a diagram
 * drag-stop (position change) is "our own change" (`lastEmitted` stamped before
 * `onChange` → the sync effect skips the re-seed → no snap), and a source
 * position edit re-seeds the canvas to the source positions. The position
 * entries are canonicalized (sorted by key) so the signature is order-
 * insensitive (the wire map is a `Record`, never an ordered map).
 *
 * The side canonicalization (undefined → default) is LOAD-BEARING: after a
 * save+re-GET, `toForm` merges non-default sides back from `edgeRoutingLayout`
 * (default edges get undefined), so the post-save signature equals the
 * pre-save signature → no spurious re-seed and the manager-chosen handles
 * survive in-session. The same holds for positions: the post-save round-trip
 * persists them exactly (non-sparse, order-insensitive signature).
 *
 * Excludes `nodeActions` (panel-only, NOT canvas-rendered — like `mode`): a
 * node-action edit must not re-seed the canvas, and an external nodeActions-
 * only change needs no re-seed (the panel reads `form.nodeActions` directly on
 * re-render). Excludes `descriptions` too (panel-only edit via `lift`, like
 * `nodeActions`): a description edit is form-only and must not re-seed the
 * canvas — the node card's `data.description` refreshes via the
 * `formToFlow`/`withDescriptions` memo recompute on form change instead.
 *
 * INCLUDES `terminalNodes` (canvas-rendered, unlike `nodeActions`): a marker
 * add/delete/reposition is a structural canvas change the guards must detect —
 * a source-view terminal edit re-seeds the canvas to the source terminalNodes,
 * and a panel/drop terminal edit (non-stamping — raw `onChange` → the sync
 * effect re-seeds) shows up as an external signature change. The drag path
 * stamps via `commit` (the dragged marker's new position flows through
 * `flowToGraph` → `terminalNodes` → this signature before `onChange`), so a
 * drag does NOT re-seed (the marker stays where dropped). Each terminal is
 * canonicalized to `'auto'` | `'hidden'` | `x,y` so the signature is stable
 * across equivalent serializations.
 *
 * INCLUDES `endSources` (canvas-rendered, like `terminalNodes`): an explicit
 * End connection add/delete is a structural canvas change the guards must
 * detect — a source-view endSources edit re-seeds the canvas, and the
 * `onConnect`-to-End / panel-delete paths (non-stamping — raw `onChange` → the
 * sync effect re-seeds) show up as an external signature change. The array is
 * canonicalized (sorted) so the signature is order-insensitive (the wire array
 * has no inherent order; a re-GET may echo a different order than the client
 * sent — the sorted signature stays stable across the round-trip).
 */
export function graphSignature(form: StateMachineForm): string {
  const canonTerminal = (v: TerminalNodesDto['start']): string =>
    v === 'auto' || v === 'hidden' ? v : `${v.x},${v.y}`;
  return JSON.stringify({
    s: form.states,
    t: form.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      actionLabel: t.actionLabel,
      sourceSide: t.sourceSide ?? DEFAULT_SOURCE_SIDE,
      targetSide: t.targetSide ?? DEFAULT_TARGET_SIDE,
    })),
    p: Object.entries(form.positions)
      .map(([k, v]) => `${k}:${v.x},${v.y}`)
      .sort(),
    tn: { start: canonTerminal(form.terminalNodes.start), end: canonTerminal(form.terminalNodes.end) },
    e: [...form.endSources].sort(),
  });
}
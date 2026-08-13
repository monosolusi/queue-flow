import {
  DEFAULT_STATE_MACHINE,
  type EdgeRoutingLayoutDto,
  type EdgeSide,
  type NodePositionsDto,
  type StateMachineDto,
  type StateTransitionDto,
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
}

/** The PRD §7 default graph prefilled into the editor's default mode. */
export function defaultStateMachineForm(): StateMachineForm {
  return {
    mode: 'default',
    states: [...DEFAULT_STATE_MACHINE.states],
    transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    positions: {},
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
): boolean {
  if (Object.keys(positions).length > 0) return false;
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
      }
    : {
        states: form.states,
        // Strip the canvas-only `sourceSide`/`targetSide` — they are NOT on the
        // wire {@link StateTransitionDto}; they travel in the separate
        // {@link EdgeRoutingLayoutDto} map (see {@link toEdgeRoutingLayoutDto}).
        transitions: form.transitions.map((t) => ({ from: t.from, to: t.to, actionLabel: t.actionLabel })),
      };
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
 * What each status of the standard (PRD §7) flow powers, in manager-facing
 * Indonesian. Keyed by the status names in {@link DEFAULT_STATE_MACHINE}; the
 * copy names the caller BUTTON (or the report metric) that stops working, never
 * the backend mechanism, because the reader is a non-technical store manager.
 */
const CANONICAL_STATE_CONSEQUENCES: Record<string, string> = {
  WAITING:
    'tiket baru dari kiosk selalu dibuat di status ini, jadi tanpa status ini tiket tidak pernah bisa dipanggil',
  CALLING: 'tombol "Panggil Berikutnya" di panel caller berhenti berfungsi',
  SERVING: 'tombol "Mulai Melayani" di panel caller berhenti berfungsi',
  SKIPPED: 'tombol "Lewati / Absen" dan "Panggil Ulang" di panel caller berhenti berfungsi',
  COMPLETED: 'tombol "Selesai Layan" berhenti berfungsi dan lama layanan tidak tercatat di laporan',
};

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
    .map((state) => ({ state, consequence: CANONICAL_STATE_CONSEQUENCES[state] ?? '' }));
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
 * Friendly Indonesian short descriptions for the 5 PRD §7 default states — the
 * canonical copy shown on the SVG state card and in the properties panel. Used
 * by {@link describeState} as the canonical lookup; custom states derive a
 * summary from their outgoing transitions instead (the wire contract carries
 * no description field, so this map is a CLIENT-SIDE derivation — never
 * serialized).
 */
export const CANONICAL_STATE_DESCRIPTIONS: Record<string, string> = {
  WAITING: 'Tiket menunggu dipanggil',
  CALLING: 'Sedang dipanggil ke counter',
  SERVING: 'Sedang dilayani',
  SKIPPED: 'Dilewati / absen',
  COMPLETED: 'Layanan selesai',
};

/**
 * Pure helper: derive a short manager-facing description for a state. Returns
 * the canonical description when the state is one of the 5 PRD §7 defaults;
 * otherwise derives a summary from the number of outgoing transitions
 * (`${n} transisi keluar` when n > 0, else `Status kustom`). The description is
 * a CLIENT-SIDE derivation only — it is never part of the wire form
 * ({@link StateMachineForm} carries only `mode`/`states`/`transitions`), so
 * adding it here changes no wire contract.
 */
export function describeState(form: StateMachineForm, name: string): string {
  const canonical = CANONICAL_STATE_DESCRIPTIONS[name];
  if (canonical) return canonical;
  const outgoing = form.transitions.filter((t) => t.from === name).length;
  if (outgoing > 0) return `${outgoing} transisi keluar`;
  return 'Status kustom';
}

/**
 * The transitions connected to a state — its "actions". A state is an empty
 * status label; the actions (caller-panel buttons) live on the TRANSITIONS
 * (edges) that enter/leave it. This helper is the single derivation the
 * properties panel reads to surface that model (manager feedback: adding a
 * state was confusing because its interactions with the ticket were
 * invisible — the panel only showed a name + a derived description + delete,
 * never the state's incoming/outgoing transitions). Pure over the form slice;
 * never serialized.
 */
export interface StateActions {
  /** Transitions whose `to` is this state — actions that ENTER it. */
  readonly incoming: readonly Transition[];
  /** Transitions whose `from` is this state — actions that LEAVE it. */
  readonly outgoing: readonly Transition[];
}

/**
 * Derive the transitions connected to a state — its "actions" — split by
 * direction. A state is just a status label; the actions (the buttons shown on
 * the caller panel) are set on the transitions that enter/leave it, and this
 * helper is the single derivation the properties panel reads to surface that
 * model. Pure over the form slice; never serialized. Order follows the form's
 * `transitions` array (stable across renders for an unchanged graph).
 */
export function stateActions(form: StateMachineForm, name: string): StateActions {
  const incoming = form.transitions.filter((t) => t.to === name);
  const outgoing = form.transitions.filter((t) => t.from === name);
  return { incoming, outgoing };
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
  return { ...form, states, transitions, positions };
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
  return { ...form, states: form.states.filter((_, idx) => idx !== i), positions };
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
 */
export function graphSignature(form: StateMachineForm): string {
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
  });
}
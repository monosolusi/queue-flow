import { describe, expect, it } from 'vitest';
import {
  flowToGraph,
  formToFlow,
  formToFlowWithMarkers,
  deriveTerminalMarkers,
  isTerminalNodeId,
  handleToSide,
  nextStateName,
  sideToHandle,
  withDescriptions,
  isDuplicateTransition,
  rejectionMessageForConnection,
  START_NODE_ID,
  END_NODE_ID,
  START_NODE_TYPE,
  END_NODE_TYPE,
  TERMINAL_EDGE_TYPE,
  HANDLE_IDS,
  DEFAULT_SOURCE_HANDLE,
  DEFAULT_TARGET_HANDLE,
  EDGE_ARROW_MARKER,
  type FlowEdge,
  type FlowNode,
} from './state-machine-flow';
import { autoLayout, defaultStateMachineForm, type StateMachineForm } from './state-machine';
import { DEFAULT_STATE_MACHINE } from '../api/types';
// Type-only: verifies the framework-free marker trick in the guard at the
// bottom of this file (tests may depend on `@xyflow/react`; the lib cannot).
import type { EdgeMarker } from '@xyflow/react';

describe('autoLayout', () => {
  it('is deterministic — same input yields same output', () => {
    const a = autoLayout(DEFAULT_STATE_MACHINE.states, DEFAULT_STATE_MACHINE.transitions);
    const b = autoLayout(DEFAULT_STATE_MACHINE.states, DEFAULT_STATE_MACHINE.transitions);
    expect(a).toEqual(b);
  });

  it('places the default 5-state graph left-to-right (x grows with rank)', () => {
    const pos = autoLayout(DEFAULT_STATE_MACHINE.states, DEFAULT_STATE_MACHINE.transitions);
    // WAITING is the sole source (no incoming edge) → rank 0.
    expect(pos.WAITING.x).toBe(0);
    // CALLING follows WAITING → rank 1.
    expect(pos.CALLING.x).toBeGreaterThan(pos.WAITING.x);
    // SERVING + SKIPPED follow CALLING → rank 2.
    expect(pos.SERVING.x).toBe(pos.SKIPPED.x);
    expect(pos.SERVING.x).toBeGreaterThan(pos.CALLING.x);
    // COMPLETED follows SERVING → rank 3.
    expect(pos.COMPLETED.x).toBeGreaterThan(pos.SERVING.x);
  });

  it('stacks nodes sharing a rank vertically by appearance order', () => {
    const pos = autoLayout(
      ['WAITING', 'CALLING', 'SKIPPED', 'SERVING'],
      [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'a' },
        { from: 'CALLING', to: 'SKIPPED', actionLabel: 'b' },
        { from: 'CALLING', to: 'SERVING', actionLabel: 'c' },
      ],
    );
    // SKIPPED precedes SERVING in the states array → lower y within rank 2.
    expect(pos.SKIPPED.y).toBeLessThan(pos.SERVING.y);
    expect(pos.SKIPPED.x).toBe(pos.SERVING.x);
  });

  it('puts pure-cycle nodes at rank 0 (unreachable from any source)', () => {
    const pos = autoLayout(['A', 'B'], [
      { from: 'A', to: 'B', actionLabel: 'a' },
      { from: 'B', to: 'A', actionLabel: 'b' },
    ]);
    // No source (both have incoming edges) → both keep rank 0.
    expect(pos.A.x).toBe(0);
    expect(pos.B.x).toBe(0);
  });

  it('handles an isolated node (no edges) at rank 0', () => {
    const pos = autoLayout(['LONE'], []);
    expect(pos.LONE).toEqual({ x: 0, y: 0 });
  });
});

describe('formToFlow', () => {
  it('derives nodes id=state-name + edges with stable ids', () => {
    const form = defaultStateMachineForm();
    const { nodes, edges } = formToFlow(form, {});
    expect(nodes.map((n) => n.id)).toEqual([...DEFAULT_STATE_MACHINE.states]);
    expect(nodes.every((n) => n.type === 'state' && n.data.name === n.id)).toBe(true);
    expect(edges).toHaveLength(DEFAULT_STATE_MACHINE.transitions.length);
    expect(edges[0].id).toBe('WAITING->CALLING#0');
    expect(edges[0].source).toBe('WAITING');
    expect(edges[0].target).toBe('CALLING');
    expect(edges[0].data.actionLabel).toBe('Panggil Berikutnya');
  });

  it('seeds every edge with the canonical L→R routing handles', () => {
    // A seed/re-seed edge (rebuilt from a wire Transition, which carries no
    // handle info) must get the default routing — out the right, into the left
    // — so the default graph still reads left-to-right. The handle ids MUST
    // match the `id` props on the StateNode's Handle elements exactly.
    const form = defaultStateMachineForm();
    const { edges } = formToFlow(form, {});
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.sourceHandle).toBe(DEFAULT_SOURCE_HANDLE);
      expect(e.targetHandle).toBe(DEFAULT_TARGET_HANDLE);
    }
    expect(DEFAULT_SOURCE_HANDLE).toBe(HANDLE_IDS.right);
    expect(DEFAULT_TARGET_HANDLE).toBe(HANDLE_IDS.left);
  });

  it('seeds handle routing from the form transition sides (redraw respects the source)', () => {
    // The form is the source of truth for handles now: a transition carrying
    // `sourceSide`/`targetSide` seeds the corresponding React Flow handles, so
    // a redraw always respects the source. A transition with no sides (absent)
    // gets the canonical L→R default. This is the core fix — the diagram redraws
    // according to the source sides, not an unclear default.
    const form: StateMachineForm = {
      mode: 'custom',
      states: [...DEFAULT_STATE_MACHINE.states],
      transitions: DEFAULT_STATE_MACHINE.transitions.map((t, i) =>
        i === 0
          ? { ...t, sourceSide: 'bottom' as const, targetSide: 'top' as const }
          : { ...t },
      ),
      positions: {},
    };
    const { edges } = formToFlow(form, {});
    const waitingCalling = edges.find((e) => e.source === 'WAITING' && e.target === 'CALLING')!;
    expect(waitingCalling.sourceHandle).toBe(HANDLE_IDS.bottom);
    expect(waitingCalling.targetHandle).toBe(HANDLE_IDS.top);
    // An edge with no sides falls back to the L→R default.
    const callingServing = edges.find((e) => e.source === 'CALLING' && e.target === 'SERVING')!;
    expect(callingServing.sourceHandle).toBe(DEFAULT_SOURCE_HANDLE);
    expect(callingServing.targetHandle).toBe(DEFAULT_TARGET_HANDLE);
  });

  it('seeds a default-routed edge (no sides) with the L→R handles', () => {
    // A transition with no sides (absent) → default L→R handles.
    const form = defaultStateMachineForm();
    const { edges } = formToFlow(form, {});
    for (const e of edges) {
      expect(e.sourceHandle).toBe(DEFAULT_SOURCE_HANDLE);
      expect(e.targetHandle).toBe(DEFAULT_TARGET_HANDLE);
    }
  });

  it('supports an asymmetric edge (sourceSide set, targetSide absent)', () => {
    // Only the source side is customized; the target falls back to the default.
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', sourceSide: 'bottom' }],
      positions: {},
    };
    const { edges } = formToFlow(form, {});
    expect(edges[0].sourceHandle).toBe(HANDLE_IDS.bottom);
    expect(edges[0].targetHandle).toBe(DEFAULT_TARGET_HANDLE);
  });

  it('exposes four typeless handle ids — one per side', () => {
    // The manager can draw an edge in any direction (down/up/left/right) with
    // one TYPELESS handle per side — a `source`-typed handle that, under
    // ConnectionMode.Loose, both STARTS and RECEIVES a connection. Pinning the
    // full set guards against a regression that drops a side or re-introduces
    // separate source/target handles.
    const ids = new Set(Object.values(HANDLE_IDS));
    expect(ids.size).toBe(4);
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(HANDLE_IDS[side]).toBe(side);
    }
  });

  it('reuses provided positions for surviving names and auto-layouts the rest', () => {
    const form = defaultStateMachineForm();
    const positions = { WAITING: { x: 10, y: 20 } };
    const { nodes } = formToFlow(form, positions);
    const waiting = nodes.find((n) => n.id === 'WAITING')!;
    expect(waiting.position).toEqual({ x: 10, y: 20 });
    // CALLING was not provided → falls back to autoLayout.
    const calling = nodes.find((n) => n.id === 'CALLING')!;
    expect(calling.position.x).toBeGreaterThan(0);
  });

  it('prefers form.positions over the provided positions arg (save+re-GET round-trip)', () => {
    // Position priority: `value.positions[name]` → `positions` arg (oldPositions)
    // → `auto[name]` → `{0,0}`. A form that carries saved positions (from a
    // re-GET) MUST win over the stale oldPositions arg so a save+re-GET does not
    // snap the nodes back to their pre-save locations.
    const form: StateMachineForm = {
      ...defaultStateMachineForm(),
      positions: { WAITING: { x: 99, y: 88 } },
    };
    const positions = { WAITING: { x: 10, y: 20 } }; // stale oldPositions
    const { nodes } = formToFlow(form, positions);
    const waiting = nodes.find((n) => n.id === 'WAITING')!;
    expect(waiting.position).toEqual({ x: 99, y: 88 });
  });

  it('stamps an arrow markerEnd on every edge so direction reads', () => {
    // Manager feedback: "garis tidak ada panah, jadi membingungkan". Every
    // transition edge — including the default graph's bottom-up SKIPPED →
    // CALLING back-edge — carries a closed-arrow `markerEnd` at the target end
    // so the edge reads "from → to". The `type` literal `'arrowclosed'` keeps
    // the lib framework-free (no `MarkerType` import); `EDGE_ARROW_MARKER` is
    // the single source of truth stamped here, in `onConnect`, and in
    // `addTransitionButton`.
    const form = defaultStateMachineForm();
    const { edges } = formToFlow(form, {});
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.markerEnd).toEqual(EDGE_ARROW_MARKER);
    }
    expect(EDGE_ARROW_MARKER.type).toBe('arrowclosed');
  });
});

describe('flowToGraph', () => {
  it('round-trips states + transitions through formToFlow', () => {
    const form = defaultStateMachineForm();
    const { nodes, edges } = formToFlow(form, {});
    const { states, transitions } = flowToGraph(nodes, edges);
    expect(states).toEqual([...DEFAULT_STATE_MACHINE.states]);
    // The structural fields round-trip; `flowToGraph` now also captures the
    // default sides (right→left) from the default handles `formToFlow` seeds.
    expect(transitions.map(({ from, to, actionLabel }) => ({ from, to, actionLabel }))).toEqual(
      DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    );
    for (const t of transitions) {
      expect(t.sourceSide).toBe('right');
      expect(t.targetSide).toBe('left');
    }
  });

  it('captures node positions into the positions map (drag → form → wire)', () => {
    // `flowToGraph` returns a `positions` map keyed by `n.data.name → n.position`
    // so a manager-dragged node's new location flows through `commit` → `onChange`
    // → save into the `nodePositions` wire field.
    const form = defaultStateMachineForm();
    const { nodes, edges } = formToFlow(form, {});
    // Move WAITING to a known position.
    const moved = nodes.map((n) =>
      n.id === 'WAITING' ? { ...n, position: { x: 42, y: 7 } } : n,
    );
    const { positions } = flowToGraph(moved, edges);
    expect(positions.WAITING).toEqual({ x: 42, y: 7 });
    // The other nodes keep their autoLayout positions.
    expect(positions.CALLING).toBeDefined();
  });

  it('preserves node array order as the states order', () => {
    const nodes = [
      { id: 'C', type: 'state', position: { x: 0, y: 0 }, data: { name: 'C', description: '' } },
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
    ];
    const { states } = flowToGraph(nodes, []);
    expect(states).toEqual(['C', 'A']);
  });

  it('captures sourceSide/targetSide from the edge handles (form is source of truth)', () => {
    // The form is the source of truth for handles now: `flowToGraph` captures
    // the connection sides from the edge's `sourceHandle`/`targetHandle` so a
    // manager-drawn edge's chosen side flows back into the form (via `commit` →
    // `onChange`). The sides are on the form {@link Transition}, NOT on the
    // wire {@link StateTransitionDto} — `toStateMachineDto` strips them at the
    // wire boundary (see state-machine.test.ts). An edge with a vertical
    // routing → `sourceSide: 'bottom'`, `targetSide: 'top'`.
    const nodes = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
      { id: 'B', type: 'state', position: { x: 0, y: 0 }, data: { name: 'B', description: '' } },
    ];
    const edges: import('./state-machine-flow').FlowEdge[] = [
      {
        id: 'A->B#0',
        source: 'A',
        target: 'B',
        type: 'transition',
        data: { actionLabel: 'go' },
        sourceHandle: HANDLE_IDS.bottom,
        targetHandle: HANDLE_IDS.top,
      },
    ];
    const { transitions } = flowToGraph(nodes, edges);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].sourceSide).toBe('bottom');
    expect(transitions[0].targetSide).toBe('top');
    // The canvas-only handle ids + markerEnd are NOT captured (never on the
    // form Transition); only the side is derived.
    expect((transitions[0] as unknown as Record<string, unknown>).sourceHandle).toBeUndefined();
    expect((transitions[0] as unknown as Record<string, unknown>).markerEnd).toBeUndefined();
  });

  it('captures default sides for a default-routed edge (right→left)', () => {
    // An edge with the default L→R handles → `sourceSide: 'right'`,
    // `targetSide: 'left'` (the canonicalization the form uses to omit default
    // entries from the sparse wire map).
    const nodes = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
      { id: 'B', type: 'state', position: { x: 0, y: 0 }, data: { name: 'B', description: '' } },
    ];
    const edges: FlowEdge[] = [
      {
        id: 'A->B#0',
        source: 'A',
        target: 'B',
        type: 'transition',
        data: { actionLabel: 'go' },
        sourceHandle: DEFAULT_SOURCE_HANDLE,
        targetHandle: DEFAULT_TARGET_HANDLE,
      },
    ];
    const { transitions } = flowToGraph(nodes, edges);
    expect(transitions[0].sourceSide).toBe('right');
    expect(transitions[0].targetSide).toBe('left');
  });

  it('drops markerEnd — the arrow never reaches the form/wire', () => {
    // `markerEnd` is CANVAS-ONLY (like the handle ids), so `flowToGraph` never
    // surfaces it on the form Transition. The wire `toStateMachineDto` further
    // strips the sides, so the wire `StateTransitionDto` is exactly
    // `{ from, to, actionLabel }` (see state-machine.test.ts).
    const nodes = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
      { id: 'B', type: 'state', position: { x: 0, y: 0 }, data: { name: 'B', description: '' } },
    ];
    const edges: FlowEdge[] = [
      {
        id: 'A->B#0',
        source: 'A',
        target: 'B',
        type: 'transition',
        data: { actionLabel: 'go' },
        sourceHandle: HANDLE_IDS.bottom,
        targetHandle: HANDLE_IDS.top,
        markerEnd: EDGE_ARROW_MARKER,
      },
    ];
    const { transitions } = flowToGraph(nodes, edges);
    expect(transitions).toHaveLength(1);
    expect((transitions[0] as unknown as Record<string, unknown>).markerEnd).toBeUndefined();
    // Sanity: the marker config object itself is still the arrow (the drop is
    // on `flowToGraph`'s output, not on the input marker).
    expect(EDGE_ARROW_MARKER.type).toBe('arrowclosed');
  });

  it('drops data.description — the client-side description never reaches the wire', () => {
    // The description is a CANVAS-ONLY field on FlowNodeData (computed by
    // `formToFlow`/`withDescriptions` for the SVG card). `flowToGraph` reads
    // only `data.name` — the description must NOT leak into the wire
    // `StateMachineForm.states` (a string array) or anywhere else. An explicit
    // keys assertion on the states entry guards the wire contract: states is a
    // `string[]`, so this is a type-level guarantee, but the test also confirms
    // `flowToGraph` never surfaces description in any output key.
    const nodes: import('./state-machine-flow').FlowNode[] = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: 'Tiket menunggu dipanggil' } },
      { id: 'B', type: 'state', position: { x: 0, y: 0 }, data: { name: 'B', description: 'Status kustom' } },
    ];
    const result = flowToGraph(nodes, []);
    expect(result.states).toEqual(['A', 'B']);
    // The states array is `string[]` — no object carries the description.
    expect(result.states.every((s) => typeof s === 'string')).toBe(true);
    // The output shape is exactly `{ states, transitions, positions }` — no
    // `description` key (the client-side description never reaches the form).
    expect(Object.keys(result).sort()).toEqual(['positions', 'states', 'transitions']);
  });

  it('formToFlow stamps data.description from describeState on every node', () => {
    // formToFlow is the construction site for the canvas model; it computes the
    // client-side description so the StateNode card reads `data.description`
    // with no form dependency (ISP — the context stays behavior-only).
    const form = defaultStateMachineForm();
    const { nodes } = formToFlow(form, {});
    const waiting = nodes.find((n) => n.id === 'WAITING');
    expect(waiting?.data.description).toBe('Tiket menunggu dipanggil');
    const calling = nodes.find((n) => n.id === 'CALLING');
    expect(calling?.data.description).toBe('Sedang dipanggil ke counter');
  });

  it('withDescriptions refreshes descriptions from the live form after a mutation', () => {
    // A mutation that changes a state's outgoing-transition count (e.g.
    // deleting a transition) must refresh the affected node cards' descriptions.
    // `withDescriptions` is the pure helper `commit` calls to re-stamp every
    // node's `data.description` from the next form.
    const form: import('./state-machine').StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'ONHOLD', 'CALLING'],
      transitions: [
        { from: 'ONHOLD', to: 'WAITING', actionLabel: 'Kembali' },
        { from: 'ONHOLD', to: 'CALLING', actionLabel: 'Lanjut' },
      ],
      positions: {},
    };
    const nodes: import('./state-machine-flow').FlowNode[] = [
      { id: 'WAITING', type: 'state', position: { x: 0, y: 0 }, data: { name: 'WAITING', description: '' } },
      { id: 'ONHOLD', type: 'state', position: { x: 0, y: 0 }, data: { name: 'ONHOLD', description: '' } },
      { id: 'CALLING', type: 'state', position: { x: 0, y: 0 }, data: { name: 'CALLING', description: '' } },
    ];
    const refreshed = withDescriptions(nodes, form);
    // ONHOLD has 2 outgoing transitions → derived summary.
    expect(refreshed.find((n) => n.id === 'ONHOLD')?.data.description).toBe('2 transisi keluar');
    // WAITING is canonical → canonical description wins.
    expect(refreshed.find((n) => n.id === 'WAITING')?.data.description).toBe('Tiket menunggu dipanggil');
    // CALLING is canonical → canonical description wins.
    expect(refreshed.find((n) => n.id === 'CALLING')?.data.description).toBe('Sedang dipanggil ke counter');
  });
});

describe('nextStateName', () => {
  it('produces STATUS_1 on an empty graph', () => {
    expect(nextStateName([])).toBe('STATUS_1');
  });

  it('avoids collisions with existing names', () => {
    expect(nextStateName(['STATUS_1'])).toBe('STATUS_2');
    expect(nextStateName(['STATUS_1', 'STATUS_2'])).toBe('STATUS_3');
  });

  it('avoids the 5 canonical names', () => {
    // A graph with all 5 canonicals + STATUS_1 must skip to STATUS_2.
    expect(nextStateName([...DEFAULT_STATE_MACHINE.states, 'STATUS_1'])).toBe('STATUS_2');
  });

  it('skips a canonical name when it would collide', () => {
    // WAITING etc. are canonical; STATUS_1 is free.
    expect(nextStateName(['WAITING', 'CALLING'])).toBe('STATUS_1');
  });
});

describe('isDuplicateTransition', () => {
  it('returns true when an edge source→target already exists', () => {
    const edges: FlowEdge[] = [
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go' } },
    ];
    expect(isDuplicateTransition(edges, 'A', 'B')).toBe(true);
    // Direction matters: B→A is a different edge (not a duplicate of A→B).
    expect(isDuplicateTransition(edges, 'B', 'A')).toBe(false);
    // A→C does not exist.
    expect(isDuplicateTransition(edges, 'A', 'C')).toBe(false);
  });

  it('returns false on an empty edge list', () => {
    expect(isDuplicateTransition([], 'A', 'B')).toBe(false);
  });

  it('detects a self-edge duplicate', () => {
    const edges: FlowEdge[] = [
      { id: 'A->A#0', source: 'A', target: 'A', type: 'transition', data: { actionLabel: 'loop' } },
    ];
    expect(isDuplicateTransition(edges, 'A', 'A')).toBe(true);
  });
});

describe('deriveTerminalMarkers (canvas-only Start/End markers)', () => {
  it('emits a Start marker + Start→source edge for the default graph (WAITING is the sole source)', () => {
    // The PRD §7 default graph: WAITING is the only in-degree-0 state
    // (CALLING has WAITING→CALLING and SKIPPED→CALLING incoming; SERVING has
    // CALLING→SERVING; SKIPPED has CALLING→SKIPPED; COMPLETED has
    // SERVING→COMPLETED). So the Start marker points at WAITING only.
    const { nodes, edges } = deriveTerminalMarkers(
      [...DEFAULT_STATE_MACHINE.states],
      DEFAULT_STATE_MACHINE.transitions,
      // Feed real positions so the marker x is offset from the leftmost node.
      { WAITING: { x: 0, y: 0 }, CALLING: { x: 240, y: 0 }, SERVING: { x: 480, y: 0 }, SKIPPED: { x: 480, y: 120 }, COMPLETED: { x: 720, y: 0 } },
    );
    const start = nodes.find((n) => n.id === START_NODE_ID);
    expect(start).toBeDefined();
    expect(start?.type).toBe(START_NODE_TYPE);
    expect(start?.draggable).toBe(false);
    expect(start?.selectable).toBe(true);
    expect(start?.data.name).toBe(START_NODE_ID);
    // One Start→WAITING terminal edge.
    const startEdges = edges.filter((e) => e.source === START_NODE_ID);
    expect(startEdges).toHaveLength(1);
    expect(startEdges[0].target).toBe('WAITING');
    expect(startEdges[0].type).toBe(TERMINAL_EDGE_TYPE);
    expect(startEdges[0].data.actionLabel).toBe('');
    expect(startEdges[0].markerEnd).toEqual(EDGE_ARROW_MARKER);
    expect(startEdges[0].sourceHandle).toBe(HANDLE_IDS.right);
    expect(startEdges[0].targetHandle).toBe(HANDLE_IDS.left);
  });

  it('emits an End marker + sink→End edge for the default graph (COMPLETED is the sole sink)', () => {
    // COMPLETED is the only out-degree-0 state in the default graph.
    const { nodes, edges } = deriveTerminalMarkers(
      [...DEFAULT_STATE_MACHINE.states],
      DEFAULT_STATE_MACHINE.transitions,
      { WAITING: { x: 0, y: 0 }, CALLING: { x: 240, y: 0 }, SERVING: { x: 480, y: 0 }, SKIPPED: { x: 480, y: 120 }, COMPLETED: { x: 720, y: 0 } },
    );
    const end = nodes.find((n) => n.id === END_NODE_ID);
    expect(end).toBeDefined();
    expect(end?.type).toBe(END_NODE_TYPE);
    expect(end?.draggable).toBe(false);
    expect(end?.data.name).toBe(END_NODE_ID);
    const endEdges = edges.filter((e) => e.target === END_NODE_ID);
    expect(endEdges).toHaveLength(1);
    expect(endEdges[0].source).toBe('COMPLETED');
    expect(endEdges[0].type).toBe(TERMINAL_EDGE_TYPE);
  });

  it('emits no markers for a pure cycle (every state has an incoming edge)', () => {
    // A↔B: both A and B have incoming edges → no sources, no sinks → no markers.
    const { nodes, edges } = deriveTerminalMarkers(
      ['A', 'B'],
      [
        { from: 'A', to: 'B', actionLabel: 'a' },
        { from: 'B', to: 'A', actionLabel: 'b' },
      ],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
    );
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('emits no markers for an empty state list', () => {
    const { nodes, edges } = deriveTerminalMarkers([], [], {});
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('emits Start only (no End) when the graph has a source but no sink', () => {
    // A→B→A is a cycle (no source/sink). Construct a graph with a source but no
    // sink: A→B, B→A would be a cycle. Instead: A→B, B→B (self-loop). A has
    // in-degree 0 (source); B has out-degree 1 (B→B) so B is NOT a sink; A has
    // out-degree 1 so A is not a sink either. No sinks → no End marker.
    const { nodes, edges } = deriveTerminalMarkers(
      ['A', 'B'],
      [
        { from: 'A', to: 'B', actionLabel: 'a' },
        { from: 'B', to: 'B', actionLabel: 'loop' },
      ],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
    );
    const start = nodes.find((n) => n.id === START_NODE_ID);
    expect(start).toBeDefined();
    const end = nodes.find((n) => n.id === END_NODE_ID);
    expect(end).toBeUndefined();
    // Only the Start→A terminal edge (no sink→End edges).
    expect(edges.every((e) => e.target !== END_NODE_ID)).toBe(true);
  });

  it('places Start.x left of min real x and End.x right of max real x', () => {
    const real = { A: { x: 100, y: 0 }, B: { x: 300, y: 0 } };
    const { nodes } = deriveTerminalMarkers(['A', 'B'], [{ from: 'A', to: 'B', actionLabel: 'a' }], real);
    const start = nodes.find((n) => n.id === START_NODE_ID)!;
    const end = nodes.find((n) => n.id === END_NODE_ID)!;
    // TERMINAL_SPACING = 240 (matches autoLayout's X_SPACING).
    expect(start.position.x).toBe(100 - 240);
    expect(end.position.x).toBe(300 + 240);
    // yCenter = (0 + 0) / 2 = 0.
    expect(start.position.y).toBe(0);
    expect(end.position.y).toBe(0);
  });

  it('defaults bounds to 0 when realPositions is empty (no NaN)', () => {
    // A single isolated state (no edges) is both a source AND a sink, so both
    // markers emit. realPositions empty → minX/maxX/minY/maxY default to 0.
    const { nodes } = deriveTerminalMarkers(['LONE'], [], {});
    const start = nodes.find((n) => n.id === START_NODE_ID)!;
    const end = nodes.find((n) => n.id === END_NODE_ID)!;
    expect(start.position).toEqual({ x: 0 - 240, y: 0 });
    expect(end.position).toEqual({ x: 0 + 240, y: 0 });
  });

  it('ignores transitions referencing a state not in the schema (defensive)', () => {
    // A transition A→C where C is not in `states` must not count toward A's
    // out-degree (so A stays a source) nor seed any marker for C.
    const { nodes, edges } = deriveTerminalMarkers(
      ['A'],
      [{ from: 'A', to: 'C', actionLabel: 'x' }],
      { A: { x: 0, y: 0 } },
    );
    // A has no in-degree (the A→C edge is ignored) → A is a source → Start emits.
    const start = nodes.find((n) => n.id === START_NODE_ID);
    expect(start).toBeDefined();
    // A also has no VALID out-degree (A→C ignored) → A is a sink → End emits.
    const end = nodes.find((n) => n.id === END_NODE_ID);
    expect(end).toBeDefined();
    // No terminal edge references C.
    expect(edges.every((e) => e.source !== 'C' && e.target !== 'C')).toBe(true);
  });
});

describe('formToFlowWithMarkers', () => {
  it('returns state nodes + Start/End markers for the default graph (7 nodes, 7 edges)', () => {
    const form = defaultStateMachineForm();
    const { nodes, edges } = formToFlowWithMarkers(form, {});
    // 5 state nodes + 1 Start + 1 End = 7.
    expect(nodes).toHaveLength(DEFAULT_STATE_MACHINE.states.length + 2);
    expect(nodes.filter((n) => n.type === 'state')).toHaveLength(5);
    expect(nodes.find((n) => n.id === START_NODE_ID)?.type).toBe(START_NODE_TYPE);
    expect(nodes.find((n) => n.id === END_NODE_ID)?.type).toBe(END_NODE_TYPE);
    // 5 transition edges + 1 Start→WAITING + 1 COMPLETED→End = 7.
    expect(edges).toHaveLength(DEFAULT_STATE_MACHINE.transitions.length + 2);
    expect(edges.filter((e) => e.type === 'transition')).toHaveLength(5);
    expect(edges.filter((e) => e.type === TERMINAL_EDGE_TYPE)).toHaveLength(2);
  });

  it('round-trips clean through flowToGraph (markers filtered, form intact)', () => {
    // flowToGraph MUST filter the terminal nodes/edges so the form/wire/XML
    // never see __start/__end. The round-tripped form has 5 states + 5
    // transitions (the markers are dropped).
    const form = defaultStateMachineForm();
    const { nodes, edges } = formToFlowWithMarkers(form, {});
    const { states, transitions } = flowToGraph(nodes, edges);
    expect(states).toEqual([...DEFAULT_STATE_MACHINE.states]);
    expect(transitions.map(({ from, to, actionLabel }) => ({ from, to, actionLabel }))).toEqual(
      DEFAULT_STATE_MACHINE.transitions.map((t) => ({ from: t.from, to: t.to, actionLabel: t.actionLabel })),
    );
  });

  it('isTerminalNodeId identifies the reserved marker ids', () => {
    expect(isTerminalNodeId(START_NODE_ID)).toBe(true);
    expect(isTerminalNodeId(END_NODE_ID)).toBe(true);
    expect(isTerminalNodeId('WAITING')).toBe(false);
    expect(isTerminalNodeId('__other')).toBe(false);
  });
});

describe('flowToGraph filters terminal markers', () => {
  it('excludes type:"start"/type:"end" nodes from states/positions', () => {
    // Feed a node list with real state nodes + a Start + an End marker, and an
    // edge list with a real transition + a terminal edge. The terminal nodes/
    // edges MUST be filtered from states/positions/transitions.
    const nodes: FlowNode[] = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
      { id: 'B', type: 'state', position: { x: 240, y: 0 }, data: { name: 'B', description: '' } },
      { id: START_NODE_ID, type: START_NODE_TYPE, position: { x: -240, y: 0 }, data: { name: START_NODE_ID, description: '' } },
      { id: END_NODE_ID, type: END_NODE_TYPE, position: { x: 480, y: 0 }, data: { name: END_NODE_ID, description: '' } },
    ];
    const edges: FlowEdge[] = [
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go' } },
      { id: `${START_NODE_ID}->A`, source: START_NODE_ID, target: 'A', type: TERMINAL_EDGE_TYPE, data: { actionLabel: '' } },
      { id: `B->${END_NODE_ID}`, source: 'B', target: END_NODE_ID, type: TERMINAL_EDGE_TYPE, data: { actionLabel: '' } },
    ];
    const { states, transitions, positions } = flowToGraph(nodes, edges);
    expect(states).toEqual(['A', 'B']);
    expect(Object.keys(positions).sort()).toEqual(['A', 'B']);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from).toBe('A');
    expect(transitions[0].to).toBe('B');
  });
});

describe('withDescriptions skips non-state nodes', () => {
  it('leaves a terminal marker node untouched (description stays empty)', () => {
    // A Start marker passed through withDescriptions keeps its `description: ''`
    // — `describeState(form, '__start')` would return a spurious summary, so the
    // helper skips non-state nodes entirely.
    const form = defaultStateMachineForm();
    const nodes: FlowNode[] = [
      { id: START_NODE_ID, type: START_NODE_TYPE, position: { x: 0, y: 0 }, data: { name: START_NODE_ID, description: '' } },
      { id: 'WAITING', type: 'state', position: { x: 0, y: 0 }, data: { name: 'WAITING', description: '' } },
    ];
    const refreshed = withDescriptions(nodes, form);
    expect(refreshed.find((n) => n.id === START_NODE_ID)?.data.description).toBe('');
    // The state node IS refreshed.
    expect(refreshed.find((n) => n.id === 'WAITING')?.data.description).toBe('Tiket menunggu dipanggil');
  });
});

describe('isDuplicateTransition excludes terminal edges', () => {
  it('does not count a terminal edge as a duplicate of a real pair', () => {
    // A terminal edge __start→A shares no real `from`/`to` pair, but the
    // defensive `type !== 'terminal'` filter keeps the predicate honest when the
    // full canvas edge list (which now includes the markers) is passed.
    const edges: FlowEdge[] = [
      { id: `${START_NODE_ID}->A`, source: START_NODE_ID, target: 'A', type: TERMINAL_EDGE_TYPE, data: { actionLabel: '' } },
      { id: `A->${END_NODE_ID}`, source: 'A', target: END_NODE_ID, type: TERMINAL_EDGE_TYPE, data: { actionLabel: '' } },
    ];
    // No real A→A edge exists; the terminal edges do NOT make it a duplicate.
    expect(isDuplicateTransition(edges, 'A', 'A')).toBe(false);
    // A real transition edge IS a duplicate.
    const withReal: FlowEdge[] = [
      ...edges,
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go' } },
    ];
    expect(isDuplicateTransition(withReal, 'A', 'B')).toBe(true);
  });
});

describe('rejectionMessageForConnection', () => {
  it('names the duplicate pair when the connection was rejected', () => {
    // The default graph's bottom-up SKIPPED → CALLING back-edge, re-drawn, is
    // the manager's "tidak bisa tarik garis dari bottom ke up, tidak ada error"
    // scenario: `isValidConnection` returns false (duplicate), `onConnectEnd`
    // surfaces this message so the silent no-op becomes a visible reason.
    const edges: FlowEdge[] = [
      { id: 'SKIPPED->CALLING#0', source: 'SKIPPED', target: 'CALLING', type: 'transition', data: { actionLabel: 'Panggil Ulang' } },
    ];
    expect(
      rejectionMessageForConnection(
        { isValid: false, fromId: 'SKIPPED', toId: 'CALLING' },
        edges,
      ),
    ).toBe('Transisi dari SKIPPED ke CALLING sudah ada.');
  });

  it('returns null when the connection was valid', () => {
    // A successful connection (isValid: true) needs no feedback.
    const edges: FlowEdge[] = [];
    expect(
      rejectionMessageForConnection(
        { isValid: true, fromId: 'A', toId: 'B' },
        edges,
      ),
    ).toBeNull();
  });

  it('returns null when isValid is null (no valid target handle)', () => {
    // React Flow's own invalid-handle case surfaces `isValid: null` (not
    // `false`); our `isValidConnection` is not consulted on that path, so no
    // duplicate-rejection message is warranted.
    const edges: FlowEdge[] = [];
    expect(
      rejectionMessageForConnection(
        { isValid: null, fromId: 'A', toId: 'B' },
        edges,
      ),
    ).toBeNull();
  });

  it('returns null when there is no target node (dropped in empty space)', () => {
    // The manager dropped the in-progress connection in empty canvas space (no
    // target node). Nothing was attempted against a target — no toast.
    const edges: FlowEdge[] = [];
    expect(
      rejectionMessageForConnection(
        { isValid: false, fromId: 'A', toId: null },
        edges,
      ),
    ).toBeNull();
  });

  it('falls back to a generic message when rejected but not a known duplicate', () => {
    // Defensive: if a future `isValidConnection` rejection reason is added,
    // `isValid === false` no longer implies a duplicate. The predicate is
    // re-checked, so an unknown rejection surfaces a generic message instead of
    // a wrong "sudah ada" claim.
    const edges: FlowEdge[] = [
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go' } },
    ];
    expect(
      rejectionMessageForConnection(
        { isValid: false, fromId: 'X', toId: 'Y' },
        edges,
      ),
    ).toBe('Transisi tidak dapat dibuat.');
  });
});

// Compile-time guard: verifies the framework-free trick — `EDGE_ARROW_MARKER`
// (the lib's `FlowEdgeMarker`, with `type: 'arrowclosed'`) must satisfy React
// Flow's `EdgeMarker` so `FlowEdge` stays structurally assignable to `Edge`
// with no `as` cast. Only a test that imports the framework type can catch a
// future widening of `FlowEdgeMarker.type` past `${MarkerType}` — the lib build
// (no `@xyflow/react` import) cannot. If this assignment ever needs `as`, the
// lib is no longer pure-assignable and this guard fails tsc.
const _markerTypeGuard: EdgeMarker = EDGE_ARROW_MARKER;
void _markerTypeGuard;

describe('side ↔ handle mappers', () => {
  it('sideToHandle round-trips all 4 sides (one typeless handle per side)', () => {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(sideToHandle(side)).toBe(side);
    }
  });

  it('handleToSide extracts the side from a handle id', () => {
    // The bare side strings round-trip cleanly.
    expect(handleToSide('top')).toBe('top');
    expect(handleToSide('bottom')).toBe('bottom');
    expect(handleToSide('right')).toBe('right');
    expect(handleToSide('left')).toBe('left');
    // Also backward-compatible with legacy `'-source'`/`'-target'` ids: the
    // mapper takes the segment before the first dash, so they still resolve.
    expect(handleToSide('top-source')).toBe('top');
    expect(handleToSide('bottom-target')).toBe('bottom');
  });

  it('handleToSide returns undefined for a missing/unknown handle', () => {
    expect(handleToSide(undefined)).toBeUndefined();
    expect(handleToSide('garbage')).toBeUndefined();
    expect(handleToSide('')).toBeUndefined();
  });

  it('side ↔ handle round-trips through formToFlow/flowToGraph', () => {
    // A transition with sourceSide 'bottom' / targetSide 'top' → edges with
    // bottom-source / top-target handles → flowToGraph captures 'bottom'/'top'.
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', sourceSide: 'bottom', targetSide: 'top' }],
      positions: {},
    };
    const { nodes, edges } = formToFlow(form, {});
    const { transitions } = flowToGraph(nodes, edges);
    expect(transitions[0].sourceSide).toBe('bottom');
    expect(transitions[0].targetSide).toBe('top');
  });
});

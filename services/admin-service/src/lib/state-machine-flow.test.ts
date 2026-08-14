import { describe, expect, it } from 'vitest';
import {
  flowToGraph,
  formToFlow,
  formToFlowWithMarkers,
  decideConnectEnd,
  deriveTerminalMarkers,
  getSelfLoopPath,
  hasEndSource,
  SELF_LOOP_RADIUS,
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
import { DEFAULT_STATE_MACHINE, DEFAULT_TERMINAL_NODES } from '../api/types';
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
        { from: 'WAITING', to: 'CALLING', actionLabel: 'a', action: 'UPDATE_STATUS' },
        { from: 'CALLING', to: 'SKIPPED', actionLabel: 'b', action: 'UPDATE_STATUS' },
        { from: 'CALLING', to: 'SERVING', actionLabel: 'c', action: 'UPDATE_STATUS' },
      ],
    );
    // SKIPPED precedes SERVING in the states array → lower y within rank 2.
    expect(pos.SKIPPED.y).toBeLessThan(pos.SERVING.y);
    expect(pos.SKIPPED.x).toBe(pos.SERVING.x);
  });

  it('puts pure-cycle nodes at rank 0 (unreachable from any source)', () => {
    const pos = autoLayout(['A', 'B'], [
      { from: 'A', to: 'B', actionLabel: 'a', action: 'UPDATE_STATUS' },
      { from: 'B', to: 'A', actionLabel: 'b', action: 'UPDATE_STATUS' },
    ]);
    // No source (both have incoming edges) → both keep rank 0.
    expect(pos.A.x).toBe(0);
    expect(pos.B.x).toBe(0);
  });

  it('handles an isolated node (no edges) at rank 0', () => {
    const pos = autoLayout(['LONE'], []);
    expect(pos.LONE).toEqual({ x: 0, y: 0 });
  });

  it('ignores a SELF-LOOP when ranking (a status pointing at itself is still a source)', () => {
    // Same root cause as the Start/End marker fix: a self-loop counted toward
    // in-degree, so a self-loop on the entry status left the graph with NO
    // relaxation seed and every node collapsed onto rank 0 (all stacked at
    // x = 0). A self-loop is flow that returns to the same status — it neither
    // ranks the status after itself nor costs it its source role.
    const pos = autoLayout(['A', 'B'], [
      { from: 'A', to: 'B', actionLabel: 'a', action: 'UPDATE_STATUS' },
      { from: 'A', to: 'A', actionLabel: 'loop', action: 'UPDATE_STATUS' },
    ]);
    expect(pos.A.x).toBe(0);
    expect(pos.B.x).toBeGreaterThan(pos.A.x);
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS', sourceSide: 'bottom' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: { WAITING: { x: 99, y: 88 } }, nodeActions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
    // The structural fields round-trip — including each edge's `action`, which
    // lives on the canvas edge's `data` and so must survive a canvas commit;
    // `flowToGraph` now also captures the default sides (right→left) from the
    // default handles `formToFlow` seeds.
    expect(
      transitions.map(({ from, to, actionLabel, action }) => ({ from, to, actionLabel, action })),
    ).toEqual(DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })));
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
        data: { actionLabel: 'go', action: 'UPDATE_STATUS' },
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
        data: { actionLabel: 'go', action: 'UPDATE_STATUS' },
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
        data: { actionLabel: 'go', action: 'UPDATE_STATUS' },
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
    // The output shape is exactly `{ states, transitions, positions,
    // terminalNodes }` — no `description` key (the client-side description
    // never reaches the form). `terminalNodes` is the fixed-shape
    // start/end-marker state (auto/pinned/hidden), preserved from
    // `prevTerminalNodes` when no marker is present on the canvas.
    expect(Object.keys(result).sort()).toEqual(['positions', 'states', 'terminalNodes', 'transitions']);
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
        { from: 'ONHOLD', to: 'WAITING', actionLabel: 'Kembali', action: 'UPDATE_STATUS' },
        { from: 'ONHOLD', to: 'CALLING', actionLabel: 'Lanjut', action: 'UPDATE_STATUS' },
      ],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go', action: 'UPDATE_STATUS' } },
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
      { id: 'A->A#0', source: 'A', target: 'A', type: 'transition', data: { actionLabel: 'loop', action: 'UPDATE_STATUS' } },
    ];
    expect(isDuplicateTransition(edges, 'A', 'A')).toBe(true);
  });
});

describe('deriveTerminalMarkers (canvas-only Start/End markers)', () => {
  /** The PRD §7 default graph's canvas positions, reused across the cases. */
  const DEFAULT_POSITIONS = {
    WAITING: { x: 0, y: 0 },
    CALLING: { x: 240, y: 0 },
    SERVING: { x: 480, y: 0 },
    SKIPPED: { x: 480, y: 120 },
    COMPLETED: { x: 720, y: 0 },
  };

  it('emits a Start marker + Start→source edge for the default graph (WAITING is the sole source)', () => {
    // The PRD §7 default graph: WAITING is the only in-degree-0 state
    // (CALLING has WAITING→CALLING and SKIPPED→CALLING incoming; SERVING has
    // CALLING→SERVING; SKIPPED has CALLING→SKIPPED; COMPLETED has
    // SERVING→COMPLETED). So the Start marker points at WAITING only.
    const { nodes, edges } = deriveTerminalMarkers(
      [...DEFAULT_STATE_MACHINE.states],
      DEFAULT_STATE_MACHINE.transitions,
      // Feed real positions so the marker x is offset from the leftmost node.
      DEFAULT_POSITIONS,
      [],
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

  it('draws NO End edge for the default graph out-degree-0 state until it is an endSource', () => {
    // COMPLETED is the only out-degree-0 state in the default graph. It used to
    // get an automatic COMPLETED→__end arrow; End is manual-only now, so with
    // `endSources: []` the marker renders bare. Manager feedback: "node masih
    // otomatis linked ke end, seharusnya manual linked."
    const bare = deriveTerminalMarkers(
      [...DEFAULT_STATE_MACHINE.states],
      DEFAULT_STATE_MACHINE.transitions,
      DEFAULT_POSITIONS,
      [],
    );
    const end = bare.nodes.find((n) => n.id === END_NODE_ID);
    // The marker NODE still emits — it is the drop target for the manual link.
    expect(end).toBeDefined();
    expect(end?.type).toBe(END_NODE_TYPE);
    expect(end?.draggable).toBe(false);
    expect(end?.selectable).toBe(true);
    expect(end?.data.name).toBe(END_NODE_ID);
    expect(bare.edges.filter((e) => e.target === END_NODE_ID)).toHaveLength(0);

    // Listing COMPLETED as an endSource draws exactly the one arrow — the
    // positive control that makes the emptiness above non-vacuous.
    const linked = deriveTerminalMarkers(
      [...DEFAULT_STATE_MACHINE.states],
      DEFAULT_STATE_MACHINE.transitions,
      DEFAULT_POSITIONS,
      ['COMPLETED'],
    );
    const endEdges = linked.edges.filter((e) => e.target === END_NODE_ID);
    expect(endEdges).toHaveLength(1);
    expect(endEdges[0].id).toBe(`COMPLETED->${END_NODE_ID}`);
    expect(endEdges[0].source).toBe('COMPLETED');
    expect(endEdges[0].type).toBe(TERMINAL_EDGE_TYPE);
    expect(endEdges[0].data.actionLabel).toBe('');
    expect(endEdges[0].markerEnd).toEqual(EDGE_ARROW_MARKER);
    expect(endEdges[0].sourceHandle).toBe(HANDLE_IDS.right);
    expect(endEdges[0].targetHandle).toBe(HANDLE_IDS.left);
  });

  it('emits no Start marker for a pure cycle (every state has an incoming edge)', () => {
    // A↔B: both A and B have incoming edges → no sources → no Start marker.
    // The End marker still emits (manual-only, always available as a drop
    // target) but draws no edge with `endSources: []`.
    const { nodes, edges } = deriveTerminalMarkers(
      ['A', 'B'],
      [
        { from: 'A', to: 'B', actionLabel: 'a', action: 'UPDATE_STATUS' },
        { from: 'B', to: 'A', actionLabel: 'b', action: 'UPDATE_STATUS' },
      ],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      [],
    );
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeUndefined();
    expect(nodes.map((n) => n.id)).toEqual([END_NODE_ID]);
    expect(edges).toHaveLength(0);
  });

  it('emits no markers for an empty state list', () => {
    const { nodes, edges } = deriveTerminalMarkers([], [], {}, []);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('emits no markers for an empty state list even when endSources is non-empty', () => {
    // The `states.length === 0` early return is the ONLY case that withholds
    // the End marker node — a stale endSource on an empty graph draws nothing.
    const { nodes, edges } = deriveTerminalMarkers([], [], {}, ['GONE']);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('emits a Start edge but no End edge when nothing is an endSource', () => {
    // A→B, B→B (self-loop): A has in-degree 0 (a source); B has out-degree 1 so
    // it is not even a leaf. Start points at A; End emits as a bare drop target.
    const { nodes, edges } = deriveTerminalMarkers(
      ['A', 'B'],
      [
        { from: 'A', to: 'B', actionLabel: 'a', action: 'UPDATE_STATUS' },
        { from: 'B', to: 'B', actionLabel: 'loop', action: 'UPDATE_STATUS' },
      ],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      [],
    );
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeDefined();
    expect(nodes.find((n) => n.id === END_NODE_ID)).toBeDefined();
    // Only the Start→A terminal edge (nothing points at End).
    expect(edges.map((e) => e.id)).toEqual([`${START_NODE_ID}->A`]);
  });

  it('emits exactly one End edge per endSource, de-duping repeats', () => {
    // A repeated entry must not mint two edges — they would share one id and
    // React would render duplicate arrows on top of each other.
    const { edges } = deriveTerminalMarkers(
      ['A', 'B'],
      [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      ['A', 'B', 'A'],
    );
    const endEdges = edges.filter((e) => e.target === END_NODE_ID);
    expect(endEdges.map((e) => e.id)).toEqual([`A->${END_NODE_ID}`, `B->${END_NODE_ID}`]);
  });

  it('skips an endSource with no real position (a stale name draws nothing)', () => {
    const { nodes, edges } = deriveTerminalMarkers(
      ['A', 'B'],
      [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      ['GONE'],
    );
    // The marker still emits; the stale entry contributes no edge.
    expect(nodes.find((n) => n.id === END_NODE_ID)).toBeDefined();
    expect(edges.filter((e) => e.target === END_NODE_ID)).toHaveLength(0);
  });

  it('places Start.x left of min real x and End.x right of its endSource', () => {
    const real = { A: { x: 100, y: 0 }, B: { x: 300, y: 0 } };
    const { nodes } = deriveTerminalMarkers(
      ['A', 'B'],
      [{ from: 'A', to: 'B', actionLabel: 'a', action: 'UPDATE_STATUS' }],
      real,
      ['B'],
    );
    const start = nodes.find((n) => n.id === START_NODE_ID)!;
    const end = nodes.find((n) => n.id === END_NODE_ID)!;
    // TERMINAL_SPACING = 240 (matches autoLayout's X_SPACING).
    expect(start.position.x).toBe(100 - 240);
    expect(end.position.x).toBe(300 + 240);
    // yCenter = (0 + 0) / 2 = 0.
    expect(start.position.y).toBe(0);
    expect(end.position.y).toBe(0);
  });

  it('bounds the markers by the CONNECTED states, not by a stray node dropped past them', () => {
    // A wired A→B chain plus a stray status the manager dropped to the RIGHT of
    // B (dropping into empty space is the common case). The End marker connects
    // only to B (its sole endSource), so it sits one rank right of B — NOT one
    // rank right of the stray, which would stretch the B→End edge past a node it
    // has no edge to. Same on the left for Start (the stray is also right of the
    // source A, so the Start bound is unaffected here — asserted for symmetry).
    const { nodes } = deriveTerminalMarkers(
      ['A', 'B', 'STRAY'],
      [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 }, STRAY: { x: 900, y: 0 } },
      ['B'],
    );
    const start = nodes.find((n) => n.id === START_NODE_ID)!;
    const end = nodes.find((n) => n.id === END_NODE_ID)!;
    // Start: one rank (240) left of the leftmost SOURCE (A at x=0).
    expect(start.position.x).toBe(0 - 240);
    // End: one rank right of the rightmost END SOURCE (B at x=240) — not STRAY.
    expect(end.position.x).toBe(240 + 240);
    // The vertical center stays graph-wide (all three nodes are at y=0 here).
    expect(start.position.y).toBe(0);
    expect(end.position.y).toBe(0);
  });

  it('parks an unconnected End marker at the right edge of the whole diagram', () => {
    // With no endSources the End marker spans nothing, so the "bound by what it
    // connects to" rule has no input — it falls back to every real node and sits
    // one rank right of the rightmost (STRAY at x=900). It must stay on-canvas
    // and reachable: it is the drop target for the first manual link.
    const { nodes } = deriveTerminalMarkers(
      ['A', 'B', 'STRAY'],
      [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 }, STRAY: { x: 900, y: 0 } },
      [],
    );
    expect(nodes.find((n) => n.id === END_NODE_ID)!.position.x).toBe(900 + 240);
  });

  it('keeps the vertical center graph-wide (a stray node still counts toward yCenter)', () => {
    // The X bounds narrow to the connected states, but the Y center does NOT —
    // the markers denote the whole diagram's entry/exit, so they sit at its
    // vertical middle. A stray at y=400 pulls the center down accordingly.
    const { nodes } = deriveTerminalMarkers(
      ['A', 'B', 'STRAY'],
      [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 }, STRAY: { x: 120, y: 400 } },
      ['B'],
    );
    // yCenter = (minY 0 + maxY 400) / 2 = 200 for both markers.
    expect(nodes.find((n) => n.id === START_NODE_ID)?.position.y).toBe(200);
    expect(nodes.find((n) => n.id === END_NODE_ID)?.position.y).toBe(200);
  });

  it('defaults bounds to 0 when realPositions is empty (no NaN)', () => {
    // A wired A→B graph (A is the sole source) so the Start marker emits, with
    // realPositions empty → minX/maxX/minY/maxY default to 0. Every bound list
    // is empty here — the source X list, the endSource X list AND the
    // all-real-nodes fallback — so this exercises every NaN guard at once.
    const { nodes } = deriveTerminalMarkers(['A', 'B'], [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }], {}, []);
    const start = nodes.find((n) => n.id === START_NODE_ID)!;
    const end = nodes.find((n) => n.id === END_NODE_ID)!;
    expect(start.position).toEqual({ x: 0 - 240, y: 0 });
    expect(end.position).toEqual({ x: 0 + 240, y: 0 });
  });

  it('defaults the End bound to 0 when the endSources have no positions (no NaN)', () => {
    // The endSource is a real state name but carries no position, so it is
    // skipped for the edge AND drops out of the X bound; the all-real-nodes
    // fallback is empty too → 0, never NaN.
    const { nodes } = deriveTerminalMarkers(['A', 'B'], [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }], {}, ['B']);
    expect(nodes.find((n) => n.id === END_NODE_ID)!.position).toEqual({ x: 240, y: 0 });
  });

  it('ignores transitions referencing a state not in the schema (defensive)', () => {
    // A transition B→C where C is not in `states` must not count toward the
    // degree tallies nor seed any marker for C.
    const { nodes, edges } = deriveTerminalMarkers(
      ['A', 'B'],
      [
        { from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' },
        { from: 'B', to: 'C', actionLabel: 'x', action: 'UPDATE_STATUS' },
      ],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      ['B'],
    );
    // A has in-degree 0 + out-degree 1 → a real source → Start emits, pointing
    // at A only. (B→C is ignored, so it cannot make C look like a target.)
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeDefined();
    expect(edges.filter((e) => e.source === START_NODE_ID).map((e) => e.target)).toEqual(['A']);
    // End is fed by its endSource B — unaffected by the invalid B→C edge.
    expect(nodes.find((n) => n.id === END_NODE_ID)).toBeDefined();
    expect(edges.filter((e) => e.target === END_NODE_ID).map((e) => e.source)).toEqual(['B']);
    // No terminal edge references C.
    expect(edges.every((e) => e.source !== 'C' && e.target !== 'C')).toBe(true);
  });

  it('emits no Start marker for a lone state whose only transition references an unknown state', () => {
    // The defensive guard and the isolated-state rule compose: dropping the
    // invalid A→C edge leaves A with degree 0 on both sides → A is isolated →
    // not a source → no Start marker. The End marker emits as a bare drop
    // target, with no edge (and none referencing C).
    const { nodes, edges } = deriveTerminalMarkers(
      ['A'],
      [{ from: 'A', to: 'C', actionLabel: 'x', action: 'UPDATE_STATUS' }],
      { A: { x: 0, y: 0 } },
      [],
    );
    expect(nodes.map((n) => n.id)).toEqual([END_NODE_ID]);
    expect(edges).toHaveLength(0);
  });

  it('excludes an isolated state from the Start edges and never auto-links it to End', () => {
    // The manager's earlier bug: a stray status added from the palette (no
    // transisi yet) has in-degree 0 AND out-degree 0, so it used to satisfy both
    // predicates and got a __start→C edge AND a C→__end edge — reading as the
    // flow's entry AND its exit at once. It is not yet wired in, so it gets
    // neither. The wired A→B chain alongside it keeps its Start edge, and B (a
    // leaf) reaches End only because it is listed as an endSource.
    const { nodes, edges } = deriveTerminalMarkers(
      ['A', 'B', 'C'],
      [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 }, C: { x: 240, y: 200 } },
      ['B'],
    );
    // Both markers emit — the chain has a real source (A) and a manual End link.
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeDefined();
    expect(nodes.find((n) => n.id === END_NODE_ID)).toBeDefined();
    // Exactly one Start edge (→A) and one End edge (B→).
    const startEdges = edges.filter((e) => e.source === START_NODE_ID);
    expect(startEdges).toHaveLength(1);
    expect(startEdges[0].target).toBe('A');
    const endEdges = edges.filter((e) => e.target === END_NODE_ID);
    expect(endEdges).toHaveLength(1);
    expect(endEdges[0].source).toBe('B');
    // NOTHING touches the stray node C.
    expect(edges.every((e) => e.source !== 'C' && e.target !== 'C')).toBe(true);
  });

  it('emits no Start marker and no edges for a graph of only isolated states', () => {
    // No state is wired to anything → no entry point → no Start marker and no
    // edges. (A fresh custom flow the manager has only dropped nodes onto looks
    // like this.) The End marker emits bare so the manager can start linking.
    const { nodes, edges } = deriveTerminalMarkers(
      ['A', 'B', 'C'],
      [],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 }, C: { x: 480, y: 0 } },
      [],
    );
    expect(nodes.map((n) => n.id)).toEqual([END_NODE_ID]);
    expect(edges).toHaveLength(0);
  });

  it('still emits Start + End for a pure chain, and no Start for a pure cycle (regression guard)', () => {
    // The isolated-state exclusion must not disturb the two established shapes.
    const chain = deriveTerminalMarkers(
      ['A', 'B', 'C'],
      [
        { from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' },
        { from: 'B', to: 'C', actionLabel: 'next', action: 'UPDATE_STATUS' },
      ],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 }, C: { x: 480, y: 0 } },
      ['C'],
    );
    expect(chain.nodes.find((n) => n.id === START_NODE_ID)).toBeDefined();
    expect(chain.nodes.find((n) => n.id === END_NODE_ID)).toBeDefined();
    expect(chain.edges.map((e) => e.id)).toEqual([`${START_NODE_ID}->A`, `C->${END_NODE_ID}`]);

    const cycle = deriveTerminalMarkers(
      ['A', 'B'],
      [
        { from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' },
        { from: 'B', to: 'A', actionLabel: 'back', action: 'UPDATE_STATUS' },
      ],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      [],
    );
    expect(cycle.nodes.map((n) => n.id)).toEqual([END_NODE_ID]);
    expect(cycle.edges).toHaveLength(0);
  });

  it('draws an End edge from a WIRED LEAF only when it is an endSource (the manager repro)', () => {
    // The exact regression: A→B leaves B with in-degree 1 and out-degree 0 — a
    // freshly wired-in leaf status. It used to be auto-linked to End the moment
    // the transition was drawn. Now it reaches End only on an explicit link.
    const auto = deriveTerminalMarkers(
      ['A', 'B'],
      [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      [],
    );
    expect(auto.edges.filter((e) => e.target === END_NODE_ID)).toHaveLength(0);

    // Positive control: the SAME leaf, listed as an endSource, gets exactly one
    // edge — so the emptiness above is a real absence, not an unreachable id.
    const manual = deriveTerminalMarkers(
      ['A', 'B'],
      [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      ['B'],
    );
    expect(manual.edges.filter((e) => e.target === END_NODE_ID).map((e) => e.id)).toEqual([
      `B->${END_NODE_ID}`,
    ]);
  });

  /**
   * Manager feedback: "current node cannot have self-loop, and if the current
   * node have 2 transisi masuk juga hilang — contoh, WAITING memiliki transisi
   * masuk dari Start dan aku mau bikin self-loop, kemudian yang dari Start
   * hilang." A self-loop used to count toward BOTH degrees, so the status it sat
   * on stopped being in-degree 0 and silently lost its `__start -> S` arrow. A
   * self-loop is flow that leaves a status and returns to it: it must not change
   * where the flow ENTERS. (End is manual-only since #106, so the symmetric
   * exit case no longer exists — nothing derives an End arrow from topology.)
   */
  it('a self-loop on the entry state KEEPS its __start edge', () => {
    const { nodes, edges } = deriveTerminalMarkers(
      ['A', 'B'],
      [
        { from: 'A', to: 'B', actionLabel: 'a', action: 'UPDATE_STATUS' },
        { from: 'A', to: 'A', actionLabel: 'loop', action: 'UPDATE_STATUS' },
      ],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      [],
    );
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeDefined();
    expect(edges.filter((e) => e.source === START_NODE_ID).map((e) => e.target)).toEqual(['A']);
  });

  it('a status whose ONLY transition is a self-loop is not an entry point', () => {
    // The PR #103 invariant survives the self-loop fix: a self-loop wires a
    // status to itself, not into the flow, so it stays degree-0 on both sides
    // and gets no Start arrow. The assertion is non-vacuous because the same
    // call positively emits the __start -> A edge.
    const { edges } = deriveTerminalMarkers(
      ['A', 'B', 'LOOPY'],
      [
        { from: 'A', to: 'B', actionLabel: 'a', action: 'UPDATE_STATUS' },
        { from: 'LOOPY', to: 'LOOPY', actionLabel: 'loop', action: 'UPDATE_STATUS' },
      ],
      { A: { x: 0, y: 0 }, B: { x: 240, y: 0 }, LOOPY: { x: 240, y: 200 } },
      [],
    );
    const fromStart = edges.filter((e) => e.source === START_NODE_ID).map((e) => e.target);
    expect(fromStart).toEqual(['A']);
    expect(fromStart).not.toContain('LOOPY');
  });

});

describe('formToFlowWithMarkers', () => {
  it('returns state nodes + Start/End markers for the default graph (7 nodes, 6 edges)', () => {
    const form = defaultStateMachineForm();
    const { nodes, edges } = formToFlowWithMarkers(form, {});
    // 5 state nodes + 1 Start + 1 End = 7. The End marker emits even though the
    // default graph declares no endSources — it is the manual link's drop target.
    expect(nodes).toHaveLength(DEFAULT_STATE_MACHINE.states.length + 2);
    expect(nodes.filter((n) => n.type === 'state')).toHaveLength(5);
    expect(nodes.find((n) => n.id === START_NODE_ID)?.type).toBe(START_NODE_TYPE);
    expect(nodes.find((n) => n.id === END_NODE_ID)?.type).toBe(END_NODE_TYPE);
    // 5 transition edges + 1 Start→WAITING = 6. No End edge: `endSources` is
    // empty and nothing about the topology adds one.
    expect(edges).toHaveLength(DEFAULT_STATE_MACHINE.transitions.length + 1);
    expect(edges.filter((e) => e.type === 'transition')).toHaveLength(5);
    expect(edges.filter((e) => e.type === TERMINAL_EDGE_TYPE)).toHaveLength(1);

    // Positive control: the same graph WITH an endSource adds exactly one more
    // terminal edge, so the count above is a real absence.
    const linked = formToFlowWithMarkers({ ...form, endSources: ['COMPLETED'] }, {});
    expect(linked.edges.filter((e) => e.type === TERMINAL_EDGE_TYPE)).toHaveLength(2);
  });

  it('round-trips clean through flowToGraph (markers filtered, form intact)', () => {
    // flowToGraph MUST filter the terminal nodes/edges so the form/wire/XML
    // never see __start/__end. The round-tripped form has 5 states + 5
    // transitions (the markers are dropped).
    const form = defaultStateMachineForm();
    const { nodes, edges } = formToFlowWithMarkers(form, {});
    const { states, transitions } = flowToGraph(nodes, edges);
    expect(states).toEqual([...DEFAULT_STATE_MACHINE.states]);
    expect(
      transitions.map(({ from, to, actionLabel, action }) => ({ from, to, actionLabel, action })),
    ).toEqual(
      DEFAULT_STATE_MACHINE.transitions.map((t) => ({
        from: t.from,
        to: t.to,
        actionLabel: t.actionLabel,
        action: t.action,
      })),
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
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go', action: 'UPDATE_STATUS' } },
      { id: `${START_NODE_ID}->A`, source: START_NODE_ID, target: 'A', type: TERMINAL_EDGE_TYPE, data: { actionLabel: '', action: 'UPDATE_STATUS' } },
      { id: `B->${END_NODE_ID}`, source: 'B', target: END_NODE_ID, type: TERMINAL_EDGE_TYPE, data: { actionLabel: '', action: 'UPDATE_STATUS' } },
    ];
    const { states, transitions, positions } = flowToGraph(nodes, edges);
    expect(states).toEqual(['A', 'B']);
    expect(Object.keys(positions).sort()).toEqual(['A', 'B']);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from).toBe('A');
    expect(transitions[0].to).toBe('B');
  });
});

describe('formToFlowWithMarkers terminal-node three-state model', () => {
  // A simple A→B graph: A is the sole source (in-degree 0), B is a leaf the
  // manager linked to End by hand (`endSources: ['B']`). Under `terminalNodes:
  // { start: 'auto', end: 'auto' }` BOTH markers emit, pinned:false, positioned
  // by the deriveTerminalMarkers math (one rank left/right of the real bounds).
  const abForm = (): StateMachineForm => ({
    mode: 'custom',
    states: ['A', 'B'],
    transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
    positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
    nodeActions: {},
    descriptions: {},
    endSources: ['B'],
    terminalNodes: { start: 'auto', end: 'auto' },
  });

  it("'auto' emits both markers with pinned:false at the derived rank offset", () => {
    const { nodes } = formToFlowWithMarkers(abForm(), {});
    const start = nodes.find((n) => n.id === START_NODE_ID);
    const end = nodes.find((n) => n.id === END_NODE_ID);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(start?.pinned).toBe(false);
    expect(end?.pinned).toBe(false);
    // A is at x=0 (leftmost) → Start sits one rank (240) left → x=-240.
    expect(start?.position.x).toBe(-240);
    // B is at x=240 (rightmost) → End sits one rank right → x=480.
    expect(end?.position.x).toBe(480);
  });

  it("'hidden' omits the marker node AND its terminal edges", () => {
    const form: StateMachineForm = {
      ...abForm(),
      terminalNodes: { start: 'hidden', end: 'auto' },
    };
    const { nodes, edges } = formToFlowWithMarkers(form, {});
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeUndefined();
    // The Start→A terminal edge is gone (an edge with no source node cannot
    // render); the End marker + its manual edge remain.
    expect(edges.filter((e) => e.source === START_NODE_ID)).toHaveLength(0);
    expect(nodes.find((n) => n.id === END_NODE_ID)).toBeDefined();
    expect(edges.filter((e) => e.target === END_NODE_ID)).toHaveLength(1);
  });

  it("'hidden' omits the End marker AND its manual terminal edges", () => {
    // The mirror case: hiding End drops its node, so its manager-drawn edge
    // cannot render either (an edge with no target node). `endSources` itself
    // is untouched — un-hiding the marker brings the arrow back.
    const form: StateMachineForm = {
      ...abForm(),
      terminalNodes: { start: 'auto', end: 'hidden' },
    };
    const { nodes, edges } = formToFlowWithMarkers(form, {});
    expect(nodes.find((n) => n.id === END_NODE_ID)).toBeUndefined();
    expect(edges.filter((e) => e.target === END_NODE_ID)).toHaveLength(0);
    // The Start marker + its edge are unaffected.
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeDefined();
    expect(edges.filter((e) => e.source === START_NODE_ID)).toHaveLength(1);
  });

  it("an explicit {x,y} emits the Start marker ALWAYS (even with no sources), pinned:true at the given position", () => {
    // A pure cycle (A→B, B→A): no sources → 'auto' would emit NO Start marker.
    // An explicit {x,y} overrides that — the marker is willed by the manager
    // regardless of topology, pinned:true, at the exact position.
    const cycleForm: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [
        { from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' },
        { from: 'B', to: 'A', actionLabel: 'back', action: 'UPDATE_STATUS' },
      ],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: { x: -300, y: 50 }, end: 'auto' },
    };
    const { nodes, edges } = formToFlowWithMarkers(cycleForm, {});
    const start = nodes.find((n) => n.id === START_NODE_ID);
    expect(start).toBeDefined();
    expect(start?.pinned).toBe(true);
    expect(start?.position).toEqual({ x: -300, y: 50 });
    // The auto End marker emits (it always does) but draws nothing.
    expect(nodes.find((n) => n.id === END_NODE_ID)?.pinned).toBe(false);
    // A pinned Start on a cycle has no source to point at → no terminal edges.
    expect(edges.filter((e) => e.type === TERMINAL_EDGE_TYPE)).toHaveLength(0);
  });

  it("'auto' on a pure cycle emits NO Start marker (no sources), End stays as a bare drop target", () => {
    const cycleForm: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [
        { from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' },
        { from: 'B', to: 'A', actionLabel: 'back', action: 'UPDATE_STATUS' },
      ],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const { nodes, edges } = formToFlowWithMarkers(cycleForm, {});
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeUndefined();
    expect(nodes.find((n) => n.id === END_NODE_ID)).toBeDefined();
    expect(edges.filter((e) => e.type === TERMINAL_EDGE_TYPE)).toHaveLength(0);
  });

  it("'auto' on a graph of ONLY isolated states emits no Start marker and no terminal edges", () => {
    // The manager just dropped two statuses on a fresh canvas and has drawn no
    // transisi yet. Neither is an entry point, so there is nothing for the Start
    // marker to point at → no auto Start. Neither is auto-linked to End either.
    // The End marker itself DOES render: without it there would be no drop
    // target, so the manager could never draw the first link (the whole point of
    // the manual-End rule).
    const strayOnly: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const { nodes, edges } = formToFlowWithMarkers(strayOnly, {});
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeUndefined();
    expect(nodes.find((n) => n.id === END_NODE_ID)).toBeDefined();
    expect(edges.filter((e) => e.type === TERMINAL_EDGE_TYPE)).toHaveLength(0);
    // The two state nodes still render.
    expect(nodes.filter((n) => n.type === 'state')).toHaveLength(2);
  });

  it('a stray state added to a wired graph gets no terminal edge (the markers stay on the chain)', () => {
    // The manager's scenario at the mapper boundary: an A→B flow the manager
    // adds a third, unconnected status to. Both markers still emit for the
    // chain, and NO terminal edge touches the stray node.
    const withStray: StateMachineForm = {
      ...abForm(),
      states: ['A', 'B', 'STATUS_1'],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 }, STATUS_1: { x: 240, y: 200 } },
    };
    const { nodes, edges } = formToFlowWithMarkers(withStray, {});
    expect(nodes.find((n) => n.id === START_NODE_ID)).toBeDefined();
    expect(nodes.find((n) => n.id === END_NODE_ID)).toBeDefined();
    const terminalEdges = edges.filter((e) => e.type === TERMINAL_EDGE_TYPE);
    expect(terminalEdges.map((e) => e.id)).toEqual([`${START_NODE_ID}->A`, `B->${END_NODE_ID}`]);
    expect(terminalEdges.every((e) => e.source !== 'STATUS_1' && e.target !== 'STATUS_1')).toBe(true);
  });

  it('a state WIRED IN as a leaf gets no End edge until the manager links it', () => {
    // The manager's repro at the mapper boundary: the stray STATUS_1 above is
    // now wired in (B→STATUS_1), giving it in-degree 1 and out-degree 0. Under
    // the old auto-sink rule that alone claimed it as the flow's exit; now the
    // only End edge is still B's, because only B is an endSource.
    const wiredLeaf: StateMachineForm = {
      ...abForm(),
      states: ['A', 'B', 'STATUS_1'],
      transitions: [
        { from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' },
        { from: 'B', to: 'STATUS_1', actionLabel: 'next', action: 'UPDATE_STATUS' },
      ],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 }, STATUS_1: { x: 480, y: 0 } },
    };
    const { edges } = formToFlowWithMarkers(wiredLeaf, {});
    const endEdges = edges.filter((e) => e.target === END_NODE_ID);
    // Non-vacuous: an End edge DOES render here (B's), just not STATUS_1's.
    expect(endEdges.map((e) => e.id)).toEqual([`B->${END_NODE_ID}`]);
  });

  it('a PINNED Start marker on an only-isolated graph still emits the node, but carries no edge', () => {
    // A pinned {x,y} marker is willed by the manager regardless of topology, so
    // the node emits — but with no source to point at, it draws no edge to the
    // stray state.
    const pinnedOnStray: StateMachineForm = {
      mode: 'custom',
      states: ['A'],
      transitions: [],
      positions: { A: { x: 0, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: { x: -300, y: 50 }, end: 'auto' },
    };
    const { nodes, edges } = formToFlowWithMarkers(pinnedOnStray, {});
    const start = nodes.find((n) => n.id === START_NODE_ID);
    expect(start).toBeDefined();
    expect(start?.pinned).toBe(true);
    expect(edges.filter((e) => e.type === TERMINAL_EDGE_TYPE)).toHaveLength(0);
    // The 'auto' End marker emits (always) with no incoming edge.
    expect(nodes.find((n) => n.id === END_NODE_ID)?.pinned).toBe(false);
  });

  it('flowToGraph preserves a prior pinned start when the auto-dropped marker is absent (isolated graph)', () => {
    // The widened auto-drop case flows through the existing disambiguation: an
    // absent marker is ambiguous ('hidden' vs auto-dropped), so `flowToGraph`
    // preserves `prevTerminalNodes[key]`. An only-isolated graph now drops the
    // auto markers, and the prior state (here a pinned start + a 'hidden' end)
    // survives the round-trip unchanged.
    const strayOnly: StateMachineForm = {
      mode: 'custom',
      states: ['A'],
      transitions: [],
      positions: { A: { x: 0, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'auto', end: 'hidden' },
    };
    const { nodes, edges } = formToFlowWithMarkers(strayOnly, {});
    const { states, terminalNodes } = flowToGraph(nodes, edges, strayOnly.terminalNodes);
    expect(states).toEqual(['A']);
    expect(terminalNodes).toEqual({ start: 'auto', end: 'hidden' });
  });
});

describe('flowToGraph captures terminalNodes back from the canvas', () => {
  // flowToGraph is the inverse: a present marker with `pinned` → {x,y}; a
  // present marker without `pinned` → 'auto'; an ABSENT marker preserves the
  // prior `prevTerminalNodes[key]` (absence is ambiguous: 'hidden' OR an auto
  // marker dropped because the topology has no sources/sinks). This is the
  // pure-function drag-capture path the plan calls out (jsdom can't simulate a
  // real React Flow pointer-geometry drag, so the pinning semantics are proven
  // here on the pure mapper the component's onNodeDragStop consults).

  it('a present pinned marker captures as {x,y} (a drag pins the marker)', () => {
    const nodes: FlowNode[] = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
      {
        id: START_NODE_ID,
        type: START_NODE_TYPE,
        position: { x: -500, y: 30 },
        data: { name: START_NODE_ID, description: '' },
        pinned: true,
      },
    ];
    const { terminalNodes } = flowToGraph(nodes, []);
    expect(terminalNodes.start).toEqual({ x: -500, y: 30 });
    // End absent → preserved from the default prevTerminalNodes ('auto').
    expect(terminalNodes.end).toBe('auto');
  });

  it('a present auto marker (pinned falsy) captures as "auto"', () => {
    const nodes: FlowNode[] = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
      {
        id: START_NODE_ID,
        type: START_NODE_TYPE,
        position: { x: -240, y: 0 },
        data: { name: START_NODE_ID, description: '' },
        // pinned omitted → auto-derived position.
      },
    ];
    const { terminalNodes } = flowToGraph(nodes, []);
    expect(terminalNodes.start).toBe('auto');
  });

  it('an absent marker preserves a prior "hidden" (absence ≠ auto-drop on a no-source graph)', () => {
    // The disambiguation case: the canvas has no Start marker. That could mean
    // the manager hid it ('hidden') OR the topology simply has no sources so
    // the auto marker didn't emit. The caller passes the prior terminalNodes
    // to disambiguate — a prior 'hidden' is preserved, NOT reset to 'auto'.
    const nodes: FlowNode[] = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
    ];
    const prev = { start: 'hidden' as const, end: 'auto' as const };
    const { terminalNodes } = flowToGraph(nodes, [], prev);
    expect(terminalNodes.start).toBe('hidden');
    expect(terminalNodes.end).toBe('auto');
  });

  it('an absent marker preserves a prior pinned {x,y}', () => {
    // Symmetric to the hidden-preserve case: a prior pinned position is kept
    // when the marker is absent on the canvas (e.g. a source-view edit that
    // hasn't re-seeded yet). The default prevTerminalNodes would be 'auto', so
    // passing the prior pinned state is load-bearing.
    const nodes: FlowNode[] = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
    ];
    const prev = { start: { x: -999, y: 0 }, end: 'auto' as const };
    const { terminalNodes } = flowToGraph(nodes, [], prev);
    expect(terminalNodes.start).toEqual({ x: -999, y: 0 });
  });

  it("defaults prevTerminalNodes to auto/auto when omitted (legacy call sites)", () => {
    // The 3rd arg defaults to DEFAULT_TERMINAL_NODES so the legacy 2-arg call
    // sites (the round-trip test above) read an absent marker as 'auto', not
    // undefined — the captured terminalNodes is always a complete {start,end}.
    const nodes: FlowNode[] = [
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
    ];
    const { terminalNodes } = flowToGraph(nodes, []);
    expect(terminalNodes).toEqual({ ...DEFAULT_TERMINAL_NODES });
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
      { id: `${START_NODE_ID}->A`, source: START_NODE_ID, target: 'A', type: TERMINAL_EDGE_TYPE, data: { actionLabel: '', action: 'UPDATE_STATUS' } },
      { id: `A->${END_NODE_ID}`, source: 'A', target: END_NODE_ID, type: TERMINAL_EDGE_TYPE, data: { actionLabel: '', action: 'UPDATE_STATUS' } },
    ];
    // No real A→A edge exists; the terminal edges do NOT make it a duplicate.
    expect(isDuplicateTransition(edges, 'A', 'A')).toBe(false);
    // A real transition edge IS a duplicate.
    const withReal: FlowEdge[] = [
      ...edges,
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go', action: 'UPDATE_STATUS' } },
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
      { id: 'SKIPPED->CALLING#0', source: 'SKIPPED', target: 'CALLING', type: 'transition', data: { actionLabel: 'Panggil Ulang', action: 'UPDATE_STATUS' } },
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
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go', action: 'UPDATE_STATUS' } },
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
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS', sourceSide: 'bottom', targetSide: 'top' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    const { nodes, edges } = formToFlow(form, {});
    const { transitions } = flowToGraph(nodes, edges);
    expect(transitions[0].sourceSide).toBe('bottom');
    expect(transitions[0].targetSide).toBe('top');
  });
});

describe('formToFlowWithMarkers End connections (endSources)', () => {
  // `endSources` is the COMPLETE set of arrows into the End marker — nothing
  // about the graph shape adds one (manager feedback: "node masih otomatis
  // linked ke end, seharusnya manual linked"). One edge per entry, id
  // `${s}->__end`, all `type: 'terminal'` so `flowToGraph` filters them out
  // (they never reach the wire transitions — `__end` is not a real state).

  /** An A→B graph with the given endSources. A is the source; B is a leaf. */
  const abForm = (endSources: string[]): StateMachineForm => ({
    mode: 'custom',
    states: ['A', 'B'],
    transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
    positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
    nodeActions: {},
    descriptions: {},
    endSources,
    terminalNodes: { start: 'auto', end: 'auto' },
  });

  it('emits a terminal edge for an endSource that has an outgoing transition', () => {
    // An endSource 'A' — a state in the MIDDLE of the flow (it has an outgoing
    // edge) — is a legal End connection: the manager decided a ticket can finish
    // there too.
    const { edges } = formToFlowWithMarkers(abForm(['A']), {});
    const edge = edges.find((e) => e.id === `A->${END_NODE_ID}`);
    expect(edge).toBeDefined();
    expect(edge?.type).toBe(TERMINAL_EDGE_TYPE);
    expect(edge?.source).toBe('A');
    expect(edge?.target).toBe(END_NODE_ID);
  });

  it('emits exactly one terminal edge for an endSource that is a LEAF (no outgoing transition)', () => {
    // The inverted case: B has out-degree 0. It used to be auto-linked, so an
    // explicit `endSources: ['B']` was de-duplicated away. Now the auto arrow is
    // gone and the explicit entry is the ONE thing that draws B→__end.
    const { edges } = formToFlowWithMarkers(abForm(['B']), {});
    expect(edges.filter((e) => e.target === END_NODE_ID).map((e) => e.id)).toEqual([
      `B->${END_NODE_ID}`,
    ]);
  });

  it('a LEAF that is NOT an endSource draws no End edge', () => {
    // The manager's bug, at the mapper boundary: B is a leaf and is not listed,
    // so nothing points at End. Paired with the case above (same fixture shape,
    // different endSources) this absence is provably real.
    const { edges } = formToFlowWithMarkers(abForm([]), {});
    expect(edges.filter((e) => e.target === END_NODE_ID)).toHaveLength(0);
  });

  it('skips a stale endSource entry not in form.states (defensive)', () => {
    const { edges } = formToFlowWithMarkers(abForm(['GONE']), {});
    expect(edges.filter((e) => e.target === END_NODE_ID)).toHaveLength(0);
  });

  it('emits the End marker when end === "auto" with NO endSources at all', () => {
    // The load-bearing UX invariant: the marker is the drop target the manual
    // link is dragged INTO, so it can never be withheld for having nothing
    // pointing at it — otherwise the first link would be impossible to draw.
    const { nodes, edges } = formToFlowWithMarkers(abForm([]), {});
    const end = nodes.find((n) => n.id === END_NODE_ID);
    expect(end).toBeDefined();
    expect(end?.pinned).toBe(false);
    expect(end?.selectable).toBe(true);
    // It parks one rank right of the rightmost real node (B at x=240 → x=480).
    expect(end?.position.x).toBe(480);
    expect(edges.filter((e) => e.target === END_NODE_ID)).toHaveLength(0);
  });

  it('positions the End marker one rank right of its rightmost endSource', () => {
    // With a connection to span, the bound narrows to what the marker actually
    // points at (A at x=0 → End at x=240), not to the rightmost node.
    const { nodes } = formToFlowWithMarkers(abForm(['A']), {});
    expect(nodes.find((n) => n.id === END_NODE_ID)?.position.x).toBe(240);
  });

  it('terminal edges never reach flowToGraph transitions (canvas-only)', () => {
    // The End marker's edges are `type: 'terminal'` so `flowToGraph` filters
    // them out — `__end` is not a real state and must never reach the wire
    // transitions.
    const { nodes, edges } = formToFlowWithMarkers(abForm(['A']), {});
    const { transitions } = flowToGraph(nodes, edges);
    // Only the real transition A→B; no `__end` leaked into transitions.
    expect(transitions).toHaveLength(1);
    expect(transitions.every((t) => t.from !== '__end' && t.to !== '__end')).toBe(true);
  });
});

describe('hasEndSource (duplicate End-connection predicate)', () => {
  const edges: FlowEdge[] = [
    { id: 'A->__end', source: 'A', target: END_NODE_ID, type: TERMINAL_EDGE_TYPE, data: { actionLabel: '', action: 'UPDATE_STATUS' } },
    { id: 'B->__end', source: 'B', target: END_NODE_ID, type: TERMINAL_EDGE_TYPE, data: { actionLabel: '', action: 'UPDATE_STATUS' } },
    { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go', action: 'UPDATE_STATUS' } },
  ];
  it('returns true for a source already linked to End', () => {
    expect(hasEndSource(edges, 'A')).toBe(true);
    expect(hasEndSource(edges, 'B')).toBe(true);
  });
  it('returns false for a source with no End connection', () => {
    expect(hasEndSource(edges, 'C')).toBe(false);
  });
  it('does NOT pre-reject a LEAF state that has no End edge yet', () => {
    // The rule change's key consequence for this predicate: B is a leaf (its
    // only edge is incoming) and used to carry an auto End arrow, which made
    // this predicate refuse the very link the manager wanted to draw. With no
    // auto arrow on the canvas, the leaf is free to be linked.
    const leafEdges: FlowEdge[] = [
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go', action: 'UPDATE_STATUS' } },
    ];
    expect(hasEndSource(leafEdges, 'B')).toBe(false);
  });
  it('ignores real transition edges (only terminal edges into __end count)', () => {
    // A→B is a real transition (type: 'transition') — hasEndSource only
    // considers terminal edges targeting __end.
    expect(hasEndSource(edges, 'A')).toBe(true); // A has a terminal edge
    // A real transition A→B does NOT make hasEndSource(edges, 'A') true via B.
    const onlyTrans: FlowEdge[] = [
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go', action: 'UPDATE_STATUS' } },
    ];
    expect(hasEndSource(onlyTrans, 'A')).toBe(false);
  });
});

describe('rejectionMessageForConnection (End-marker duplicate message)', () => {
  it('returns a manager-facing message when dropping onto End from an already-connected source', () => {
    const edges: FlowEdge[] = [
      { id: 'A->__end', source: 'A', target: END_NODE_ID, type: TERMINAL_EDGE_TYPE, data: { actionLabel: '', action: 'UPDATE_STATUS' } },
    ];
    const msg = rejectionMessageForConnection(
      { isValid: false, fromId: 'A', toId: END_NODE_ID },
      edges,
    );
    expect(msg).toBe('Status A sudah terhubung ke titik akhir.');
  });
  it('names a duplicate SELF-LOOP as its own case (not "dari X ke X")', () => {
    // Reachable live: dropping on a DIFFERENT handle of the same node IS a
    // valid handle pair, so `isValidConnection` runs and rejects the duplicate
    // (isValid false). "Transisi dari X ke X sudah ada" names the same status
    // twice and reads like a typo to a manager.
    const edges: FlowEdge[] = [
      { id: 'A->A#0', source: 'A', target: 'A', type: 'transition', data: { actionLabel: 'ulang', action: 'UPDATE_STATUS' } },
    ];
    const msg = rejectionMessageForConnection({ isValid: false, fromId: 'A', toId: 'A' }, edges);
    expect(msg).toBe('Status A sudah punya transisi ke dirinya sendiri.');
  });
  it('falls back to the duplicate-transition message for a non-End duplicate', () => {
    const edges: FlowEdge[] = [
      { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go', action: 'UPDATE_STATUS' } },
    ];
    const msg = rejectionMessageForConnection(
      { isValid: false, fromId: 'A', toId: 'B' },
      edges,
    );
    expect(msg).toBe('Transisi dari A ke B sudah ada.');
  });
});

describe('getSelfLoopPath (self-loop edge geometry)', () => {
  // A state-node card at (0,0)-(160,50): `min-width: 10rem` (160px) wide and
  // ~50px tall (icon + title + description rows plus 0.55rem padding). The four
  // handle anchor points are the side midpoints React Flow resolves for the
  // typeless per-side handles.
  const CARD = { left: 0, top: 0, right: 160, bottom: 50 };
  const HANDLE_POINT: Record<string, { x: number; y: number }> = {
    top: { x: 80, y: 0 },
    right: { x: 160, y: 25 },
    bottom: { x: 80, y: 50 },
    left: { x: 0, y: 25 },
  };
  const SIDES = ['top', 'right', 'bottom', 'left'] as const;

  function loopFor(sourcePosition: string, targetPosition: string) {
    const s = HANDLE_POINT[sourcePosition];
    const t = HANDLE_POINT[targetPosition];
    return getSelfLoopPath({
      sourceX: s.x,
      sourceY: s.y,
      sourcePosition,
      targetX: t.x,
      targetY: t.y,
      targetPosition,
    });
  }

  it('draws ONE cubic from the source point to the target point', () => {
    const [path] = loopFor('right', 'top');
    // `M sx,sy C c1x,c1y c2x,c2y tx,ty` — the same single-cubic shape
    // `getBezierPath` returns, so `BaseEdge` renders it unchanged.
    expect(path).toMatch(/^M 160,25 C -?[\d.]+,-?[\d.]+ -?[\d.]+,-?[\d.]+ 80,0$/);
  });

  it('puts the label OFF the node card for every handle pair (16 combinations)', () => {
    // The whole point of BUG B: `getBezierPath` parked the chip on top of the
    // card. Every pair must land the label outside the card rect — including
    // the seeded default `right`→`left` (opposite sides) and the same-side
    // pairs, which are the degenerate cases for a naive rotate-the-normal
    // tangent. The worst pair (top↔bottom, whose loop swings sideways past the
    // card's 80px half-width) still clears by 40px.
    const onTheCard: string[] = [];
    let worstClearance = Infinity;
    for (const sourceSide of SIDES) {
      for (const targetSide of SIDES) {
        const [, labelX, labelY] = loopFor(sourceSide, targetSide);
        const clearance = Math.max(
          CARD.left - labelX,
          labelX - CARD.right,
          CARD.top - labelY,
          labelY - CARD.bottom,
        );
        if (clearance <= 0) onTheCard.push(`${sourceSide}->${targetSide} (${labelX},${labelY})`);
        worstClearance = Math.min(worstClearance, clearance);
      }
    }
    expect(onTheCard).toEqual([]);
    expect(worstClearance).toBeGreaterThanOrEqual(40);
  });

  it('arcs an ADJACENT pair around the corner between the two sides', () => {
    // `right`→`top` (the pair the canvas self-loop fallback creates from a
    // right-handle drag): the loop must sweep the TOP-RIGHT corner — label
    // right of the card AND above it.
    const [, labelX, labelY] = loopFor('right', 'top');
    expect(labelX).toBeGreaterThan(CARD.right);
    expect(labelY).toBeLessThan(CARD.top);
  });

  it('swings the DEFAULT right→left pair up and over the card (not back through it)', () => {
    // The seeded routing for an edge with no manager-chosen sides is
    // `right`→`left` — opposite sides, where a naively rotated tangent
    // S-curves straight through the card. The loop must clear it vertically.
    const [, labelX, labelY] = loopFor('right', 'left');
    expect(labelY).toBeLessThan(CARD.top);
    // Symmetric swing: the apex sits over the middle of the card.
    expect(labelX).toBe(80);
  });

  it('opens a SAME-side pair into a round loop off that side', () => {
    const [, labelX, labelY] = loopFor('right', 'right');
    expect(labelX).toBeGreaterThan(CARD.right);
    // Symmetric about the handle, so the apex stays at the handle's height.
    expect(labelY).toBe(25);
  });

  it('sizes the loop by SELF_LOOP_RADIUS (a full card-width clear of the card)', () => {
    // The manager asked for a LONGER loop ("seharusnya lebih panjang lagi").
    // The radius is the single knob: both control points sit R out along the
    // normal, so the cubic's apex ((P0 + 3C1 + 3C2 + P3) / 8 with P0 = P3) is
    // 0.75 * R out from the handle — 120px for a 160px-wide card.
    expect(SELF_LOOP_RADIUS).toBeGreaterThanOrEqual(160);
    const [, labelX] = loopFor('right', 'right');
    expect(labelX).toBe(HANDLE_POINT.right.x + 0.75 * SELF_LOOP_RADIUS);
  });

  it('falls back to right/left normals for an unknown handle position', () => {
    // Defensive: a corrupt/legacy handle id must never produce NaN coordinates
    // (a NaN in the `d` attribute drops the whole path from the canvas).
    const [path, labelX, labelY] = getSelfLoopPath({
      sourceX: 10,
      sourceY: 20,
      sourcePosition: 'bogus',
      targetX: 10,
      targetY: 20,
      targetPosition: 'bogus',
    });
    expect(path).not.toContain('NaN');
    expect(Number.isFinite(labelX)).toBe(true);
    expect(Number.isFinite(labelY)).toBe(true);
  });
});

describe('decideConnectEnd (self-loop fallback + rejection message)', () => {
  const edges: FlowEdge[] = [
    { id: 'A->B#0', source: 'A', target: 'B', type: 'transition', data: { actionLabel: 'go', action: 'UPDATE_STATUS' } },
  ];

  it('creates a self-loop with two DISTINCT adjacent handles when the drag ended on its own node', () => {
    // The natural gesture: drag out of A's `right` handle and drop back on the
    // SAME handle. React Flow rejects that handle pair internally (isValid is
    // `null`, not `false`) but still reports `toNode` — so the fallback fires.
    const decision = decideConnectEnd(
      { isValid: null, fromId: 'A', toId: 'A', fromHandleId: HANDLE_IDS.right, pointerNodeId: null },
      edges,
    );
    expect(decision).toEqual({
      kind: 'self-loop',
      source: 'A',
      sourceHandle: HANDLE_IDS.right,
      targetHandle: HANDLE_IDS.top,
    });
  });

  it('keeps the dragged-from side as the loop SOURCE side', () => {
    const decision = decideConnectEnd(
      { isValid: null, fromId: 'A', toId: 'A', fromHandleId: HANDLE_IDS.bottom, pointerNodeId: null },
      edges,
    );
    expect(decision).toEqual({
      kind: 'self-loop',
      source: 'A',
      sourceHandle: HANDLE_IDS.bottom,
      targetHandle: HANDLE_IDS.right,
    });
  });

  it('falls back to the default source side when the from-handle is unknown', () => {
    const decision = decideConnectEnd(
      { isValid: null, fromId: 'A', toId: 'A', fromHandleId: null, pointerNodeId: null },
      edges,
    );
    expect(decision).toEqual({
      kind: 'self-loop',
      source: 'A',
      sourceHandle: DEFAULT_SOURCE_HANDLE,
      targetHandle: HANDLE_IDS.top,
    });
  });

  it('does NOT create a second self-loop when React Flow already committed one (isValid true)', () => {
    // Dropping on a DIFFERENT handle of the same node IS valid under Loose
    // mode, so `onConnect` already added the edge — the fallback must stay out
    // of the way or the manager gets two loops from one drag.
    const decision = decideConnectEnd(
      { isValid: true, fromId: 'A', toId: 'A', fromHandleId: HANDLE_IDS.right, pointerNodeId: null },
      edges,
    );
    expect(decision).toEqual({ kind: 'none' });
  });

  it('explains a duplicate self-loop instead of creating a second one', () => {
    const withLoop: FlowEdge[] = [
      ...edges,
      { id: 'A->A#1', source: 'A', target: 'A', type: 'transition', data: { actionLabel: 'ulang', action: 'UPDATE_STATUS' } },
    ];
    const decision = decideConnectEnd(
      { isValid: null, fromId: 'A', toId: 'A', fromHandleId: HANDLE_IDS.right, pointerNodeId: null },
      withLoop,
    );
    expect(decision).toEqual({
      kind: 'message',
      message: 'Status A sudah punya transisi ke dirinya sendiri.',
    });
  });

  it('never creates a self-loop on a canvas-only terminal marker', () => {
    const decision = decideConnectEnd(
      { isValid: null, fromId: START_NODE_ID, toId: START_NODE_ID, fromHandleId: HANDLE_IDS.right, pointerNodeId: null },
      edges,
    );
    expect(decision).toEqual({ kind: 'none' });
  });

  it('delegates a rejected two-node drop to the rejection message', () => {
    const decision = decideConnectEnd(
      { isValid: false, fromId: 'A', toId: 'B', fromHandleId: HANDLE_IDS.right, pointerNodeId: null },
      edges,
    );
    expect(decision).toEqual({ kind: 'message', message: 'Transisi dari A ke B sudah ada.' });
  });

  it('does nothing for a drag dropped in empty space (no target node)', () => {
    const decision = decideConnectEnd(
      { isValid: null, fromId: 'A', toId: null, fromHandleId: HANDLE_IDS.right, pointerNodeId: null },
      edges,
    );
    expect(decision).toEqual({ kind: 'none' });
  });

  describe('released over the card BODY (pointerNodeId fallback)', () => {
    // React Flow reports `toNode` only when the release landed on a HANDLE. The
    // manager's real gesture is "drag out of the status, drag back onto the
    // status, release" — usually over the card body, where React Flow reports
    // nothing at all. The component resolves that node from the DOM and passes
    // it as `pointerNodeId`.
    it('creates the self-loop when the pointer was over the node the drag started on', () => {
      const decision = decideConnectEnd(
        { isValid: null, fromId: 'A', toId: null, fromHandleId: HANDLE_IDS.right, pointerNodeId: 'A' },
        edges,
      );
      expect(decision).toEqual({
        kind: 'self-loop',
        source: 'A',
        sourceHandle: HANDLE_IDS.right,
        targetHandle: HANDLE_IDS.top,
      });
    });

    it('never hijacks a release over a DIFFERENT node (React Flow owns that drop)', () => {
      const decision = decideConnectEnd(
        { isValid: null, fromId: 'A', toId: null, fromHandleId: HANDLE_IDS.right, pointerNodeId: 'B' },
        edges,
      );
      expect(decision).toEqual({ kind: 'none' });
    });

    it('never fires for a release over a canvas-only terminal marker', () => {
      // The markers are `.react-flow__node` wrappers too, so the DOM lookup CAN
      // resolve one — the id equality check is what rejects it.
      const decision = decideConnectEnd(
        {
          isValid: null,
          fromId: 'A',
          toId: null,
          fromHandleId: HANDLE_IDS.right,
          pointerNodeId: END_NODE_ID,
        },
        edges,
      );
      expect(decision).toEqual({ kind: 'none' });
    });

    it('explains a duplicate instead of adding a second loop', () => {
      const withLoop: FlowEdge[] = [
        ...edges,
        { id: 'A->A#1', source: 'A', target: 'A', type: 'transition', data: { actionLabel: 'ulang', action: 'UPDATE_STATUS' } },
      ];
      const decision = decideConnectEnd(
        { isValid: null, fromId: 'A', toId: null, fromHandleId: HANDLE_IDS.right, pointerNodeId: 'A' },
        withLoop,
      );
      expect(decision).toEqual({
        kind: 'message',
        message: 'Status A sudah punya transisi ke dirinya sendiri.',
      });
    });

    it("prefers React Flow's own target over the pointer fallback", () => {
      // Release on B's handle while the pointer also overlaps A's card: React
      // Flow evaluated A→B, so that is the drop — not a self-loop on A.
      const decision = decideConnectEnd(
        { isValid: null, fromId: 'A', toId: 'B', fromHandleId: HANDLE_IDS.right, pointerNodeId: 'A' },
        edges,
      );
      expect(decision).toEqual({ kind: 'none' });
    });
  });
});

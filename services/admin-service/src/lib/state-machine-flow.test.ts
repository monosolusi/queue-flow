import { describe, expect, it } from 'vitest';
import {
  autoLayout,
  flowToGraph,
  formToFlow,
  nextStateName,
  withDescriptions,
  isDuplicateTransition,
  rejectionMessageForConnection,
  HANDLE_IDS,
  DEFAULT_SOURCE_HANDLE,
  DEFAULT_TARGET_HANDLE,
  EDGE_ARROW_MARKER,
  type FlowEdge,
} from './state-machine-flow';
import { defaultStateMachineForm } from './state-machine';
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
    expect(DEFAULT_SOURCE_HANDLE).toBe(HANDLE_IDS.rightSource);
    expect(DEFAULT_TARGET_HANDLE).toBe(HANDLE_IDS.leftTarget);
  });

  it('preserves prior handle routing for surviving edges across a re-seed', () => {
    // External re-seed preserves the manager-chosen side (a vertical edge
    // stays vertical) via the handleMap arg, mirroring position preservation.
    // Edges with no prior routing entry fall back to the L→R default.
    const form = defaultStateMachineForm();
    const handleMap = {
      // WAITING->CALLING was a manager-drawn vertical edge (out the bottom,
      // into the top) — it must keep that routing, not snap back to L→R.
      'WAITING->CALLING': {
        sourceHandle: HANDLE_IDS.bottomSource,
        targetHandle: HANDLE_IDS.topTarget,
      },
    };
    const { edges } = formToFlow(form, {}, handleMap);
    const waitingCalling = edges.find((e) => e.source === 'WAITING' && e.target === 'CALLING')!;
    expect(waitingCalling.sourceHandle).toBe(HANDLE_IDS.bottomSource);
    expect(waitingCalling.targetHandle).toBe(HANDLE_IDS.topTarget);
    // An edge with no prior routing entry falls back to the L→R default.
    const callingServing = edges.find((e) => e.source === 'CALLING' && e.target === 'SERVING')!;
    expect(callingServing.sourceHandle).toBe(DEFAULT_SOURCE_HANDLE);
    expect(callingServing.targetHandle).toBe(DEFAULT_TARGET_HANDLE);
  });

  it('exposes eight handle ids — source + target on every side', () => {
    // The manager can draw an edge in any direction (down/up/left/right) only
    // if every side has both an outgoing (source) and incoming (target) handle.
    // Pinning the full set guards against a regression that drops a side.
    const ids = new Set(Object.values(HANDLE_IDS));
    expect(ids.size).toBe(8);
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(HANDLE_IDS[`${side}Source` as keyof typeof HANDLE_IDS]).toBe(`${side}-source`);
      expect(HANDLE_IDS[`${side}Target` as keyof typeof HANDLE_IDS]).toBe(`${side}-target`);
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
    expect(transitions).toEqual(DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })));
  });

  it('preserves node array order as the states order', () => {
    const nodes = [
      { id: 'C', type: 'state', position: { x: 0, y: 0 }, data: { name: 'C', description: '' } },
      { id: 'A', type: 'state', position: { x: 0, y: 0 }, data: { name: 'A', description: '' } },
    ];
    const { states } = flowToGraph(nodes, []);
    expect(states).toEqual(['C', 'A']);
  });

  it('drops sourceHandle/targetHandle — handle routing never reaches the wire', () => {
    // The load-bearing invariant of the vertical-edges feature: handle fields
    // are CANVAS-ONLY. flowToGraph must emit a Transition with exactly
    // { from, to, actionLabel } — never sourceHandle/targetHandle — so the PUT
    // /api/system/config payload (and the StateMachineDto wire contract) is
    // unchanged. An explicit keys assertion gives a clear regression message
    // (the round-trip toEqual guards it implicitly but doesn't name the rule).
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
        sourceHandle: HANDLE_IDS.bottomSource,
        targetHandle: HANDLE_IDS.topTarget,
      },
    ];
    const { transitions } = flowToGraph(nodes, edges);
    expect(transitions).toHaveLength(1);
    expect(Object.keys(transitions[0]).sort()).toEqual(['actionLabel', 'from', 'to']);
    expect(transitions[0]).toEqual({ from: 'A', to: 'B', actionLabel: 'go' });
  });

  it('drops markerEnd — the arrow never reaches the wire', () => {
    // Mirrors the sourceHandle/targetHandle drop test above: `markerEnd` is
    // CANVAS-ONLY (like handle routing), so the PUT /api/system/config payload
    // (and the StateMachineDto wire contract) is unchanged. An explicit keys
    // assertion guards the rule: the wire Transition has exactly { from, to,
    // actionLabel } — never markerEnd.
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
        sourceHandle: HANDLE_IDS.bottomSource,
        targetHandle: HANDLE_IDS.topTarget,
        markerEnd: EDGE_ARROW_MARKER,
      },
    ];
    const { transitions } = flowToGraph(nodes, edges);
    expect(transitions).toHaveLength(1);
    expect(Object.keys(transitions[0]).sort()).toEqual(['actionLabel', 'from', 'to']);
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
    // The output shape is exactly `{ states, transitions }` — no `description` key.
    expect(Object.keys(result).sort()).toEqual(['states', 'transitions']);
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

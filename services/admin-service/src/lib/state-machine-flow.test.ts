import { describe, expect, it } from 'vitest';
import {
  autoLayout,
  flowToGraph,
  formToFlow,
  nextStateName,
  withDescriptions,
  HANDLE_IDS,
  DEFAULT_SOURCE_HANDLE,
  DEFAULT_TARGET_HANDLE,
} from './state-machine-flow';
import { defaultStateMachineForm } from './state-machine';
import { DEFAULT_STATE_MACHINE } from '../api/types';

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
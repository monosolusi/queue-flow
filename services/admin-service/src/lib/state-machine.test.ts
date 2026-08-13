import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_MACHINE } from '../api/types';
import {
  CANONICAL_STATE_DESCRIPTIONS,
  DEFAULT_SOURCE_SIDE,
  DEFAULT_TARGET_SIDE,
  addTransition,
  defaultStateMachineForm,
  describeState,
  graphSignature,
  isDefaultGraph,
  mergeEdgeSides,
  missingCanonicalStates,
  toEdgeRoutingLayoutDto,
  toNodePositionsDto,
  toStateMachineDto,
  updateState,
  updateTransition,
  validateCustomStateMachine,
  type StateMachineForm,
} from './state-machine';

describe('toStateMachineDto (wire-boundary mapping)', () => {
  it('strips the client-only mode preset', () => {
    const dto = toStateMachineDto({ ...defaultStateMachineForm(), mode: 'custom' });
    expect((dto as unknown as Record<string, unknown>).mode).toBeUndefined();
  });

  it('sends the edited graph in custom mode', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
      positions: {},
    };
    expect(toStateMachineDto(form)).toEqual({
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
    });
  });

  it('force-resets to the PRD §7 default graph in default mode, even when the form carries an edited graph', () => {
    // The editor's default-radio replaces the graph today, so this is the
    // defense against that ever changing: a `mode: 'default'` form whose graph
    // was left half-edited must NOT ship that graph as "the default". Both the
    // wizard's finalize and the panel's save map through here, so neither
    // surface can be the one that leaks it.
    const abandoned: StateMachineForm = {
      mode: 'default',
      states: ['WAITING', 'BOGUS'],
      transitions: [{ from: 'WAITING', to: 'BOGUS', actionLabel: 'Setengah Jadi' }],
      positions: {},
    };
    expect(toStateMachineDto(abandoned)).toEqual({
      states: [...DEFAULT_STATE_MACHINE.states],
      transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    });
  });

  it('deep-copies the default graph so a later mutation cannot corrupt the shared constant', () => {
    const dto = toStateMachineDto(defaultStateMachineForm());
    expect(dto.states).not.toBe(DEFAULT_STATE_MACHINE.states);
    expect(dto.transitions[0]).not.toBe(DEFAULT_STATE_MACHINE.transitions[0]);
  });
});

describe('validateCustomStateMachine (Indonesian, no internal terms)', () => {
  it('accepts the PRD §7 default graph', () => {
    expect(validateCustomStateMachine({ ...defaultStateMachineForm(), mode: 'custom' })).toEqual([]);
  });

  it('reports an empty schema in manager-facing Indonesian', () => {
    const errors = validateCustomStateMachine({ mode: 'custom', states: [], transitions: [], positions: {} });
    expect(errors).toContain('Alur status harus memiliki minimal satu status.');
    expect(errors).toContain('Alur status harus memiliki minimal satu transisi.');
    // "state machine" / "state" is developer vocabulary — the editor is on
    // /config now, which the store manager uses daily.
    expect(errors.join(' ')).not.toMatch(/state/i);
  });

  it('reports a duplicate status, an empty name, and an unknown transition endpoint', () => {
    const errors = validateCustomStateMachine({
      mode: 'custom',
      states: ['WAITING', 'WAITING', ' '],
      transitions: [{ from: 'WAITING', to: 'GHOST', actionLabel: 'Panggil' }],
      positions: {},
    });
    expect(errors).toContain("Status 'WAITING' duplikat.");
    expect(errors).toContain('Nama status tidak boleh kosong.');
    expect(errors).toContain("Transisi 'WAITING'→'GHOST': status 'GHOST' tidak dikenal.");
    expect(errors.join(' ')).not.toMatch(/\bstate\b/i);
  });

  it('reports a duplicate edge and an empty action label', () => {
    const errors = validateCustomStateMachine({
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
        { from: 'WAITING', to: 'CALLING', actionLabel: '' },
      ],
      positions: {},
    });
    expect(errors).toContain("Transisi 'WAITING'→'CALLING' duplikat.");
    expect(errors).toContain('Label aksi tidak boleh kosong.');
  });

  it('never reports a dropped standard status as an error (that is a warning, not a gate)', () => {
    // The save/Lanjut gate reads this list, so a dropped standard status must
    // NOT appear here — the backend accepts such a graph and a custom flow may
    // legitimately skip a status. `missingCanonicalStates` carries it instead.
    const noCompleted: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
      positions: {},
    };
    expect(validateCustomStateMachine(noCompleted)).toEqual([]);
    expect(missingCanonicalStates(noCompleted).length).toBeGreaterThan(0);
  });
});

describe('missingCanonicalStates (non-blocking dropped-standard-status warning)', () => {
  it('reports nothing when the custom graph keeps every standard status', () => {
    expect(missingCanonicalStates({ ...defaultStateMachineForm(), mode: 'custom' })).toEqual([]);
  });

  it('reports nothing in default mode (the default graph always ships verbatim)', () => {
    // A `mode: 'default'` form is force-reset to the standard graph at the wire
    // boundary, so its live `states` can never be what gets saved.
    expect(
      missingCanonicalStates({ mode: 'default', states: [], transitions: [], positions: {} }),
    ).toEqual([]);
  });

  it('names each dropped status in standard-flow order with what stops working', () => {
    const missing = missingCanonicalStates({
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
      positions: {},
    });
    expect(missing.map((m) => m.state)).toEqual(['SERVING', 'SKIPPED', 'COMPLETED']);
    // The consequence names the caller BUTTON / the report metric, never the
    // backend mechanism — the reader is a non-technical store manager.
    const completed = missing.find((m) => m.state === 'COMPLETED');
    expect(completed?.consequence).toContain('Selesai Layan');
    expect(completed?.consequence).toContain('laporan');
    expect(missing.map((m) => m.consequence).join(' ')).not.toMatch(/state|schema|endpoint/i);
  });

  it('ignores surrounding whitespace when matching a status name', () => {
    // The editor uppercases on input but does not trim, so a stray space must
    // not fake a "dropped" status the manager can plainly see in the list.
    const padded = missingCanonicalStates({
      mode: 'custom',
      states: [' WAITING ', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED'],
      transitions: [{ from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' }],
      positions: {},
    });
    expect(padded).toEqual([]);
  });
});

describe('describeState (client-side description derivation)', () => {
  it('returns the canonical description for each of the 5 PRD §7 default states', () => {
    const form = defaultStateMachineForm();
    expect(describeState(form, 'WAITING')).toBe(CANONICAL_STATE_DESCRIPTIONS.WAITING);
    expect(describeState(form, 'CALLING')).toBe(CANONICAL_STATE_DESCRIPTIONS.CALLING);
    expect(describeState(form, 'SERVING')).toBe(CANONICAL_STATE_DESCRIPTIONS.SERVING);
    expect(describeState(form, 'SKIPPED')).toBe(CANONICAL_STATE_DESCRIPTIONS.SKIPPED);
    expect(describeState(form, 'COMPLETED')).toBe(CANONICAL_STATE_DESCRIPTIONS.COMPLETED);
  });

  it('derives a `${n} transisi keluar` summary for a custom state with outgoing transitions', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'ONHOLD', 'CALLING'],
      transitions: [
        { from: 'ONHOLD', to: 'WAITING', actionLabel: 'Kembali' },
        { from: 'ONHOLD', to: 'CALLING', actionLabel: 'Lanjut' },
      ],
      positions: {},
    };
    expect(describeState(form, 'ONHOLD')).toBe('2 transisi keluar');
  });

  it('derives "Status kustom" for a custom state with 0 outgoing transitions', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'ONHOLD'],
      transitions: [{ from: 'WAITING', to: 'ONHOLD', actionLabel: 'Tahan' }],
      positions: {},
    };
    // ONHOLD has no outgoing transition (only incoming) — the 0-outgoing branch.
    expect(describeState(form, 'ONHOLD')).toBe('Status kustom');
  });

  it('the canonical description wins even when the canonical state also has outgoing transitions', () => {
    // WAITING has 1 outgoing transition in the default graph, but the canonical
    // description takes precedence over the derived `${n} transisi keluar` form.
    const form = defaultStateMachineForm();
    expect(describeState(form, 'WAITING')).toBe('Tiket menunggu dipanggil');
    expect(describeState(form, 'CALLING')).toBe('Sedang dipanggil ke counter');
  });

  it('the description is never serialized (wire contract unchanged)', () => {
    // `describeState` is a pure client-side helper; it adds NO field to the
    // wire form. `toStateMachineDto` strips `mode` and emits `{ states,
    // transitions }` — no `description` key.
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'ONHOLD'],
      transitions: [{ from: 'WAITING', to: 'ONHOLD', actionLabel: 'Tahan' }],
      positions: {},
    };
    describeState(form, 'ONHOLD'); // derive (no-op on the wire shape)
    const dto = toStateMachineDto(form);
    expect((dto as unknown as Record<string, unknown>).description).toBeUndefined();
    expect(Object.keys(dto).sort()).toEqual(['states', 'transitions']);
  });
});

describe('connection sides (sourceSide / targetSide)', () => {
  it('toStateMachineDto strips sides — they never reach the wire StateTransitionDto', () => {
    // The wire contract is unchanged: sides travel in the separate
    // `edgeRoutingLayout` map, NOT on the wire transitions. A custom form with
    // a vertical edge still emits `{ from, to, actionLabel }` on the wire.
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil', sourceSide: 'bottom', targetSide: 'top' },
      ],
      positions: {},
    };
    const dto = toStateMachineDto(form);
    expect(dto.transitions).toEqual([{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' }]);
    expect(Object.keys(dto.transitions[0] as object).sort()).toEqual(['actionLabel', 'from', 'to']);
  });

  it('toEdgeRoutingLayoutDto builds the sparse map (default omitted, non-default included)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B', 'C'],
      transitions: [
        { from: 'A', to: 'B', actionLabel: 'go' }, // default → omitted
        { from: 'B', to: 'C', actionLabel: 'up', sourceSide: 'bottom', targetSide: 'top' },
      ],
      positions: {},
    };
    expect(toEdgeRoutingLayoutDto(form)).toEqual({
      'B->C': { sourceSide: 'bottom', targetSide: 'top' },
    });
  });

  it('toEdgeRoutingLayoutDto returns {} when every edge is default', () => {
    const form = defaultStateMachineForm();
    expect(toEdgeRoutingLayoutDto(form)).toEqual({});
  });

  it('toNodePositionsDto builds the positions map from the form', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 30, y: 40 } },
    };
    expect(toNodePositionsDto(form)).toEqual({
      A: { x: 10, y: 20 },
      B: { x: 30, y: 40 },
    });
  });

  it('toNodePositionsDto returns {} when positions are empty', () => {
    const form = defaultStateMachineForm();
    expect(toNodePositionsDto(form)).toEqual({});
  });

  it('graphSignature canonicalizes undefined→default so explicit-default equals absent', () => {
    // The key anti-re-seed property: a form with explicit default sides and a
    // form with undefined sides produce the SAME signature. After a save+re-GET,
    // `toForm` merges non-default sides back (default edges get undefined), so
    // the post-save signature equals the pre-save signature → no spurious re-seed.
    const explicit: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [
        { from: 'A', to: 'B', actionLabel: 'go', sourceSide: DEFAULT_SOURCE_SIDE, targetSide: DEFAULT_TARGET_SIDE },
      ],
      positions: {},
    };
    const absent: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
    };
    expect(graphSignature(explicit)).toBe(graphSignature(absent));
  });

  it('graphSignature differs when the sides differ', () => {
    const vertical: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', sourceSide: 'bottom', targetSide: 'top' }],
      positions: {},
    };
    const horizontal: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
    };
    expect(graphSignature(vertical)).not.toBe(graphSignature(horizontal));
  });

  it('graphSignature differs when positions differ', () => {
    // Positions are part of the anti-re-seed signature — a moved node changes
    // the signature, so a save+re-GET (which carries positions back) does NOT
    // spuriously re-seed the canvas. Conversely, an unchanged graph with the
    // same positions produces the same signature → no re-seed.
    const positioned: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 10, y: 20 } },
    };
    const moved: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 99, y: 20 } },
    };
    expect(graphSignature(positioned)).not.toBe(graphSignature(moved));
  });

  it('isDefaultGraph returns false when a default-structure graph has a non-default side', () => {
    // A graph that structurally matches the PRD §7 default but has a custom-
    // routed edge is CUSTOM (the manager touched the handle routing) → loads
    // as `mode: 'custom'` (editable), not `mode: 'default'` (read-only).
    const transitions = DEFAULT_STATE_MACHINE.transitions.map((t, i) =>
      i === 3 // SKIPPED → CALLING back-edge with a vertical routing
        ? { ...t, sourceSide: 'top' as const, targetSide: 'bottom' as const }
        : { ...t },
    );
    expect(isDefaultGraph([...DEFAULT_STATE_MACHINE.states], transitions)).toBe(false);
  });

  it('isDefaultGraph returns true for the all-default graph', () => {
    expect(
      isDefaultGraph([...DEFAULT_STATE_MACHINE.states], DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t }))),
    ).toBe(true);
  });

  it('isDefaultGraph returns false when positions are present', () => {
    // A graph that structurally matches the PRD §7 default but has node
    // positions is CUSTOM (the manager dragged a node) → loads as `mode:
    // 'custom'` (editable), not `mode: 'default'` (read-only).
    expect(
      isDefaultGraph(
        [...DEFAULT_STATE_MACHINE.states],
        DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
        { WAITING: { x: 0, y: 0 } },
      ),
    ).toBe(false);
  });

  it('updateState (rename) preserves sourceSide/targetSide on affected transitions', () => {
    // Regression: before the fix the rename rebuilt each transition as
    // `{ from, to, actionLabel }`, dropping the sides and snapping a vertical
    // edge back to L→R. The spread form preserves them.
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil', sourceSide: 'bottom', targetSide: 'top' },
      ],
      positions: { WAITING: { x: 10, y: 20 }, CALLING: { x: 30, y: 40 } },
    };
    const renamed = updateState(form, 0, 'PENDING');
    expect(renamed.transitions[0].from).toBe('PENDING');
    expect(renamed.transitions[0].sourceSide).toBe('bottom');
    expect(renamed.transitions[0].targetSide).toBe('top');
    // The position key follows the rename (WAITING → PENDING).
    expect(renamed.positions.PENDING).toEqual({ x: 10, y: 20 });
    expect(renamed.positions.WAITING).toBeUndefined();
  });

  it('updateTransition preserves existing sides when patching from/to/actionLabel', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', sourceSide: 'bottom', targetSide: 'top' }],
      positions: {},
    };
    const patched = updateTransition(form, 0, { actionLabel: 'go fast' });
    expect(patched.transitions[0].actionLabel).toBe('go fast');
    expect(patched.transitions[0].sourceSide).toBe('bottom');
    expect(patched.transitions[0].targetSide).toBe('top');
  });

  it('addTransition creates a new transition with no sides (default routing)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
    };
    const added = addTransition(form);
    expect(added.transitions[1].sourceSide).toBeUndefined();
    expect(added.transitions[1].targetSide).toBeUndefined();
  });
});

describe('mergeEdgeSides (wire map → form transitions)', () => {
  it('merges a sparse map — present edges get sides, absent edges get none', () => {
    const transitions = DEFAULT_STATE_MACHINE.transitions;
    const layout = { 'SKIPPED->CALLING': { sourceSide: 'top' as const, targetSide: 'bottom' as const } };
    const merged = mergeEdgeSides(transitions, layout);
    // The SKIPPED→CALLING back-edge carries the vertical sides.
    const back = merged.find((t) => t.from === 'SKIPPED' && t.to === 'CALLING')!;
    expect(back.sourceSide).toBe('top');
    expect(back.targetSide).toBe('bottom');
    // Every other edge has no sides (undefined → default routing).
    const others = merged.filter((t) => !(t.from === 'SKIPPED' && t.to === 'CALLING'));
    expect(others.every((t) => t.sourceSide === undefined && t.targetSide === undefined)).toBe(true);
  });

  it('undefined edgeLayout yields all-default transitions (no sides)', () => {
    const merged = mergeEdgeSides(DEFAULT_STATE_MACHINE.transitions, undefined);
    expect(merged.every((t) => t.sourceSide === undefined && t.targetSide === undefined)).toBe(true);
  });

  it('empty edgeLayout yields all-default transitions', () => {
    const merged = mergeEdgeSides(DEFAULT_STATE_MACHINE.transitions, {});
    expect(merged.every((t) => t.sourceSide === undefined && t.targetSide === undefined)).toBe(true);
  });

  it('is the inverse of toEdgeRoutingLayoutDto (round-trip)', () => {
    // Build a form with a vertical edge, serialize to the sparse wire map, then
    // merge back — the merged transitions carry the same sides.
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B', 'C'],
      transitions: [
        { from: 'A', to: 'B', actionLabel: 'go' }, // default
        { from: 'B', to: 'C', actionLabel: 'up', sourceSide: 'bottom', targetSide: 'top' }, // vertical
      ],
      positions: {},
    };
    const wire = toEdgeRoutingLayoutDto(form);
    const merged = mergeEdgeSides(
      form.transitions.map((t) => ({ from: t.from, to: t.to, actionLabel: t.actionLabel })),
      wire,
    );
    expect(merged[0].sourceSide).toBeUndefined();
    expect(merged[1].sourceSide).toBe('bottom');
    expect(merged[1].targetSide).toBe('top');
  });

  it('uses explicit fields (not spread) so an EdgeSides widening cannot leak extras', () => {
    // A malicious / future entry with an extra field must NOT leak onto the
    // Transition — only sourceSide/targetSide are copied.
    const transitions = [{ from: 'A', to: 'B', actionLabel: 'go' }];
    const layout = { 'A->B': { sourceSide: 'bottom', targetSide: 'top', extra: 'leak' } as unknown as { sourceSide: 'bottom'; targetSide: 'top' } };
    const merged = mergeEdgeSides(transitions, layout);
    expect(merged[0].sourceSide).toBe('bottom');
    expect(merged[0].targetSide).toBe('top');
    expect(Object.keys(merged[0]).sort()).toEqual(['actionLabel', 'from', 'sourceSide', 'targetSide', 'to']);
  });
});

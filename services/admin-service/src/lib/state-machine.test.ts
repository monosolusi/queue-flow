import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_MACHINE, DEFAULT_TERMINAL_NODES } from '../api/types';
import {
  CANONICAL_STATE_DESCRIPTIONS,
  DEFAULT_SOURCE_SIDE,
  DEFAULT_TARGET_SIDE,
  addTransition,
  canonicalStatusOf,
  defaultStateMachineForm,
  describeState,
  descriptionFor,
  deriveAutoSources,
  graphSignature,
  stateDegrees,
  isDefaultGraph,
  mergeEdgeSides,
  missingCanonicalStates,
  reconcileStateNameRefs,
  removeState,
  toEdgeRoutingLayoutDto,
  toNodeActionsDto,
  toNodePositionsDto,
  toStateMachineDto,
  toEndSourcesDto,
  toTerminalNodesDto,
  updateState,
  updateStateDescription,
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    expect(toStateMachineDto(form)).toEqual({
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
      // Descriptions travel INSIDE the stateMachine object (full-stack slice);
      // an empty map round-trips as `{}` (the wire payload stays lean).
      descriptions: {},
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    expect(toStateMachineDto(abandoned)).toEqual({
      states: [...DEFAULT_STATE_MACHINE.states],
      transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
      // Default mode force-resets the graph AND the descriptions map (the
      // PRD §7 default machine carries no per-state description overrides).
      descriptions: {},
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
    const errors = validateCustomStateMachine({ mode: 'custom', states: [], transitions: [], positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const });
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    });
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    });
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      missingCanonicalStates({ mode: 'default', states: [], transitions: [], positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const }),
    ).toEqual([]);
  });

  it('names each dropped status in standard-flow order with what stops working', () => {
    const missing = missingCanonicalStates({
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    });
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    });
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    expect(describeState(form, 'ONHOLD')).toBe('2 transisi keluar');
  });

  it('derives "Status kustom" for a custom state with 0 outgoing transitions', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'ONHOLD'],
      transitions: [{ from: 'WAITING', to: 'ONHOLD', actionLabel: 'Tahan' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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

  it('the derived description is never serialized as a top-level `description` key (descriptions travel inside stateMachine)', () => {
    // `describeState` is a pure client-side helper; it adds NO top-level
    // `description` field to the wire form. Per-state description OVERRIDES
    // travel INSIDE the `stateMachine` object as `descriptions` (a full-stack
    // vertical slice), never as a top-level `description` key. The derived
    // fallback copy is never serialized at all.
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'ONHOLD'],
      transitions: [{ from: 'WAITING', to: 'ONHOLD', actionLabel: 'Tahan' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    describeState(form, 'ONHOLD'); // derive (no-op on the wire shape)
    const dto = toStateMachineDto(form);
    expect((dto as unknown as Record<string, unknown>).description).toBeUndefined();
    // The wire shape is `{ states, transitions, descriptions }` — descriptions
    // live inside the stateMachine payload, the derived copy is NOT serialized.
    expect(Object.keys(dto).sort()).toEqual(['descriptions', 'states', 'transitions']);
  });
});

describe('canonicalStatusOf (status the node IS, derived from its name)', () => {
  it('returns the canonical record for each of the 5 PRD §7 default state names', () => {
    // The status is DERIVED from the name (the name IS the system identity),
    // not stored as a separate field — a true free-name vs. hardcoded-status
    // decoupling is out of scope (would need a domain rewrite). The properties
    // panel reads this to surface "what status is this node" (manager feedback:
    // "status node itu apa? masukn d properties").
    const waiting = canonicalStatusOf('WAITING');
    expect(waiting).not.toBeNull();
    expect(waiting?.name).toBe('WAITING');
    expect(waiting?.description).toBe(CANONICAL_STATE_DESCRIPTIONS.WAITING);
    expect(waiting?.consequence).toMatch(/tiket baru dari kiosk/);
    for (const name of DEFAULT_STATE_MACHINE.states) {
      expect(canonicalStatusOf(name)).not.toBeNull();
    }
  });

  it('returns null for a custom (non-canonical) name', () => {
    expect(canonicalStatusOf('ONHOLD')).toBeNull();
    expect(canonicalStatusOf('PREPARING')).toBeNull();
  });

  it('is case-sensitive — the canonical names are load-bearing identities', () => {
    expect(canonicalStatusOf('waiting')).toBeNull();
    expect(canonicalStatusOf('Waiting')).toBeNull();
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: { A: { x: 10, y: 20 }, B: { x: 30, y: 40 } }, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    const absent: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    expect(graphSignature(explicit)).toBe(graphSignature(absent));
  });

  it('graphSignature differs when the sides differ', () => {
    const vertical: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', sourceSide: 'bottom', targetSide: 'top' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    const horizontal: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: { A: { x: 10, y: 20 } }, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    const moved: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 99, y: 20 } }, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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

  it('isDefaultGraph returns false when a terminal marker is pinned or hidden', () => {
    // A structurally-default graph with a non-auto terminal marker is CUSTOM —
    // the manager touched the Start/End marker (pinned it at {x,y} or hid it),
    // so it loads editable, not as the read-only default canvas. Both the
    // pinned-{x,y} and the 'hidden' cases must trip the guard.
    const states = [...DEFAULT_STATE_MACHINE.states];
    const transitions = DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t }));
    expect(
      isDefaultGraph(states, transitions, {}, {
        start: { x: -240, y: 0 },
        end: 'auto',
      }),
    ).toBe(false);
    expect(
      isDefaultGraph(states, transitions, {}, {
        start: 'auto',
        end: 'hidden',
      }),
    ).toBe(false);
  });

  it('isDefaultGraph defaults an absent terminalNodes arg to auto/auto (treats missing as default)', () => {
    // The 4th arg defaults to DEFAULT_TERMINAL_NODES so the legacy 3-arg call
    // sites (which never passed terminalNodes) still read as default when the
    // rest of the graph is default — no silent flip to custom.
    expect(
      isDefaultGraph(
        [...DEFAULT_STATE_MACHINE.states],
        DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
      ),
    ).toBe(true);
  });
});

describe('toTerminalNodesDto (wire-boundary mapping)', () => {
  it('passes the auto/auto default through unchanged', () => {
    const form = defaultStateMachineForm();
    expect(toTerminalNodesDto(form)).toEqual({ start: 'auto', end: 'auto' });
  });

  it('passes the hidden sentinel through unchanged', () => {
    const form: StateMachineForm = {
      ...defaultStateMachineForm(),
      terminalNodes: { start: 'hidden', end: 'hidden' },
    };
    expect(toTerminalNodesDto(form)).toEqual({ start: 'hidden', end: 'hidden' });
  });

  it('deep-copies a pinned {x,y} so the wire payload never aliases the form object', () => {
    // NFR-REL-02 hygiene: the form's mutable position object must not be shared
    // with the wire payload — a later form mutation would otherwise leak into
    // the already-built save request. The pinned {x,y} is the one branch that
    // carries a reference type, so it is the only one that needs a deep copy.
    const pinned = { x: -240, y: 60 };
    const form: StateMachineForm = {
      ...defaultStateMachineForm(),
      terminalNodes: { start: pinned, end: 'auto' },
    };
    const dto = toTerminalNodesDto(form);
    expect(dto.start).toEqual({ x: -240, y: 60 });
    expect(dto.start).not.toBe(pinned); // a NEW object, not the form's reference
    // Mutating the form's object after mapping must not affect the wire payload.
    pinned.x = 9999;
    expect((dto.start as { x: number; y: number }).x).toBe(-240);
  });
});

describe('graphSignature with terminalNodes', () => {
  // graphSignature INCLUDES terminalNodes (canvas-rendered, unlike nodeActions)
  // so a marker add/delete/reposition re-seeds the canvas — except the drag
  // path, which stamps via commit (the signature is computed AFTER the form
  // update, so the dragged position is already in the form → no re-seed).

  it('canonicalizes auto/auto and the DEFAULT_TERMINAL_NODES constant identically', () => {
    const base = {
      mode: 'custom' as const,
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
      nodeActions: {},
      descriptions: {},
      endSources: [],
    };
    const fromConstant: StateMachineForm = { ...base, terminalNodes: { ...DEFAULT_TERMINAL_NODES } };
    const fromLiteral: StateMachineForm = { ...base, terminalNodes: { start: 'auto', end: 'auto' } };
    expect(graphSignature(fromConstant)).toBe(graphSignature(fromLiteral));
  });

  it('differs when a terminal marker is pinned vs auto', () => {
    const base = {
      mode: 'custom' as const,
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
      nodeActions: {},
      descriptions: {},
      endSources: [],
    };
    const auto: StateMachineForm = { ...base, terminalNodes: { start: 'auto', end: 'auto' } };
    const pinned: StateMachineForm = {
      ...base,
      terminalNodes: { start: { x: -240, y: 0 }, end: 'auto' },
    };
    expect(graphSignature(auto)).not.toBe(graphSignature(pinned));
  });

  it('differs when a terminal marker is hidden vs auto', () => {
    const base = {
      mode: 'custom' as const,
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
      nodeActions: {},
      descriptions: {},
      endSources: [],
    };
    const auto: StateMachineForm = { ...base, terminalNodes: { start: 'auto', end: 'auto' } };
    const hidden: StateMachineForm = { ...base, terminalNodes: { start: 'hidden', end: 'auto' } };
    expect(graphSignature(auto)).not.toBe(graphSignature(hidden));
  });

  it('differs when a pinned terminal moves to a new {x,y}', () => {
    const base = {
      mode: 'custom' as const,
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
      nodeActions: {},
      descriptions: {},
      endSources: [],
    };
    const at1: StateMachineForm = {
      ...base,
      terminalNodes: { start: { x: -240, y: 0 }, end: 'auto' },
    };
    const at2: StateMachineForm = {
      ...base,
      terminalNodes: { start: { x: -300, y: 0 }, end: 'auto' },
    };
    expect(graphSignature(at1)).not.toBe(graphSignature(at2));
  });
});

describe('transition mutations (updateState / updateTransition / addTransition)', () => {
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
      positions: { WAITING: { x: 10, y: 20 }, CALLING: { x: 30, y: 40 } }, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    const added = addTransition(form);
    expect(added.transitions[1].sourceSide).toBeUndefined();
    expect(added.transitions[1].targetSide).toBeUndefined();
  });
});

describe('node actions (node-level, panel-only)', () => {
  it('toNodeActionsDto builds the actions map from the form', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
      nodeActions: {
        A: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'B' }],
        B: [
          { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'A' },
          { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'A' },
        ],
      },
      descriptions: {},
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    expect(toNodeActionsDto(form)).toEqual({
      A: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'B' }],
      B: [
        { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'A' },
        { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'A' },
      ],
    });
  });

  it('toNodeActionsDto returns {} when no node actions exist', () => {
    const form = defaultStateMachineForm();
    expect(toNodeActionsDto(form)).toEqual({});
  });

  it('graphSignature is EQUAL for two forms differing only in nodeActions (panel-only exclusion)', () => {
    // The core acceptance of the no-re-seed behavior: a node-action edit must
    // not re-seed the canvas. `graphSignature` excludes `nodeActions` (panel-
    // only, like `mode`), so two forms with identical graph + positions but
    // different nodeActions yield the SAME signature → the sync effect skips
    // the re-seed. The panel reads `form.nodeActions` directly on re-render.
    const base: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
      nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const withActions: StateMachineForm = {
      ...base,
      nodeActions: {
        A: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'B' }],
      },
    };
    expect(graphSignature(withActions)).toBe(graphSignature(base));
  });

  it('updateState (rename) moves the nodeActions entry to the new key + drops the old', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' }],
      positions: { WAITING: { x: 10, y: 20 } },
      nodeActions: {
        WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
      },
      descriptions: {},
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const renamed = updateState(form, 0, 'PENDING');
    expect(renamed.nodeActions.PENDING).toEqual([
      { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' },
    ]);
    expect(renamed.nodeActions.WAITING).toBeUndefined();
  });

  it('removeState drops the nodeActions entry for the removed state', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 30, y: 40 } },
      nodeActions: {
        A: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'B' }],
        B: [{ executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'A' }],
      },
      descriptions: {},
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const removed = removeState(form, 0);
    expect(removed.nodeActions.A).toBeUndefined();
    expect(removed.nodeActions.B).toEqual([
      { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'A' },
    ]);
  });
});

describe('descriptionFor / updateStateDescription (per-state override + fallback)', () => {
  function formWith(descriptions: Record<string, string>): StateMachineForm {
    return { ...defaultStateMachineForm(), mode: 'custom', descriptions };
  }

  it('descriptionFor returns the saved override when present (non-empty)', () => {
    const form = formWith({ WAITING: 'Antrian dimulai di sini' });
    expect(descriptionFor(form, 'WAITING')).toBe('Antrian dimulai di sini');
  });

  it('descriptionFor falls back to describeState when the override is absent', () => {
    const form = formWith({});
    // WAITING is a canonical status → the canonical description is the fallback.
    expect(descriptionFor(form, 'WAITING')).toBe(describeState(form, 'WAITING'));
    expect(descriptionFor(form, 'WAITING')).toBe(CANONICAL_STATE_DESCRIPTIONS.WAITING);
  });

  it('descriptionFor falls back to describeState when the override is empty/whitespace', () => {
    // An empty/whitespace saved value is treated as absent (the key is deleted
    // by updateStateDescription, but a corrupt prefill could leave a blank).
    const form = formWith({ WAITING: '   ' });
    expect(descriptionFor(form, 'WAITING')).toBe(describeState(form, 'WAITING'));
  });

  it('updateStateDescription sets a non-empty value', () => {
    const form = formWith({});
    const next = updateStateDescription(form, 'WAITING', 'Antrian dimulai di sini');
    expect(next.descriptions.WAITING).toBe('Antrian dimulai di sini');
  });

  it('updateStateDescription deletes the key when the value is empty/whitespace', () => {
    const form = formWith({ WAITING: 'Antrian dimulai di sini' });
    const next = updateStateDescription(form, 'WAITING', '');
    expect(next.descriptions.WAITING).toBeUndefined();
    // Whitespace-only also clears.
    const next2 = updateStateDescription(form, 'WAITING', '   ');
    expect(next2.descriptions.WAITING).toBeUndefined();
  });

  it('updateState (rename) moves the descriptions entry to the new key + drops the old', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' }],
      positions: { WAITING: { x: 10, y: 20 } },
      nodeActions: {},
      descriptions: { WAITING: 'Antrian dimulai di sini' },
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const renamed = updateState(form, 0, 'PENDING');
    expect(renamed.descriptions.PENDING).toBe('Antrian dimulai di sini');
    expect(renamed.descriptions.WAITING).toBeUndefined();
  });

  it('removeState drops the descriptions entry for the removed state', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 30, y: 40 } },
      nodeActions: {},
      descriptions: { A: 'Status A', B: 'Status B' },
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const removed = removeState(form, 0);
    expect(removed.descriptions.A).toBeUndefined();
    expect(removed.descriptions.B).toBe('Status B');
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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

describe('toEndSourcesDto (wire-boundary mapping)', () => {
  it('returns a fresh array copy of form.endSources', () => {
    const form: StateMachineForm = {
      ...defaultStateMachineForm(),
      mode: 'custom',
      endSources: ['WAITING', 'CALLING'],
    };
    const dto = toEndSourcesDto(form);
    expect(dto).toEqual(['WAITING', 'CALLING']);
    // A fresh array — mutating the dto must not leak back into the form.
    expect(dto).not.toBe(form.endSources);
  });

  it('returns [] when endSources is empty (the default)', () => {
    const form = defaultStateMachineForm();
    expect(toEndSourcesDto(form)).toEqual([]);
  });
});

describe('endSources cascade (rename / delete)', () => {
  it('updateState (rename) renames an endSources entry referencing the old name', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING', 'ONHOLD'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' }],
      positions: {},
      nodeActions: {},
      descriptions: {},
      endSources: ['WAITING', 'ONHOLD'],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    // Rename ONHOLD (index 2) → DONE.
    const next = updateState(form, 2, 'DONE');
    expect(next.endSources).toEqual(['WAITING', 'DONE']);
    // The state name is renamed too.
    expect(next.states).toContain('DONE');
  });

  it('removeState (delete) drops an endSources entry referencing the removed state', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING', 'ONHOLD'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' }],
      positions: {},
      nodeActions: {},
      descriptions: {},
      endSources: ['WAITING', 'ONHOLD'],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    // Delete ONHOLD (index 2).
    const next = removeState(form, 2);
    expect(next.endSources).toEqual(['WAITING']);
    expect(next.states).not.toContain('ONHOLD');
  });
});

describe('graphSignature with endSources', () => {
  // graphSignature INCLUDES endSources (canvas-rendered, like terminalNodes)
  // so an explicit End connection add/delete re-seeds the canvas. The array is
  // canonicalized (sorted) so the signature is order-insensitive (a re-GET may
  // echo a different order than the client sent).

  it('differs when endSources changes (an explicit End connection added)', () => {
    const base = {
      mode: 'custom' as const,
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
      nodeActions: {},
      descriptions: {},
      terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const without: StateMachineForm = { ...base, endSources: [] };
    const withExplicit: StateMachineForm = { ...base, endSources: ['A'] };
    expect(graphSignature(without)).not.toBe(graphSignature(withExplicit));
  });

  it('is order-insensitive (a re-GET may echo a different order than sent)', () => {
    const base = {
      mode: 'custom' as const,
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
      nodeActions: {},
      descriptions: {},
      terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const a: StateMachineForm = { ...base, endSources: ['A', 'B'] };
    const b: StateMachineForm = { ...base, endSources: ['B', 'A'] };
    expect(graphSignature(a)).toBe(graphSignature(b));
  });
});

describe('isDefaultGraph with endSources', () => {
  it('a non-empty endSources is a customization (loads as custom, not default)', () => {
    // A graph that structurally matches the PRD §7 default but has an explicit
    // End connection is CUSTOM — the manager dragged an arrow into End.
    const states = [...DEFAULT_STATE_MACHINE.states];
    const transitions = DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t }));
    expect(isDefaultGraph(states, transitions, {}, DEFAULT_TERMINAL_NODES, ['WAITING'])).toBe(false);
  });

  it('an empty endSources keeps a default-structure graph default', () => {
    const states = [...DEFAULT_STATE_MACHINE.states];
    const transitions = DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t }));
    expect(isDefaultGraph(states, transitions, {}, DEFAULT_TERMINAL_NODES, [])).toBe(true);
  });
});

describe('stateDegrees / deriveAutoSources (the shared degree predicates)', () => {
  it('counts a normal transition on both ends', () => {
    const { inDeg, outDeg } = stateDegrees(['A', 'B'], [{ from: 'A', to: 'B' }]);
    expect(outDeg.get('A')).toBe(1);
    expect(inDeg.get('A')).toBe(0);
    expect(inDeg.get('B')).toBe(1);
    expect(outDeg.get('B')).toBe(0);
  });

  it('counts a SELF-LOOP toward NEITHER degree', () => {
    // The core of the fix: flow that leaves a status and returns to it brings
    // nothing into the graph and takes nothing out.
    const { inDeg, outDeg } = stateDegrees(['A'], [{ from: 'A', to: 'A' }]);
    expect(inDeg.get('A')).toBe(0);
    expect(outDeg.get('A')).toBe(0);
  });

  it('ignores a transition referencing a state not in the schema', () => {
    const { inDeg, outDeg } = stateDegrees(['A'], [{ from: 'A', to: 'GONE' }]);
    expect(outDeg.get('A')).toBe(0);
    expect(inDeg.get('A')).toBe(0);
  });

  it('derives the default graph entry state (WAITING)', () => {
    expect(
      deriveAutoSources([...DEFAULT_STATE_MACHINE.states], DEFAULT_STATE_MACHINE.transitions),
    ).toEqual(['WAITING']);
  });

  it('keeps an entry state an entry state when it grows a self-loop', () => {
    // The manager's report: WAITING had a Start arrow, drawing WAITING -> WAITING
    // made it in-degree 1 and the Start arrow silently vanished.
    const states = ['A', 'B'];
    const transitions = [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'A' },
      { from: 'B', to: 'B' },
    ];
    expect(deriveAutoSources(states, transitions)).toEqual(['A']);
  });

  it('treats a self-loop-ONLY state as isolated (not an entry point)', () => {
    const states = ['A', 'B', 'LOOPY'];
    const transitions = [
      { from: 'A', to: 'B' },
      { from: 'LOOPY', to: 'LOOPY' },
    ];
    expect(deriveAutoSources(states, transitions)).toEqual(['A']);
  });

  it('treats a not-yet-wired state as isolated (the PR #103 invariant)', () => {
    const states = ['A', 'B', 'STRAY'];
    const transitions = [{ from: 'A', to: 'B' }];
    expect(deriveAutoSources(states, transitions)).toEqual(['A']);
  });
});

describe('reconcileStateNameRefs (canvas delete/rename cascade)', () => {
  // The three fields that reference states BY NAME. The save use case
  // cross-checks all of them and 400s on an entry naming a dead state, and no
  // panel lists such an entry — so a stranded name locks the manager out of
  // saving with no in-app way to clear it. This helper is the single cascade
  // the canvas `commit` path runs.
  const refs = () => ({
    nodeActions: {
      COMPLETED: [{ executionType: 'ON_ENTRY' as const, type: 'UPDATE_STATUS' as const, value: 'WAITING' }],
      SERVING: [{ executionType: 'ON_EXIT' as const, type: 'UPDATE_STATUS' as const, value: 'COMPLETED' }],
    },
    descriptions: { COMPLETED: 'Tiket selesai', SERVING: 'Sedang dilayani' },
    endSources: ['COMPLETED'],
  });

  it('remaps every reference to the renamed state (a rename preserves intent)', () => {
    const out = reconcileStateNameRefs(refs(), ['WAITING', 'SERVING', 'SELESAI'], {
      from: 'COMPLETED',
      to: 'SELESAI',
    });
    // The End link follows the rename rather than being dropped.
    expect(out.endSources).toEqual(['SELESAI']);
    expect(out.descriptions).toEqual({ SELESAI: 'Tiket selesai', SERVING: 'Sedang dilayani' });
    // Both the KEY and a referencing action VALUE are remapped.
    expect(out.nodeActions.SELESAI).toEqual([
      { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'WAITING' },
    ]);
    expect(out.nodeActions.SERVING).toEqual([
      { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'SELESAI' },
    ]);
    expect(out.nodeActions.COMPLETED).toBeUndefined();
  });

  it('prunes every reference to a deleted state', () => {
    const out = reconcileStateNameRefs(refs(), ['WAITING', 'SERVING']);
    expect(out.endSources).toEqual([]);
    expect(out.descriptions).toEqual({ SERVING: 'Sedang dilayani' });
    expect(out.nodeActions.COMPLETED).toBeUndefined();
    // A surviving state's action pointing AT the deleted state is dropped —
    // "Update Status ke <deleted>" has no meaning and would fail the same
    // cross-check.
    expect(out.nodeActions.SERVING).toEqual([]);
  });

  it('leaves a fully-live set untouched', () => {
    const input = refs();
    const out = reconcileStateNameRefs(input, ['WAITING', 'SERVING', 'COMPLETED']);
    expect(out.endSources).toEqual(input.endSources);
    expect(out.descriptions).toEqual(input.descriptions);
    expect(out.nodeActions).toEqual(input.nodeActions);
  });

  it('de-duplicates an endSource that a rename collapses onto an existing entry', () => {
    // Defensive: the backend `EndSources.of` rejects a duplicate entry as
    // malformed. `onRenameState` refuses a name already on the canvas, so this
    // is unreachable today — the guard costs one Set.
    const out = reconcileStateNameRefs(
      { nodeActions: {}, descriptions: {}, endSources: ['A', 'B'] },
      ['B'],
      { from: 'A', to: 'B' },
    );
    expect(out.endSources).toEqual(['B']);
  });

  it('never emits a name outside the live state list', () => {
    // The invariant the backend cross-check enforces, asserted directly. The
    // fixture is built so every output collection SURVIVES non-empty — a live
    // key, a live action value and a live end source all remain. An `.every()`
    // over an empty array passes trivially, so a fixture that prunes everything
    // would assert nothing about over-pruning; the non-emptiness expectations
    // below keep this test honest.
    const out = reconcileStateNameRefs(
      {
        nodeActions: {
          // Key dies (COMPLETED is not live).
          COMPLETED: [
            { executionType: 'ON_ENTRY' as const, type: 'UPDATE_STATUS' as const, value: 'WAITING' },
          ],
          // Key lives; first action's value dies, second survives.
          SERVING: [
            { executionType: 'ON_EXIT' as const, type: 'UPDATE_STATUS' as const, value: 'COMPLETED' },
            { executionType: 'ON_ENTRY' as const, type: 'UPDATE_STATUS' as const, value: 'WAITING' },
          ],
        },
        descriptions: { COMPLETED: 'Tiket selesai', SERVING: 'Sedang dilayani' },
        endSources: ['COMPLETED', 'SERVING'],
      },
      ['WAITING', 'SERVING'],
    );
    const live = new Set(['WAITING', 'SERVING']);
    // Non-vacuity: each collection the invariant ranges over is non-empty.
    expect(out.endSources).toEqual(['SERVING']);
    expect(Object.keys(out.descriptions)).toEqual(['SERVING']);
    expect(out.nodeActions.SERVING).toHaveLength(1);
    expect(out.endSources.every((s) => live.has(s))).toBe(true);
    expect(Object.keys(out.descriptions).every((k) => live.has(k))).toBe(true);
    expect(Object.keys(out.nodeActions).every((k) => live.has(k))).toBe(true);
    for (const actions of Object.values(out.nodeActions)) {
      expect(actions.every((a) => live.has(a.value))).toBe(true);
    }
  });

  it('leaves a non-UPDATE_STATUS action value alone (mirrors the backend cross-check)', () => {
    // `NodeActionType` has one member today, so this asserts the GATE rather
    // than live behaviour: a future action type whose `value` is not a state
    // name (a webhook URL, say) must survive a canvas commit instead of being
    // silently deleted. Cast because the union cannot express the future type
    // yet — when it widens, this test starts exercising a real code path.
    const out = reconcileStateNameRefs(
      {
        nodeActions: {
          SERVING: [
            {
              executionType: 'ON_ENTRY' as const,
              type: 'WEBHOOK' as unknown as 'UPDATE_STATUS',
              value: 'http://printer.local/notify',
            },
          ],
        },
        descriptions: {},
        endSources: [],
      },
      ['SERVING'],
    );
    expect(out.nodeActions.SERVING).toHaveLength(1);
    expect(out.nodeActions.SERVING[0].value).toBe('http://printer.local/notify');
  });
});

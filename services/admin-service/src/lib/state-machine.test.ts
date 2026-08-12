import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_MACHINE } from '../api/types';
import {
  CANONICAL_STATE_DESCRIPTIONS,
  defaultStateMachineForm,
  describeState,
  missingCanonicalStates,
  toStateMachineDto,
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
    const errors = validateCustomStateMachine({ mode: 'custom', states: [], transitions: [] });
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
      missingCanonicalStates({ mode: 'default', states: [], transitions: [] }),
    ).toEqual([]);
  });

  it('names each dropped status in standard-flow order with what stops working', () => {
    const missing = missingCanonicalStates({
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
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
    };
    expect(describeState(form, 'ONHOLD')).toBe('2 transisi keluar');
  });

  it('derives "Status kustom" for a custom state with 0 outgoing transitions', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'ONHOLD'],
      transitions: [{ from: 'WAITING', to: 'ONHOLD', actionLabel: 'Tahan' }],
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
    };
    describeState(form, 'ONHOLD'); // derive (no-op on the wire shape)
    const dto = toStateMachineDto(form);
    expect((dto as unknown as Record<string, unknown>).description).toBeUndefined();
    expect(Object.keys(dto).sort()).toEqual(['states', 'transitions']);
  });
});

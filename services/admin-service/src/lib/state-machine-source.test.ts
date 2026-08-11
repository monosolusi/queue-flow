import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE_MACHINE,
  type StateMachineDto,
} from '../api/types';
import {
  addTransition,
  formToJson,
  jsonToForm,
  toStateMachineDto,
  validateCustomStateMachine,
  type StateMachineForm,
} from './state-machine';

/** The PRD §7 default graph as a `StateMachineForm` in default mode. */
function defaultForm(): StateMachineForm {
  return {
    mode: 'default',
    states: [...DEFAULT_STATE_MACHINE.states],
    transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
  };
}

describe('formToJson', () => {
  it('serializes the graph as indented JSON with states then transitions', () => {
    const json = formToJson(defaultForm());
    const parsed = JSON.parse(json) as StateMachineDto;
    expect(parsed.states).toEqual(DEFAULT_STATE_MACHINE.states);
    expect(parsed.transitions).toEqual(DEFAULT_STATE_MACHINE.transitions);
    // Deterministic key order: states before transitions.
    expect(json.indexOf('"states"')).toBeLessThan(json.indexOf('"transitions"'));
    // Indented (two-space) for a readable Source view.
    expect(json).toContain('\n  ');
  });

  it('strips the client-only `mode` preset (never in the source view)', () => {
    const json = formToJson({ ...defaultForm(), mode: 'custom' });
    expect(json).not.toContain('"mode"');
  });
});

describe('jsonToForm', () => {
  it('round-trips a valid graph and forces mode to custom', () => {
    const original = formToJson(defaultForm());
    const result = jsonToForm(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.mode).toBe('custom'); // editing source = custom intent
    expect(result.form.states).toEqual(DEFAULT_STATE_MACHINE.states);
    expect(result.form.transitions).toEqual(DEFAULT_STATE_MACHINE.transitions);
  });

  it('rejects malformed JSON without throwing', () => {
    const result = jsonToForm('{ broken');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON tidak valid/i);
  });

  it('rejects an empty string without throwing', () => {
    const result = jsonToForm('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON tidak valid/i);
  });

  it('rejects a non-object root', () => {
    expect(jsonToForm('[]').ok).toBe(false);
    expect(jsonToForm('"hello"').ok).toBe(false);
    expect(jsonToForm('null').ok).toBe(false);
  });

  it('rejects missing states / transitions arrays', () => {
    expect(jsonToForm('{}').ok).toBe(false);
    expect(jsonToForm('{"states":["A"]}').ok).toBe(false);
    expect(jsonToForm('{"transitions":[]}').ok).toBe(false);
    expect(jsonToForm('{"states":"A","transitions":[]}').ok).toBe(false);
  });

  it('rejects a non-string state', () => {
    const result = jsonToForm('{"states":["A",5],"transitions":[]}');
    expect(result.ok).toBe(false);
  });

  it('rejects a transition missing a required string field', () => {
    const result = jsonToForm(
      '{"states":["A","B"],"transitions":[{"from":"A","to":"B"}]}',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/actionLabel/i);
  });

  it('ignores unknown top-level keys (lenient on extras, strict on shape)', () => {
    const result = jsonToForm(
      '{"states":["A","B"],"transitions":[{"from":"A","to":"B","actionLabel":"Go"}],"extra":42}',
    );
    expect(result.ok).toBe(true);
  });

  it('returns the first validation error for a graph the backend would 400', () => {
    // Empty action label — validateCustomStateMachine flags it.
    const result = jsonToForm(
      '{"states":["A","B"],"transitions":[{"from":"A","to":"B","actionLabel":""}]}',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/label aksi/i);
  });

  it('returns the first validation error for a duplicate transition edge', () => {
    const result = jsonToForm(
      '{"states":["A","B"],"transitions":[{"from":"A","to":"B","actionLabel":"Go"},{"from":"A","to":"B","actionLabel":"Go Again"}]}',
    );
    expect(result.ok).toBe(false);
  });

  it('the parsed form passes validateCustomStateMachine and toStateMachineDto unchanged', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING', 'SERVING'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
        { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
      ],
    };
    const result = jsonToForm(formToJson(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateCustomStateMachine(result.form)).toEqual([]);
    // Custom mode passes the graph straight through to the wire shape.
    expect(toStateMachineDto(result.form).transitions).toEqual(form.transitions);
  });

  it('a freshly added empty-label transition is caught (mirrors the visual editor invariant)', () => {
    const form = addTransition(defaultForm());
    const result = jsonToForm(formToJson(form));
    expect(result.ok).toBe(false);
  });
});
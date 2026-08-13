import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_MACHINE } from '../api/types';
import {
  addTransition,
  autoLayout,
  toStateMachineDto,
  validateCustomStateMachine,
  type StateMachineForm,
} from './state-machine';
import { formToXml, xmlToForm } from './state-machine-xml';

/** The PRD §7 default graph as a `StateMachineForm` in default mode. */
function defaultForm(): StateMachineForm {
  return {
    mode: 'default',
    states: [...DEFAULT_STATE_MACHINE.states],
    transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    positions: {},
  };
}

describe('formToXml', () => {
  it('serializes the graph as XML with the XML prolog, stateMachine root, states then transitions', () => {
    const xml = formToXml(defaultForm());
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<stateMachine>');
    expect(xml).toContain('</stateMachine>');
    // States come before transitions (deterministic order).
    expect(xml.indexOf('<state ')).toBeLessThan(xml.indexOf('<transition '));
    // Every default state is present as a <state name="..."/>.
    for (const s of DEFAULT_STATE_MACHINE.states) {
      expect(xml).toContain(`<state name="${s}"`);
    }
    // Every default transition is present as a <transition .../>.
    expect(xml).toContain('Panggil Berikutnya');
  });

  it('strips the client-only `mode` preset (never in the source view)', () => {
    const xml = formToXml({ ...defaultForm(), mode: 'custom' });
    expect(xml).not.toContain('mode');
  });

  it('each state carries x/y from form.positions', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 0 } },
    };
    const xml = formToXml(form);
    expect(xml).toContain('<state name="A" x="10" y="20"/>');
    expect(xml).toContain('<state name="B" x="240" y="0"/>');
  });

  it('defaults absent positions to the deterministic autoLayout (matching the diagram)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {},
    };
    const xml = formToXml(form);
    // A is the sole source → rank 0 → x=0; B follows A → rank 1 → x=240; both
    // index 0 in their rank → y=0.
    expect(xml).toContain('<state name="A" x="0" y="0"/>');
    expect(xml).toContain('<state name="B" x="240" y="0"/>');
    // The serialized coordinates MUST equal the autoLayout derivation the
    // Diagram's `formToFlow` uses (XML == diagram derivation, single source
    // of truth).
    const auto = autoLayout(['A', 'B'], [{ from: 'A', to: 'B', actionLabel: 'go' }]);
    expect(auto.A).toEqual({ x: 0, y: 0 });
    expect(auto.B).toEqual({ x: 240, y: 0 });
  });

  it('the XML positions match the Diagram autoLayout for the default graph (single source of truth)', () => {
    const form = defaultForm();
    expect(form.positions).toEqual({}); // un-customized → autoLayout fallback
    const xml = formToXml(form);
    const auto = autoLayout(DEFAULT_STATE_MACHINE.states, DEFAULT_STATE_MACHINE.transitions);
    // Parse each <state name="X" x=".." y=".."/> coordinate out of the XML and
    // assert it equals autoLayout[...] for the same graph — the regression
    // guard proving the XML and the Diagram cannot diverge.
    for (const s of DEFAULT_STATE_MACHINE.states) {
      const re = new RegExp(`<state name="${s}" x="(-?[0-9.]+)" y="(-?[0-9.]+)"/>`);
      const m = xml.match(re);
      expect(m).not.toBeNull();
      const [xStr, yStr] = [m![1], m![2]];
      expect(Number(xStr)).toBe(auto[s].x);
      expect(Number(yStr)).toBe(auto[s].y);
    }
  });

  it('omits sourceSide/targetSide on default-routed transitions', () => {
    const xml = formToXml(defaultForm());
    // No transition in the default graph carries a side.
    expect(xml).not.toContain('sourceSide');
    expect(xml).not.toContain('targetSide');
  });

  it('includes both sides together when either is non-default', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [
        { from: 'A', to: 'B', actionLabel: 'go', sourceSide: 'bottom', targetSide: 'top' },
      ],
      positions: {},
    };
    const xml = formToXml(form);
    expect(xml).toContain('sourceSide="bottom"');
    expect(xml).toContain('targetSide="top"');
  });

  it('materializes the default side when only one is non-default (never half-routed)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', sourceSide: 'bottom' }],
      positions: {},
    };
    const xml = formToXml(form);
    expect(xml).toContain('sourceSide="bottom"');
    // targetSide materialized to the default ('left').
    expect(xml).toContain('targetSide="left"');
  });

  it('escapes XML-special characters in attribute values', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A&B'],
      transitions: [{ from: 'A&B', to: 'A&B', actionLabel: 'go "there" <now>' }],
      positions: {},
    };
    const xml = formToXml(form);
    expect(xml).toContain('name="A&amp;B"');
    expect(xml).toContain('from="A&amp;B"');
    expect(xml).toContain('actionLabel="go &quot;there&quot; &lt;now&gt;"');
    // The serialized XML must parse back without error.
    expect(xmlToForm(xml).ok).toBe(true);
  });

  it('truncates sub-pixel coordinates for stable round-trip text', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A'],
      transitions: [],
      positions: { A: { x: 10.123456, y: 20.999 } },
    };
    const xml = formToXml(form);
    expect(xml).toContain('x="10.12"');
    expect(xml).toContain('y="21"');
  });
});

describe('xmlToForm', () => {
  it('round-trips a valid graph and forces mode to custom', () => {
    const original = formToXml(defaultForm());
    const result = xmlToForm(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.mode).toBe('custom'); // editing source = custom intent
    expect(result.form.states).toEqual(DEFAULT_STATE_MACHINE.states);
    expect(result.form.transitions).toEqual(DEFAULT_STATE_MACHINE.transitions);
  });

  it('rejects malformed XML without throwing', () => {
    const result = xmlToForm('<not-xml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/XML tidak valid/i);
  });

  it('rejects an empty string without throwing', () => {
    const result = xmlToForm('');
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong root tag', () => {
    const result = xmlToForm('<?xml version="1.0"?><graph/>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/<stateMachine>/i);
  });

  it('rejects a missing name on a state', () => {
    const xml = '<?xml version="1.0"?><stateMachine><state x="0" y="0"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/"name"/i);
  });

  it('rejects a missing x or y on a state', () => {
    const xml = '<?xml version="1.0"?><stateMachine><state name="A" y="0"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/"x" dan "y"/i);
  });

  it('rejects a non-numeric x or y', () => {
    const xml = '<?xml version="1.0"?><stateMachine><state name="A" x="abc" y="0"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/angka/i);
  });

  it('rejects a transition missing from/to/actionLabel', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><transition from="A" to="A"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/actionLabel/i);
  });

  it('rejects an invalid sourceSide enum', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><state name="B" x="0" y="0"/><transition from="A" to="B" actionLabel="go" sourceSide="sideways"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/top.*right.*bottom.*left/i);
  });

  it('rejects an invalid targetSide enum', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><state name="B" x="0" y="0"/><transition from="A" to="B" actionLabel="go" targetSide="42"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
  });

  it('leaves sides absent when not present (default routing)', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><state name="B" x="0" y="0"/><transition from="A" to="B" actionLabel="go"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.transitions[0].sourceSide).toBeUndefined();
    expect(result.form.transitions[0].targetSide).toBeUndefined();
  });

  it('parses valid sides and carries them onto the transition', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><state name="B" x="0" y="0"/><transition from="A" to="B" actionLabel="go" sourceSide="bottom" targetSide="top"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.transitions[0].sourceSide).toBe('bottom');
    expect(result.form.transitions[0].targetSide).toBe('top');
  });

  it('ignores unknown elements and attributes (lenient on extras, strict on shape)', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><extra/><state name="A" x="0" y="0" note="hi"/><state name="B" x="0" y="0"/><transition from="A" to="B" actionLabel="go" custom="42"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
  });

  it('returns the first validation error for a graph the backend would 400', () => {
    // Empty action label — validateCustomStateMachine flags it.
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><state name="B" x="0" y="0"/><transition from="A" to="B" actionLabel=""/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/label aksi/i);
  });

  it('returns the first validation error for a duplicate transition edge', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><state name="B" x="0" y="0"/><transition from="A" to="B" actionLabel="Go"/><transition from="A" to="B" actionLabel="Go Again"/></stateMachine>';
    const result = xmlToForm(xml);
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
      positions: {},
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateCustomStateMachine(result.form)).toEqual([]);
    // Custom mode passes the graph straight through to the wire shape.
    expect(toStateMachineDto(result.form).transitions).toEqual(form.transitions);
  });

  it('a freshly added empty-label transition is caught (mirrors the visual editor invariant)', () => {
    const form = addTransition(defaultForm());
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(false);
  });

  it('round-trips node positions through formToXml→xmlToForm', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 80 } },
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.positions.A).toEqual({ x: 10, y: 20 });
    expect(result.form.positions.B).toEqual({ x: 240, y: 80 });
  });

  it('round-trips a non-default-routed edge (sourceSide/targetSide) through formToXml→xmlToForm', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'up', sourceSide: 'bottom', targetSide: 'top' }],
      positions: {},
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.transitions[0].sourceSide).toBe('bottom');
    expect(result.form.transitions[0].targetSide).toBe('top');
  });

  it('the default graph source XML omits sourceSide/targetSide on every transition', () => {
    // Default-routed edges carry no sides in the source (sparse), so the
    // default graph's source has no side attributes — a store that never
    // customized routing sees clean XML.
    const xml = formToXml(defaultForm());
    expect(xml).not.toContain('sourceSide');
    expect(xml).not.toContain('targetSide');
  });
});
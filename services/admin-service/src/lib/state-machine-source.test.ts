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
    positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,  };
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
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 0 } }, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    const xml = formToXml(form);
    // States carry a computed `description` attribute (derived from
    // `describeState`), so the element is no longer a bare `x/y` self-closing
    // tag — assert the name/x/y prefix instead.
    expect(xml).toContain('<state name="A" x="10" y="20"');
    expect(xml).toContain('<state name="B" x="240" y="0"');
  });

  it('defaults absent positions to the deterministic autoLayout (matching the diagram)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    const xml = formToXml(form);
    // A is the sole source → rank 0 → x=0; B follows A → rank 1 → x=240; both
    // index 0 in their rank → y=0.
    expect(xml).toContain('<state name="A" x="0" y="0"');
    expect(xml).toContain('<state name="B" x="240" y="0"');
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
    // Parse each <state name="X" x=".." y=".." .../> coordinate out of the XML
    // and assert it equals autoLayout[...] for the same graph — the regression
    // guard proving the XML and the Diagram cannot diverge. States now carry a
    // trailing `description` attribute, so the regex matches the x/y prefix
    // without requiring a bare self-closing terminator.
    for (const s of DEFAULT_STATE_MACHINE.states) {
      const re = new RegExp(`<state name="${s}" x="(-?[0-9.]+)" y="(-?[0-9.]+)"`);
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    const xml = formToXml(form);
    expect(xml).toContain('sourceSide="bottom"');
    expect(xml).toContain('targetSide="top"');
  });

  it('materializes the default side when only one is non-default (never half-routed)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', sourceSide: 'bottom' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: { A: { x: 10.123456, y: 20.999 } }, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 80 } }, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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

  it('formToXml emits a description attribute only for non-empty overrides (sparse serialization)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 80 } },
      nodeActions: {},
      descriptions: { A: 'Antrian dimulai di sini', B: '' },
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const xml = formToXml(form);
    // A's non-empty override is serialized as a `description` attribute.
    expect(xml).toContain('description="Antrian dimulai di sini"');
    // B's empty value is dropped (sparse) — no `description` attribute on B.
    expect(xml).toContain('<state name="B" x="240" y="80"/>');
    // The derived fallback (canonical copy / transition count) is NOT
    // serialized — only real overrides appear in the source.
    expect(xml).not.toContain('description="1 transisi keluar"');
  });

  it('xmlToForm round-trips the description attribute through formToXml→xmlToForm', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 80 } },
      nodeActions: {},
      descriptions: { A: 'Antrian dimulai di sini' },
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.descriptions.A).toBe('Antrian dimulai di sini');
    // B had no override → no key in the round-tripped descriptions map.
    expect(result.form.descriptions.B).toBeUndefined();
  });

  it('formToXml omits the description attribute entirely when no overrides are present', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 80 } },
      nodeActions: {},
      descriptions: {},
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    const xml = formToXml(form);
    expect(xml).not.toContain('description=');
  });

  it('xmlToForm parses an explicit description attribute and skips an empty one', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<stateMachine>\n' +
      '  <state name="A" x="10" y="20" description="Antrian dimulai di sini"/>\n' +
      '  <state name="B" x="240" y="80" description=""/>\n' +
      '  <transition from="A" to="B" actionLabel="go"/>\n' +
      '</stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.descriptions.A).toBe('Antrian dimulai di sini');
    // An empty description attribute is skipped (sparse — an empty/whitespace
    // override round-trips as an absent key so descriptionFor falls back).
    expect(result.form.descriptions.B).toBeUndefined();
  });
});

describe('formToXml terminal markers + node actions', () => {
  it('always emits <start>/<end> (auto="true" for the default auto/auto)', () => {
    // The manager's "XML harus memuat semua informasi node" feedback: terminal
    // state is explicit, never inferred from absence. The default graph's
    // auto/auto markers serialize as auto="true" self-closing elements AFTER
    // the <transition>s.
    const xml = formToXml(defaultForm());
    expect(xml).toContain('<start auto="true"/>');
    expect(xml).toContain('<end auto="true"/>');
    // Order: <start> before <end>, both after the transitions.
    expect(xml.indexOf('<start ')).toBeGreaterThan(xml.indexOf('<transition '));
    expect(xml.indexOf('<end ')).toBeGreaterThan(xml.indexOf('<start '));
  });

  it('serializes hidden as hidden="true" and a pinned {x,y} as x/y attrs', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'hidden', end: { x: 720, y: 30 } },
    };
    const xml = formToXml(form);
    expect(xml).toContain('<start hidden="true"/>');
    expect(xml).toContain('<end x="720" y="30"/>');
  });

  it('emits <action> children inside <state> (open/close for actions, self-closing otherwise)', () => {
    // The Kaleo-style node-level actions serialize as <action> children; a
    // state WITH actions opens `<state ...>` and closes `</state>`, while a
    // state WITHOUT actions stays self-closing. Under sparse description
    // semantics, no `description` attribute is emitted when the state has no
    // non-empty override in its `descriptions` map.
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {
        A: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'B' }],
      },
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const xml = formToXml(form);
    // A has an action → open tag + child + close (no description override).
    expect(xml).toContain('<state name="A" x="0" y="0">');
    expect(xml).toContain('<action execution="ON_ENTRY" type="UPDATE_STATUS" value="B"/>');
    expect(xml).toContain('</state>');
    // B has no actions → self-closing, no description override.
    expect(xml).toContain('<state name="B" x="240" y="0"/>');
  });
});

describe('xmlToForm round-trips terminalNodes + nodeActions', () => {
  it('round-trips auto/hidden/pinned terminal markers', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'hidden', end: { x: 720, y: 30 } },
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.terminalNodes.start).toBe('hidden');
    expect(result.form.terminalNodes.end).toEqual({ x: 720, y: 30 });
  });

  it('round-trips nodeActions (per-state <action> children)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {
        A: [
          { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'B' },
          { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'CALLING' },
        ],
      },
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.nodeActions.A).toEqual(form.nodeActions.A);
    // A state with no actions round-trips as an absent key (not an empty array).
    expect(result.form.nodeActions.B).toBeUndefined();
  });

  it("defaults absent <start>/<end> to 'auto' (backward-compat with pre-marker XML)", () => {
    // XML written before terminal markers were serialized has no <start>/<end>.
    // The parser defaults both to 'auto' so a legacy source loads cleanly.
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><state name="B" x="240" y="0"/><transition from="A" to="B" actionLabel="go"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.terminalNodes).toEqual({ start: 'auto', end: 'auto' });
  });

  it('rejects a <start> missing x/y (and without auto/hidden) with a manager-facing error', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><start/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/"auto".*"hidden".*"x".*"y"/i);
  });

  it('rejects a non-numeric <end> x/y', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><end x="abc" y="0"/></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/angka/i);
  });
});

describe('endSources XML round-trip', () => {
  it('emits <endSources><source name="X"/></endSources> only when non-empty', () => {
    // Non-empty → the block is emitted with one <source> per entry.
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: ['A', 'B'],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const xml = formToXml(form);
    expect(xml).toContain('<endSources>');
    expect(xml).toContain('<source name="A"/>');
    expect(xml).toContain('<source name="B"/>');
    expect(xml).toContain('</endSources>');
  });

  it('omits the <endSources> block when endSources is empty (default graph stays lean)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const xml = formToXml(form);
    expect(xml).not.toContain('<endSources>');
  });

  it('round-trips endSources through formToXml → xmlToForm', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go' }],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      nodeActions: {},
      descriptions: {},
      endSources: ['A', 'B'],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.endSources).toEqual(['A', 'B']);
  });

  it('drops a stale <source> name not in the parsed states (defensive parse)', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><state name="B" x="240" y="0"/><transition from="A" to="B" actionLabel="go"/><start auto="true"/><end auto="true"/><endSources><source name="A"/><source name="GONE"/></endSources></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 'GONE' is not a parsed state → dropped; 'A' survives.
    expect(result.form.endSources).toEqual(['A']);
  });

  it('rejects a <source> with a missing name attribute', () => {
    const xml =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><start auto="true"/><end auto="true"/><endSources><source/></endSources></stateMachine>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/name/);
  });
});
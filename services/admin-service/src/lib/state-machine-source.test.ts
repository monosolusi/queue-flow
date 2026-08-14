import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_MACHINE } from '../api/types';
import {
  addTransition,
  autoLayout,
  stateDegrees,
  toStateMachineDto,
  validateCustomStateMachine,
  type StateMachineForm,
} from './state-machine';
import { formToXml, xmlToForm } from './state-machine-xml';

/**
 * Codec tests for the Liferay Kaleo `<workflow-definition>` Source view.
 *
 * The manager asked for 1-on-1 parity with Kaleo 7.4's format, so a status is a
 * `<task>` (has outgoing transitions) or a `<state>` (terminal), its transitions
 * nest under it, and every QMS-only facet rides a `<metadata>` CDATA JSON
 * payload — the same escape hatch Kaleo itself uses for canvas coordinates.
 */

/** The PRD §7 default graph as a `StateMachineForm` in default mode. */
function defaultForm(): StateMachineForm {
  return {
    mode: 'default',
    states: [...DEFAULT_STATE_MACHINE.states],
    transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    positions: {},
    nodeActions: {},
    descriptions: {},
    endSources: [],
    terminalNodes: { start: 'auto', end: 'auto' },
  };
}

/**
 * A graph exercising every QMS-only facet at once: custom states, node actions
 * (both execution types), a saved description override, a non-default-routed
 * edge, a hidden Start + a pinned End, and an explicit End connection.
 */
function richForm(): StateMachineForm {
  return {
    mode: 'custom',
    states: ['WAITING', 'VERIFIKASI', 'SERVING', 'COMPLETED'],
    transitions: [
      { from: 'WAITING', to: 'VERIFIKASI', actionLabel: 'Panggil Berikutnya', action: 'UPDATE_STATUS' },
      { from: 'VERIFIKASI', to: 'SERVING', actionLabel: 'Mulai Melayani', action: 'UPDATE_STATUS' },
      {
        from: 'VERIFIKASI',
        to: 'WAITING',
        actionLabel: 'Kembalikan ke Antrian', action: 'UPDATE_STATUS',
        sourceSide: 'bottom',
        targetSide: 'top',
      },
      { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan', action: 'UPDATE_STATUS' },
    ],
    positions: {
      WAITING: { x: 0, y: 0 },
      VERIFIKASI: { x: 240, y: 0 },
      SERVING: { x: 480, y: 0 },
      COMPLETED: { x: 720, y: 0 },
    },
    nodeActions: {
      VERIFIKASI: [
        { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'VERIFIKASI' },
        { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'SERVING' },
      ],
    },
    descriptions: { VERIFIKASI: 'Petugas memeriksa berkas pelanggan' },
    terminalNodes: { start: 'hidden', end: { x: 960, y: 30 } },
    endSources: ['SERVING'],
  };
}

/** A graph with a self-loop alongside real flow (CALLING re-calls itself). */
function selfLoopForm(): StateMachineForm {
  return {
    mode: 'custom',
    states: ['WAITING', 'CALLING', 'COMPLETED'],
    transitions: [
      { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya', action: 'UPDATE_STATUS' },
      { from: 'CALLING', to: 'CALLING', actionLabel: 'Panggil Ulang', action: 'UPDATE_STATUS' },
      { from: 'CALLING', to: 'COMPLETED', actionLabel: 'Selesai Layan', action: 'UPDATE_STATUS' },
    ],
    positions: {},
    nodeActions: {},
    descriptions: {},
    endSources: [],
    terminalNodes: { start: 'auto', end: 'auto' },
  };
}

/**
 * A one-status graph. It carries a self-loop because `validateCustomStateMachine`
 * requires at least one transition — a lone status with no transitions is not a
 * legal graph on either view (see the dedicated rejection test below).
 */
function singleStateForm(): StateMachineForm {
  return {
    mode: 'custom',
    states: ['WAITING'],
    transitions: [{ from: 'WAITING', to: 'WAITING', actionLabel: 'Panggil Ulang', action: 'UPDATE_STATUS' }],
    positions: {},
    nodeActions: {},
    descriptions: {},
    endSources: [],
    terminalNodes: { start: 'auto', end: 'auto' },
  };
}

const ROUND_TRIP_FIXTURES: ReadonlyArray<readonly [string, () => StateMachineForm]> = [
  ['the PRD §7 default graph', defaultForm],
  ['a graph with custom states, actions, descriptions, terminals, endSources and edge sides', richForm],
  ['a self-loop graph', selfLoopForm],
  ['a single-status graph', singleStateForm],
];

/** Coordinate rounding, mirroring the codec's 2-decimal truncation. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The form as the codec canonicalizes it. `xmlToForm(formToXml(f))` equals
 * `canonical(f)` — never less. Two fields are deliberately normalized rather
 * than echoed verbatim, and both GAIN information rather than lose it:
 *
 *  - `mode` is forced to `'custom'` (editing the source is a custom-graph intent).
 *  - `positions` is MATERIALIZED: an entry missing from `form.positions` (`{}` for
 *    an un-customized graph) is serialized from the shared `autoLayout`, so the
 *    XML always carries the coordinates the canvas renders (PR #82 — the two
 *    views of one form can never diverge). The parse therefore returns a full map.
 *  - `transitions` is REGROUPED by source status: nesting each transition under
 *    its source node is what makes `from` implicit, so the cross-source
 *    interleaving of the flat array is not expressible. Per-source order — the
 *    only order the Caller's button list depends on — is preserved exactly.
 *
 * `canonical` is idempotent, and `formToXml` is a fixed point over it; both are
 * asserted below, which is what actually proves the round-trip is lossless.
 */
function canonical(form: StateMachineForm): StateMachineForm {
  const auto = autoLayout(form.states, form.transitions);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const name of form.states) {
    const p = form.positions[name] ?? auto[name] ?? { x: 0, y: 0 };
    positions[name] = { x: round(p.x), y: round(p.y) };
  }
  const canonTerminal = (v: StateMachineForm['terminalNodes']['start']) =>
    typeof v === 'object' && v !== null ? { x: round(v.x), y: round(v.y) } : v;
  return {
    ...form,
    mode: 'custom',
    positions,
    // `action` is sparse in the XML (the UPDATE_STATUS default is omitted), so a
    // fixture that leaves it off round-trips as the explicit default. Same shape
    // as materializing positions above: the codec resolves the default on the way
    // back in, and the expected form has to say so.
    transitions: form.states.flatMap((s) =>
      form.transitions
        .filter((t) => t.from === s)
        .map((t) => ({ ...t, action: t.action ?? 'UPDATE_STATUS' })),
    ),
    terminalNodes: {
      start: canonTerminal(form.terminalNodes.start),
      end: canonTerminal(form.terminalNodes.end),
    },
  };
}

/** The exact Kaleo document the PRD §7 default graph serializes to. */
const DEFAULT_GRAPH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:liferay.com:liferay-workflow_7.4.0 http://www.liferay.com/dtd/liferay-workflow-definition_7_4_0.xsd">
  <name>alur-status-tiket</name>
  <description>Alur status tiket antrian: status, aksi otomatis, dan transisi yang jadi tombol di layar petugas.</description>
  <version>1</version>
  <task>
    <name>WAITING</name>
    <metadata><![CDATA[{"xy":[0,0]}]]></metadata>
    <initial>true</initial>
    <labels>
      <label language-id="id_ID">WAITING</label>
    </labels>
    <transitions>
      <transition>
        <labels>
          <label language-id="id_ID">Panggil Berikutnya</label>
        </labels>
        <name>panggil-berikutnya</name>
        <target>CALLING</target>
        <default>true</default>
      </transition>
    </transitions>
  </task>
  <task>
    <name>CALLING</name>
    <metadata><![CDATA[{"xy":[240,0]}]]></metadata>
    <labels>
      <label language-id="id_ID">CALLING</label>
    </labels>
    <transitions>
      <transition>
        <labels>
          <label language-id="id_ID">Mulai Melayani</label>
        </labels>
        <name>mulai-melayani</name>
        <target>SERVING</target>
        <default>true</default>
      </transition>
      <transition>
        <labels>
          <label language-id="id_ID">Lewati / Absen</label>
        </labels>
        <name>lewati-absen</name>
        <target>SKIPPED</target>
        <default>false</default>
      </transition>
    </transitions>
  </task>
  <task>
    <name>SERVING</name>
    <metadata><![CDATA[{"xy":[480,0]}]]></metadata>
    <labels>
      <label language-id="id_ID">SERVING</label>
    </labels>
    <transitions>
      <transition>
        <labels>
          <label language-id="id_ID">Selesai Layan</label>
        </labels>
        <name>selesai-layan</name>
        <target>COMPLETED</target>
        <default>true</default>
      </transition>
    </transitions>
  </task>
  <task>
    <name>SKIPPED</name>
    <metadata><![CDATA[{"xy":[480,120]}]]></metadata>
    <labels>
      <label language-id="id_ID">SKIPPED</label>
    </labels>
    <transitions>
      <transition>
        <labels>
          <label language-id="id_ID">Panggil Ulang</label>
        </labels>
        <name>panggil-ulang</name>
        <target>CALLING</target>
        <default>true</default>
      </transition>
    </transitions>
  </task>
  <state>
    <name>COMPLETED</name>
    <metadata><![CDATA[{"xy":[720,0]}]]></metadata>
    <labels>
      <label language-id="id_ID">COMPLETED</label>
    </labels>
  </state>
</workflow-definition>`;

describe('formToXml — Kaleo workflow-definition shape', () => {
  it('emits the exact Kaleo document for the PRD §7 default graph', () => {
    // The flagship fixture, asserted verbatim: it pins the element names, the
    // Kaleo child order, the derived <initial>/<default>/<name> values, the
    // task-vs-state choice, and the sparse root metadata all at once. A
    // deliberate format change updates this string; an accidental one fails.
    expect(formToXml(defaultForm())).toBe(DEFAULT_GRAPH_XML);
  });

  it('serializes with the XML prolog and a fully namespaced <workflow-definition> root', () => {
    const xml = formToXml(defaultForm());
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    // The full Kaleo root: the workflow namespace, the XSI namespace, and the
    // schemaLocation hint — so a definition copied out of this pane is shaped
    // like a real Kaleo document.
    expect(xml).toContain('xmlns="urn:liferay.com:liferay-workflow_7.4.0"');
    expect(xml).toContain('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
    expect(xml).toContain(
      'xsi:schemaLocation="urn:liferay.com:liferay-workflow_7.4.0 http://www.liferay.com/dtd/liferay-workflow-definition_7_4_0.xsd"',
    );
    expect(xml).toContain('</workflow-definition>');
    // The definition header Kaleo requires.
    expect(xml).toContain('<name>alur-status-tiket</name>');
    expect(xml).toContain('<version>1</version>');
    // Every default status is present as its own node, named by <name>.
    for (const s of DEFAULT_STATE_MACHINE.states) {
      expect(xml).toContain(`<name>${s}</name>`);
    }
    // The action label — the Caller's button text — rides a <label>.
    expect(xml).toContain('<label language-id="id_ID">Panggil Berikutnya</label>');
  });

  it('confines every http(s) literal to the root schema hint (NFR-REL-01 blast radius)', () => {
    // The Kaleo root carries two http(s) literals — the XSI namespace and the
    // schemaLocation XSD hint. Both are INERT: they are text in a generated
    // string rendered into a textarea, no validating parser runs offline, and
    // nothing ever fetches them. `www.w3.org` and `www.liferay.com` are the only
    // hosts allowed to reach the built bundle from here, and both are in
    // core-api's `offline-assets` ALLOWED_HOSTS. This test is the guard that a
    // future edit does not smuggle a THIRD host into the emitted document —
    // e.g. a per-node doc link — where nobody would think to look for it.
    const urls = formToXml(richForm()).match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    const hosts = [...new Set(urls.map((u) => new URL(u).host))];
    expect(hosts.sort()).toEqual(['www.liferay.com', 'www.w3.org']);
    // Every one of them sits on the root element; no node/transition/action
    // carries a URL.
    const [rootLine, ...body] = formToXml(richForm()).split('\n').slice(1);
    expect(rootLine).toContain('xsi:schemaLocation');
    expect(body.join('\n')).not.toMatch(/https?:\/\//);
  });

  it('strips the client-only `mode` preset (never in the source view)', () => {
    const xml = formToXml({ ...defaultForm(), mode: 'custom' });
    expect(xml).not.toContain('mode');
  });

  it('uses <task> for a status with outgoing transitions and <state> for a terminal one', () => {
    const xml = formToXml(defaultForm());
    // COMPLETED is the only sink in the default graph → the only <state>.
    expect(xml).toContain('<state>\n    <name>COMPLETED</name>');
    expect(xml).toContain('<task>\n    <name>WAITING</name>');
    expect((xml.match(/^ {2}<state>$/gm) ?? []).length).toBe(1);
    expect((xml.match(/^ {2}<task>$/gm) ?? []).length).toBe(4);
  });

  it('excludes a self-loop from the tag choice (a self-looping status is a <state>)', () => {
    // The tag reads the SHARED `stateDegrees` predicate, not a local
    // `from === name` filter: a self-loop is flow that leaves a status and
    // returns to it, so it does not stop the status being an exit. The
    // single-status graph is out-degree 0 → <state>.
    const xml = formToXml(singleStateForm());
    expect(xml).toContain('<state>');
    expect(xml).not.toContain('<task>');
    // The tag is a topology LABEL, not a filter — the self-loop transition
    // itself still serializes (Kaleo's <state> permits a <transitions> block).
    expect(xml).toContain('<target>WAITING</target>');
  });

  it('a self-loop on a sink keeps it a <state> (the diagram and the source agree on terminal)', () => {
    // `{A → S, S → S}`: the canvas draws `S → __end` (S is an auto sink —
    // in-degree 1, out-degree 0 once the self-loop is excluded) and the
    // End-marker panel lists S under "Transisi masuk". A local outgoing-count
    // here would emit <task> for S, so the diagram would call S terminal while
    // the source called it "work happens here, then it moves on". One predicate,
    // three consumers — this is the case that pins them together.
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'S'],
      transitions: [
        { from: 'A', to: 'S', actionLabel: 'Lanjut', action: 'UPDATE_STATUS' },
        { from: 'S', to: 'S', actionLabel: 'Ulangi', action: 'UPDATE_STATUS' },
      ],
    };
    const xml = formToXml(form);
    expect(xml).toContain('<task>\n    <name>A</name>');
    expect(xml).toContain('<state>\n    <name>S</name>');
    // Asserted against the SHARED predicate the tag is derived from, so the
    // two cannot drift apart again without this failing. S is terminal
    // (out-degree 0) precisely because its only outgoing edge is a self-loop,
    // which `stateDegrees` counts toward neither degree.
    expect(stateDegrees(form.states, form.transitions).outDeg.get('S')).toBe(0);
    // Both of S's facets survive the round-trip regardless of the tag.
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.transitions).toEqual(form.transitions);
  });

  it('follows the Kaleo child order inside a node: name, metadata, initial, actions, labels, transitions', () => {
    const xml = formToXml(richForm());
    const node = xml.slice(xml.indexOf('<name>VERIFIKASI</name>'), xml.indexOf('</task>', xml.indexOf('<name>VERIFIKASI</name>')));
    const order = ['<metadata>', '<actions>', '<labels>', '<transitions>'].map((tag) => node.indexOf(tag));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it('follows the Kaleo child order inside a transition: labels, name, target, default, metadata', () => {
    const xml = formToXml(richForm());
    const start = xml.indexOf('<label language-id="id_ID">Kembalikan ke Antrian</label>');
    const transition = xml.slice(start, xml.indexOf('</transition>', start));
    const order = ['<name>', '<target>', '<default>', '<metadata>'].map((tag) => transition.indexOf(tag));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it('marks <default>true</default> on the first outgoing transition of each node only', () => {
    const xml = formToXml(defaultForm());
    // CALLING has two outgoing transitions → the first is default, the second is not.
    expect(xml).toContain('<target>SERVING</target>\n        <default>true</default>');
    expect(xml).toContain('<target>SKIPPED</target>\n        <default>false</default>');
  });

  it('derives a Kaleo <name> slug from the action label, deduped within the source node', () => {
    // Two transitions out of one status can legitimately share a label (to
    // different targets); Kaleo requires transition names unique within the node.
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B', 'C'],
      transitions: [
        { from: 'A', to: 'B', actionLabel: 'Lanjut', action: 'UPDATE_STATUS' },
        { from: 'A', to: 'C', actionLabel: 'Lanjut', action: 'UPDATE_STATUS' },
      ],
    };
    const xml = formToXml(form);
    expect(xml).toContain('<name>lanjut</name>');
    expect(xml).toContain('<name>lanjut-2</name>');
  });

  it('falls back to a placeholder slug when a label has nothing sluggable', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: '→ ✓', action: 'UPDATE_STATUS' }],
    };
    expect(formToXml(form)).toContain('<name>transisi</name>');
  });
});

describe('formToXml — <initial> derivation', () => {
  it('marks the graph entry status <initial>true</initial> and no other', () => {
    const xml = formToXml(defaultForm());
    expect(xml).toContain('<name>WAITING</name>\n    <metadata><![CDATA[{"xy":[0,0]}]]></metadata>\n    <initial>true</initial>');
    // Exactly one status is the entry point in the default graph.
    expect((xml.match(/<initial>true<\/initial>/g) ?? []).length).toBe(1);
  });

  it('marks EVERY entry status when a graph has more than one (deviates from Kaleo on purpose)', () => {
    // Kaleo definitions carry exactly one <initial>. A QMS manager can wire two
    // independent lanes, and the canvas already draws a Start arrow into each —
    // matching the diagram beats single-initial conformance.
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['ANTRI_A', 'ANTRI_B', 'SELESAI'],
      transitions: [
        { from: 'ANTRI_A', to: 'SELESAI', actionLabel: 'Selesai Layan', action: 'UPDATE_STATUS' },
        { from: 'ANTRI_B', to: 'SELESAI', actionLabel: 'Selesai Layan', action: 'UPDATE_STATUS' },
      ],
    };
    const xml = formToXml(form);
    expect((xml.match(/<initial>true<\/initial>/g) ?? []).length).toBe(2);
  });

  it('a self-loop does not stop its status from being the entry point', () => {
    // The shared `deriveAutoSources` excludes self-loops from the degree count
    // (the same predicate the canvas Start marker uses), so a self-loop on the
    // entry status must not silently drop its <initial>.
    const form: StateMachineForm = {
      ...selfLoopForm(),
      transitions: [
        { from: 'WAITING', to: 'WAITING', actionLabel: 'Tunggu Lagi', action: 'UPDATE_STATUS' },
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya', action: 'UPDATE_STATUS' },
        { from: 'CALLING', to: 'COMPLETED', actionLabel: 'Selesai Layan', action: 'UPDATE_STATUS' },
      ],
    };
    const xml = formToXml(form);
    expect(xml).toContain('<name>WAITING</name>\n    <metadata><![CDATA[{"xy":[0,0]}]]></metadata>\n    <initial>true</initial>');
  });

  it('marks no status initial when the only transition is a self-loop (isolated, not an entry)', () => {
    // A status whose ONLY wiring is a self-loop is degree-0 on both sides — it
    // is wired to itself, not into the flow — so it is neither entry nor exit.
    expect(formToXml(singleStateForm())).not.toContain('<initial>');
  });
});

describe('formToXml — positions in node <metadata>', () => {
  it('each node carries xy from form.positions', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 0 } },
    };
    const xml = formToXml(form);
    expect(xml).toContain('<name>A</name>\n    <metadata><![CDATA[{"xy":[10,20]}]]></metadata>');
    expect(xml).toContain('<name>B</name>\n    <metadata><![CDATA[{"xy":[240,0]}]]></metadata>');
  });

  it('defaults absent positions to the deterministic autoLayout (matching the diagram)', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      positions: {},
    };
    const xml = formToXml(form);
    // A is the sole source → rank 0 → x=0; B follows A → rank 1 → x=240; both
    // index 0 in their rank → y=0.
    expect(xml).toContain('{"xy":[0,0]}');
    expect(xml).toContain('{"xy":[240,0]}');
    // The serialized coordinates MUST equal the autoLayout derivation the
    // Diagram's `formToFlow` uses (XML == diagram derivation, single source
    // of truth).
    const auto = autoLayout(['A', 'B'], [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }]);
    expect(auto.A).toEqual({ x: 0, y: 0 });
    expect(auto.B).toEqual({ x: 240, y: 0 });
  });

  it('the XML positions match the Diagram autoLayout for the default graph (single source of truth)', () => {
    const form = defaultForm();
    expect(form.positions).toEqual({}); // un-customized → autoLayout fallback
    const xml = formToXml(form);
    const auto = autoLayout(DEFAULT_STATE_MACHINE.states, DEFAULT_STATE_MACHINE.transitions);
    // Pull each node's `xy` out of the XML and assert it equals autoLayout[...]
    // for the same graph — the regression guard proving the XML and the Diagram
    // cannot diverge.
    for (const s of DEFAULT_STATE_MACHINE.states) {
      const re = new RegExp(`<name>${s}</name>\\s*<metadata><!\\[CDATA\\[\\{"xy":\\[(-?[0-9.]+),(-?[0-9.]+)\\]`);
      const m = xml.match(re);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(auto[s].x);
      expect(Number(m![2])).toBe(auto[s].y);
    }
  });

  it('truncates sub-pixel coordinates for stable round-trip text', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A'],
      transitions: [],
      positions: { A: { x: 10.123456, y: 20.999 } },
    };
    expect(formToXml(form)).toContain('{"xy":[10.12,21]}');
  });
});

describe('formToXml — sparse metadata', () => {
  it('omits sourceSide/targetSide metadata on default-routed transitions', () => {
    const xml = formToXml(defaultForm());
    expect(xml).not.toContain('sourceSide');
    expect(xml).not.toContain('targetSide');
  });

  it('includes both sides together when either is non-default', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS', sourceSide: 'bottom', targetSide: 'top' }],
    };
    expect(formToXml(form)).toContain('{"sourceSide":"bottom","targetSide":"top"}');
  });

  it('materializes the default side when only one is non-default (never half-routed)', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS', sourceSide: 'bottom' }],
    };
    // targetSide materialized to the default ('left').
    expect(formToXml(form)).toContain('{"sourceSide":"bottom","targetSide":"left"}');
  });

  it('emits a node description only for non-empty overrides (sparse serialization)', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 80 } },
      descriptions: { A: 'Antrian dimulai di sini', B: '' },
    };
    const xml = formToXml(form);
    // A's non-empty override rides the node metadata alongside its xy.
    expect(xml).toContain('{"xy":[10,20],"description":"Antrian dimulai di sini"}');
    // B's empty value is dropped (sparse) — its metadata carries xy only.
    expect(xml).toContain('{"xy":[240,80]}');
    // The derived fallback (canonical copy / transition count) is NOT
    // serialized — only real overrides appear in the source.
    expect(xml).not.toContain('1 transisi keluar');
  });

  it('omits the description key entirely when no overrides are present', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 80 } },
    };
    // The node metadata carries `xy` and nothing else. (Matched on the metadata
    // key, not the bare word — the root <description> element is the Kaleo
    // definition's own description and is always present.)
    expect(formToXml(form)).not.toContain('"description"');
    expect(formToXml(form)).toContain('<metadata><![CDATA[{"xy":[10,20]}]]></metadata>');
  });

  it('omits the root <metadata> entirely for auto/auto terminals and no endSources', () => {
    // The default graph's source stays clean — the sparse rule that already
    // governs edge sides and descriptions now governs the graph-wide facets too.
    expect(formToXml(defaultForm())).not.toContain('<metadata><![CDATA[{"terminal');
    expect(formToXml(defaultForm())).not.toContain('endSources');
  });

  it('carries a hidden Start and a pinned End in the root <metadata>', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      terminalNodes: { start: 'hidden', end: { x: 720, y: 30 } },
    };
    expect(formToXml(form)).toContain(
      '<metadata><![CDATA[{"terminalNodes":{"start":"hidden","end":{"x":720,"y":30}}}]]></metadata>',
    );
  });

  it('carries endSources in the root <metadata> only when non-empty', () => {
    const withSources: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      positions: { A: { x: 0, y: 0 }, B: { x: 240, y: 0 } },
      endSources: ['A', 'B'],
    };
    expect(formToXml(withSources)).toContain('"endSources":["A","B"]');
    expect(formToXml({ ...withSources, endSources: [] })).not.toContain('endSources');
  });
});

describe('formToXml — node actions', () => {
  it('emits an <actions> block with Kaleo execution-type spellings + QMS metadata', () => {
    const xml = formToXml(richForm());
    expect(xml).toContain('<actions>');
    expect(xml).toContain('<execution-type>onEntry</execution-type>');
    expect(xml).toContain('<execution-type>onExit</execution-type>');
    expect(xml).toContain('<metadata><![CDATA[{"type":"UPDATE_STATUS","value":"VERIFIKASI"}]]></metadata>');
    expect(xml).toContain('<name>update-status-verifikasi</name>');
  });

  it('omits <actions> for a status with none', () => {
    const xml = formToXml(richForm());
    const waiting = xml.slice(xml.indexOf('<name>WAITING</name>'), xml.indexOf('</task>'));
    expect(waiting).not.toContain('<actions>');
  });

  it('omits Kaleo <status> and <assignments> (QMS has no equivalent)', () => {
    const xml = formToXml(richForm());
    expect(xml).not.toContain('<status>');
    expect(xml).not.toContain('<assignments>');
  });

  it('dedupes derived action names within a node', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      nodeActions: {
        A: [
          { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'B' },
          { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'B' },
        ],
      },
    };
    const xml = formToXml(form);
    expect(xml).toContain('<name>update-status-b</name>');
    expect(xml).toContain('<name>update-status-b-2</name>');
  });
});

describe('formToXml — escaping', () => {
  it('escapes XML-special characters in element text', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A&B'],
      transitions: [{ from: 'A&B', to: 'A&B', actionLabel: 'go "there" <now>', action: 'UPDATE_STATUS' }],
    };
    const xml = formToXml(form);
    expect(xml).toContain('<name>A&amp;B</name>');
    expect(xml).toContain('<target>A&amp;B</target>');
    expect(xml).toContain('<label language-id="id_ID">go "there" &lt;now&gt;</label>');
    // The serialized XML must parse back without error.
    expect(xmlToForm(xml).ok).toBe(true);
  });

  it('a CDATA payload can never contain the ]]> terminator', () => {
    // A description containing `]]>` would otherwise close the CDATA section
    // early and shred the document. Every `>` in the JSON text is written as the
    // `>` escape — value-preserving, since a raw `>` can only occur inside
    // a JSON string literal.
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      descriptions: { A: 'akhiri dengan ]]> lalu lanjut' },
    };
    const xml = formToXml(form);
    expect(xml).not.toContain(']]> lalu');
    expect(xml).toContain('\\u003e');
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.descriptions.A).toBe('akhiri dengan ]]> lalu lanjut');
  });
});

describe('round-trip (formToXml → xmlToForm)', () => {
  for (const [label, make] of ROUND_TRIP_FIXTURES) {
    it(`LOSSLESSNESS GUARANTEE — formToXml is a fixed point over ${label}`, () => {
      // ── This is THE acceptance criterion for the codec. ──────────────────
      // `formToXml(xmlToForm(formToXml(f)).form) === formToXml(f)`, byte for
      // byte, is what actually proves nothing is lost: if ANY field failed to
      // survive the parse — a description, a pinned terminal, an action's
      // execution type, an edge side — the re-serialization would differ, and
      // no amount of canonicalization can hide that. The deep-equal against
      // `canonical(f)` below is the readable statement of the same fact; this
      // assertion is the one that cannot be fooled.
      const form = make();
      const xml = formToXml(form);
      const result = xmlToForm(xml);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(formToXml(result.form)).toBe(xml);

      // Every field survives; only `mode`, materialized `positions` and the
      // source-grouped `transitions` order are canonicalized (see `canonical`).
      expect(result.form).toEqual(canonical(form));

      // A second pass is the identity — the codec has settled on one fixed
      // point rather than oscillating between two equivalent forms.
      const again = xmlToForm(formToXml(result.form));
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.form).toEqual(result.form);
    });
  }

  it('canonicalization is IDEMPOTENT — so "deep-equal to canonical(f)" is a claim, not a tautology', () => {
    // Without this, `canonical` could silently absorb a codec bug by encoding
    // the bug's own output as "the expected shape". An idempotent canonicalizer
    // has a single fixed point, so the round-trip assertion above is pinned to
    // it rather than to whatever the codec happens to produce.
    for (const [, make] of ROUND_TRIP_FIXTURES) {
      const once = canonical(make());
      expect(canonical(once)).toEqual(once);
    }
  });

  it('forces mode to custom and preserves the default graph structure', () => {
    const result = xmlToForm(formToXml(defaultForm()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.mode).toBe('custom'); // editing source = custom intent
    expect(result.form.states).toEqual(DEFAULT_STATE_MACHINE.states);
    // Same edges, regrouped under their source status by the nesting.
    expect([...result.form.transitions].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`))).toEqual(
      [...DEFAULT_STATE_MACHINE.transitions].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)),
    );
  });

  it('preserves per-source transition order (the Caller button order)', () => {
    const result = xmlToForm(formToXml(defaultForm()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // CALLING's two buttons keep their authored order: Mulai Melayani, then
    // Lewati / Absen — the only ordering the Caller panel depends on.
    expect(result.form.transitions.filter((t) => t.from === 'CALLING').map((t) => t.actionLabel)).toEqual([
      'Mulai Melayani',
      'Lewati / Absen',
    ]);
  });

  it('round-trips node positions', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      positions: { A: { x: 10, y: 20 }, B: { x: 240, y: 80 } },
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.positions.A).toEqual({ x: 10, y: 20 });
    expect(result.form.positions.B).toEqual({ x: 240, y: 80 });
  });

  it('round-trips a non-default-routed edge (sourceSide/targetSide)', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'up', action: 'UPDATE_STATUS', sourceSide: 'bottom', targetSide: 'top' }],
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.transitions[0].sourceSide).toBe('bottom');
    expect(result.form.transitions[0].targetSide).toBe('top');
  });

  it('round-trips a description override and leaves an un-overridden status absent', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['A', 'B'],
      transitions: [{ from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' }],
      descriptions: { A: 'Antrian dimulai di sini' },
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.descriptions.A).toBe('Antrian dimulai di sini');
    expect(result.form.descriptions.B).toBeUndefined();
  });

  it('round-trips nodeActions and leaves an action-free status absent (not an empty array)', () => {
    const result = xmlToForm(formToXml(richForm()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.nodeActions.VERIFIKASI).toEqual(richForm().nodeActions.VERIFIKASI);
    expect(result.form.nodeActions.WAITING).toBeUndefined();
  });

  it('round-trips terminal markers and endSources through the root metadata', () => {
    const result = xmlToForm(formToXml(richForm()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.terminalNodes.start).toBe('hidden');
    expect(result.form.terminalNodes.end).toEqual({ x: 960, y: 30 });
    expect(result.form.endSources).toEqual(['SERVING']);
  });

  it('the parsed form passes validateCustomStateMachine and toStateMachineDto unchanged', () => {
    const form: StateMachineForm = {
      ...defaultForm(),
      mode: 'custom',
      states: ['WAITING', 'CALLING', 'SERVING'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya', action: 'UPDATE_STATUS' },
        { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani', action: 'UPDATE_STATUS' },
      ],
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateCustomStateMachine(result.form)).toEqual([]);
    // Custom mode passes the graph straight through to the wire shape.
    expect(toStateMachineDto(result.form).transitions).toEqual(form.transitions);
  });
});

describe('xmlToForm — lenient reading', () => {
  it('accepts <state> and <task> interchangeably (the choice is derived on serialize)', () => {
    // A hand-edited document that used <state> for a status that leads onward
    // still parses; re-serializing promotes it to <task>.
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <state><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels><target>B</target></transition></transitions>
      </state>
      <task><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></task>
    </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.states).toEqual(['A', 'B']);
    expect(formToXml(result.form)).toContain('<task>\n    <name>A</name>');
  });

  it('accepts any label language-id, preferring id_ID', () => {
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels>
          <label language-id="en_US">Call Next</label>
          <label language-id="id_ID">Panggil Berikutnya</label>
        </labels><target>B</target></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
    </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.transitions[0].actionLabel).toBe('Panggil Berikutnya');
  });

  it('falls back to the first label when no id_ID label is present', () => {
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="en_US">Call Next</label></labels><target>B</target></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
    </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.transitions[0].actionLabel).toBe('Call Next');
  });

  it('ignores the derived <initial>, <default>, transition <name> and node <labels>', () => {
    // All four are computed on serialize, so a hand-edited (even wrong) value
    // must not reach the form.
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <initial>false</initial>
        <labels><label language-id="id_ID">bukan nama A</label></labels>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels>
          <name>nama-yang-diketik-tangan</name><target>B</target><default>false</default>
        </transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
    </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.states).toEqual(['A', 'B']);
    // `action` is absent from this hand-written source, so it reads back as the
    // UPDATE_STATUS default the serializer omits it for.
    expect(result.form.transitions).toEqual([
      { from: 'A', to: 'B', actionLabel: 'go', action: 'UPDATE_STATUS' },
    ]);
    // A is still re-derived as the entry status on the way back out.
    expect(formToXml(result.form)).toContain('<initial>true</initial>');
  });

  it('accepts a case-insensitive execution-type', () => {
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <actions><action><execution-type>ONENTRY</execution-type>
          <metadata><![CDATA[{"type":"UPDATE_STATUS","value":"B"}]]></metadata></action></actions>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels><target>B</target></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
    </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.nodeActions.A).toEqual([
      { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'B' },
    ]);
  });

  it('accepts an {x,y} object as well as Kaleo\'s [x,y] array for a position', () => {
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <task><name>A</name><metadata><![CDATA[{"xy":{"x":10,"y":20}}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels><target>B</target></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
    </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.positions.A).toEqual({ x: 10, y: 20 });
  });

  it('ignores unknown elements and attributes (lenient on extras, strict on shape)', () => {
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <extra/>
      <task tanda="hi"><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <assignments><roles><role><name>MANAGER</name></role></roles></assignments>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels><target>B</target></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
    </workflow-definition>`;
    expect(xmlToForm(xml).ok).toBe(true);
  });

  it('leaves sides absent when no transition metadata is present (default routing)', () => {
    const result = xmlToForm(formToXml(defaultForm()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.transitions[0].sourceSide).toBeUndefined();
    expect(result.form.transitions[0].targetSide).toBeUndefined();
  });

  it("defaults an absent root <metadata> to auto/auto terminals and no endSources", () => {
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels><target>B</target></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
    </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.terminalNodes).toEqual({ start: 'auto', end: 'auto' });
    expect(result.form.endSources).toEqual([]);
  });

  it('drops an endSources entry that is not a parsed status (defensive parse)', () => {
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <metadata><![CDATA[{"endSources":["A","GONE",42]}]]></metadata>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels><target>B</target></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
    </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 'GONE' is not a parsed status and 42 is not a name → both dropped.
    expect(result.form.endSources).toEqual(['A']);
  });
});

describe('xmlToForm — errors (never throws, always Indonesian)', () => {
  it('rejects malformed XML without throwing', () => {
    const result = xmlToForm('<not-xml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/XML tidak valid/i);
  });

  it('rejects an empty string without throwing', () => {
    expect(xmlToForm('').ok).toBe(false);
  });

  it('rejects a wrong root tag', () => {
    const result = xmlToForm('<?xml version="1.0"?><graph/>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/<workflow-definition>/i);
  });

  it('rejects the former <stateMachine> format with a clear error (no back-compat)', () => {
    // The XML was only ever a view — it is never persisted, so no migration and
    // no legacy parsing is owed. Pasting the old shape gets a plain message.
    const legacy =
      '<?xml version="1.0"?><stateMachine><state name="A" x="0" y="0"/><transition from="A" to="A" actionLabel="go"/></stateMachine>';
    const result = xmlToForm(legacy);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/<workflow-definition>/i);
  });

  it('rejects a status with no <name>', () => {
    const xml =
      '<?xml version="1.0"?><workflow-definition><task><metadata><![CDATA[{"xy":[0,0]}]]></metadata></task></workflow-definition>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/<name>/i);
  });

  it('rejects an empty <name>', () => {
    const xml =
      '<?xml version="1.0"?><workflow-definition><task><name></name><metadata><![CDATA[{"xy":[0,0]}]]></metadata></task></workflow-definition>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/tidak boleh kosong/i);
  });

  it('rejects a status with no position metadata', () => {
    const xml = '<?xml version="1.0"?><workflow-definition><task><name>A</name></task></workflow-definition>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/posisi kanvas/i);
    expect(result.error).toMatch(/"xy"/);
  });

  it('rejects a non-numeric position', () => {
    const xml =
      '<?xml version="1.0"?><workflow-definition><task><name>A</name><metadata><![CDATA[{"xy":["abc",0]}]]></metadata></task></workflow-definition>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/angka/i);
  });

  it('rejects a metadata payload that is not JSON', () => {
    const xml =
      '<?xml version="1.0"?><workflow-definition><task><name>A</name><metadata><![CDATA[{bukan json}]]></metadata></task></workflow-definition>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/bukan JSON yang benar/i);
  });

  it('rejects a transition with no <target>', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels></transition></transitions>
      </task></workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/<target>/i);
  });

  it('rejects a transition with no <label> (the Caller button text)', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><target>B</target></transition></transitions>
      </task></workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/<label/i);
    expect(result.error).toMatch(/layar petugas/i);
  });

  it('rejects an invalid sourceSide', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels><target>B</target>
          <metadata><![CDATA[{"sourceSide":"sideways"}]]></metadata></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
      </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/top.*right.*bottom.*left/i);
  });

  it('rejects an invalid targetSide', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels><target>B</target>
          <metadata><![CDATA[{"targetSide":42}]]></metadata></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
      </workflow-definition>`;
    expect(xmlToForm(xml).ok).toBe(false);
  });

  it('rejects an action with no <execution-type>', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <actions><action><metadata><![CDATA[{"type":"UPDATE_STATUS","value":"B"}]]></metadata></action></actions>
      </task></workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/onEntry.*onExit/i);
  });

  it('rejects an action whose metadata has no type/value', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <actions><action><execution-type>onEntry</execution-type></action></actions>
      </task></workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/"type" dan "value"/i);
  });

  it('rejects an unknown action type', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <actions><action><execution-type>onEntry</execution-type>
          <metadata><![CDATA[{"type":"WEBHOOK","value":"B"}]]></metadata></action></actions>
      </task></workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/UPDATE_STATUS/);
  });

  it('rejects an unusable terminal marker value', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <metadata><![CDATA[{"terminalNodes":{"start":"kadang"}}]]></metadata>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata></task></workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/"auto".*"hidden"/i);
  });

  it('rejects a non-numeric pinned End position', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <metadata><![CDATA[{"terminalNodes":{"end":{"x":"abc","y":0}}}]]></metadata>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata></task></workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Selesai/i);
  });

  it('rejects an endSources value that is not a list', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <metadata><![CDATA[{"endSources":"A"}]]></metadata>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata></task></workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/daftar nama status/i);
  });

  it('returns the first shared-validator error for a graph the backend would 400', () => {
    // Empty action label — validateCustomStateMachine flags it, so the source
    // view and the visual diagram enforce the same invariants.
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID"></label></labels><target>B</target></transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
      </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/label aksi/i);
  });

  it('returns the shared-validator error for a duplicate transition edge', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions>
          <transition><labels><label language-id="id_ID">Go</label></labels><target>B</target></transition>
          <transition><labels><label language-id="id_ID">Go Again</label></labels><target>B</target></transition>
        </transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
      </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/duplikat/i);
  });

  it('rejects a transition pointing at a status that is not in the graph', () => {
    const xml = `<?xml version="1.0"?><workflow-definition>
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels><target>HILANG</target></transition></transitions>
      </task></workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/tidak dikenal/i);
  });

  it('rejects a lone status with no transitions (the shared minimum-one-transition rule)', () => {
    const xml =
      '<?xml version="1.0"?><workflow-definition><state><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata></state></workflow-definition>';
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/minimal satu transisi/i);
  });

  it('a freshly added empty-label transition is caught (mirrors the visual editor invariant)', () => {
    const form = addTransition(defaultForm());
    expect(xmlToForm(formToXml(form)).ok).toBe(false);
  });
});

describe("a transition's action in the source", () => {
  /**
   * The PRD §7 default graph plus a `CALLING → WAITING` edge carrying `action`.
   * A category move must target WAITING (`validateCustomStateMachine`, mirroring
   * the backend's save-time rule), so this is the only shape the codec can
   * round-trip a declared transfer through.
   */
  function withWaitingAction(action: 'UPDATE_STATUS' | 'TRANSFER_CATEGORY'): StateMachineForm {
    const base = defaultForm();
    return {
      ...base,
      mode: 'custom',
      transitions: [
        ...base.transitions,
        { from: 'CALLING', to: 'WAITING', actionLabel: 'Kembalikan ke Antrian', action },
      ],
    };
  }

  it('is omitted for the UPDATE_STATUS default (sparse — the source stays quiet about it)', () => {
    const xml = formToXml(withWaitingAction('UPDATE_STATUS'));
    // The JSON key, not the bare word — `<actions>`/`<execution-type>` and the
    // Indonesian prose elsewhere in the document both contain "action".
    expect(xml).not.toContain('"action"');
    // And no metadata element appears on an otherwise default edge at all. (An
    // earlier cut wrote `<metadata><![CDATA[{}]]></metadata>` on every edge,
    // which the exact-document test caught — this pins it directly.)
    expect(xml).not.toContain('<metadata><![CDATA[{}]]></metadata>');
    // Non-vacuous: the same assertion FAILS once an action is declared.
    expect(formToXml(withWaitingAction('TRANSFER_CATEGORY'))).toContain('"action"');
  });

  it('is emitted and read back when the manager declared a category move', () => {
    const form = withWaitingAction('TRANSFER_CATEGORY');
    const xml = formToXml(form);
    expect(xml).toContain('"action":"TRANSFER_CATEGORY"');

    const result = xmlToForm(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = result.form.transitions.find((t) => t.from === 'CALLING' && t.to === 'WAITING');
    expect(parsed?.action).toBe('TRANSFER_CATEGORY');
    // Every other edge keeps the default, so the sparse emission is not
    // leaking the one declared value onto its neighbours.
    expect(
      result.form.transitions
        .filter((t) => !(t.from === 'CALLING' && t.to === 'WAITING'))
        .every((t) => t.action === 'UPDATE_STATUS'),
    ).toBe(true);
  });

  it('rides the same metadata element as the connection sides without either being lost', () => {
    // Both facets are sparse and share one `<metadata>`; a naive implementation
    // that wrote one then overwrote it would drop the other.
    const base = defaultForm();
    const form: StateMachineForm = {
      ...base,
      mode: 'custom',
      transitions: [
        ...base.transitions,
        {
          from: 'CALLING',
          to: 'WAITING',
          actionLabel: 'Pindah Kategori',
          action: 'TRANSFER_CATEGORY' as const,
          sourceSide: 'bottom' as const,
          targetSide: 'top' as const,
        },
      ],
    };
    const result = xmlToForm(formToXml(form));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = result.form.transitions.find((t) => t.from === 'CALLING' && t.to === 'WAITING');
    expect(parsed).toMatchObject({
      action: 'TRANSFER_CATEGORY',
      sourceSide: 'bottom',
      targetSide: 'top',
    });
  });

  it('rejects an unknown action with a manager-readable Indonesian error', () => {
    const xml = `<?xml version="1.0"?><workflow-definition xmlns="urn:liferay.com:liferay-workflow_7.4.0">
      <task><name>A</name><metadata><![CDATA[{"xy":[0,0]}]]></metadata>
        <transitions><transition><labels><label language-id="id_ID">go</label></labels>
          <target>B</target><metadata><![CDATA[{"action":"SEND_WEBHOOK"}]]></metadata>
        </transition></transitions>
      </task>
      <state><name>B</name><metadata><![CDATA[{"xy":[240,0]}]]></metadata></state>
    </workflow-definition>`;
    const result = xmlToForm(xml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('UPDATE_STATUS');
    expect(result.error).toContain('TRANSFER_CATEGORY');
  });
});

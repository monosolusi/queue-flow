/**
 * The XML "Sumber" (Source) view codec for the Alur Status Tiket graph — an
 * editable XML source pane alongside the visual {@link StateMachineWorkflow}
 * diagram (a designer-style visual/source toggle).
 *
 * **Format: Liferay Kaleo `<workflow-definition>`.** The manager asked for
 * 1-on-1 parity with Kaleo 7.4's workflow-definition XML rather than the former
 * QMS-custom shape (`<stateMachine>` + flat `<transition from= to=>`), so the
 * source reads like a real workflow definition an operations person may already
 * know:
 *
 * ```xml
 * <?xml version="1.0" encoding="UTF-8"?>
 * <workflow-definition
 *     xmlns="urn:liferay.com:liferay-workflow_7.4.0"
 *     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
 *     xsi:schemaLocation="urn:liferay.com:liferay-workflow_7.4.0 http://www.liferay.com/dtd/liferay-workflow-definition_7_4_0.xsd"
 * >
 *   <name>alur-status-tiket</name>
 *   <description>…</description>
 *   <version>1</version>
 *   <task>
 *     <name>WAITING</name>
 *     <metadata><![CDATA[{"xy":[0,0]}]]></metadata>
 *     <initial>true</initial>
 *     <labels><label language-id="id_ID">WAITING</label></labels>
 *     <transitions>
 *       <transition>
 *         <labels><label language-id="id_ID">Panggil Berikutnya</label></labels>
 *         <name>panggil-berikutnya</name>
 *         <target>CALLING</target>
 *         <default>true</default>
 *       </transition>
 *     </transitions>
 *   </task>
 *   <state>
 *     <name>COMPLETED</name>
 *     <metadata><![CDATA[{"xy":[960,0]}]]></metadata>
 *     <labels><label language-id="id_ID">COMPLETED</label></labels>
 *   </state>
 * </workflow-definition>
 * ```
 *
 * **Node element choice.** A status with out-degree > 0 serializes as `<task>`
 * (Kaleo's "work happens here, then it moves on"); a terminal status with
 * out-degree 0 serializes as `<state>` (Kaleo's "the flow rests here", e.g.
 * `COMPLETED`). The degree comes from the shared {@link stateDegrees} — the ONE
 * predicate the canvas's Start/End markers and the End-marker panel's "Transisi
 * masuk" list also use — so self-loops are excluded from the count and the
 * diagram and the source can never disagree about which statuses are terminal.
 * On PARSE the two are accepted interchangeably — the element name is DERIVED
 * from the topology, so a hand-edited `<state>` that gains a `<transitions>`
 * block still parses, and re-serializing re-derives the tag.
 *
 * **Everything Kaleo has no slot for rides in `<metadata>` CDATA JSON** — the
 * same mechanism Kaleo itself uses for canvas coordinates (`{"xy":[x,y]}`), so
 * nothing about the QMS graph is lost in the round-trip:
 *
 * | QMS form field | Kaleo slot |
 * |---|---|
 * | `states[]` | one `<task>`/`<state>` per entry, in order |
 * | `transitions[].actionLabel` | `<transition><labels><label language-id="id_ID">` |
 * | `transitions[].to` | `<transition><target>` |
 * | `transitions[].from` | the CONTAINING node's `<name>` (nesting) |
 * | `transitions[].sourceSide`/`targetSide` | transition `<metadata>` JSON (sparse) |
 * | `transitions[].action` | transition `<metadata>` JSON `action` (sparse) |
 * | `positions[name]` | node `<metadata>` JSON `xy` |
 * | `descriptions[name]` | node `<metadata>` JSON `description` (sparse) |
 * | `nodeActions[name]` | `<actions><action>` + action `<metadata>` JSON |
 * | `terminalNodes` | ROOT `<metadata>` JSON `terminalNodes` (sparse) |
 * | `endSources` | ROOT `<metadata>` JSON `endSources` (sparse) |
 * | `mode` | NOT serialized — a client-only UI preset |
 *
 * Positions are the single source of truth shared with the Diagram view: an
 * absent position (empty `positions` map, i.e. an un-customized graph) is
 * materialized from the shared `autoLayout` (the canonical default-positions
 * derivation in `state-machine.ts`), so the XML Source always carries the
 * coordinates the canvas renders and the two views of the same
 * {@link StateMachineForm} can never diverge — the XML is the human-editable
 * source the diagram arranges from.
 *
 * **The XML is a VIEW, never storage.** `formToXml`/`xmlToForm` are imported by
 * `AlurStatusDesigner` (and tests) only; the wire + DB carry JSON via
 * `toStateMachineDto` / `toNodePositionsDto` / `toNodeActionsDto` /
 * `toTerminalNodesDto` / `toEndSourcesDto`. So the format change needs no
 * migration and no backward-compatible parsing of the former `<stateMachine>`
 * shape — that XML never outlived a browser session, and pasting it now yields
 * a clear Indonesian parse error.
 *
 * This module is the ONE DOM-dependent module in the state-machine lib surface
 * (`DOMParser` is a browser + jsdom built-in — no external dependency,
 * NFR-REL-01 safe). It imports from the pure `state-machine.ts` (no DOM) so the
 * dependency direction stays clean: the DOM layer depends on the pure layer,
 * never the reverse, and never on the React Flow layer (`state-machine-flow.ts`).
 */
import {
  autoLayout,
  DEFAULT_SOURCE_SIDE,
  DEFAULT_TARGET_SIDE,
  DEFAULT_TRANSITION_ACTION,
  deriveAutoSources,
  EDGE_SIDES,
  isDefaultSides,
  stateDegrees,
  TRANSITION_ACTIONS,
  validateCustomStateMachine,
  type StateMachineForm,
  type Transition,
} from './state-machine';
import type {
  EdgeSide,
  NodeActionDto,
  NodeActionExecutionType,
  NodeActionType,
  TerminalNodeStateDto,
  TransitionActionType,
} from '../api/types';

// `EdgeSide` is the wire enum `'top'|'right'|'bottom'|'left'` (from
// `api/types`); `EDGE_SIDES` (imported from the pure `state-machine.ts`) is its
// runtime list, reused as the single source of truth for enum validation.
type Side = EdgeSide;

/**
 * The Kaleo 7.4 workflow-definition namespace, emitted verbatim so the document
 * is namespace-identical to a real Kaleo definition.
 *
 * Kaleo's own sample also carries `xmlns:xsi` + an `xsi:schemaLocation` hint
 * pointing at `http://www.liferay.com/dtd/liferay-workflow-definition_7_4_0.xsd`,
 * and both are emitted verbatim so a definition copied out of this pane is
 * byte-shaped like a real Kaleo document and validates in a Liferay instance.
 *
 * The `schemaLocation` is an INERT literal: it is a hint to a validating parser
 * that would fetch the XSD over the internet, which this deployment never does
 * (NFR-REL-01) — nothing here resolves it, and the pane renders the document as
 * text. It does mean an `http://` literal reaches the built bundle, so
 * `www.liferay.com` is whitelisted in core-api's `offline-assets` acceptance
 * gate, alongside the OOXML/ODF namespace hosts SheetJS writes into generated
 * spreadsheets for exactly the same reason. The namespace proper is a `urn:`,
 * not a URL, so it never reaches that gate at all.
 */
const KALEO_NAMESPACE = 'urn:liferay.com:liferay-workflow_7.4.0';
const XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';
const KALEO_SCHEMA_LOCATION =
  'urn:liferay.com:liferay-workflow_7.4.0 http://www.liferay.com/dtd/liferay-workflow-definition_7_4_0.xsd';

/** The Kaleo document element. */
const ROOT_TAG = 'workflow-definition';

/**
 * Kaleo requires a definition `<name>` (its identity in a Liferay deployment).
 * QMS has exactly ONE state machine per store, so the name is a stable slug
 * rather than manager-editable data — it carries no form information and is
 * ignored on parse. Same for {@link DEFINITION_DESCRIPTION} and
 * {@link DEFINITION_VERSION} (QMS does not version the graph; core-api stores
 * the current one).
 */
const DEFINITION_NAME = 'alur-status-tiket';
const DEFINITION_DESCRIPTION =
  'Alur status tiket antrian: status, aksi otomatis, dan transisi yang jadi tombol di layar petugas.';
const DEFINITION_VERSION = '1';

/**
 * The `language-id` written on every emitted `<label>`. The UI is Indonesian, so
 * `id_ID` is the honest tag (Kaleo's sample uses `en_US`). On PARSE any
 * `language-id` is accepted — `id_ID` preferred, otherwise the first `<label>` —
 * so a definition exported from a Liferay instance still reads.
 */
const LABEL_LANGUAGE_ID = 'id_ID';

/**
 * QMS `NodeActionExecutionType` → Kaleo's `<execution-type>` spelling. Kaleo
 * uses lowerCamelCase (`onEntry`/`onExit`/`onAssignment`); the QMS wire VO uses
 * SCREAMING_SNAKE. A `Record<NodeActionExecutionType, string>` is an EXHAUSTIVE
 * guard — widening the union makes this map a compile error until a Kaleo
 * spelling is chosen for the new member.
 */
const EXECUTION_TYPE_TO_KALEO: Record<NodeActionExecutionType, string> = {
  ON_ENTRY: 'onEntry',
  ON_EXIT: 'onExit',
};

/** The inverse of {@link EXECUTION_TYPE_TO_KALEO}, keyed by lowercased Kaleo
 *  spelling so a hand-typed `onentry` still parses. */
const KALEO_TO_EXECUTION_TYPE: Record<string, NodeActionExecutionType> = {
  onentry: 'ON_ENTRY',
  onexit: 'ON_EXIT',
};

/**
 * Escapes the five XML-special characters for an attribute value. Both quote
 * styles are escaped so either delimiter is safe regardless of which the
 * serializer would choose.
 */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escapes element TEXT content. `>` is escaped alongside `&`/`<` (not strictly
 * required by XML except in `]]>`, but escaping it unconditionally means a
 * status name or action label can never accidentally form a CDATA terminator or
 * read as markup). Used for every text node the codec writes — `<name>`,
 * `<target>`, `<label>`.
 */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rounds a coordinate to 2 decimal places. Sub-pixel display drift is
 * acceptable; the truncation is what makes x/y STABLE across source round-trips
 * (a serialize→parse→serialize cycle reproduces the same text, so the textarea
 * does not flicker while the manager types).
 */
function coord(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Serializes a metadata payload as `<metadata><![CDATA[…]]></metadata>` — the
 * Kaleo-native escape hatch this codec uses for every field Kaleo has no slot
 * for.
 *
 * The CDATA payload can never contain the `]]>` terminator: every `>` in the
 * JSON text is rewritten to the `\u003e` escape. That is value-preserving and
 * total — JSON's structural characters are `{}[]:,` plus `"`, so a raw `>` can
 * only ever occur INSIDE a string literal, where `\u003e` is a valid escape that
 * parses back to `>`. (`JSON.stringify` never leaves a dangling backslash, so
 * the escape can never land mid-sequence.) A status named `A]]>B` therefore
 * round-trips instead of splitting the document.
 */
function metadataElement(value: unknown): string {
  return `<metadata><![CDATA[${JSON.stringify(value).replace(/>/g, '\\u003e')}]]></metadata>`;
}

/**
 * A lowercase kebab slug for a Kaleo `<name>` — Kaleo names are identifiers, not
 * prose. Non-alphanumeric runs collapse to a single `-`; leading/trailing `-`
 * are trimmed. A label with nothing sluggable left (punctuation only, or a
 * non-Latin script) falls back to `fallback` so the element is never empty.
 */
function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

/**
 * Makes `base` unique within `used` by appending `-2`, `-3`, … Kaleo requires
 * transition names unique within their source node and action names unique
 * within their node; two transitions can legitimately share an action label (to
 * different targets), so the derived slug needs a dedupe suffix. The names are
 * DERIVED — `xmlToForm` ignores them — so the suffix carries no meaning beyond
 * satisfying Kaleo's uniqueness rule.
 */
function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}-${n}`;
    n += 1;
  }
  used.add(name);
  return name;
}

/** A terminal-marker state with its coordinates rounded (see {@link coord}). */
function canonTerminal(state: TerminalNodeStateDto): TerminalNodeStateDto {
  return typeof state === 'object' && state !== null
    ? { x: coord(state.x), y: coord(state.y) }
    : state;
}

/**
 * The ROOT `<metadata>` payload — the two graph-wide facets Kaleo has no slot
 * for at all: the Start/End terminal-marker state and the explicit End
 * connections. **Sparse**: each key is omitted when it holds its default
 * (`auto/auto` terminals, empty `endSources`), and `null` is returned when both
 * are default so the `<metadata>` element itself is omitted and a default
 * graph's XML stays clean. Mirrors the sparse edge-sides rule below and the
 * sparse `toEdgeRoutingLayoutDto` wire map.
 */
function rootMetadata(form: StateMachineForm): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  const { start, end } = form.terminalNodes;
  if (start !== 'auto' || end !== 'auto') {
    meta.terminalNodes = { start: canonTerminal(start), end: canonTerminal(end) };
  }
  if (form.endSources.length > 0) meta.endSources = [...form.endSources];
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Serializes the editable state machine into the Kaleo XML shown in the
 * designer's Source view.
 *
 * Deterministic and stable across re-serializations (a flickering diff while the
 * manager types would be noise): nodes are emitted in `form.states` order, each
 * node's transitions in `form.transitions` order filtered to that source, and
 * every derived value (`<initial>`, `<default>`, the `<name>` slugs) is a pure
 * function of the form.
 *
 * The client-only `mode` preset is deliberately NOT included — the source is the
 * graph only, and `mode` never travels on the wire either ({@link
 * toStateMachineDto} owns stripping it there).
 *
 * Nesting each transition under its SOURCE node is what makes `from` implicit,
 * and it is why the transition ARRAY comes back grouped by source: no per-source
 * order is lost (that is the only order the Caller's button list depends on),
 * but the cross-source interleaving of `form.transitions` is not expressible in
 * the nested shape. `formToXml` is a FIXED POINT over that regrouping —
 * `formToXml(xmlToForm(formToXml(f)).form) === formToXml(f)` byte-for-byte — so
 * the round-trip is lossless in the sense that matters: no re-serialization ever
 * drifts.
 */
export function formToXml(form: StateMachineForm): string {
  // The SAME default-positions derivation the Diagram uses (`formToFlow` in
  // state-machine-flow.ts), so the Source XML always carries the coordinates
  // the canvas renders. `form.positions` is the source of truth; an empty map
  // (`{}` = "use autoLayout") is materialized here so the XML — the human-
  // editable single source of truth — never shows 0,0 while the diagram shows
  // a spread.
  const auto = autoLayout(form.states, form.transitions);
  // Kaleo marks the flow's entry node `<initial>true</initial>`. The entry
  // states are DERIVED from topology via the shared `deriveAutoSources` (the
  // SAME predicate the canvas's Start marker uses, self-loops excluded from the
  // degree count) — never a stored field — so the XML and the diagram can never
  // disagree about where the flow starts.
  //
  // DEVIATION from Kaleo: Kaleo definitions have exactly ONE `<initial>` node.
  // A QMS graph may legitimately have several entry statuses (the manager wires
  // two independent lanes), and the canvas already draws a Start arrow into each
  // — so every entry status is marked. A Kaleo importer would reject that; QMS
  // never feeds this XML to Liferay (it is a view over `StateMachineForm`), so
  // matching the diagram is worth more than single-initial conformance.
  const initialStates = new Set(deriveAutoSources(form.states, form.transitions));
  // The `<task>`/`<state>` choice comes from the SAME shared degree predicate,
  // for the same reason: a status the flow leaves is a `<task>`, a status it
  // rests at is a `<state>`. Self-loops are excluded from the count here too, so
  // the canvas (which draws `S → __end` for an out-degree-0 status) and the
  // Sumber view agree on which statuses are terminal.
  const { outDeg } = stateDegrees(form.states, form.transitions);

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(
    `<${ROOT_TAG} xmlns="${escapeXmlAttr(KALEO_NAMESPACE)}"` +
      ` xmlns:xsi="${escapeXmlAttr(XSI_NAMESPACE)}"` +
      ` xsi:schemaLocation="${escapeXmlAttr(KALEO_SCHEMA_LOCATION)}">`,
  );
  lines.push(`  <name>${escapeXmlText(DEFINITION_NAME)}</name>`);
  lines.push(`  <description>${escapeXmlText(DEFINITION_DESCRIPTION)}</description>`);
  lines.push(`  <version>${DEFINITION_VERSION}</version>`);
  const rootMeta = rootMetadata(form);
  if (rootMeta !== null) lines.push(`  ${metadataElement(rootMeta)}`);

  for (const name of form.states) {
    const outgoing = form.transitions.filter((t) => t.from === name);
    // A status the flow leaves is a `<task>`; a status it rests at is a
    // `<state>` (see the module doc). Read from the shared `outDeg`, NOT from
    // `outgoing.length`: a self-loop is a real transition with a real Caller
    // button, but it is flow that leaves a status and returns to it, so it does
    // not stop the status being an exit. Counting it here (the pre-fix local
    // filter) let the source contradict the diagram — the canvas drew
    // `S → __end` for a self-looping sink while the XML called it a `<task>`.
    const tag = (outDeg.get(name) ?? 0) > 0 ? 'task' : 'state';
    lines.push(`  <${tag}>`);
    // Kaleo child order, per the reference sample: name, metadata, initial,
    // actions, labels, transitions.
    lines.push(`    <name>${escapeXmlText(name)}</name>`);

    const pos = form.positions[name] ?? auto[name] ?? { x: 0, y: 0 };
    const nodeMeta: Record<string, unknown> = { xy: [coord(pos.x), coord(pos.y)] };
    // Carry a `description` ONLY when a non-empty saved override is present.
    // The derived fallback (canonical copy / transition count) is NOT
    // serialized — it stays a client-side derivation, so the XML stays lean and
    // a round-trip does not pin the canonical copy into the source text (the
    // manager edits only real overrides here). Mirrors the sparse edge sides.
    const desc = form.descriptions[name];
    if (desc !== undefined && desc.trim().length > 0) nodeMeta.description = desc;
    lines.push(`    ${metadataElement(nodeMeta)}`);

    if (initialStates.has(name)) lines.push('    <initial>true</initial>');

    const actions = form.nodeActions[name] ?? [];
    if (actions.length > 0) {
      lines.push('    <actions>');
      const usedActionNames = new Set<string>();
      for (const a of actions) {
        lines.push('      <action>');
        lines.push(
          `        <name>${escapeXmlText(uniqueName(slugify(`${a.type}-${a.value}`, 'aksi'), usedActionNames))}</name>`,
        );
        lines.push(`        <execution-type>${EXECUTION_TYPE_TO_KALEO[a.executionType]}</execution-type>`);
        // Kaleo's `<action>` also carries `<status>` (a Liferay-specific numeric
        // workflow status code) and the node carries `<assignments>` (which
        // Liferay role must act). Both are OMITTED: QMS has no equivalent of
        // Liferay's status codes, and it has no per-status role assignment at
        // all (the Caller panel is one role). The QMS-specific `type`/`value`
        // pair rides the action `<metadata>` instead.
        lines.push(`        ${metadataElement({ type: a.type, value: a.value })}`);
        lines.push('      </action>');
      }
      lines.push('    </actions>');
    }

    lines.push('    <labels>');
    lines.push(
      `      <label language-id="${LABEL_LANGUAGE_ID}">${escapeXmlText(name)}</label>`,
    );
    lines.push('    </labels>');

    // Every authored transition is emitted, self-loops included — the tag above
    // is a topology LABEL, not a filter, so a self-looping sink is a `<state>`
    // that still carries its `<transitions>` block (Kaleo's `<state>` permits
    // one, and the parser reads both elements the same way).
    if (outgoing.length > 0) {
      lines.push('    <transitions>');
      const usedTransitionNames = new Set<string>();
      outgoing.forEach((t, i) => {
        lines.push('      <transition>');
        // The label is the LOAD-BEARING value here: it is the Caller panel's
        // button text ("Panggil Berikutnya", …). `<name>` below is only Kaleo's
        // identifier, derived from it and ignored on parse.
        lines.push('        <labels>');
        lines.push(
          `          <label language-id="${LABEL_LANGUAGE_ID}">${escapeXmlText(t.actionLabel)}</label>`,
        );
        lines.push('        </labels>');
        lines.push(
          `        <name>${escapeXmlText(uniqueName(slugify(t.actionLabel, 'transisi'), usedTransitionNames))}</name>`,
        );
        lines.push(`        <target>${escapeXmlText(t.to)}</target>`);
        // Kaleo's `<default>` marks the transition taken when none is chosen
        // explicitly. QMS has no such notion (the Caller always picks a button),
        // so it is DERIVED — the node's first outgoing transition — and ignored
        // on parse. Emitted on every transition (not sparse) because Kaleo's
        // sample carries it and its meaning is positional, not optional.
        lines.push(`        <default>${i === 0 ? 'true' : 'false'}</default>`);
        // The transition `<metadata>` carries the two facets Kaleo has no slot
        // for, each SPARSE — omitted at its default — so a default-shaped graph
        // emits no metadata element at all:
        //
        // - connection sides, and then BOTH are written so the source never
        //   shows a half-routed edge. This mirrors the sparse
        //   {@link toEdgeRoutingLayoutDto} wire map — the source is the
        //   human-readable twin of the wire map, so they omit the same entries.
        // - `action`: what running the edge DOES. Omitted for the
        //   `UPDATE_STATUS` default, so only a manager-declared category move
        //   appears in the source. It rides metadata rather than a Kaleo element
        //   because Kaleo has no per-transition action concept — its `<action>`
        //   lives on nodes.
        const transitionMeta: Record<string, unknown> = {};
        if (!isDefaultSides(t.sourceSide, t.targetSide)) {
          transitionMeta.sourceSide = t.sourceSide ?? DEFAULT_SOURCE_SIDE;
          transitionMeta.targetSide = t.targetSide ?? DEFAULT_TARGET_SIDE;
        }
        // `?? DEFAULT` is defensive against a partially-built fixture form (the
        // field is required in `Transition`): without it an absent value would
        // write `action: undefined`, which `JSON.stringify` drops — emitting an
        // empty `<metadata><![CDATA[{}]]></metadata>` element on an otherwise
        // default edge and breaking the sparse-emission contract.
        const action = t.action ?? DEFAULT_TRANSITION_ACTION;
        if (action !== DEFAULT_TRANSITION_ACTION) transitionMeta.action = action;
        if (Object.keys(transitionMeta).length > 0) {
          lines.push(`        ${metadataElement(transitionMeta)}`);
        }
        lines.push('      </transition>');
      });
      lines.push('    </transitions>');
    }
    lines.push(`  </${tag}>`);
  }

  lines.push(`</${ROOT_TAG}>`);
  return lines.join('\n');
}

/** A successful {@link xmlToForm} parse — the rebuilt form (always custom mode). */
export interface XmlToFormOk {
  ok: true;
  form: StateMachineForm;
}

/** A failed parse — a single manager-facing (Indonesian) error message. */
export interface XmlToFormErr {
  ok: false;
  error: string;
}

/** The internal result type every parse helper below returns — a discriminated
 *  union rather than `T | { error }`, so a payload that happens to carry an
 *  `error` key can never be mistaken for a failure. */
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Direct element children of `el` with the given tag name. Direct children
 *  only — `getElementsByTagName` would reach into nested nodes and, in the
 *  nested Kaleo shape, a node's `<name>` would collide with its transitions'
 *  `<name>`s. */
function childrenNamed(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}

/** The first direct child with the given tag name, or `null`. */
function childNamed(el: Element, tag: string): Element | null {
  return childrenNamed(el, tag)[0] ?? null;
}

/**
 * The trimmed text of a direct child element, or `null` when the child is
 * absent. Trimmed because element text in XML is conventionally
 * whitespace-insensitive — a hand-pretty-printed `<name>\n  WAITING\n</name>`
 * must read as `WAITING`, not as a status name with newlines in it.
 */
function childText(el: Element, tag: string): string | null {
  const child = childNamed(el, tag);
  return child === null ? null : (child.textContent ?? '').trim();
}

/**
 * Reads a `<metadata>` CDATA JSON payload from a direct child. An ABSENT
 * `<metadata>` is not an error — it yields `{}` (every metadata key this codec
 * writes is either sparse or checked by its own caller), which is what lets a
 * hand-written Kaleo definition with no metadata at all still parse as far as
 * its own shape allows. `where` names the owner in the error message so the
 * manager knows which element to fix.
 */
function parseMetadata(el: Element, where: string): Parsed<Record<string, unknown>> {
  const metaEl = childNamed(el, 'metadata');
  if (metaEl === null) return { ok: true, value: {} };
  const raw = (metaEl.textContent ?? '').trim();
  if (raw.length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `Isi <metadata> pada ${where} bukan JSON yang benar.` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `Isi <metadata> pada ${where} harus berupa objek JSON, contoh {"xy":[0,0]}.` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * The label text of a `<labels>` block — `id_ID` preferred, otherwise the FIRST
 * `<label>` regardless of `language-id`, so a definition exported from a
 * Liferay instance (`en_US`) still reads. Returns `null` when there is no
 * `<labels>`/`<label>` at all.
 */
function parseLabel(el: Element): string | null {
  const labelsEl = childNamed(el, 'labels');
  if (labelsEl === null) return null;
  const labelEls = childrenNamed(labelsEl, 'label');
  if (labelEls.length === 0) return null;
  const preferred =
    labelEls.find((l) => l.getAttribute('language-id') === LABEL_LANGUAGE_ID) ?? labelEls[0];
  return (preferred.textContent ?? '').trim();
}

/**
 * Reads an `{x, y}` pair out of a metadata value. Accepts Kaleo's `[x, y]` array
 * form (what this codec writes, and what Kaleo's own `"xy"` uses) as well as an
 * `{x, y}` object, so a hand-edited payload in either shape works.
 */
function parsePoint(value: unknown): { x: number; y: number } | null {
  if (Array.isArray(value) && value.length >= 2) {
    const [x, y] = value;
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    const { x, y } = value as { x?: unknown; y?: unknown };
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }
  return null;
}

/**
 * Reads one Start/End terminal-marker state out of the root metadata:
 * `'auto'` | `'hidden'` | `{x, y}` (or `[x, y]`). An ABSENT key defaults to
 * `'auto'` — the sparse serialization's inverse.
 */
function parseTerminalState(value: unknown, tag: 'Mulai' | 'Selesai'): Parsed<TerminalNodeStateDto> {
  if (value === undefined) return { ok: true, value: 'auto' };
  if (value === 'auto' || value === 'hidden') return { ok: true, value };
  const point = parsePoint(value);
  if (point !== null) return { ok: true, value: point };
  return {
    ok: false,
    error: `Penanda ${tag} harus "auto", "hidden", atau posisi {"x":0,"y":0}.`,
  };
}

/**
 * Reads the root `<metadata>` — the graph-wide `terminalNodes` + `endSources`.
 * `knownStates` filters `endSources` defensively (drop a name that is not a
 * parsed status), mirroring the same rule the former codec applied: a stale
 * entry referencing a removed status never survives the round-trip.
 */
function parseRootMetadata(
  root: Element,
  knownStates: ReadonlySet<string>,
): Parsed<{ terminalNodes: { start: TerminalNodeStateDto; end: TerminalNodeStateDto }; endSources: string[] }> {
  const meta = parseMetadata(root, 'alur status');
  if (!meta.ok) return meta;
  const raw = meta.value.terminalNodes;
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    return { ok: false, error: 'Bagian "terminalNodes" pada <metadata> harus berupa objek JSON.' };
  }
  const terminals = (raw ?? {}) as { start?: unknown; end?: unknown };
  const start = parseTerminalState(terminals.start, 'Mulai');
  if (!start.ok) return start;
  const end = parseTerminalState(terminals.end, 'Selesai');
  if (!end.ok) return end;

  const endSourcesRaw = meta.value.endSources;
  if (endSourcesRaw !== undefined && !Array.isArray(endSourcesRaw)) {
    return { ok: false, error: 'Bagian "endSources" pada <metadata> harus berupa daftar nama status.' };
  }
  const endSources = ((endSourcesRaw ?? []) as unknown[]).filter(
    (s): s is string => typeof s === 'string' && knownStates.has(s),
  );
  return { ok: true, value: { terminalNodes: { start: start.value, end: end.value }, endSources } };
}

/** Reads the `<actions>` block of a node into the QMS `NodeActionDto[]`. An
 *  absent or empty block yields `[]` (the caller omits the key entirely, so a
 *  status with no actions round-trips as an ABSENT key, not an empty array). */
function parseNodeActions(nodeEl: Element, stateName: string): Parsed<NodeActionDto[]> {
  const actionsEl = childNamed(nodeEl, 'actions');
  if (actionsEl === null) return { ok: true, value: [] };
  const actions: NodeActionDto[] = [];
  for (const actionEl of childrenNamed(actionsEl, 'action')) {
    const executionRaw = childText(actionEl, 'execution-type');
    const executionType = executionRaw === null ? undefined : KALEO_TO_EXECUTION_TYPE[executionRaw.toLowerCase()];
    if (executionType === undefined) {
      return {
        ok: false,
        error: `Aksi pada status '${stateName}' harus punya <execution-type> berisi "onEntry" atau "onExit".`,
      };
    }
    const meta = parseMetadata(actionEl, `aksi status '${stateName}'`);
    if (!meta.ok) return meta;
    const { type, value } = meta.value as { type?: unknown; value?: unknown };
    if (typeof type !== 'string' || typeof value !== 'string') {
      return {
        ok: false,
        error: `Aksi pada status '${stateName}' harus punya <metadata> berisi "type" dan "value".`,
      };
    }
    if (type !== 'UPDATE_STATUS') {
      return { ok: false, error: `"type" pada aksi status '${stateName}' harus "UPDATE_STATUS".` };
    }
    actions.push({ executionType, type: type as NodeActionType, value });
  }
  return { ok: true, value: actions };
}

/**
 * Validates the `action` out of a transition's metadata — what running the edge
 * does. Absent → the {@link DEFAULT_TRANSITION_ACTION} the serializer omits it
 * for, which is also what every edge authored before the field existed means.
 *
 * The accepted set is DERIVED from {@link TRANSITION_ACTIONS}, the same list the
 * dropdown derives its options from — so widening the union teaches the codec and
 * the UI in one edit. An earlier action-type parser here hardcoded its one
 * accepted literal and would have silently rejected a value the dropdown had
 * already started offering. It reads the action LIST rather than the label map, so
 * this codec depends on no presentation copy.
 */
function parseTransitionAction(value: unknown, from: string): Parsed<TransitionActionType> {
  if (value === undefined) return { ok: true, value: DEFAULT_TRANSITION_ACTION };
  if (typeof value === 'string' && (TRANSITION_ACTIONS as readonly string[]).includes(value)) {
    return { ok: true, value: value as TransitionActionType };
  }
  return {
    ok: false,
    error: `"action" pada transisi dari status '${from}' harus salah satu dari ${TRANSITION_ACTIONS
      .map((k) => `"${k}"`)
      .join(', ')}.`,
  };
}

/** Validates one connection-side value out of a transition's metadata. Absent →
 *  `undefined` (default routing). The side enum is validated HERE (the parse
 *  boundary), NOT in `validateCustomStateMachine` — sides are layout, not graph
 *  structure. */
function parseSide(value: unknown, from: string): Parsed<Side | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'string' && EDGE_SIDES.includes(value as Side)) {
    return { ok: true, value: value as Side };
  }
  return {
    ok: false,
    error: `Titik sambungan transisi dari status '${from}' harus salah satu dari "top", "right", "bottom", "left".`,
  };
}

/** Reads the `<transitions>` block of a node. `from` is the CONTAINING node's
 *  name — the nesting is what encodes it, so a transition can never dangle from
 *  a status that is not in the graph. */
function parseNodeTransitions(nodeEl: Element, from: string): Parsed<Transition[]> {
  const transitionsEl = childNamed(nodeEl, 'transitions');
  if (transitionsEl === null) return { ok: true, value: [] };
  const transitions: Transition[] = [];
  for (const transitionEl of childrenNamed(transitionsEl, 'transition')) {
    const actionLabel = parseLabel(transitionEl);
    if (actionLabel === null) {
      return {
        ok: false,
        error: `Setiap transisi dari status '${from}' harus punya <labels> berisi <label> — teks tombolnya di layar petugas.`,
      };
    }
    const to = childText(transitionEl, 'target');
    if (to === null || to.length === 0) {
      return {
        ok: false,
        error: `Setiap transisi dari status '${from}' harus punya <target> berisi nama status tujuan.`,
      };
    }
    const meta = parseMetadata(transitionEl, `transisi dari status '${from}'`);
    if (!meta.ok) return meta;
    const sourceSide = parseSide(meta.value.sourceSide, from);
    if (!sourceSide.ok) return sourceSide;
    const targetSide = parseSide(meta.value.targetSide, from);
    if (!targetSide.ok) return targetSide;
    const action = parseTransitionAction(meta.value.action, from);
    if (!action.ok) return action;
    // `<name>` and `<default>` are DERIVED on serialize (a slug of the label /
    // the first-outgoing flag), so they are read back as nothing at all.
    const transition: Transition = { from, to, actionLabel, action: action.value };
    if (sourceSide.value !== undefined) transition.sourceSide = sourceSide.value;
    if (targetSide.value !== undefined) transition.targetSide = targetSide.value;
    transitions.push(transition);
  }
  return { ok: true, value: transitions };
}

/**
 * Parses the Source view's Kaleo XML back into a {@link StateMachineForm}.
 *
 * **Never throws** — every failure (malformed XML, wrong shape, a graph the
 * backend would 400) is returned as `{ ok: false, error }` so a half-typed
 * textarea can never crash the designer page. The textarea is the one untrusted
 * input on this surface; funneling every failure through a result type keeps
 * the page resilient (mirrors the domain rule that a shared VO's construction
 * failure is a result/400, not an uncaught throw).
 *
 * The returned form is COMPLETE — states, transitions, positions, descriptions,
 * node actions, terminal markers and end sources all come out of the XML, so the
 * caller needs no merge-back against the previous draft.
 *
 * It is ALWAYS `mode: 'custom'` — editing the source is an explicit custom-graph
 * intent, so even XML that deep-equals the PRD §7 default graph is treated as
 * custom (the manager typed it). This matches {@link toStateMachineDto}'s
 * contract: it force-resets to the default graph only when `mode === 'default'`,
 * and a manager who touched the source chose custom.
 *
 * Parsing uses the browser/jsdom `DOMParser` (`application/xml`), so a malformed
 * document surfaces a `<parsererror>` element — detected and turned into an
 * error result (never thrown). Unknown elements/attributes are ignored (lenient
 * on extras, strict on the Kaleo shape); `<task>` and `<state>` are accepted
 * interchangeably as nodes; Kaleo's `<initial>`, `<default>`, transition
 * `<name>`, action `<name>` and the node `<labels>` are all DERIVED on serialize
 * and therefore ignored here. Validation runs through the shared
 * {@link validateCustomStateMachine} so the source view and the visual diagram
 * enforce the same invariants — the first error is returned (one message at a
 * time stays readable in the textarea gutter; the full list is visible in the
 * Diagram view's `sm-errors`).
 */
export function xmlToForm(xml: string): XmlToFormOk | XmlToFormErr {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // A malformed XML document surfaces a `<parsererror>` element (the
  // DOMParser spec's error signal — it does not throw). jsdom follows the
  // same convention, so the detection works in tests too.
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    return { ok: false, error: `XML tidak valid: ${parserError.textContent ?? 'kesalahan parse'}` };
  }
  const root = doc.documentElement;
  if (!root || root.tagName !== ROOT_TAG) {
    return { ok: false, error: `Akar dokumen harus <${ROOT_TAG}>.` };
  }

  // A node is a `<task>` (has outgoing transitions) or a `<state>` (terminal).
  // Both are read the same way — the distinction is derived on serialize, so a
  // hand-edited document that picks the "wrong" one still parses.
  const nodeEls = Array.from(root.children).filter(
    (c) => c.tagName === 'task' || c.tagName === 'state',
  );

  const states: string[] = [];
  const positions: Record<string, { x: number; y: number }> = {};
  const descriptions: Record<string, string> = {};
  const nodeActions: Record<string, NodeActionDto[]> = {};
  const transitions: Transition[] = [];

  for (const nodeEl of nodeEls) {
    const name = childText(nodeEl, 'name');
    if (name === null) {
      return { ok: false, error: 'Setiap status harus punya <name>.' };
    }
    if (name.length === 0) {
      return { ok: false, error: 'Isi <name> pada status tidak boleh kosong.' };
    }

    const meta = parseMetadata(nodeEl, `status '${name}'`);
    if (!meta.ok) return meta;
    const point = parsePoint(meta.value.xy);
    if (point === null) {
      return {
        ok: false,
        error: `Status '${name}' harus punya posisi kanvas — tambahkan <metadata> berisi {"xy":[0,0]} dengan dua angka.`,
      };
    }
    positions[name] = point;
    // A `description` is carried only when it is a real non-empty override; an
    // empty one is skipped so `descriptionFor` falls back to the derived
    // canonical copy (sparse, matching what `formToXml` emits). Stored verbatim
    // (untrimmed) — `updateStateDescription` and the backend VO trim/drop at
    // their own boundaries, and the source view keeps the manager's text as
    // typed so the textarea does not flicker while editing.
    const desc = meta.value.description;
    if (typeof desc === 'string' && desc.trim().length > 0) descriptions[name] = desc;

    const actions = parseNodeActions(nodeEl, name);
    if (!actions.ok) return actions;
    if (actions.value.length > 0) nodeActions[name] = actions.value;

    const nodeTransitions = parseNodeTransitions(nodeEl, name);
    if (!nodeTransitions.ok) return nodeTransitions;

    states.push(name);
    transitions.push(...nodeTransitions.value);
  }

  // The root metadata is read AFTER the nodes so `endSources` can be filtered
  // against the parsed status names.
  const rootMeta = parseRootMetadata(root, new Set(states));
  if (!rootMeta.ok) return { ok: false, error: rootMeta.error };

  const form: StateMachineForm = {
    mode: 'custom',
    states,
    transitions,
    positions,
    nodeActions,
    descriptions,
    terminalNodes: rootMeta.value.terminalNodes,
    endSources: rootMeta.value.endSources,
  };
  const errors = validateCustomStateMachine(form);
  if (errors.length > 0) {
    return { ok: false, error: errors[0] };
  }
  return { ok: true, form };
}

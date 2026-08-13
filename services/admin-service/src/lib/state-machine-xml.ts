/**
 * The XML "Source" view codec for the Alur Status Tiket graph — a Kaleo-
 * Designer-style editable source pane alongside the visual
 * {@link StateMachineWorkflow} diagram.
 *
 * Replaces the former JSON source view (`formToJson`/`jsonToForm`, deleted
 * from `state-machine.ts`). XML carries the state node x/y positions and the
 * transition connection sides + from→to direction that the JSON form could
 * not express readably:
 *
 * ```xml
 * <?xml version="1.0" encoding="UTF-8"?>
 * <stateMachine>
 *   <state name="WAITING" x="0" y="0"/>
 *   <state name="CALLING" x="240" y="0"/>
 *   <transition from="WAITING" to="CALLING" actionLabel="Panggil Berikutnya"/>
 *   <transition from="CALLING" to="SKIPPED" actionLabel="Lewati / Absen" sourceSide="bottom" targetSide="top"/>
 * </stateMachine>
 * ```
 *
 * Positions are the single source of truth shared with the Diagram view: an
 * absent position (empty `positions` map, i.e. an un-customized graph) is
 * materialized from the shared `autoLayout` (the canonical default-positions
 * derivation in `state-machine.ts`), so the XML Source always carries the
 * coordinates the canvas renders and the two views of the same
 * {@link StateMachineForm} can never diverge — the XML is the human-editable
 * source the diagram arranges from.
 *
 * This module is the ONE DOM-dependent module in the state-machine lib surface
 * (`DOMParser`/`XMLSerializer` are browser + jsdom built-ins — no external
 * dependency, NFR-REL-01 safe). It imports from the pure `state-machine.ts`
 * (no DOM) so the dependency direction stays clean: the DOM layer depends on
 * the pure layer, never the reverse. `state-machine.ts` and
 * `state-machine-flow.ts` remain framework-free.
 */
import {
  autoLayout,
  DEFAULT_SOURCE_SIDE,
  DEFAULT_TARGET_SIDE,
  EDGE_SIDES,
  isDefaultSides,
  validateCustomStateMachine,
  type StateMachineForm,
  type Transition,
} from './state-machine';
import type { EdgeSide } from '../api/types';

// `EdgeSide` is the wire enum `'top'|'right'|'bottom'|'left'` (from
// `api/types`); `EDGE_SIDES` (imported from the pure `state-machine.ts`) is its
// runtime list, reused as the single source of truth for enum validation.
type Side = EdgeSide;

/**
 * Escapes the five XML-special characters for an attribute value. Both quote
 * styles are escaped so either delimiter is safe regardless of which the
 * serializer would choose. Used for every attribute value (`name`, `from`,
 * `to`, `actionLabel`, `x`, `y`) so a state name or label containing `&`/`<`/
 * `>`/quotes round-trips without breaking the parse.
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
 * Serializes a number to a 2-decimal-place string via
 * `String(Math.round(n * 100) / 100)`. Sub-pixel display drift is acceptable;
 * the truncation is what makes x/y STABLE across source round-trips (a
 * serialize→parse→serialize cycle reproduces the same text, so the textarea
 * does not flicker while the manager types).
 */
function coord(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * Serializes the editable state machine into the XML shown in the designer's
 * Source view. The `mode` preset is deliberately NOT included — the source is
 * the graph only (`<state>` + `<transition>`), and `mode` is a client-only UI
 * preset that never travels on the wire ({@link toStateMachineDto} owns
 * stripping it). `<state>` elements come first (in `form.states` order), then
 * `<transition>` elements, so the output is deterministic and stable across
 * re-serializations (a flickering diff while the manager types would be noise).
 *
 * Each `<state>` carries its `name` + canvas `x`/`y`. An absent position (an
 * entry missing from `form.positions`, which is `{}` for an un-customized graph)
 * is materialized from the shared {@link autoLayout} — the SAME default-
 * positions derivation the Diagram's `formToFlow` (in `state-machine-flow.ts`)
 * uses — so the Source XML is the single source of truth and the diagram
 * arranges from it: the two views of the same {@link StateMachineForm} cannot
 * diverge, and an un-customized graph serializes the spread the canvas renders
 * rather than `0,0` for every state. A manager-moved node's position (a
 * `form.positions` entry) round-trips through the source unchanged.
 * Connection sides are included on a `<transition>` ONLY when non-default
 * (`!isDefaultSides`): a default edge → `from/to/actionLabel` only; a vertical
 * edge → `... sourceSide="bottom" targetSide="top"`. Both sides are emitted
 * together when either is non-default, so the source never shows a half-routed
 * edge. This mirrors the sparse {@link toEdgeRoutingLayoutDto} wire map — the
 * source is the human-readable twin of the wire map, so they omit the same
 * default entries.
 */
export function formToXml(form: StateMachineForm): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<stateMachine>'];
  // The SAME default-positions derivation the Diagram uses (`formToFlow` in
  // state-machine-flow.ts), so the Source XML always carries the coordinates
  // the canvas renders. `form.positions` is the source of truth; an empty map
  // (`{}` = "use autoLayout") is materialized here so the XML — the human-
  // editable single source of truth — never shows 0,0 while the diagram shows
  // a spread.
  const auto = autoLayout(form.states, form.transitions);
  for (const name of form.states) {
    const pos = form.positions[name] ?? auto[name] ?? { x: 0, y: 0 };
    lines.push(
      `  <state name="${escapeXmlAttr(name)}" x="${coord(pos.x)}" y="${coord(pos.y)}"/>`,
    );
  }
  for (const t of form.transitions) {
    const parts = [
      `from="${escapeXmlAttr(t.from)}"`,
      `to="${escapeXmlAttr(t.to)}"`,
      `actionLabel="${escapeXmlAttr(t.actionLabel)}"`,
    ];
    if (!isDefaultSides(t.sourceSide, t.targetSide)) {
      parts.push(`sourceSide="${t.sourceSide ?? DEFAULT_SOURCE_SIDE}"`);
      parts.push(`targetSide="${t.targetSide ?? DEFAULT_TARGET_SIDE}"`);
    }
    lines.push(`  <transition ${parts.join(' ')}/>`);
  }
  lines.push('</stateMachine>');
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

/**
 * Reads a required string attribute from an element, or returns `null` when
 * absent (the caller turns the first `null` into a clear "missing attribute"
 * error). Centralizes the `getAttribute` + null-check so each `<state>`/
 * `<transition>` validation reads the same way.
 */
function requiredAttr(
  el: Element,
  name: string,
): string | null {
  const v = el.getAttribute(name);
  return v === null ? null : v;
}

/**
 * Validates an optional connection-side attribute. Returns the parsed
 * {@link Side} when present + valid, `undefined` when absent (default routing),
 * or an error string when present but not in the enum. The side enum is
 * validated HERE (the parse boundary), NOT in `validateCustomStateMachine` —
 * sides are layout, not graph structure (mirrors the old `jsonToForm` rule).
 */
function parseSideAttr(
  el: Element,
  attr: 'sourceSide' | 'targetSide',
): { side: Side | undefined; error: string | null } {
  const raw = el.getAttribute(attr);
  if (raw === null) return { side: undefined, error: null };
  if (!EDGE_SIDES.includes(raw as Side)) {
    return {
      side: undefined,
      error: `"${attr}" harus salah satu dari "top", "right", "bottom", "left".`,
    };
  }
  return { side: raw as Side, error: null };
}

/**
 * Parses the Source view's XML text back into a {@link StateMachineForm}.
 *
 * **Never throws** — every failure (malformed XML, wrong shape, a graph the
 * backend would 400) is returned as `{ ok: false, error }` so a half-typed
 * textarea can never crash the designer page. The textarea is the one untrusted
 * input on this surface; funneling every failure through a result type keeps
 * the page resilient (mirrors the domain rule that a shared VO's construction
 * failure is a result/400, not an uncaught throw).
 *
 * The returned form is ALWAYS `mode: 'custom'` — editing the source is an
 * explicit custom-graph intent, so even XML that deep-equals the PRD §7 default
 * graph is treated as custom (the manager typed it). This matches
 * {@link toStateMachineDto}'s contract: it force-resets to the default graph
 * only when `mode === 'default'`, and a manager who touched the source chose
 * custom.
 *
 * Parsing uses the browser/jsdom `DOMParser` (`application/xml`), so a
 * malformed document surfaces a `<parsererror>` element — detected and turned
 * into an error result (never thrown). Unknown attributes/elements are ignored
 * (lenient on extras, strict on the required `<state>`/`<transition>` shape).
 * `<state>` elements are read in document order; each needs a non-empty
 * `name` + finite numeric `x`/`y`. `<transition>` elements need string
 * `from`/`to`/`actionLabel` + optional `sourceSide`/`targetSide` in the enum.
 * `positions` is built from the `<state>` x/y (Record<name,{x,y}>). Validation
 * runs through the shared {@link validateCustomStateMachine} so the source view
 * and the visual diagram enforce the same invariants — the first error is
 * returned (one message at a time stays readable in the textarea gutter; the
 * full list is visible in the Diagram view's `sm-errors`).
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
  if (!root || root.tagName !== 'stateMachine') {
    return { ok: false, error: 'Akar dokumen harus <stateMachine>.' };
  }

  const stateEls = Array.from(root.getElementsByTagName('state'));
  const transitionEls = Array.from(root.getElementsByTagName('transition'));

  const states: string[] = [];
  const positions: Record<string, { x: number; y: number }> = {};
  for (const el of stateEls) {
    const name = requiredAttr(el, 'name');
    if (name === null) return { ok: false, error: 'Setiap <state> harus memiliki atribut "name".' };
    if (!name.trim()) return { ok: false, error: 'Atribut "name" pada <state> tidak boleh kosong.' };
    const xRaw = requiredAttr(el, 'x');
    const yRaw = requiredAttr(el, 'y');
    if (xRaw === null || yRaw === null) {
      return { ok: false, error: 'Setiap <state> harus memiliki atribut "x" dan "y".' };
    }
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: 'Atribut "x" dan "y" pada <state> harus berupa angka.' };
    }
    states.push(name);
    positions[name] = { x, y };
  }

  const transitions: Transition[] = [];
  for (const el of transitionEls) {
    const from = requiredAttr(el, 'from');
    const to = requiredAttr(el, 'to');
    const actionLabel = requiredAttr(el, 'actionLabel');
    if (from === null || to === null || actionLabel === null) {
      return {
        ok: false,
        error: 'Setiap <transition> harus memiliki "from", "to", dan "actionLabel".',
      };
    }
    const source = parseSideAttr(el, 'sourceSide');
    if (source.error) return { ok: false, error: source.error };
    const target = parseSideAttr(el, 'targetSide');
    if (target.error) return { ok: false, error: target.error };
    const t: Transition = { from, to, actionLabel };
    if (source.side !== undefined) t.sourceSide = source.side;
    if (target.side !== undefined) t.targetSide = target.side;
    transitions.push(t);
  }

  const form: StateMachineForm = {
    mode: 'custom',
    states,
    transitions,
    positions,
    // The XML Source view carries no node-level actions (they are panel-only,
    // NOT serialized to XML — `formToXml` omits them). Emit `{}` here; the
    // caller (`AlurStatusDesigner.handleSourceChange`) merges the existing
    // `nodeActions` back so a source edit preserves node actions (the source
    // edits only the graph + positions, never the node-level Aksi list).
    nodeActions: {},
  };
  const errors = validateCustomStateMachine(form);
  if (errors.length > 0) {
    return { ok: false, error: errors[0] };
  }
  return { ok: true, form };
}
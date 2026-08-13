/**
 * The XML "Source" view codec for the Alur Status Tiket graph — an
 * editable XML source pane alongside the visual
 * {@link StateMachineWorkflow} diagram (a designer-style visual/source toggle).
 *
 * Replaces the former JSON source view (`formToJson`/`jsonToForm`, deleted
 * from `state-machine.ts`). XML carries the state node x/y positions and the
 * transition connection sides + from→to direction that the JSON form could
 * not express readably:
 *
 * ```xml
 * <?xml version="1.0" encoding="UTF-8"?>
 * <stateMachine>
 *   <state name="WAITING" x="0" y="0" description="Tiket menunggu dipanggil">
 *     <action execution="ON_ENTRY" type="UPDATE_STATUS" value="CALLING"/>
 *   </state>
 *   <state name="CALLING" x="240" y="0" description="Sedang dipanggil ke counter"/>
 *   <transition from="WAITING" to="CALLING" actionLabel="Panggil Berikutnya"/>
 *   <transition from="CALLING" to="SKIPPED" actionLabel="Lewati / Absen" sourceSide="bottom" targetSide="top"/>
 *   <start auto="true"/>
 *   <end x="720" y="0"/>
 * </stateMachine>
 * ```
 *
 * Each `<state>` carries a `description` attr ONLY when a non-empty saved
 * override is present (parsed back on parse — sparse serialization; the derived
 * fallback is NOT emitted) + optional `<action>` children (the Kaleo-style
 * node-level actions). `<start>`/`<end>` carry the terminal-marker state
 * (`auto="true"` | `hidden="true"` | `x`/`y`), always emitted so the XML fully
 * reflects `form.terminalNodes` (manager feedback: "XML harus memuat semua
 * informasi node").
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
import type {
  EdgeSide,
  NodeActionDto,
  NodeActionExecutionType,
  NodeActionType,
  TerminalNodeStateDto,
} from '../api/types';

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
/**
 * Serializes one terminal-marker state as a `<start>`/`<end>` element:
 * `'auto'` → `<start auto="true"/>`; `'hidden'` → `<start hidden="true"/>`;
 * `{x,y}` → `<start x=".." y=".."/>`. Both elements are ALWAYS emitted (even
 * when `'auto'`) so the XML fully reflects `form.terminalNodes` — the manager's
 * "XML harus memuat semua informasi node" feedback. A reader sees the marker
 * state explicitly rather than inferring it from absence.
 */
function terminalElement(tag: 'start' | 'end', state: TerminalNodeStateDto): string {
  if (state === 'auto') return `  <${tag} auto="true"/>`;
  if (state === 'hidden') return `  <${tag} hidden="true"/>`;
  return `  <${tag} x="${coord(state.x)}" y="${coord(state.y)}"/>`;
}

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
    // Emit a `description` attribute ONLY when a non-empty saved override is
    // present. The derived fallback (canonical copy / transition count) is NOT
    // serialized — it stays a client-side derivation, so the XML stays lean and
    // a round-trip does not pin the canonical copy into the source text (the
    // manager edits only real overrides here). Mirrors how `formToXml` omits
    // default connection sides (sparse serialization).
    const desc = form.descriptions?.[name];
    const descAttr =
      desc !== undefined && desc.trim().length > 0
        ? ` description="${escapeXmlAttr(desc)}"`
        : '';
    const actions = form.nodeActions[name] ?? [];
    const open = `  <state name="${escapeXmlAttr(name)}" x="${coord(pos.x)}" y="${coord(pos.y)}"${descAttr}`;
    if (actions.length === 0) {
      lines.push(`${open}/>`);
    } else {
      lines.push(`${open}>`);
      for (const a of actions) {
        lines.push(
          `    <action execution="${a.executionType}" type="${a.type}" value="${escapeXmlAttr(a.value)}"/>`,
        );
      }
      lines.push('  </state>');
    }
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
  // Terminal markers — ALWAYS emitted so the XML fully reflects
  // `form.terminalNodes` (manager feedback: "XML harus memuat semua informasi
  // node"). `<start>`/`<end>` after `<transition>`s.
  lines.push(terminalElement('start', form.terminalNodes.start));
  lines.push(terminalElement('end', form.terminalNodes.end));
  // Explicit End connections — emitted as `<endSources><source name="X"/>…`
  // ONLY when non-empty (an empty array is the default → omit so a default
  // graph's XML stays lean, mirroring the sparse `description`/sides rule).
  // The names are validated against `form.states` at parse (drop unknown).
  if (form.endSources.length > 0) {
    lines.push('  <endSources>');
    for (const s of form.endSources) {
      lines.push(`    <source name="${escapeXmlAttr(s)}"/>`);
    }
    lines.push('  </endSources>');
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
  // Per-state description overrides parsed from the `description` attribute.
  // An absent or empty attribute is skipped (the derived fallback wins). A
  // present non-empty value is stored verbatim (untrimmed — `updateStateDescription`
  // and the VO trim/drop at the boundaries; the source view keeps the manager's
  // text as typed so the textarea does not flicker while editing).
  const descriptions: Record<string, string> = {};
  const nodeActions: Record<string, NodeActionDto[]> = {};
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
    const descRaw = el.getAttribute('description');
    if (descRaw !== null && descRaw.trim().length > 0) {
      descriptions[name] = descRaw;
    }
    states.push(name);
    positions[name] = { x, y };
    // Parse the per-state <action> children (Kaleo-style node-level actions).
    const actionEls = Array.from(el.children).filter((c) => c.tagName === 'action');
    if (actionEls.length > 0) {
      const parsed: NodeActionDto[] = [];
      for (const aEl of actionEls) {
        const execution = requiredAttr(aEl, 'execution');
        const type = requiredAttr(aEl, 'type');
        const value = requiredAttr(aEl, 'value');
        if (execution === null || type === null || value === null) {
          return {
            ok: false,
            error: 'Setiap <action> harus memiliki "execution", "type", dan "value".',
          };
        }
        if (execution !== 'ON_ENTRY' && execution !== 'ON_EXIT') {
          return {
            ok: false,
            error: '"execution" pada <action> harus "ON_ENTRY" atau "ON_EXIT".',
          };
        }
        if (type !== 'UPDATE_STATUS') {
          return { ok: false, error: '"type" pada <action> harus "UPDATE_STATUS".' };
        }
        parsed.push({
          executionType: execution as NodeActionExecutionType,
          type: type as NodeActionType,
          value,
        });
      }
      nodeActions[name] = parsed;
    }
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

  // Parse the <start>/<end> terminal elements → terminalNodes. Default 'auto'
  // when absent (backward-compat with XML written before this change). A
  // terminal may carry `auto="true"`, `hidden="true"`, or `x`/`y`.
  const terminalNodes = parseTerminalNodes(root);
  if ('error' in terminalNodes) return { ok: false, error: terminalNodes.error };

  // Parse the optional <endSources><source name="X"/></endSources> block →
  // form.endSources. Absent → `[]` (the default — backward-compat with XML
  // written before this change). Names are validated against the parsed
  // `states` (drop unknown, mirroring the defensive parse conventions — a
  // stale entry referencing a removed state never survives the round-trip).
  const stateSet = new Set(states);
  const endSources: string[] = [];
  const endSourcesEl = root.getElementsByTagName('endSources')[0] ?? null;
  if (endSourcesEl) {
    for (const sEl of Array.from(endSourcesEl.children).filter((c) => c.tagName === 'source')) {
      const name = requiredAttr(sEl, 'name');
      if (name === null) return { ok: false, error: 'Setiap <source> harus memiliki atribut "name".' };
      if (!name.trim()) return { ok: false, error: 'Atribut "name" pada <source> tidak boleh kosong.' };
      if (stateSet.has(name)) endSources.push(name);
    }
  }

  const form: StateMachineForm = {
    mode: 'custom',
    states,
    transitions,
    positions,
    // nodeActions, descriptions, terminalNodes, and endSources are all parsed
    // from the XML → xmlToForm returns a COMPLETE form (no caller merge-back
    // needed).
    nodeActions,
    descriptions,
    terminalNodes,
    endSources,
  };
  const errors = validateCustomStateMachine(form);
  if (errors.length > 0) {
    return { ok: false, error: errors[0] };
  }
  return { ok: true, form };
}

/**
 * Parses the `<start>`/`<end>` terminal elements into a {@link TerminalNodesDto}.
 * Each terminal defaults to `'auto'` when its element is absent (backward-compat
 * with XML written before terminal markers were serialized). A present element
 * carries `auto="true"`, `hidden="true"`, or finite `x`/`y`. On a malformed
 * marker (missing x/y, or non-numeric x/y) returns an error result so a
 * half-typed source never crashes the designer.
 */
function parseTerminalNodes(
  root: Element,
): { start: TerminalNodeStateDto; end: TerminalNodeStateDto } | { error: string } {
  const startEl = Array.from(root.getElementsByTagName('start')).at(-1) ?? null;
  const endEl = Array.from(root.getElementsByTagName('end')).at(-1) ?? null;
  const parseOne = (el: Element | null, tag: 'start' | 'end'): TerminalNodeStateDto | { error: string } => {
    if (!el) return 'auto';
    if (el.getAttribute('hidden') === 'true') return 'hidden';
    if (el.getAttribute('auto') === 'true') return 'auto';
    const xRaw = requiredAttr(el, 'x');
    const yRaw = requiredAttr(el, 'y');
    if (xRaw === null || yRaw === null) {
      return { error: `<${tag}> harus memiliki "auto", "hidden", atau "x" dan "y".` };
    }
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { error: `Atribut "x" dan "y" pada <${tag}> harus berupa angka.` };
    }
    return { x, y };
  };
  const start = parseOne(startEl, 'start');
  if (typeof start === 'object' && 'error' in start) return { error: start.error };
  const end = parseOne(endEl, 'end');
  if (typeof end === 'object' && 'error' in end) return { error: end.error };
  return { start, end };
}
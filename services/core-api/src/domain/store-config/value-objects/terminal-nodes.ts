import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/** The per-terminal three-state model.
 *
 *  - `'auto'` — derive the marker position from the real node bounds (default;
 *    preserves the pre-marker-persistence UX where Start/End were auto-derived
 *    canvas-only nodes).
 *  - `'hidden'` — the manager deleted the marker; it is omitted from the canvas
 *    entirely (terminal EDGES still auto-derive from topology — a hidden Start
 *    still connects to every in-degree-0 state, just no marker node is drawn).
 *  - `{ x, y }` — the manager pinned the marker to an explicit canvas position.
 */
export type TerminalNodeState = 'auto' | 'hidden' | { readonly x: number; readonly y: number };

/** The persisted shape: a fixed-shape map `{ start, end }` (the keys are the
 *  fixed terminal ids, NOT arbitrary state names — this is the whole reason
 *  `terminalNodes` is a dedicated JSONB field rather than a piggyback on
 *  `nodePositions`, whose save-use-case cross-check rejects any key that is not
 *  a state name). */
export interface TerminalNodesProps {
  readonly start: TerminalNodeState;
  readonly end: TerminalNodeState;
}

/** Wire DTO (the shape returned by `toDto()` and carried on the config GET/PUT). */
export type TerminalNodesDto = TerminalNodesProps;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalizes one terminal's raw value into a {@link TerminalNodeState}, or
 *  throws `InvalidValueObjectException` on a present-but-malformed value. */
function normalizeTerminal(key: 'start' | 'end', raw: unknown): TerminalNodeState {
  // Absent → 'auto' (the default; preserves the pre-marker-persistence UX so a
  // legacy/partial payload recovers without a per-row migration seed).
  if (raw === undefined) return 'auto';
  // The two string sentinel values.
  if (raw === 'auto' || raw === 'hidden') return raw;
  // A pinned position must be a plain object with finite x/y.
  if (!isPlainObject(raw)) {
    throw new InvalidValueObjectException(
      `terminal nodes['${key}'] must be 'auto', 'hidden', or { x, y }, got '${String(raw)}'`,
    );
  }
  const v = raw as Record<string, unknown>;
  const x = v.x;
  if (!Number.isFinite(x)) {
    throw new InvalidValueObjectException(
      `terminal nodes['${key}'].x must be a finite number, got '${String(x)}'`,
    );
  }
  const y = v.y;
  if (!Number.isFinite(y)) {
    throw new InvalidValueObjectException(
      `terminal nodes['${key}'].y must be a finite number, got '${String(y)}'`,
    );
  }
  // Deep-copy the {x,y} so the caller's input cannot mutate the VO's internal
  // state. Unknown extra properties are ignored — only the 2 canonical fields
  // are read. `Number.isFinite` is a runtime guard but not a TS type-predicate,
  // so the finite-checked values are narrowed via the explicit cast (mirrors
  // `node-positions.ts:88-105`).
  return { x: x as number, y: y as number };
}

/**
 * Persisted Start/End terminal-node presence + position for the admin
 * state-machine editor. A sibling VO on {@link SystemConfiguration}, parallel
 * to `NodeActions` / `NodePositions` — persisted on its own JSONB column
 * (`terminal_nodes`), NOT inside `StateMachine` (keeps `ITransitionPolicy`
 * pure; SRP for `StateMachine`; OCP — a sibling VO added without touching the
 * transition-policy surface). The manager-facing concern is marker PRESENCE +
 * POSITION only; terminal EDGES stay auto-derived from topology (sources =
 * in-degree 0, sinks = out-degree 0), so a pinned or hidden Start still
 * connects to every source (or none if hidden).
 *
 * Keys are the fixed terminal ids `start` / `end` (NOT state names) — this is
 * the whole reason this is a dedicated field: the save use case's
 * state-membership cross-check on `nodePositions` (and `nodeActions`) rejects
 * any key that is not a state name, so `__start` / `__end` cannot piggyback on
 * those maps. A separate fixed-shape VO avoids that cross-check entirely.
 *
 * `of()` is permissive on *missing* (a `undefined`/`null` raw from the
 * pre-migration boot window, a JSON `null`, or an absent `start`/`end` key)
 * → `'auto'` for each missing terminal, so a reconstituted row from before
 * this column existed, or a defensively-empty/partial column, recovers to the
 * default `{ start: 'auto', end: 'auto' }` (markers render at derived
 * positions) without a per-row migration seeding math. It is strict only on
 * *present*-but-malformed values: a non-object raw, a terminal value that is
 * not `'auto'`/`'hidden'`/a plain `{x,y}`, or a non-finite `x`/`y` throws
 * `InvalidValueObjectException` (→ HTTP 400) so a malformed PUT fails fast
 * (NFR-REL-02 — no illegal terminal map burns a write).
 *
 * NO state-membership cross-check (terminal ids `__start`/`__end` are not
 * state names — that is the whole reason this is a separate field), unlike
 * `nodePositions`/`nodeActions` whose keys ARE state names and so ARE
 * cross-checked in the save use case. The VO therefore has no `StateMachine`
 * dependency (DIP / anti-corruption), and the save use case performs no
 * terminal-membership validation.
 *
 * Not change-gated for audit — `terminalNodes` is an appearance concern, like
 * `nodePositions`/`nodeActions`/`edgeRoutingLayout`/`tvPanelLayout`/
 * `brandColor`/`serviceThemes`, and is not in the NFR-SEC-02 audited list
 * (manual reset, state-schema, routing). `equals` is inherited (structural
 * deep-equal, order-insensitive over object keys) and available if a future
 * ticket adds a terminal-change diff-audit.
 */
export class TerminalNodes extends ValueObject<TerminalNodesProps> {
  private constructor(props: TerminalNodesProps) {
    super(props);
  }

  public static of(raw: unknown): TerminalNodes {
    // Non-object (undefined/null from the pre-migration boot window or a JSON
    // null) → DEFAULT (auto/auto). A present-but-wrong-shape value (string,
    // array, number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return TerminalNodes.DEFAULT;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `terminal nodes must be a plain object { start, end }, got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;
    return new TerminalNodes({
      start: normalizeTerminal('start', incoming.start),
      end: normalizeTerminal('end', incoming.end),
    });
  }

  /** `{ start: 'auto', end: 'auto' }` — markers render at derived positions.
   *  Matches `NodePositions.DEFAULT` / `NodeActions.DEFAULT` /
   *  `EdgeRoutingLayout.DEFAULT` for zero visual regression — a store that
   *  never configures this keeps the auto-derived markers. */
  public static DEFAULT: TerminalNodes = TerminalNodes.of({});

  public get start(): TerminalNodeState {
    return this.props.start;
  }

  public get end(): TerminalNodeState {
    return this.props.end;
  }

  /** Returns a deep copy of the props so callers can mutate the DTO without
   *  affecting the VO (a pinned `{x,y}` is rebuilt into a fresh object). */
  public toDto(): TerminalNodesDto {
    return {
      start: cloneTerminal(this.props.start),
      end: cloneTerminal(this.props.end),
    };
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}

/** Deep-copies a single terminal state so the returned DTO is independent of
 *  the VO's internal state. */
function cloneTerminal(state: TerminalNodeState): TerminalNodeState {
  if (typeof state === 'string') return state;
  return { x: state.x, y: state.y };
}
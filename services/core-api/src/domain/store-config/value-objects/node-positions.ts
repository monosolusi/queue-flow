import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/** A single state node's x/y position on the admin state-machine canvas. */
export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

/** The persisted shape: a keyed map `stateName -> { x, y }`. Non-sparse — every
 *  state whose position is known has an entry; `{}` means "use the deterministic
 *  autoLayout". */
export type NodePositionsMap = Readonly<Record<string, NodePosition>>;

/** Wire DTO (the shape returned by `toDto()` and carried on the config GET/PUT). */
export type NodePositionsDto = Record<string, NodePosition>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Per-state node x/y positions for the admin state-machine visual editor,
 * persisted on {@link SystemConfiguration} as a JSONB object column (the
 * `edge_routing_layout` / `service_themes` keyed-map precedent, not the scalar
 * `brand_color` column — a keyed map is a nested value object). Keys are state
 * names (e.g. `"WAITING"`); the editor reads `GET /api/system/config`, applies
 * each entry's `x`/`y` as the node's canvas position, and writes the whole map
 * back on save. The map is NON-SPARSE: every state whose position is known has
 * an entry. An empty object `{}` means "use the deterministic autoLayout" —
 * this is the default, so a store that never configures this keeps the
 * editor's auto-laid-out canvas (zero visual regression, mirroring
 * `EdgeRoutingLayout` / `ServiceThemes` / `TvPanelLayout`).
 *
 * `of()` is permissive on *missing* (a `undefined`/`null` raw from the
 * pre-migration boot window or a JSON `null`) so a reconstituted row from before
 * this column existed, or a defensively-empty column, recovers to the default
 * (empty map = autoLayout) without a migration. It is strict only on *present*
 * entries: a non-object raw, a non-object value, or a present `x`/`y` that is
 * not a finite number throws `InvalidValueObjectException` (→ HTTP 400) so a
 * malformed PUT fails fast (NFR-REL-02 — no illegal layout burns a write).
 *
 * State-membership validation (every position key must be a state in the active
 * state machine) lives in the **save use case**, NOT here — this keeps the VO
 * free of a `StateMachine` dependency (DIP / anti-corruption: a pure domain
 * value object must not reach into the state-machine aggregate).
 *
 * Not change-gated for audit — `nodePositions` is an appearance concern, like
 * `edgeRoutingLayout`/`tvPanelLayout`/`brandColor`/`serviceThemes`, and is not
 * in the NFR-SEC-02 audited list (manual reset, state-schema, routing). `equals`
 * is inherited (structural deep-equal, order-insensitive over object keys) and
 * available if a future ticket adds a position-change diff-audit.
 */
export class NodePositions extends ValueObject<NodePositionsMap> {
  private constructor(map: NodePositionsMap) {
    super(map);
  }

  public static of(raw: unknown): NodePositions {
    // Non-object (undefined/null from the pre-migration boot window or a JSON
    // null) → empty default map. A present-but-wrong-shape value (string,
    // array, number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return NodePositions.DEFAULT;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `node positions must be a plain object (keyed map), got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;
    const map: Record<string, NodePosition> = {};
    for (const [key, value] of Object.entries(incoming)) {
      // Keys are state names. JS object keys are always strings, but an
      // empty-string key is malformed → reject.
      if (typeof key !== 'string' || key.length === 0) {
        throw new InvalidValueObjectException(
          `node positions key must be a non-empty string, got '${String(key)}'`,
        );
      }
      if (!isPlainObject(value)) {
        throw new InvalidValueObjectException(
          `node positions['${key}'] must be an object with numeric x/y, got '${String(value)}'`,
        );
      }
      const v = value as Record<string, unknown>;
      const x = v.x;
      if (!Number.isFinite(x)) {
        throw new InvalidValueObjectException(
          `node positions['${key}'].x must be a finite number, got '${String(x)}'`,
        );
      }
      const y = v.y;
      if (!Number.isFinite(y)) {
        throw new InvalidValueObjectException(
          `node positions['${key}'].y must be a finite number, got '${String(y)}'`,
        );
      }
      // Deep-copy each entry into the stored map so the caller's input cannot
      // mutate the VO's internal state. Unknown extra properties are ignored —
      // only the 2 canonical fields are read. `Number.isFinite` is a runtime
      // guard but not a TS type-predicate, so the finite-checked values are
      // narrowed via the explicit cast (mirrors how `edge-routing-layout.ts`
      // uses an `isEdgeSide` type-guard for its enum check).
      map[key] = { x: x as number, y: y as number };
    }
    return new NodePositions(map);
  }

  /** Empty map = use the deterministic autoLayout. Matches
   * `EdgeRoutingLayout.DEFAULT` / `ServiceThemes.DEFAULT` / `TvPanelLayout.DEFAULT`
   * for zero visual regression — a store that never configures this keeps the
   * auto-laid-out canvas. */
  public static DEFAULT: NodePositions = NodePositions.of({});

  /** The keyed map of per-state node positions. */
  public get positions(): NodePositionsMap {
    return this.props;
  }

  /** The position keys (state names) — used by the save use case cross-check
   *  against the active state-machine state names. */
  public keys(): string[] {
    return Object.keys(this.props);
  }

  /** Returns a deep copy of the map so callers can mutate the DTO without
   *  affecting the VO (each entry is rebuilt into a fresh object). */
  public toDto(): NodePositionsDto {
    const out: Record<string, NodePosition> = {};
    for (const [key, { x, y }] of Object.entries(this.props)) {
      out[key] = { x, y };
    }
    return out;
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}
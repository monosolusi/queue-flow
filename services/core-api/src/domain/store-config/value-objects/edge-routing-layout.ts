import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * Which side of a node a transition edge connects to, in the admin
 * state-machine visual editor. The four axis-aligned handle choices React Flow
 * exposes per node. Stable wire identifier; the friendly labels live in the
 * admin client, never here.
 */
export type EdgeSide = 'top' | 'right' | 'bottom' | 'left';

export const EDGE_SIDES: readonly EdgeSide[] = ['top', 'right', 'bottom', 'left'];

/**
 * The per-edge connection-point choice: which side of the source node the edge
 * leaves from, and which side of the target node it arrives at. The default
 * routing is `sourceSide: 'right', targetSide: 'left'` (left→right flow) — those
 * entries are omitted from the wire map (the map is sparse).
 */
export interface EdgeSides {
  readonly sourceSide: EdgeSide;
  readonly targetSide: EdgeSide;
}

/** The persisted shape: a sparse keyed map `"from->to" -> { sourceSide, targetSide }`. */
export type EdgeRoutingLayoutMap = Readonly<Record<string, EdgeSides>>;

/** Wire DTO (the shape returned by `toDto()` and carried on the config GET/PUT). */
export type EdgeRoutingLayoutDto = Record<string, EdgeSides>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEdgeSide(value: unknown): value is EdgeSide {
  return typeof value === 'string' && (EDGE_SIDES as readonly string[]).includes(value);
}

/**
 * Per-edge connection-point (handle) layout for the admin state-machine visual
 * editor, persisted on {@link SystemConfiguration} as a JSONB object column
 * (the `service_themes` keyed-map precedent, not the scalar `brand_color`
 * column — a sparse edge→sides map is a nested value object). Keys are opaque
 * strings of the form `${from}->${to}` (e.g. `"SKIPPED->CALLING"`); the editor
 * reads `GET /api/system/config`, applies each entry's `sourceSide`/`targetSide`
 * as the edge's source/target handle, and writes the whole map back on save.
 * The map is SPARSE: it only carries entries for edges with non-default
 * connection points. The default connection is `sourceSide: 'right'`,
 * `targetSide: 'left'` (omitted from the wire map). An empty object `{}`
 * means "every edge uses the default left→right routing" — this is the default,
 * so a store that never configures this keeps the existing editor routing
 * (zero visual regression, mirroring `ServiceThemes` / `TvPanelLayout`).
 *
 * `of()` is permissive on *missing* (a `undefined`/`null` raw from the
 * pre-migration boot window or a JSON `null`) so a reconstituted row from before
 * this column existed, or a defensively-empty column, recovers to the default
 * (empty map = all-default routing) without a migration. It is strict only on
 * *present* entries: a non-object raw, a non-object value, or a present
 * `sourceSide`/`targetSide` that is not a string in {top,right,bottom,left}
 * throws `InvalidValueObjectException` (→ HTTP 400) so a malformed PUT fails
 * fast (NFR-REL-02 — no illegal layout burns a write).
 *
 * Edge-membership validation (every layout key must be an active transition in
 * the state machine) lives in the **save use case**, NOT here — this keeps the
 * VO free of a `StateMachine` dependency (DIP / anti-corruption: a pure domain
 * value object must not reach into the state-machine aggregate).
 *
 * Not change-gated for audit — `edgeRoutingLayout` is an appearance concern,
 * like `tvPanelLayout`/`brandColor`/`serviceThemes`, and is not in the
 * NFR-SEC-02 audited list (manual reset, state-schema, routing). `equals` is
 * inherited (structural deep-equal, order-insensitive over object keys) and
 * available if a future ticket adds layout-change diff-audit.
 */
export class EdgeRoutingLayout extends ValueObject<EdgeRoutingLayoutMap> {
  private constructor(map: EdgeRoutingLayoutMap) {
    super(map);
  }

  public static of(raw: unknown): EdgeRoutingLayout {
    // Non-object (undefined/null from the pre-migration boot window or a JSON
    // null) → empty default map. A present-but-wrong-shape value (string,
    // array, number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return EdgeRoutingLayout.DEFAULT;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `edge routing layout must be a plain object (keyed map), got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;
    const map: Record<string, EdgeSides> = {};
    for (const [key, value] of Object.entries(incoming)) {
      // Keys are opaque strings of the form "from->to". JS object keys are
      // always strings, but an empty-string key is malformed → reject.
      if (typeof key !== 'string' || key.length === 0) {
        throw new InvalidValueObjectException(
          `edge routing layout key must be a non-empty string, got '${String(key)}'`,
        );
      }
      if (!isPlainObject(value)) {
        throw new InvalidValueObjectException(
          `edge routing layout['${key}'] must be an object with string sourceSide/targetSide, got '${String(value)}'`,
        );
      }
      const v = value as Record<string, unknown>;
      const sourceSide = v.sourceSide;
      if (!isEdgeSide(sourceSide)) {
        throw new InvalidValueObjectException(
          `edge routing layout['${key}'].sourceSide must be one of [${EDGE_SIDES.join(', ')}], got '${String(sourceSide)}'`,
        );
      }
      const targetSide = v.targetSide;
      if (!isEdgeSide(targetSide)) {
        throw new InvalidValueObjectException(
          `edge routing layout['${key}'].targetSide must be one of [${EDGE_SIDES.join(', ')}], got '${String(targetSide)}'`,
        );
      }
      // Deep-copy each entry into the stored map so the caller's input cannot
      // mutate the VO's internal state. Unknown extra properties are ignored —
      // only the 2 canonical fields are read.
      map[key] = { sourceSide, targetSide };
    }
    return new EdgeRoutingLayout(map);
  }

  /** Empty map = every edge uses the default left→right routing. Matches
   * `ServiceThemes.DEFAULT` / `TvPanelLayout.DEFAULT` for zero visual
   * regression — a store that never configures this keeps the existing routing. */
  public static DEFAULT: EdgeRoutingLayout = EdgeRoutingLayout.of({});

  /** The sparse keyed map of per-edge connection-point choices. */
  public get routing(): EdgeRoutingLayoutMap {
    return this.props;
  }

  /** The layout keys (opaque `"from->to"` strings) — used by the save use case
   *  cross-check against the active state-machine edges. */
  public keys(): string[] {
    return Object.keys(this.props);
  }

  /** Returns a deep copy of the map so callers can mutate the DTO without
   *  affecting the VO (each entry is rebuilt into a fresh object). */
  public toDto(): EdgeRoutingLayoutDto {
    const out: Record<string, EdgeSides> = {};
    for (const [key, { sourceSide, targetSide }] of Object.entries(this.props)) {
      out[key] = { sourceSide, targetSide };
    }
    return out;
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}
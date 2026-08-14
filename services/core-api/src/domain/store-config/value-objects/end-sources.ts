import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/** Wire DTO (the shape returned by `toDto()` and carried on the config GET/PUT).
 *  A flat array of state names explicitly connected to the End terminal marker. */
export type EndSourcesDto = string[];

/**
 * Explicit "end sources" for the admin state-machine editor — the flat array of
 * state NAMES the manager dragged an explicit arrow from into the End terminal
 * marker (`__end`). Persisted on {@link SystemConfiguration} as a sibling VO
 * (parallel to `NodePositions` / `NodeActions` / `TerminalNodes`) on its own
 * JSONB column (`end_sources`).
 *
 * The manager drags a connection from a state into End, with MULTIPLE allowed —
 * these "end sources" are purely visual canvas metadata (like node positions):
 * they have NO domain / queue-engine meaning and are NOT consumed by caller /
 * tv / kiosk (ISP — they never read `endSources`). They persist across save /
 * reload so the manager-designed canvas is stable. How the admin canvas renders
 * them (and whether it derives any additional End arrow of its own) is a
 * PRESENTATION concern owned entirely by admin-service — this VO deliberately
 * states no canvas derivation rule.
 *
 * `of()` is permissive on *missing* (a `undefined`/`null` raw from the
 * pre-migration boot window or a JSON `null`) so a reconstituted row from before
 * this column existed, or a defensively-empty column, recovers to the default
 * (an empty array — no end sources recorded) without a per-row migration
 * seeding. It is strict
 * only on *present*-but-malformed values: a non-array raw, a non-string
 * element, an empty/whitespace-only element, or a duplicate entry throws
 * `InvalidValueObjectException` (→ HTTP 400) so a malformed PUT fails fast
 * (NFR-REL-02 — no illegal end-sources array burns a write). Entries are
 * trimmed and de-duplicated defensively (the wire shape is a flat `string[]`,
 * not a state-name-keyed map like `nodePositions`/`nodeActions`).
 *
 * State-membership validation (every entry must be a state in the active state
 * machine) lives in the **save use case**, NOT here — this keeps the VO free of
 * a `StateMachine` dependency (DIP / anti-corruption: a pure domain value
 * object must not reach into the state-machine aggregate). Mirrors
 * `nodePositions` / `nodeActions` whose keys are also state names and are
 * cross-checked in the save use case.
 *
 * Not change-gated for audit — `endSources` is an appearance concern, like
 * `nodePositions`/`nodeActions`/`terminalNodes`/`edgeRoutingLayout`, and is
 * not in the NFR-SEC-02 audited list (manual reset, state-schema, routing).
 * `equals` is inherited (structural deep-equal — array order-sensitive, but
 * `of()` de-duplicates preserving first-occurrence order deterministically, so
 * identical inputs produce identical VOs) and available if a future ticket
 * adds an end-sources-change diff-audit.
 */
export class EndSources extends ValueObject<EndSourcesDto> {
  private constructor(sources: EndSourcesDto) {
    super(sources);
  }

  public static of(raw: unknown): EndSources {
    // Non-array (undefined/null from the pre-migration boot window or a JSON
    // null) → empty default array. A present-but-wrong-shape value (string,
    // object, number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return EndSources.DEFAULT;
    }
    if (!Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `end sources must be an array of strings, got '${String(raw)}'`,
      );
    }
    const sources: string[] = [];
    const seen = new Set<string>();
    for (const element of raw) {
      if (typeof element !== 'string') {
        throw new InvalidValueObjectException(
          `end sources entries must be strings, got '${String(element)}'`,
        );
      }
      const trimmed = element.trim();
      if (trimmed.length === 0) {
        throw new InvalidValueObjectException(
          `end sources entries must be non-empty strings, got '${element}'`,
        );
      }
      // Dedup defensively — the wire shape is a flat array (not a keyed map),
      // and a duplicate drag is a no-op visually. First-occurrence order is
      // preserved so `toDto()` / `equals` are deterministic across identical
      // inputs (the inherited `ValueObject.equals` is array order-sensitive).
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      sources.push(trimmed);
    }
    return new EndSources(sources);
  }

  /** Empty array = no end sources recorded. Matches `NodePositions.DEFAULT` /
   *  `NodeActions.DEFAULT` / `TerminalNodes.DEFAULT` — a store that never
   *  configures this persists nothing and the admin canvas decides what to
   *  render for it. */
  public static DEFAULT: EndSources = EndSources.of([]);

  /** The flat array of explicit end-source state names. Used by the save use
   *  case cross-check against the active state-machine state names. */
  public get sources(): readonly string[] {
    return this.props;
  }

  /** The end-source state names as a mutable array — used by the save use case
   *  cross-check against the active state-machine state names. Mirrors
   *  `NodePositions.keys()` / `NodeActions.keys()`. */
  public keys(): string[] {
    return [...this.props];
  }

  /** Returns a fresh copy of the array so callers can mutate the DTO without
   *  affecting the VO (each entry is a primitive string, so a shallow copy
   *  suffices). */
  public toDto(): EndSourcesDto {
    return [...this.props];
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}
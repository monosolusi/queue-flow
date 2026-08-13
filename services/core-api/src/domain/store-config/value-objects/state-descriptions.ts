import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * The persisted shape: a keyed map `stateName -> description` (a non-empty
 *  string). `{}` means "no per-state description overrides — derive from the
 *  canonical copy / outgoing-transition count" (the {@link StateMachine}
 *  default). Empty/whitespace values are dropped at construction so the wire
 *  stays lean.
 */
export type StateDescriptionsMap = Readonly<Record<string, string>>;

/** Wire DTO (the shape returned by `toDto()` and carried on the config GET/PUT
 *  inside the `stateMachine` object as a `descriptions` key). */
export type StateDescriptionsDto = Record<string, string>;

/**
 * Per-state editable descriptions for the admin state-machine editor —
 * intrinsic per-state metadata that is part of the state-machine definition
 * (NOT a designer-only appearance concern like `NodePositions`/`NodeActions`,
 * which are sibling VOs on `SystemConfiguration`). Persisted INSIDE the
 * `StateMachine` aggregate (the 3rd constructor member) and serialized inside
 * the existing `state_machine` JSONB column as a `descriptions` key (lazy-key
 * backward-compat — pre-feature rows lack the key, default to `{}`, mirroring
 * the `timezone`-in-`daily_reset_policy` lazy-key pattern). No new SQL
 * migration (JSONB is flexible).
 *
 * `of()` is permissive on *missing* (a `undefined`/`null` raw from a pre-
 * feature row or a JSON `null`) so a reconstituted row from before this feature
 * existed recovers to the default (empty map = derive from canonical copy)
 * without a migration. It is strict only on *present* entries: a non-object
 * raw, a non-string value, or a blank key throws `InvalidValueObjectException`
 * (→ HTTP 400) so a malformed PUT fails fast (NFR-REL-02 — no illegal
 * description map burns a write). Empty/whitespace VALUES are dropped (not
 * thrown) so a cleared description field round-trips as an absent key (the
 * admin `updateStateDescription` helper deletes empties; the VO mirrors that
 * defensively).
 *
 * State-membership validation (every description key must be a state in the
 * active state machine) lives in the **save use case**, NOT here — this keeps
 * the VO free of a `StateMachine` dependency (DIP / anti-corruption: a pure
 * domain value object must not reach into the state-machine aggregate). This
 * mirrors `NodePositions`/`NodeActions`'s cross-check placement.
 *
 * `ITransitionPolicy` (Queue context) is untouched — descriptions are an
 * additional member on `StateMachine`, NOT part of the transition-policy
 * contract (`isAllowed`/`actionLabelFor` do not touch them). DIP preserved.
 *
 * Not change-gated for audit — `descriptions` is an intrinsic metadata concern,
 * like `nodePositions`/`nodeActions`/`edgeRoutingLayout`, and is not in the
 * NFR-SEC-02 audited list (manual reset, state-schema, routing). `equals` is
 * inherited (structural deep-equal, order-insensitive over object keys).
 */
export class StateDescriptions extends ValueObject<StateDescriptionsMap> {
  private constructor(map: StateDescriptionsMap) {
    super(map);
  }

  public static of(raw: unknown): StateDescriptions {
    // Non-object (undefined/null from a pre-feature row or a JSON null) → empty
    // default map. A present-but-wrong-shape value (string, array, number) is a
    // malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return StateDescriptions.DEFAULT;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `state descriptions must be a plain object (keyed map), got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      // Keys are state names. JS object keys are always strings, but an
      // empty-string key is malformed → reject.
      if (typeof key !== 'string' || key.length === 0) {
        throw new InvalidValueObjectException(
          `state descriptions key must be a non-empty string, got '${String(key)}'`,
        );
      }
      // A non-string value (e.g. `5`) is malformed → reject. The VO does NOT
      // cross-check keys ⊆ schema (DIP — the use case does that).
      if (typeof value !== 'string') {
        throw new InvalidValueObjectException(
          `state descriptions['${key}'] must be a string, got '${String(value)}'`,
        );
      }
      // Drop empty/whitespace values so the wire stays lean and a cleared
      // description field round-trips as an absent key (the caller's
      // `updateStateDescription` deletes empties; this mirrors it defensively).
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      map[key] = trimmed;
    }
    return new StateDescriptions(map);
  }

  /** Empty map = no per-state description overrides (derive from canonical
   *  copy / outgoing-transition count). Matches `NodePositions.DEFAULT` /
   *  `NodeActions.DEFAULT` / `EdgeRoutingLayout.DEFAULT` for zero regression —
   *  a store that never configures this keeps the derived descriptions. */
  public static DEFAULT: StateDescriptions = StateDescriptions.of({});

  /** The description-map keys (state names) — used by the save use case
   *  cross-check against the active state-machine state names. */
  public keys(): string[] {
    return Object.keys(this.props);
  }

  /** The description override for `state`, or `undefined` when none is stored
   *  (the caller falls back to the derived canonical / transition-count copy). */
  public descriptionFor(state: string): string | undefined {
    const v = this.props[state];
    return v === undefined ? undefined : v;
  }

  /** Returns a deep copy of the map so callers can mutate the DTO without
   *  affecting the VO. */
  public toDto(): StateDescriptionsDto {
    return { ...this.props };
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}
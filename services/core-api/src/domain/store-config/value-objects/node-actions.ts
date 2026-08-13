import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/** Kaleo execution-type: when the node-level action fires. Closed enum. */
export type NodeActionExecutionType = 'ON_ENTRY' | 'ON_EXIT';

/** The action semantic. QMS has exactly one today — `UPDATE_STATUS` (a future
 *  PR widens this, e.g. a webhook / notify action). Closed enum. */
export type NodeActionType = 'UPDATE_STATUS';

/** One node-level action (Kaleo-shaped): an execution trigger, an action
 *  semantic, and a value (for `UPDATE_STATUS`, the target state name). */
export interface NodeActionProps {
  readonly executionType: NodeActionExecutionType;
  readonly type: NodeActionType;
  readonly value: string;
}

/** The persisted shape: a keyed map `stateName -> NodeActionProps[]`. A node
 *  (state) may carry zero or more actions; `{}` means "no node-level actions". */
export type NodeActionsMap = Readonly<Record<string, NodeActionProps[]>>;

/** Wire DTO (the shape returned by `toDto()` and carried on the config GET/PUT). */
export type NodeActionsDto = Record<string, NodeActionProps[]>;

const EXECUTION_TYPES: readonly NodeActionExecutionType[] = ['ON_ENTRY', 'ON_EXIT'];
const ACTION_TYPES: readonly NodeActionType[] = ['UPDATE_STATUS'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Per-state Kaleo-style node-level actions for the admin state-machine editor,
 * persisted on {@link SystemConfiguration} as a JSONB object column (the
 * `node_positions` / `edge_routing_layout` / `service_themes` keyed-map
 * precedent, not a scalar column — a keyed map is a nested value object). Keys
 * are state names (e.g. `"WAITING"`); the editor reads `GET /api/system/config`,
 * renders each entry's actions in the node's "Aksi" panel, and writes the whole
 * map back on save. An empty object `{}` means "no node-level actions" — this
 * is the default, so a store that never configures this keeps the editor's
 * action-less nodes (zero regression, mirroring `NodePositions` /
 * `EdgeRoutingLayout` / `ServiceThemes` / `TvPanelLayout`).
 *
 * Decoupled from transitions (Kaleo parity): a node action is a node-level
 * `{ executionType, type, value }` triple, NOT a per-edge `{label, target}`.
 * Transitions remain purely the "label keluar / label button" surface; actions
 * are an independent, persisted, node-level list. `ITransitionPolicy` (Queue
 * context) is untouched — actions are a Store-Config config concern, not a
 * transition-policy concern (SRP for `StateMachine`; OCP — a sibling VO added
 * without touching the policy).
 *
 * `of()` is permissive on *missing* (a `undefined`/`null` raw from the
 * pre-migration boot window or a JSON `null`) so a reconstituted row from before
 * this column existed, or a defensively-empty column, recovers to the default
 * (empty map = no actions) without a migration. It is strict only on *present*
 * entries: a non-object raw, a non-array value, or an action element whose
 * `executionType`/`type` is not a member of its closed enum or whose `value` is
 * not a non-empty string throws `InvalidValueObjectException` (→ HTTP 400) so a
 * malformed PUT fails fast (NFR-REL-02 — no illegal action map burns a write).
 *
 * State-membership validation (every action-map key must be a state in the
 * active state machine) AND value-membership validation (every
 * `UPDATE_STATUS.value` must be a state in the active state machine) live in
 * the **save use case**, NOT here — this keeps the VO free of a `StateMachine`
 * dependency (DIP / anti-corruption: a pure domain value object must not reach
 * into the state-machine aggregate).
 *
 * Not change-gated for audit — `nodeActions` is an appearance/config concern,
 * like `nodePositions`/`edgeRoutingLayout`/`tvPanelLayout`/`brandColor`/
 * `serviceThemes`, and is not in the NFR-SEC-02 audited list (manual reset,
 * state-schema, routing). `equals` is inherited (structural deep-equal,
 * order-insensitive over object keys) and available if a future ticket adds an
 * action-change diff-audit.
 */
export class NodeActions extends ValueObject<NodeActionsMap> {
  private constructor(map: NodeActionsMap) {
    super(map);
  }

  public static of(raw: unknown): NodeActions {
    // Non-object (undefined/null from the pre-migration boot window or a JSON
    // null) → empty default map. A present-but-wrong-shape value (string,
    // array, number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return NodeActions.DEFAULT;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `node actions must be a plain object (keyed map), got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;
    const map: Record<string, NodeActionProps[]> = {};
    for (const [key, value] of Object.entries(incoming)) {
      // Keys are state names. JS object keys are always strings, but an
      // empty-string key is malformed → reject.
      if (typeof key !== 'string' || key.length === 0) {
        throw new InvalidValueObjectException(
          `node actions key must be a non-empty string, got '${String(key)}'`,
        );
      }
      // Each entry is an array of action objects (NOT a single object, unlike
      // `node_positions`'s single `{x, y}` — a node may carry several actions).
      if (!Array.isArray(value)) {
        throw new InvalidValueObjectException(
          `node actions['${key}'] must be an array of action objects, got '${String(value)}'`,
        );
      }
      const actions: NodeActionProps[] = [];
      for (const element of value) {
        if (!isPlainObject(element)) {
          throw new InvalidValueObjectException(
            `node actions['${key}'][*] must be a plain action object, got '${String(element)}'`,
          );
        }
        const e = element as Record<string, unknown>;
        const executionType = e.executionType;
        if (typeof executionType !== 'string' || !EXECUTION_TYPES.includes(executionType as NodeActionExecutionType)) {
          throw new InvalidValueObjectException(
            `node actions['${key}'].executionType must be one of ${JSON.stringify(EXECUTION_TYPES)}, got '${String(executionType)}'`,
          );
        }
        const type = e.type;
        if (typeof type !== 'string' || !ACTION_TYPES.includes(type as NodeActionType)) {
          throw new InvalidValueObjectException(
            `node actions['${key}'].type must be one of ${JSON.stringify(ACTION_TYPES)}, got '${String(type)}'`,
          );
        }
        const actionValue = e.value;
        if (typeof actionValue !== 'string' || actionValue.length === 0) {
          throw new InvalidValueObjectException(
            `node actions['${key}'].value must be a non-empty string, got '${String(actionValue)}'`,
          );
        }
        // Deep-copy each action into the stored map so the caller's input
        // cannot mutate the VO's internal state. Unknown extra properties are
        // ignored — only the 3 canonical fields are read. The enum membership
        // check is a runtime guard but TS does not narrow `executionType` from
        // the `includes` call, so the checked value is narrowed via the
        // explicit cast (mirrors how `node-positions.ts` casts `x as number`
        // after `Number.isFinite`).
        actions.push({
          executionType: executionType as NodeActionExecutionType,
          type: type as NodeActionType,
          value: actionValue,
        });
      }
      map[key] = actions;
    }
    return new NodeActions(map);
  }

  /** Empty map = no node-level actions. Matches `NodePositions.DEFAULT` /
   * `EdgeRoutingLayout.DEFAULT` / `ServiceThemes.DEFAULT` / `TvPanelLayout.DEFAULT`
   * for zero regression — a store that never configures this keeps the
   * action-less nodes. */
  public static DEFAULT: NodeActions = NodeActions.of({});

  /** The keyed map of per-state node actions. */
  public get actions(): NodeActionsMap {
    return this.props;
  }

  /** The action-map keys (state names) — used by the save use case cross-check
   *  against the active state-machine state names. */
  public keys(): string[] {
    return Object.keys(this.props);
  }

  /** The actions attached to `state` (empty array when none). Returns a fresh
   *  array of fresh action objects so callers cannot mutate the VO. */
  public actionsFor(state: string): readonly NodeActionProps[] {
    const list = this.props[state];
    if (!list) return [];
    return list.map((a) => ({ ...a }));
  }

  /** Returns a deep copy of the map so callers can mutate the DTO without
   *  affecting the VO (each action is rebuilt into a fresh object). */
  public toDto(): NodeActionsDto {
    const out: Record<string, NodeActionProps[]> = {};
    for (const [key, list] of Object.entries(this.props)) {
      out[key] = list.map((a) => ({ ...a }));
    }
    return out;
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}
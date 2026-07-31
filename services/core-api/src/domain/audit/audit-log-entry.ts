import { InvalidValueObjectException } from '../shared/errors';
import { Identifier } from '../shared/identifier';
import { ValueObject } from '../shared/value-object';
import { AuditAction } from './audit-action';

/**
 * The JSON-serializable snapshot of the affected entity's state before
 * (`before`) and after (`after`) an audited mutation. `before` is `null` for a
 * creation / first-time operation. Kept as `Record<string, unknown>` so the
 * audit domain stays agnostic of the mutated aggregate's shape — the mutating
 * use case is responsible for serializing its own before/after snapshots into
 * plain objects (no class instances, no cycles).
 */
export type AuditSnapshot = Record<string, unknown>;

export interface AuditLogEntryProps {
  /** Stable unique id (UUID v4) for the entry — assigned at creation. */
  readonly id: string;
  /** Who initiated the mutation (`'admin'`, a counter id, …) — free-form. */
  readonly actor: string;
  readonly action: AuditAction;
  /** Pre-mutation snapshot, or `null` when the mutation creates something. */
  readonly before: AuditSnapshot | null;
  /** Post-mutation snapshot (always present — even a delete records what was). */
  readonly after: AuditSnapshot;
  /** Epoch-ms when the mutation occurred. */
  readonly occurredAt: number;
}

/**
 * An immutable, append-only record of a single audited system mutation
 * (NFR-SEC-02). A {@link ValueObject}: compared by its constituent values, never
 * mutated in place. The audit log is a separate bounded context — `Queue` and
 * `Store-Config` never import this type, so recording an audit entry can never
 * pull queue/store-config domain internals into the audit context
 * (anti-corruption). The mutating use case hands plain snapshot objects in.
 */
export class AuditLogEntry extends ValueObject<AuditLogEntryProps> {
  private constructor(props: AuditLogEntryProps) {
    super(props);
  }

  /**
   * Construct an entry. `id` defaults to a fresh UUID v4 and `occurredAt` to the
   * supplied clock value — so the common case (the mutating use case knows the
   * actor / action / snapshots) needs no id bookkeeping. Tests pass an explicit
   * id / occurredAt for deterministic assertions.
   */
  public static of(params: {
    actor: string;
    action: AuditAction;
    before: AuditSnapshot | null;
    after: AuditSnapshot;
    occurredAt: number;
    id?: string;
  }): AuditLogEntry {
    if (!params.actor || params.actor.trim().length === 0) {
      throw new InvalidValueObjectException('AuditLogEntry.actor must be non-empty');
    }
    return new AuditLogEntry({
      id: params.id ?? Identifier.generate().value,
      actor: params.actor,
      action: params.action,
      before: params.before,
      after: params.after,
      occurredAt: params.occurredAt,
    });
  }

  /** Reconstitute an entry from persisted storage (no validation beyond shape). */
  public static reconstitute(props: AuditLogEntryProps): AuditLogEntry {
    return new AuditLogEntry(props);
  }

  public get id(): string {
    return this.value.id;
  }
  public get actor(): string {
    return this.value.actor;
  }
  public get action(): AuditAction {
    return this.value.action;
  }
  public get before(): AuditSnapshot | null {
    return this.value.before;
  }
  public get after(): AuditSnapshot {
    return this.value.after;
  }
  public get occurredAt(): number {
    return this.value.occurredAt;
  }
}
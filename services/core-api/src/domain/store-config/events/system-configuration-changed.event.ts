import { DomainEvent } from '../../shared/domain-event';
import { SYSTEM_AGGREGATE_ID } from '../../shared/system-aggregate-id';

/**
 * Emitted when the {@link SystemConfiguration} singleton is saved (wizard /
 * admin save, FR-WZD-02..06). Not owned by a specific aggregate *instance* —
 * the whole configuration changed — so it references the shared system
 * sentinel rather than the config's id (mirrors {@link DailyQueueResetEvent}).
 *
 * Broadcast as `SYSTEM_CONFIG_CHANGED` so connected caller panels refetch the
 * active state machine and reflect the admin-designed flow + its `actionLabel`
 * wording **without a page reload** (FR-CLR-02 — the caller must drive the
 * admin-configured transitions and their wording; a mid-session
 * reconfiguration otherwise leaves the panel on a stale snapshot, rendering
 * removed transitions as buttons that 409 on tap and hiding newly added /
 * relabeled ones). The event is a pure refetch signal — it carries no payload,
 * matching `SYSTEM_RESET`'s "signal + refetch" contract rather than inlining
 * the full graph on the wire.
 */
export class SystemConfigurationChangedEvent extends DomainEvent {
  constructor(occurredAt?: number) {
    super(SYSTEM_AGGREGATE_ID, 'SYSTEM_CONFIG_CHANGED', 1, occurredAt);
  }
}
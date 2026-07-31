import type { StatusValue } from './value-objects/ticket-status';

/**
 * Port (interface) the Queue aggregate consumes to decide whether a status
 * transition is permitted by the active, configurable state machine. Defined
 * here — next to its consumer — per the Interface Segregation Principle. The
 * Store Config context supplies the concrete implementation backed by
 * {@link StateTransitionRule}s, so the Queue context never imports Store
 * Config internals directly (anti-corruption layer between bounded contexts).
 */
export interface ITransitionPolicy {
  isAllowed(from: StatusValue, to: StatusValue): boolean;
  actionLabelFor(from: StatusValue, to: StatusValue): string | undefined;
}

/**
 * NestJS DI token for {@link ITransitionPolicyResolver}. Interfaces are erased
 * at runtime, so the application layer injects the port by this Symbol rather
 * than by type metadata. A plain language builtin — no framework import — so it
 * does not compromise domain purity (NFR-MNT-01), mirroring the other port
 * tokens.
 */
export const TRANSITION_POLICY_RESOLVER = Symbol('TRANSITION_POLICY_RESOLVER');

/**
 * Port that resolves the *currently active* {@link ITransitionPolicy} on demand
 * (QUE-2). Queue command use cases call {@link getActivePolicy} at the start of
 * each execution and feed the resolved **synchronous** policy into the
 * `QueueTicket` aggregate's transition methods.
 *
 * Resolution is lazy/per-execution rather than a constructor-injected snapshot
 * for two reasons:
 *
 * 1. The app must boot **before** the first-run wizard creates a
 *    `SystemConfiguration` (the wizard is itself served by the running app).
 *    Eagerly resolving a policy at module construction would throw
 *    `SystemNotConfiguredException` and crash startup.
 * 2. The active state machine is configurable via the wizard/admin. Resolving
 *    per execution means a config edit takes effect on the very next transition
 *    without restarting the process.
 *
 * The use case depends on this port (a domain abstraction), never on the
 * `ISystemConfigurationRepository` directly, so the application layer stays
 * decoupled from the Store-Config context (anti-corruption / DIP).
 */
export interface ITransitionPolicyResolver {
  /**
   * Resolves the active transition policy. Throws
   * `SystemNotConfiguredException` when no `SystemConfiguration` exists yet
   * (first-run guard, FR-WZD-01) — queue control is unavailable until the
   * wizard completes.
   */
  getActivePolicy(): Promise<ITransitionPolicy>;
}
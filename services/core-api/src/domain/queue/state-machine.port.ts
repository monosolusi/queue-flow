import type { TransitionActionValue } from '../shared/transition-action';
import type { StatusValue } from './value-objects/ticket-status';

/**
 * One directed edge of the active state machine as the Queue context sees it:
 * a `from -> to` pair, the Indonesian caller-panel button label configured for
 * it (PRD §7), and the {@link TransitionAction} the manager declared for it. A
 * transport-agnostic, framework-free shape — deliberately NOT the Store-Config
 * `StateTransitionRule` value object, so enumerating the graph does not leak
 * Store-Config internals into the Queue context.
 *
 * `action` is carried here rather than derived downstream because it is the
 * *only* thing that says what running the edge does. Reading it from the graph is
 * what stops the Queue context from inferring an edge's meaning from the name of
 * its target state (see {@link TransitionAction}).
 */
export interface TransitionDescriptor {
  readonly from: StatusValue;
  readonly to: StatusValue;
  readonly actionLabel: string;
  readonly action: TransitionActionValue;
}

/**
 * A read-only view of the whole active state machine: its node set plus every
 * configured edge. Returned by {@link ITransitionGraphSource.describeGraph} as a
 * single value because the two halves are only useful together — a consumer
 * that projects "what can I do from each state?" must key by *every* state,
 * including the ones with no outgoing edge, which the edge list alone cannot
 * reveal. One method returning both keeps the port at a single member (ISP) and
 * guarantees the states and edges come from one consistent policy instance.
 */
export interface TransitionGraph {
  readonly states: readonly StatusValue[];
  readonly transitions: readonly TransitionDescriptor[];
}

/**
 * Port (interface) the Queue aggregate consumes to decide whether a status
 * transition is permitted by the active, configurable state machine. Defined
 * here — next to its consumer — per the Interface Segregation Principle. The
 * Store Config context supplies the concrete implementation backed by
 * {@link StateTransitionRule}s, so the Queue context never imports Store
 * Config internals directly (anti-corruption layer between bounded contexts).
 *
 * Deliberately **decision-only**: it answers "is this edge allowed, and what is
 * it called?" and nothing else. Whole-graph enumeration is a separate port
 * ({@link ITransitionGraphSource}) because the two client sets are disjoint —
 * the aggregate only ever decides one edge at a time. Keeping them apart means a
 * narrowing decorator (say, a counter-scoped policy that restricts `isAllowed`)
 * is passable to `QueueTicket.markCalling(...)` without also having to answer
 * for the whole graph — the shape that would otherwise tempt it into delegating
 * `describeGraph` to the full, un-narrowed graph and silently breaking LSP.
 */
export interface ITransitionPolicy {
  isAllowed(from: StatusValue, to: StatusValue): boolean;
  actionLabelFor(from: StatusValue, to: StatusValue): string | undefined;
}

/**
 * Port for enumerating the active graph — the node set plus every edge, with the
 * action each one declares. The aggregate never calls it: it decides one edge at a
 * time and is handed the policy, so it needs no view of the whole graph.
 *
 * Its clients are the read side, which publishes the graph as the caller panel's
 * action surface (FR-CLR-02), and the two command use cases, which read an edge's
 * declared action to refuse running it as the wrong command — both without the
 * Queue context importing the Store-Config `StateMachine`. Segregated from
 * {@link ITransitionPolicy} (ISP) so a narrowing decorator of the policy is not
 * forced to answer for whole-graph enumeration; the same concrete `StateMachine`
 * implements both.
 */
export interface ITransitionGraphSource {
  describeGraph(): TransitionGraph;
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
   *
   * Resolves an implementation of **both** ports: the command use cases pass it
   * to the aggregate as an {@link ITransitionPolicy} (the only slice the
   * aggregate demands), while the read side additionally enumerates it via
   * {@link ITransitionGraphSource}. One resolution serves both so the decision
   * and the enumeration always come from the same configuration instant.
   */
  getActivePolicy(): Promise<ITransitionPolicy & ITransitionGraphSource>;
}
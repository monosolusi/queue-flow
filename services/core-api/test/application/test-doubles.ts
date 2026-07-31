import { StateMachine } from '../../src/domain/store-config';
import type { ITransitionPolicyResolver } from '../../src/domain/queue';

/**
 * A fake {@link ITransitionPolicyResolver} that always resolves to the given
 * policy (default: the PRD §7 default state machine). Used by the queue command
 * use-case unit tests so they don't need the real `StateTransitionValidator` +
 * `SystemConfiguration` plumbing.
 */
export function fakePolicyResolver(policy = StateMachine.DEFAULT): ITransitionPolicyResolver {
  return { getActivePolicy: async () => policy };
}

/**
 * A spy stand-in for {@link QueueEventDispatcher}. Records every `dispatch` /
 * `dispatchEvents` call so tests can assert the use case drained the aggregate's
 * domain events after `save` (FR-ENG-04). Returned as a loose `any` so it is
 * assignable to the `QueueEventDispatcher` constructor parameter of the use cases
 * while keeping its `jest.Mock` assertion surface (`.mock.calls`) intact.
 */
export function spyDispatcher(): any {
  return {
    dispatch: jest.fn(async () => undefined),
    dispatchEvents: jest.fn(async () => undefined),
  };
}
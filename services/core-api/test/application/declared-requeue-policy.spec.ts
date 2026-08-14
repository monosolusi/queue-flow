import { declaredRequeuePolicyFor } from '../../src/application/queue/declared-requeue-policy';
import type { TransitionGraph } from '../../src/domain/queue';
import {
  DEFAULT_REQUEUE_POLICY,
  RequeuePolicyKind,
  type RequeuePolicy,
} from '../../src/domain/shared';

/**
 * Graph fixture for the re-queue policy helper. Two `-> WAITING` edges carry
 * distinct policies, and one edge targets a non-WAITING state (the helper does
 * not care about the target — it only reads the policy attached to the matched
 * edge).
 */
const GRAPH: TransitionGraph = {
  states: ['CALLING', 'WAITING', 'SERVING'],
  transitions: [
    {
      from: 'CALLING',
      to: 'WAITING',
      actionLabel: 'Kembalikan ke Antrian',
      requeuePolicy: { kind: RequeuePolicyKind.KEEP, n: null },
    },
    {
      from: 'SERVING',
      to: 'WAITING',
      actionLabel: 'Kembalikan ke Antrian',
      requeuePolicy: { kind: RequeuePolicyKind.TO_BACK, n: null },
    },
    {
      from: 'WAITING',
      to: 'CALLING',
      actionLabel: 'Panggil Berikutnya',
      requeuePolicy: DEFAULT_REQUEUE_POLICY,
    },
  ],
};

describe('declaredRequeuePolicyFor', () => {
  it('reads the policy off the matching edge', () => {
    expect(declaredRequeuePolicyFor(GRAPH, 'CALLING', 'WAITING')).toEqual({
      kind: RequeuePolicyKind.KEEP,
      n: null,
    });
    const toBack: RequeuePolicy = { kind: RequeuePolicyKind.TO_BACK, n: null };
    expect(declaredRequeuePolicyFor(GRAPH, 'SERVING', 'WAITING')).toEqual(toBack);
  });

  it('matches on the whole (from, to) pair, not the target alone', () => {
    // Keying on `to` alone would give both `-> WAITING` edges the same policy.
    expect(declaredRequeuePolicyFor(GRAPH, 'CALLING', 'WAITING')).not.toEqual(
      declaredRequeuePolicyFor(GRAPH, 'SERVING', 'WAITING'),
    );
  });

  it('defaults to KEEP for an edge the flow does not contain (belt-and-suspenders)', () => {
    // The VO already defaults a missing policy to KEEP; the `??` here covers a
    // future narrowing decorator that drops the field. A missing edge is still
    // a 409 from the aggregate — this default is the policy leg only.
    expect(declaredRequeuePolicyFor(GRAPH, 'WAITING', 'SERVING')).toEqual(DEFAULT_REQUEUE_POLICY);
  });
});
import {
  assertRunnableAsCategoryTransfer,
  assertRunnableAsStatusChange,
  declaredActionFor,
  declaredRequeuePolicyFor,
} from '../../src/application/queue';
import type { TransitionGraph } from '../../src/domain/queue';
import {
  DEFAULT_REQUEUE_POLICY,
  InvalidArgumentException,
  RequeuePolicyKind,
  TransitionAction,
} from '../../src/domain/shared';

/**
 * The pairing the two queue commands share. Both guards read the same declared
 * fact, and the point of testing them together is that they stay each other's
 * mirror: enforcing only one direction would let a client run an edge as the
 * wrong command with nothing failing.
 */
const GRAPH: TransitionGraph = {
  states: ['CALLING', 'WAITING', 'SERVING'],
  transitions: [
    // Same endpoints as the transfer below in every respect except the
    // declaration — which is the whole reason the declaration exists.
    {
      from: 'CALLING',
      to: 'WAITING',
      actionLabel: 'Kembalikan ke Antrian',
      action: TransitionAction.UPDATE_STATUS,
      requeuePolicy: { kind: RequeuePolicyKind.KEEP, n: null },
    },
    {
      from: 'SERVING',
      to: 'WAITING',
      actionLabel: 'Pindah Kategori',
      action: TransitionAction.TRANSFER_CATEGORY,
      requeuePolicy: { kind: RequeuePolicyKind.KEEP, n: null },
    },
  ],
};

describe('declaredActionFor', () => {
  it('reads the action off the matching edge', () => {
    expect(declaredActionFor(GRAPH, 'CALLING', 'WAITING')).toBe('UPDATE_STATUS');
    expect(declaredActionFor(GRAPH, 'SERVING', 'WAITING')).toBe('TRANSFER_CATEGORY');
  });

  it('matches on the whole pair, not the target alone', () => {
    // The defect in one line: keying on `to` would give both edges above the
    // same answer.
    expect(declaredActionFor(GRAPH, 'CALLING', 'WAITING')).not.toBe(
      declaredActionFor(GRAPH, 'SERVING', 'WAITING'),
    );
  });

  it('returns undefined for an edge the flow does not contain', () => {
    expect(declaredActionFor(GRAPH, 'WAITING', 'SERVING')).toBeUndefined();
  });
});

describe('the two guards mirror each other', () => {
  it('lets the status-change command run an UPDATE_STATUS edge and refuses a transfer edge', () => {
    expect(() => assertRunnableAsStatusChange(GRAPH, 'CALLING', 'WAITING')).not.toThrow();
    expect(() => assertRunnableAsStatusChange(GRAPH, 'SERVING', 'WAITING')).toThrow(
      InvalidArgumentException,
    );
  });

  it('lets the transfer command run a TRANSFER_CATEGORY edge and refuses a plain one', () => {
    expect(() => assertRunnableAsCategoryTransfer(GRAPH, 'SERVING', 'WAITING')).not.toThrow();
    expect(() => assertRunnableAsCategoryTransfer(GRAPH, 'CALLING', 'WAITING')).toThrow(
      InvalidArgumentException,
    );
  });

  it('accepts exactly one of the two commands for every configured edge', () => {
    expect(GRAPH.transitions.length).toBeGreaterThan(0);
    for (const t of GRAPH.transitions) {
      const statusChangeOk = safe(() => assertRunnableAsStatusChange(GRAPH, t.from, t.to));
      const transferOk = safe(() => assertRunnableAsCategoryTransfer(GRAPH, t.from, t.to));
      expect(statusChangeOk).toBe(!transferOk);
    }
  });

  it('leaves a missing edge to the aggregate rather than reporting a bad request', () => {
    // A flow that lacks the edge is a 409 from the aggregate; pre-empting it here
    // with a 400 would report a mis-drawn flow as a malformed request. The
    // transfer guard is the exception: with nothing declared there is nothing
    // authorising a category move.
    expect(() => assertRunnableAsStatusChange(GRAPH, 'WAITING', 'SERVING')).not.toThrow();
    expect(() => assertRunnableAsCategoryTransfer(GRAPH, 'WAITING', 'SERVING')).toThrow(
      InvalidArgumentException,
    );
  });
});

describe('declaredRequeuePolicyFor', () => {
  it('reads the policy off the matching edge', () => {
    expect(declaredRequeuePolicyFor(GRAPH, 'CALLING', 'WAITING')).toEqual({
      kind: RequeuePolicyKind.KEEP,
      n: null,
    });
  });

  it('defaults to KEEP for an edge the flow does not contain (belt-and-suspenders)', () => {
    // The VO already defaults a missing policy to KEEP; the `??` here covers a
    // future narrowing decorator that drops the field. A missing edge is still
    // a 409 from the aggregate — this default is the policy leg only.
    expect(declaredRequeuePolicyFor(GRAPH, 'WAITING', 'SERVING')).toEqual(DEFAULT_REQUEUE_POLICY);
  });
});

function safe(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

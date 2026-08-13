import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  NodeActions,
  type NodeActionProps,
} from '../../src/domain/store-config/value-objects/node-actions';

describe('NodeActions (per-state Kaleo-style action map)', () => {
  it('of(undefined) / of(null) → DEFAULT (empty map), toDto() deep-equals {}', () => {
    expect(NodeActions.of(undefined)).toBe(NodeActions.DEFAULT);
    expect(NodeActions.of(null)).toBe(NodeActions.DEFAULT);
    expect(NodeActions.DEFAULT.toDto()).toEqual({});
  });

  it('of({}) → empty map', () => {
    const actions = NodeActions.of({});
    expect(actions.toDto()).toEqual({});
    expect(actions.keys()).toEqual([]);
  });

  it('of({...}) round-trips the shape via toDto() and the actions getter', () => {
    const input: Record<string, NodeActionProps[]> = {
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
      CALLING: [
        { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'SERVING' },
        { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' },
      ],
    };
    const actions = NodeActions.of(input);
    expect(actions.toDto()).toEqual(input);
    expect(actions.actions['CALLING']).toEqual([
      { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'SERVING' },
      { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' },
    ]);
    expect(actions.keys().sort()).toEqual(['CALLING', 'WAITING']);
  });

  it('deep-copies: mutating the input after of() does not change the VO', () => {
    const input = {
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
    } as Record<string, { executionType: string; type: string; value: string }[]>;
    const actions = NodeActions.of(input);
    input['WAITING'][0].value = 'COMPLETED';
    input['CALLING'] = [{ executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' }];
    expect(actions.toDto()).toEqual({
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
    });
  });

  it('toDto() returns an independent copy (mutating the DTO does not affect the VO)', () => {
    const actions = NodeActions.of({
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
    });
    const dto = actions.toDto() as Record<string, { executionType: string; type: string; value: string }[]>;
    dto['WAITING'][0].value = 'COMPLETED';
    dto['CALLING'] = [{ executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' }];
    expect(actions.toDto()).toEqual({
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
    });
  });

  it('actionsFor(state) returns a fresh copy (mutating it does not affect the VO); empty for unknown state', () => {
    const actions = NodeActions.of({
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
    });
    const list = actions.actionsFor('WAITING') as { executionType: string; type: string; value: string }[];
    list[0].value = 'COMPLETED';
    expect(actions.actionsFor('WAITING')).toEqual([
      { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' },
    ]);
    expect(actions.actionsFor('NOPE')).toEqual([]);
  });

  it.each([
    ['a string', 'not-an-object'],
    ['a number', 5],
    ['an array', [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'X' }]],
    ['a boolean', true],
  ])('rejects a non-object raw (%s) with InvalidValueObjectException', (_label, raw) => {
    expect(() => NodeActions.of(raw)).toThrow(InvalidValueObjectException);
  });

  it('rejects a value that is not an array (a string)', () => {
    expect(() => NodeActions.of({ WAITING: 'not-an-array' })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a value that is an object instead of an array', () => {
    expect(() =>
      NodeActions.of({ WAITING: { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'X' } }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects an action element that is not a plain object (a string)', () => {
    expect(() => NodeActions.of({ WAITING: ['not-an-object'] })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects an action element that is null', () => {
    expect(() => NodeActions.of({ WAITING: [null] })).toThrow(InvalidValueObjectException);
  });

  it('rejects a bad executionType (not in {ON_ENTRY, ON_EXIT})', () => {
    expect(() =>
      NodeActions.of({
        WAITING: [{ executionType: 'ON_DONE', type: 'UPDATE_STATUS', value: 'CALLING' }],
      }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-string executionType', () => {
    expect(() =>
      NodeActions.of({
        WAITING: [{ executionType: 5, type: 'UPDATE_STATUS', value: 'CALLING' }],
      }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a bad type (not in {UPDATE_STATUS})', () => {
    expect(() =>
      NodeActions.of({
        WAITING: [{ executionType: 'ON_ENTRY', type: 'DELETE_STATUS', value: 'CALLING' }],
      }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-string type', () => {
    expect(() =>
      NodeActions.of({
        WAITING: [{ executionType: 'ON_ENTRY', type: 5, value: 'CALLING' }],
      }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects an empty-string value', () => {
    expect(() =>
      NodeActions.of({
        WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: '' }],
      }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-string value', () => {
    expect(() =>
      NodeActions.of({
        WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 5 }],
      }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects an empty-string key', () => {
    expect(() =>
      NodeActions.of({ '': [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'X' }] }),
    ).toThrow(InvalidValueObjectException);
  });

  it('accepts an empty action array for a state (a state with no actions)', () => {
    const actions = NodeActions.of({ WAITING: [] });
    expect(actions.toDto()).toEqual({ WAITING: [] });
    expect(actions.actionsFor('WAITING')).toEqual([]);
  });

  it('keys() returns the action-map keys', () => {
    const actions = NodeActions.of({
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
      CALLING: [{ executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' }],
    });
    expect(actions.keys().sort()).toEqual(['CALLING', 'WAITING']);
  });

  it('toString() returns JSON', () => {
    const actions = NodeActions.of({
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
    });
    expect(actions.toString()).toBe(
      JSON.stringify({
        WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
      }),
    );
  });

  it('equals (inherited structural deep-equal): same map → equal, different → not', () => {
    const a = NodeActions.of({
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
    });
    const b = NodeActions.of({
      WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
    });
    const c = NodeActions.of({
      WAITING: [{ executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'CALLING' }],
    });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    // Order-insensitive over object keys, and order-SENSITIVE within an action
    // array (an array is positional — a re-ordered action list is a different
    // sequence of node-level actions, not the same map).
    const d = NodeActions.of({
      WAITING: [
        { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' },
        { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' },
      ],
    });
    const e = NodeActions.of({
      WAITING: [
        { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' },
        { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' },
      ],
      CALLING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'SERVING' }],
    });
    const f = NodeActions.of({
      CALLING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'SERVING' }],
      WAITING: [
        { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' },
        { executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' },
      ],
    });
    expect(e.equals(f)).toBe(true);
    expect(d.equals(e)).toBe(false);
  });

  it('does NOT validate state membership — a key/value that is not a real state does NOT throw (anti-corruption: the cross-check is the use case job, not the VO)', () => {
    // The VO must stay free of a StateMachine dependency (DIP), so it accepts a
    // key like "NOPE" and a value like "ALSO_NOPE" even though no such states
    // exist in the default state machine. The save use case performs the
    // cross-check.
    expect(() =>
      NodeActions.of({
        NOPE: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'ALSO_NOPE' }],
      }),
    ).not.toThrow();
  });
});
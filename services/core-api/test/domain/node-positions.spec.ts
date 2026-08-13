import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  NodePositions,
  type NodePosition,
} from '../../src/domain/store-config/value-objects/node-positions';

describe('NodePositions (per-state node x/y map)', () => {
  it('of(undefined) / of(null) → DEFAULT (empty map), toDto() deep-equals {}', () => {
    expect(NodePositions.of(undefined)).toBe(NodePositions.DEFAULT);
    expect(NodePositions.of(null)).toBe(NodePositions.DEFAULT);
    expect(NodePositions.DEFAULT.toDto()).toEqual({});
  });

  it('of({}) → empty map', () => {
    const positions = NodePositions.of({});
    expect(positions.toDto()).toEqual({});
    expect(positions.keys()).toEqual([]);
  });

  it('of({...}) round-trips the shape via toDto() and the positions getter', () => {
    const input: Record<string, NodePosition> = {
      WAITING: { x: 0, y: 0 },
      CALLING: { x: 240, y: 0 },
    };
    const positions = NodePositions.of(input);
    expect(positions.toDto()).toEqual(input);
    expect(positions.positions['CALLING']).toEqual({ x: 240, y: 0 });
    expect(positions.keys().sort()).toEqual(['CALLING', 'WAITING']);
  });

  it('deep-copies: mutating the input after of() does not change the VO', () => {
    const input = {
      WAITING: { x: 0, y: 0 },
    } as Record<string, { x: number; y: number }>;
    const positions = NodePositions.of(input);
    input['WAITING'].x = 999;
    input['CALLING'] = { x: 240, y: 0 };
    expect(positions.toDto()).toEqual({
      WAITING: { x: 0, y: 0 },
    });
  });

  it('toDto() returns an independent copy (mutating the DTO does not affect the VO)', () => {
    const positions = NodePositions.of({ WAITING: { x: 0, y: 0 } });
    const dto = positions.toDto() as Record<string, { x: number; y: number }>;
    dto['WAITING'].x = 999;
    dto['CALLING'] = { x: 240, y: 0 };
    expect(positions.toDto()).toEqual({
      WAITING: { x: 0, y: 0 },
    });
  });

  it.each([
    ['a string', 'not-an-object'],
    ['a number', 5],
    ['an array', [{ x: 0, y: 0 }]],
    ['a boolean', true],
  ])('rejects a non-object raw (%s) with InvalidValueObjectException', (_label, raw) => {
    expect(() => NodePositions.of(raw)).toThrow(InvalidValueObjectException);
  });

  it('rejects a value that is not a plain object (a string)', () => {
    expect(() => NodePositions.of({ WAITING: 'not-an-object' })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a value that is an array', () => {
    expect(() => NodePositions.of({ WAITING: [0, 0] })).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-number x', () => {
    expect(() => NodePositions.of({ WAITING: { x: 'five', y: 0 } })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a non-number y', () => {
    expect(() => NodePositions.of({ WAITING: { x: 0, y: 'five' } })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a non-finite x (NaN)', () => {
    expect(() => NodePositions.of({ WAITING: { x: NaN, y: 0 } })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a non-finite y (Infinity)', () => {
    expect(() => NodePositions.of({ WAITING: { x: 0, y: Infinity } })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('accepts negative and fractional coordinates', () => {
    const positions = NodePositions.of({ WAITING: { x: -120.5, y: 40.25 } });
    expect(positions.toDto()).toEqual({ WAITING: { x: -120.5, y: 40.25 } });
  });

  it('rejects an empty-string key', () => {
    expect(() => NodePositions.of({ '': { x: 0, y: 0 } })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('rejects a null value entry', () => {
    expect(() => NodePositions.of({ WAITING: null })).toThrow(InvalidValueObjectException);
  });

  it('keys() returns the position keys', () => {
    const positions = NodePositions.of({
      WAITING: { x: 0, y: 0 },
      CALLING: { x: 240, y: 0 },
    });
    expect(positions.keys().sort()).toEqual(['CALLING', 'WAITING']);
  });

  it('toString() returns JSON', () => {
    const positions = NodePositions.of({ WAITING: { x: 0, y: 0 } });
    expect(positions.toString()).toBe(JSON.stringify({ WAITING: { x: 0, y: 0 } }));
  });

  it('equals (inherited structural deep-equal): same map → equal, different → not', () => {
    const a = NodePositions.of({ WAITING: { x: 0, y: 0 } });
    const b = NodePositions.of({ WAITING: { x: 0, y: 0 } });
    const c = NodePositions.of({ WAITING: { x: 10, y: 0 } });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    // Order-insensitive over object keys.
    const d = NodePositions.of({
      WAITING: { x: 0, y: 0 },
      CALLING: { x: 240, y: 0 },
    });
    const e = NodePositions.of({
      CALLING: { x: 240, y: 0 },
      WAITING: { x: 0, y: 0 },
    });
    expect(d.equals(e)).toBe(true);
  });

  it('does NOT validate state membership — a key that is not a real state does NOT throw (anti-corruption: the cross-check is the use case job, not the VO)', () => {
    // The VO must stay free of a StateMachine dependency (DIP), so it accepts a
    // key like "NOPE" even though no such state exists in the default state
    // machine. The save use case performs the cross-check.
    expect(() => NodePositions.of({ NOPE: { x: 0, y: 0 } })).not.toThrow();
  });
});
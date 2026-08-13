import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  EdgeRoutingLayout,
  type EdgeSides,
} from '../../src/domain/store-config/value-objects/edge-routing-layout';

describe('EdgeRoutingLayout (per-edge connection-point map)', () => {
  it('of(undefined) / of(null) → DEFAULT (empty map), toDto() deep-equals {}', () => {
    expect(EdgeRoutingLayout.of(undefined)).toBe(EdgeRoutingLayout.DEFAULT);
    expect(EdgeRoutingLayout.of(null)).toBe(EdgeRoutingLayout.DEFAULT);
    expect(EdgeRoutingLayout.DEFAULT.toDto()).toEqual({});
  });

  it('of({}) → empty map', () => {
    const layout = EdgeRoutingLayout.of({});
    expect(layout.toDto()).toEqual({});
    expect(layout.keys()).toEqual([]);
  });

  it('of({...}) round-trips the shape via toDto() and the routing getter', () => {
    const input: Record<string, EdgeSides> = {
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
      'WAITING->CALLING': { sourceSide: 'top', targetSide: 'bottom' },
    };
    const layout = EdgeRoutingLayout.of(input);
    expect(layout.toDto()).toEqual(input);
    expect(layout.routing['SKIPPED->CALLING']).toEqual({ sourceSide: 'bottom', targetSide: 'top' });
    expect(layout.keys().sort()).toEqual(['SKIPPED->CALLING', 'WAITING->CALLING']);
  });

  it('deep-copies: mutating the input after of() does not change the VO', () => {
    const input = {
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    } as Record<string, { sourceSide: string; targetSide: string }>;
    const layout = EdgeRoutingLayout.of(input);
    input['SKIPPED->CALLING'].sourceSide = 'top';
    input['WAITING->CALLING'] = { sourceSide: 'left', targetSide: 'right' };
    expect(layout.toDto()).toEqual({
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    });
  });

  it('toDto() returns an independent copy (mutating the DTO does not affect the VO)', () => {
    const layout = EdgeRoutingLayout.of({
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    });
    const dto = layout.toDto() as Record<string, { sourceSide: string; targetSide: string }>;
    dto['SKIPPED->CALLING'].sourceSide = 'left';
    dto['EXTRA->EDGE'] = { sourceSide: 'top', targetSide: 'bottom' };
    expect(layout.toDto()).toEqual({
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    });
  });

  it.each([
    ['a string', 'not-an-object'],
    ['a number', 5],
    ['an array', [{ sourceSide: 'top', targetSide: 'bottom' }]],
    ['a boolean', true],
  ])('rejects a non-object raw (%s) with InvalidValueObjectException', (_label, raw) => {
    expect(() => EdgeRoutingLayout.of(raw)).toThrow(InvalidValueObjectException);
  });

  it('rejects a value that is not a plain object (a string)', () => {
    expect(() =>
      EdgeRoutingLayout.of({ 'SKIPPED->CALLING': 'not-an-object' }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a value that is an array', () => {
    expect(() =>
      EdgeRoutingLayout.of({ 'SKIPPED->CALLING': ['top', 'bottom'] }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-string sourceSide', () => {
    expect(() =>
      EdgeRoutingLayout.of({ 'SKIPPED->CALLING': { sourceSide: 5, targetSide: 'top' } }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-string targetSide', () => {
    expect(() =>
      EdgeRoutingLayout.of({ 'SKIPPED->CALLING': { sourceSide: 'top', targetSide: 5 } }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a sourceSide not in {top,right,bottom,left}', () => {
    expect(() =>
      EdgeRoutingLayout.of({ 'SKIPPED->CALLING': { sourceSide: 'sideways', targetSide: 'top' } }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a targetSide not in {top,right,bottom,left}', () => {
    expect(() =>
      EdgeRoutingLayout.of({ 'SKIPPED->CALLING': { sourceSide: 'top', targetSide: 'sideways' } }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects an empty-string key', () => {
    expect(() =>
      EdgeRoutingLayout.of({ '': { sourceSide: 'top', targetSide: 'bottom' } }),
    ).toThrow(InvalidValueObjectException);
  });

  it('rejects a null value entry', () => {
    expect(() => EdgeRoutingLayout.of({ 'SKIPPED->CALLING': null })).toThrow(
      InvalidValueObjectException,
    );
  });

  it('keys() returns the layout keys', () => {
    const layout = EdgeRoutingLayout.of({
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
      'WAITING->CALLING': { sourceSide: 'top', targetSide: 'bottom' },
    });
    expect(layout.keys().sort()).toEqual(['SKIPPED->CALLING', 'WAITING->CALLING']);
  });

  it('toString() returns JSON', () => {
    const layout = EdgeRoutingLayout.of({
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    });
    expect(layout.toString()).toBe(
      JSON.stringify({ 'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' } }),
    );
  });

  it('equals (inherited structural deep-equal): same map → equal, different → not', () => {
    const a = EdgeRoutingLayout.of({ 'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' } });
    const b = EdgeRoutingLayout.of({ 'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' } });
    const c = EdgeRoutingLayout.of({ 'SKIPPED->CALLING': { sourceSide: 'top', targetSide: 'bottom' } });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    // Order-insensitive over object keys.
    const d = EdgeRoutingLayout.of({
      'WAITING->CALLING': { sourceSide: 'top', targetSide: 'bottom' },
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    });
    const e = EdgeRoutingLayout.of({
      'SKIPPED->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
      'WAITING->CALLING': { sourceSide: 'top', targetSide: 'bottom' },
    });
    expect(d.equals(e)).toBe(true);
  });

  it('does NOT validate edge membership — a key that is not a real transition does NOT throw (anti-corruption: the cross-check is the use case job, not the VO)', () => {
    // The VO must stay free of a StateMachine dependency (DIP), so it accepts a
    // key like "WAITING->COMPLETED" even though no such edge exists in the
    // default state machine. The save use case performs the cross-check.
    expect(() =>
      EdgeRoutingLayout.of({ 'WAITING->COMPLETED': { sourceSide: 'top', targetSide: 'bottom' } }),
    ).not.toThrow();
  });
});
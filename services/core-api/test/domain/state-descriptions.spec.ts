import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import { StateDescriptions } from '../../src/domain/store-config/value-objects/state-descriptions';

describe('StateDescriptions (per-state description override map)', () => {
  it('of(undefined) / of(null) → DEFAULT (empty map), toDto() deep-equals {}', () => {
    expect(StateDescriptions.of(undefined)).toBe(StateDescriptions.DEFAULT);
    expect(StateDescriptions.of(null)).toBe(StateDescriptions.DEFAULT);
    expect(StateDescriptions.DEFAULT.toDto()).toEqual({});
  });

  it('of({}) → empty map', () => {
    const descriptions = StateDescriptions.of({});
    expect(descriptions.toDto()).toEqual({});
    expect(descriptions.keys()).toEqual([]);
  });

  it('of({...}) round-trips the shape via toDto()', () => {
    const input: Record<string, string> = {
      WAITING: 'Tiket menunggu dipanggil',
      CALLING: 'Sedang dipanggil ke counter',
    };
    const descriptions = StateDescriptions.of(input);
    expect(descriptions.toDto()).toEqual(input);
    expect(descriptions.keys().sort()).toEqual(['CALLING', 'WAITING']);
  });

  it('DROPS empty/whitespace values (a cleared field round-trips as an absent key)', () => {
    const descriptions = StateDescriptions.of({
      WAITING: 'Tiket menunggu',
      CALLING: '   ',
      SERVING: '',
    });
    expect(descriptions.toDto()).toEqual({ WAITING: 'Tiket menunggu' });
    expect(descriptions.keys()).toEqual(['WAITING']);
  });

  it('deep-copies: mutating the input after of() does not change the VO', () => {
    const input = { WAITING: 'Tiket menunggu' } as Record<string, string>;
    const descriptions = StateDescriptions.of(input);
    input['WAITING'] = 'CHANGED';
    input['CALLING'] = 'New';
    expect(descriptions.toDto()).toEqual({ WAITING: 'Tiket menunggu' });
  });

  it('toDto() returns an independent copy (mutating the DTO does not affect the VO)', () => {
    const descriptions = StateDescriptions.of({ WAITING: 'Tiket menunggu' });
    const dto = descriptions.toDto() as Record<string, string>;
    dto['WAITING'] = 'CHANGED';
    dto['CALLING'] = 'New';
    expect(descriptions.toDto()).toEqual({ WAITING: 'Tiket menunggu' });
  });

  it('descriptionFor(state) returns the saved override; undefined for unknown state / absent key', () => {
    const descriptions = StateDescriptions.of({
      WAITING: 'Tiket menunggu dipanggil',
    });
    expect(descriptions.descriptionFor('WAITING')).toBe('Tiket menunggu dipanggil');
    expect(descriptions.descriptionFor('NOPE')).toBeUndefined();
  });

  it.each([
    ['a string', 'not-an-object'],
    ['a number', 5],
    ['an array', ['WAITING']],
    ['a boolean', true],
  ])('rejects a non-object raw (%s) with InvalidValueObjectException', (_label, raw) => {
    expect(() => StateDescriptions.of(raw)).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-string value (a number)', () => {
    expect(() => StateDescriptions.of({ WAITING: 5 })).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-string value (an object)', () => {
    expect(() => StateDescriptions.of({ WAITING: { x: 1 } })).toThrow(InvalidValueObjectException);
  });

  it('rejects an empty-string key', () => {
    expect(() => StateDescriptions.of({ '': 'desc' })).toThrow(InvalidValueObjectException);
  });

  it('keys() returns the description-map keys (empties already dropped)', () => {
    const descriptions = StateDescriptions.of({
      WAITING: 'Tiket menunggu',
      CALLING: 'Sedang dipanggil',
      SERVING: '  ',
    });
    expect(descriptions.keys().sort()).toEqual(['CALLING', 'WAITING']);
  });

  it('toString() returns JSON', () => {
    const descriptions = StateDescriptions.of({ WAITING: 'Tiket menunggu' });
    expect(descriptions.toString()).toBe(JSON.stringify({ WAITING: 'Tiket menunggu' }));
  });

  it('equals (inherited structural deep-equal): same map → equal, different → not', () => {
    const a = StateDescriptions.of({ WAITING: 'Tiket menunggu' });
    const b = StateDescriptions.of({ WAITING: 'Tiket menunggu' });
    const c = StateDescriptions.of({ WAITING: 'Sedang dipanggil' });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it('does NOT validate state membership — a key that is not a real state does NOT throw (anti-corruption: the cross-check is the use case job, not the VO)', () => {
    // The VO must stay free of a StateMachine dependency (DIP), so it accepts a
    // key like "NOPE" even though no such state exists in the default state
    // machine. The save use case performs the cross-check.
    expect(() => StateDescriptions.of({ NOPE: 'A description' })).not.toThrow();
  });
});
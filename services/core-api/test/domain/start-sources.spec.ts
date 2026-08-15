import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  StartSources,
  type StartSourcesDto,
} from '../../src/domain/store-config/value-objects/start-sources';

describe('StartSources (explicit start-source state names for the Start terminal marker)', () => {
  it('of(undefined) / of(null) → DEFAULT (empty array), toDto() deep-equals []', () => {
    expect(StartSources.of(undefined)).toBe(StartSources.DEFAULT);
    expect(StartSources.of(null)).toBe(StartSources.DEFAULT);
    expect(StartSources.DEFAULT.toDto()).toEqual([]);
  });

  it('of([]) → empty array', () => {
    const es = StartSources.of([]);
    expect(es.toDto()).toEqual([]);
    expect(es.equals(StartSources.DEFAULT)).toBe(true);
  });

  it('of(["WAITING"]) round-trips via toDto() and the sources getter', () => {
    const es = StartSources.of(['WAITING']);
    expect(es.sources).toEqual(['WAITING']);
    expect(es.toDto()).toEqual(['WAITING']);
  });

  it('of(["WAITING", "COMPLETED"]) round-trips multiple start sources (multiple allowed)', () => {
    const es = StartSources.of(['WAITING', 'COMPLETED']);
    expect(es.toDto()).toEqual(['WAITING', 'COMPLETED']);
    expect(es.keys()).toEqual(['WAITING', 'COMPLETED']);
  });

  it('trims each entry', () => {
    const es = StartSources.of(['  WAITING  ', '\tCOMPLETED\n']);
    expect(es.toDto()).toEqual(['WAITING', 'COMPLETED']);
  });

  it('deduplicates defensively (preserving first-occurrence order)', () => {
    const es = StartSources.of(['WAITING', 'COMPLETED', 'WAITING', 'COMPLETED']);
    expect(es.toDto()).toEqual(['WAITING', 'COMPLETED']);
  });

  it.each([
    ['a string', 'WAITING'],
    ['a number', 5],
    ['a boolean', true],
    ['a plain object', { WAITING: true }],
  ])('rejects a non-array raw (%s) with InvalidValueObjectException', (_label, raw) => {
    expect(() => StartSources.of(raw)).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-string element (a number) with InvalidValueObjectException', () => {
    expect(() => StartSources.of(['WAITING', 5])).toThrow(InvalidValueObjectException);
  });

  it('rejects a non-string element (null) with InvalidValueObjectException', () => {
    expect(() => StartSources.of([null])).toThrow(InvalidValueObjectException);
  });

  it('rejects an empty-string element', () => {
    expect(() => StartSources.of([''])).toThrow(InvalidValueObjectException);
  });

  it('rejects a whitespace-only element', () => {
    expect(() => StartSources.of(['   '])).toThrow(InvalidValueObjectException);
  });

  it('toDto() returns an independent copy (mutating the DTO does not affect the VO)', () => {
    const es = StartSources.of(['WAITING', 'COMPLETED']);
    const dto = es.toDto() as string[];
    dto.push('CALLING');
    dto[0] = 'NOPE';
    expect(es.toDto()).toEqual(['WAITING', 'COMPLETED']);
  });

  it('DEFAULT is empty', () => {
    expect(StartSources.DEFAULT.toDto()).toEqual([]);
    expect(StartSources.DEFAULT.sources).toEqual([]);
  });

  it('toString() returns JSON', () => {
    const es = StartSources.of(['WAITING', 'COMPLETED']);
    expect(es.toString()).toBe(JSON.stringify(['WAITING', 'COMPLETED']));
  });

  it('equals (inherited structural deep-equal): same array → equal, different → not', () => {
    const a = StartSources.of(['WAITING', 'COMPLETED']);
    const b = StartSources.of(['WAITING', 'COMPLETED']);
    const c = StartSources.of(['WAITING']);
    const d = StartSources.of(['COMPLETED', 'WAITING']);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    // Order-sensitive (inherited array deep-equal) — a different order is NOT
    // equal. `of()` de-duplicates preserving first-occurrence order, so
    // identical inputs always produce identical VOs.
    expect(a.equals(d)).toBe(false);
  });

  it('does NOT perform state-membership validation (DIP — no StateMachine dependency)', () => {
    // The VO stays free of a StateMachine dependency. There is no cross-check
    // that an entry corresponds to a real state — that lives in the save use
    // case, which already built the state machine. So any valid string array
    // is accepted here.
    expect(() => StartSources.of(['NOT_A_STATE', 'ALSO_FAKE'])).not.toThrow();
  });
});
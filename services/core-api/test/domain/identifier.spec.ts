import { Identifier } from '../../src/domain/shared/identifier';
import { InvalidValueObjectException } from '../../src/domain/shared/errors';

// A well-known valid RFC 4122 v4 UUID (version nibble `4`, variant `8`).
const VALID_V4 = '00000000-0000-4000-8000-000000000000';

describe('Identifier', () => {
  it('constructs a valid v4 UUID and exposes its value', () => {
    const id = Identifier.of(VALID_V4);
    expect(id.value).toBe(VALID_V4);
    expect(id.toString()).toBe(VALID_V4);
  });

  it('generates a valid v4 UUID', () => {
    expect(Identifier.isValid(Identifier.generate().value)).toBe(true);
  });

  it('rejects a malformed id with InvalidValueObjectException (not a plain Error)', () => {
    // Regression for QUE-31: `Identifier.of` must throw a `DomainError`
    // (`InvalidValueObjectException`) so `DomainExceptionFilter` maps a
    // hand-crafted bad id to HTTP 400, not the 500 a plain `Error` surfaces as.
    expect(() => Identifier.of('not-a-uuid')).toThrow(InvalidValueObjectException);
    let caught: unknown;
    try {
      Identifier.of('not-a-uuid');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidValueObjectException);
    expect((caught as InvalidValueObjectException).code).toBe('INVALID_VALUE_OBJECT');
  });

  it('rejects empty / short / non-v4-variant strings', () => {
    expect(() => Identifier.of('')).toThrow(InvalidValueObjectException);
    expect(() => Identifier.of('A')).toThrow(InvalidValueObjectException);
    // a v1 UUID (version nibble `1`) is rejected by the v4 regex
    expect(() => Identifier.of('550e8400-e29b-11d4-a716-446655440000')).toThrow(
      InvalidValueObjectException,
    );
  });

  it('isValid is true only for v4 UUIDs', () => {
    expect(Identifier.isValid(VALID_V4)).toBe(true);
    expect(Identifier.isValid(Identifier.generate().value)).toBe(true);
    expect(Identifier.isValid('not-a-uuid')).toBe(false);
    expect(Identifier.isValid('')).toBe(false);
    expect(Identifier.isValid('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });

  it('compares by value, not identity', () => {
    expect(Identifier.of(VALID_V4).equals(Identifier.of(VALID_V4))).toBe(true);
    const other = Identifier.generate();
    expect(Identifier.of(VALID_V4).equals(other)).toBe(false);
  });
});
import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import { TicketNumber } from '../../src/domain/queue';

describe('TicketNumber', () => {
  it('formats with zero-padded sequence (min 3 digits)', () => {
    expect(TicketNumber.of('A', 1).formatted()).toBe('A-001');
    expect(TicketNumber.of('A', 12).formatted()).toBe('A-012');
    expect(TicketNumber.of('B', 1234).formatted()).toBe('B-1234');
  });

  it('parses a formatted string back into equal value', () => {
    expect(TicketNumber.parse('A-001').equals(TicketNumber.of('A', 1))).toBe(true);
  });

  it('rejects lowercase / non-letter category codes', () => {
    expect(() => TicketNumber.of('a', 1)).toThrow(InvalidValueObjectException);
    expect(() => TicketNumber.of('A1', 1)).toThrow(InvalidValueObjectException);
  });

  it('rejects non-positive or non-integer sequences', () => {
    expect(() => TicketNumber.of('A', 0)).toThrow(InvalidValueObjectException);
    expect(() => TicketNumber.of('A', -1)).toThrow(InvalidValueObjectException);
    expect(() => TicketNumber.of('A', 1.5)).toThrow(InvalidValueObjectException);
  });

  it('rejects malformed strings on parse', () => {
    expect(() => TicketNumber.parse('A001')).toThrow(InvalidValueObjectException);
    expect(() => TicketNumber.parse('A-')).toThrow(InvalidValueObjectException);
  });

  it('compares by value, not identity', () => {
    expect(TicketNumber.of('A', 1).equals(TicketNumber.of('A', 1))).toBe(true);
    expect(TicketNumber.of('A', 1).equals(TicketNumber.of('A', 2))).toBe(false);
  });
});
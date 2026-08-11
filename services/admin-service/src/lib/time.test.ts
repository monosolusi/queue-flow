import { describe, expect, it } from 'vitest';
import { isTimeValue, normalizeTimeInput } from './time';

describe('normalizeTimeInput', () => {
  it('zero-pads a one-digit hour', () => {
    expect(normalizeTimeInput('8:30')).toBe('08:30');
    expect(normalizeTimeInput('0:00')).toBe('00:00');
  });

  it('passes a complete HH:MM through unchanged', () => {
    expect(normalizeTimeInput('08:30')).toBe('08:30');
    expect(normalizeTimeInput('23:59')).toBe('23:59');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeTimeInput('  07:05 ')).toBe('07:05');
  });

  it('rejects a one-digit minute so a mid-typed "8:3" is never committed as 08:03', () => {
    expect(normalizeTimeInput('8:3')).toBeNull();
    expect(normalizeTimeInput('08:3')).toBeNull();
  });

  it('rejects incomplete input while typing', () => {
    for (const partial of ['', '0', '08', '08:', ':30']) {
      expect(normalizeTimeInput(partial)).toBeNull();
    }
  });

  it('rejects out-of-range hours and minutes', () => {
    expect(normalizeTimeInput('24:00')).toBeNull();
    expect(normalizeTimeInput('99:00')).toBeNull();
    expect(normalizeTimeInput('12:60')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(normalizeTimeInput('pagi')).toBeNull();
    expect(normalizeTimeInput('8:30 PM')).toBeNull();
  });
});

describe('isTimeValue', () => {
  it('mirrors normalizeTimeInput', () => {
    expect(isTimeValue('08:30')).toBe(true);
    expect(isTimeValue('8:3')).toBe(false);
    expect(isTimeValue('')).toBe(false);
  });
});

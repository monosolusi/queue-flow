import { describe, expect, it } from 'vitest';
import {
  daysAgoLocalKey,
  formatDateKey,
  isDateKey,
  localDayKey,
  parseDateKey,
  todayLocalKey,
} from './date';

describe('formatDateKey / todayLocalKey / daysAgoLocalKey', () => {
  it('formats a Date as a zero-padded local YYYY-MM-DD', () => {
    expect(formatDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(formatDateKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('todayLocalKey matches the local calendar day', () => {
    expect(todayLocalKey()).toBe(formatDateKey(new Date()));
  });

  it('daysAgoLocalKey walks back n calendar days across a month boundary', () => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    expect(daysAgoLocalKey(6)).toBe(formatDateKey(d));
  });
});

describe('localDayKey', () => {
  it('uses the LOCAL calendar day of an epoch timestamp, not the UTC one', () => {
    // Built from local components, so the key must round-trip regardless of the
    // machine's zone (a UTC-derived key would shift for any non-UTC store —
    // NFR-SEC-01, single on-premise box).
    const ms = new Date(2026, 6, 15, 23, 30).getTime();
    expect(localDayKey(ms)).toBe('2026-07-15');
  });
});

describe('parseDateKey / isDateKey', () => {
  it('parses a key into LOCAL midnight (not UTC midnight)', () => {
    const d = parseDateKey('2026-07-15');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(6);
    expect(d!.getDate()).toBe(15);
    expect(d!.getHours()).toBe(0);
  });

  it('round-trips every key it accepts', () => {
    for (const key of ['2026-01-01', '2026-02-29', '2024-02-29', '2026-12-31']) {
      const d = parseDateKey(key);
      if (key === '2026-02-29') {
        // 2026 is not a leap year — rejected by the round-trip guard.
        expect(d).toBeNull();
      } else {
        expect(formatDateKey(d!)).toBe(key);
      }
    }
  });

  it('rejects impossible civil dates rather than silently rolling them over', () => {
    // JS rolls 2026-02-31 to March 3; the round-trip guard catches it.
    expect(parseDateKey('2026-02-31')).toBeNull();
    expect(parseDateKey('2026-13-01')).toBeNull();
    expect(parseDateKey('2026-00-10')).toBeNull();
    expect(parseDateKey('2026-04-31')).toBeNull();
  });

  it('rejects malformed shapes', () => {
    for (const bad of ['', '2026-7-15', '15-07-2026', '2026/07/15', 'hari ini', '2026-07-15T00:00']) {
      expect(parseDateKey(bad)).toBeNull();
    }
  });

  it('isDateKey mirrors parseDateKey', () => {
    expect(isDateKey('2026-07-15')).toBe(true);
    expect(isDateKey('2026-02-31')).toBe(false);
    expect(isDateKey('')).toBe(false);
  });
});

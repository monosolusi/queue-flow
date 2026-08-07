import { describe, expect, it } from 'vitest';
import { formatDuration } from './format';

describe('formatDuration (QUE-51 — dynamic Indonesian units)', () => {
  it('formats zero and sub-minute durations as detik', () => {
    expect(formatDuration(0)).toBe('0.0 detik');
    expect(formatDuration(12000)).toBe('12.0 detik');
    expect(formatDuration(59900)).toBe('59.9 detik');
  });

  it('promotes a sub-threshold value that rounds up to the next unit (no 60.0 detik)', () => {
    // 59999ms = 59.999s → rounds to 60.0s → renders as 1.0 menit, keeping the
    // display continuous across the unit boundary (a 1ms diff must not flip
    // "60.0 detik" → "1.0 menit").
    expect(formatDuration(59999)).toBe('1.0 menit');
    expect(formatDuration(60000)).toBe('1.0 menit');
  });

  it('formats sub-hour durations as menit', () => {
    expect(formatDuration(90000)).toBe('1.5 menit');
    expect(formatDuration(3540000)).toBe('59.0 menit');
  });

  it('promotes a sub-hour value that rounds up to jam (no 60.0 menit)', () => {
    // 3599999ms = 59.99998min → rounds to 60.0min → renders as 1.0 jam.
    expect(formatDuration(3599999)).toBe('1.0 jam');
    expect(formatDuration(3600000)).toBe('1.0 jam');
  });

  it('formats hour-and-above durations as jam', () => {
    expect(formatDuration(7200000)).toBe('2.0 jam');
  });
});
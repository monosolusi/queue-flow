import { describe, expect, it } from 'vitest';
import { buildCallFragments } from './audio-provider';

describe('buildCallFragments (FR-TV-02)', () => {
  it('builds the exact announcement sequence for A-005 at counter 2', () => {
    // The canonical example from the plan: bell → "nomor antrian" → category
    // letter → each digit one-by-one → "silakan ke counter" → counter id.
    expect(buildCallFragments('A-005', 2)).toEqual([
      'bell',
      'nomor-antrian',
      'A',
      '0',
      '0',
      '5',
      'silakan-ke-counter',
      '2',
    ]);
  });

  it('announces multi-digit numbers and double-digit counters one digit at a time for the number, whole for the counter', () => {
    expect(buildCallFragments('B-013', 10)).toEqual([
      'bell',
      'nomor-antrian',
      'B',
      '0',
      '1',
      '3',
      'silakan-ke-counter',
      '10',
    ]);
  });

  it('handles a ticket number with no dash by treating the whole string as the category', () => {
    expect(buildCallFragments('A', 1)).toEqual([
      'bell',
      'nomor-antrian',
      'A',
      'silakan-ke-counter',
      '1',
    ]);
  });
});
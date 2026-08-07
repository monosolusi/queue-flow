import { describe, expect, it } from 'vitest';
import { validateStoreName } from './store-name';

describe('validateStoreName', () => {
  it('accepts a non-empty name', () => {
    expect(validateStoreName('Apotek Sehat Sentosa')).toBeNull();
  });

  it('rejects an empty or whitespace-only name with Indonesian copy', () => {
    // One rule + one string of copy shared by the wizard's step-1 guard and the
    // AdminPanel's save guard, so the two surfaces cannot drift.
    expect(validateStoreName('')).toBe('Nama toko tidak boleh kosong.');
    expect(validateStoreName('   ')).toBe('Nama toko tidak boleh kosong.');
  });

  it('accepts a name with surrounding whitespace (the backend trims, presence is the rule)', () => {
    expect(validateStoreName('  Toko  ')).toBeNull();
  });
});

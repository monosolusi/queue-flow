import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import { BrandColor } from '../../src/domain/store-config';

describe('BrandColor value object (QUE-36)', () => {
  describe('hex', () => {
    it('accepts #rrggbb and lowercases it', () => {
      expect(BrandColor.of('#2563EB').value).toBe('#2563eb');
      expect(BrandColor.of('#aabbcc').value).toBe('#aabbcc');
    });

    it('accepts #rgb shorthand', () => {
      expect(BrandColor.of('#abc').value).toBe('#abc');
      expect(BrandColor.of('#F00').value).toBe('#f00');
    });

    it('accepts #rrggbbaa 8-digit with alpha', () => {
      expect(BrandColor.of('#2563ebFF').value).toBe('#2563ebff');
    });

    it('trims surrounding whitespace', () => {
      expect(BrandColor.of('  #aabbcc  ').value).toBe('#aabbcc');
    });
  });

  describe('oklch', () => {
    it('accepts oklch(L C H)', () => {
      expect(BrandColor.of('oklch(0.7 0.15 200)').value).toBe('oklch(0.7 0.15 200)');
    });

    it('accepts oklch with alpha slash', () => {
      expect(BrandColor.of('oklch(0.7 0.15 200 / 0.5)').value).toBe(
        'oklch(0.7 0.15 200 / 0.5)',
      );
    });

    it('accepts percentages and deg units', () => {
      expect(BrandColor.of('oklch(70% 0.15 200deg)').value).toBe('oklch(70% 0.15 200deg)');
    });

    it('normalizes keyword case and collapses whitespace', () => {
      expect(BrandColor.of('OKLCH(  0.7   0.15   200 )').value).toBe('oklch(0.7 0.15 200)');
    });
  });

  describe('rejections', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['#', 'bare hash'],
      ['#gggggg', 'non-hex chars'],
      ['#1234', '4-digit hex (not a valid length)'],
      ['#1234567', '7-digit hex'],
      ['red', 'named color'],
      ['rgb(1, 2, 3)', 'rgb function'],
      ['oklch(0.7)', 'oklch with too few components'],
      ['oklch(0.7 0.15)', 'oklch with 2 components'],
      ['oklch(0.7 0.15 200 extra)', 'oklch with trailing junk'],
    ];
    for (const [input, label] of cases) {
      it(`rejects ${label} ('${input}') with InvalidValueObjectException`, () => {
        expect(() => BrandColor.of(input)).toThrow(InvalidValueObjectException);
      });
    }

    it('rejects a non-string', () => {
      expect(() => BrandColor.of(undefined as unknown as string)).toThrow(
        InvalidValueObjectException,
      );
    });
  });

  describe('DEFAULT', () => {
    it('is the existing --accent #2563eb (zero visual regression)', () => {
      expect(BrandColor.DEFAULT.value).toBe('#2563eb');
    });
  });

  describe('equals', () => {
    it('is structural over the normalized string', () => {
      expect(BrandColor.of('#2563eb').equals(BrandColor.of('#2563EB'))).toBe(true);
      expect(BrandColor.of('#2563eb').equals(BrandColor.of('#aabbcc'))).toBe(false);
    });
  });
});
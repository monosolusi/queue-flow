import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import { ServiceThemes } from '../../src/domain/store-config';

describe('ServiceThemes value object (QUE-47)', () => {
  describe('of', () => {
    it('accepts a full light/dark map', () => {
      const t = ServiceThemes.of({ kiosk: 'light', tv: 'dark', caller: 'dark', admin: 'light' });
      expect(t.toDto()).toEqual({
        kiosk: 'light',
        tv: 'dark',
        caller: 'dark',
        admin: 'light',
      });
    });

    it('defaults a missing surface to light (lazy-key reconstitution)', () => {
      const t = ServiceThemes.of({ kiosk: 'dark' });
      expect(t.toDto()).toEqual({
        kiosk: 'dark',
        tv: 'light',
        caller: 'light',
        admin: 'light',
      });
    });

    it('defaults a null surface value to light', () => {
      const t = ServiceThemes.of({ kiosk: 'dark', tv: null, caller: 'dark', admin: null });
      expect(t.toDto()).toEqual({
        kiosk: 'dark',
        tv: 'light',
        caller: 'dark',
        admin: 'light',
      });
    });

    it('recovers undefined (boot-window missing column) to all-light', () => {
      expect(ServiceThemes.of(undefined).toDto()).toEqual({
        kiosk: 'light',
        tv: 'light',
        caller: 'light',
        admin: 'light',
      });
    });

    it('recovers null (JSON null) to all-light', () => {
      expect(ServiceThemes.of(null).toDto()).toEqual({
        kiosk: 'light',
        tv: 'light',
        caller: 'light',
        admin: 'light',
      });
    });

    it('ignores unknown surfaces (only the 4 canonical keys are read)', () => {
      const t = ServiceThemes.of({
        kiosk: 'dark',
        tv: 'dark',
        caller: 'dark',
        admin: 'dark',
        // an extra key from a future/direct-API payload is not a 4-surface value
        unknown: 'dark',
      } as Record<string, string>);
      expect(t.toDto()).toEqual({
        kiosk: 'dark',
        tv: 'dark',
        caller: 'dark',
        admin: 'dark',
      });
    });
  });

  describe('rejections', () => {
    it.each([
      ['a string', 'kiosk:dark'],
      ['an array', ['kiosk', 'dark']],
      ['a number', 5],
    ])('rejects a non-object raw (%s) with InvalidValueObjectException', (_label, raw) => {
      expect(() => ServiceThemes.of(raw)).toThrow(InvalidValueObjectException);
    });

    it('rejects a present-but-invalid surface value', () => {
      expect(() =>
        ServiceThemes.of({ kiosk: 'blue', tv: 'light', caller: 'light', admin: 'light' }),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-string surface value (e.g. number) without a TypeError', () => {
      expect(() =>
        ServiceThemes.of({ kiosk: 5, tv: 'light', caller: 'light', admin: 'light' } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });
  });

  describe('DEFAULT', () => {
    it('is all-light (zero visual regression, matches CSS :root default)', () => {
      expect(ServiceThemes.DEFAULT.toDto()).toEqual({
        kiosk: 'light',
        tv: 'light',
        caller: 'light',
        admin: 'light',
      });
    });

    it('is the same instance recovered from undefined', () => {
      expect(ServiceThemes.of(undefined)).toBe(ServiceThemes.DEFAULT);
      expect(ServiceThemes.of(null)).toBe(ServiceThemes.DEFAULT);
    });
  });

  describe('toDto', () => {
    it('returns a defensive copy (mutating it does not affect the VO)', () => {
      const t = ServiceThemes.of({ kiosk: 'dark', tv: 'light', caller: 'light', admin: 'light' });
      const dto = t.toDto();
      dto.kiosk = 'light';
      expect(t.toDto().kiosk).toBe('dark');
    });
  });

  describe('equals', () => {
    it('is structural over the per-surface map', () => {
      expect(
        ServiceThemes.of({ kiosk: 'dark', tv: 'light', caller: 'light', admin: 'light' }).equals(
          ServiceThemes.of({ kiosk: 'dark', tv: 'light', caller: 'light', admin: 'light' }),
        ),
      ).toBe(true);
      expect(
        ServiceThemes.of({ kiosk: 'dark', tv: 'light', caller: 'light', admin: 'light' }).equals(
          ServiceThemes.of({ kiosk: 'light', tv: 'light', caller: 'light', admin: 'light' }),
        ),
      ).toBe(false);
    });
  });

  describe('toString', () => {
    it('JSON-serializes the per-surface map', () => {
      const map = { kiosk: 'dark', tv: 'light', caller: 'light', admin: 'light' };
      expect(ServiceThemes.of(map).toString()).toBe(JSON.stringify(map));
    });
  });
});
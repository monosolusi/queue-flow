import { afterEach, describe, expect, it } from 'vitest';
import { applyBrandColor, applyThemeMode } from './theme';

/**
 * `applyThemeMode` (QUE-47) toggles a `data-theme="dark"` attribute on <html>;
 * light is the CSS `:root` default applied by omission. The leaf is duplicated
 * 4× (one per service, not synced — QUE-37 minimal-dependency ethos); this spec
 * guards the shared logic once, in the kiosk service, since all four copies are
 * byte-identical. `applyBrandColor` is exercised alongside to anchor the
 * co-located leaf's other half.
 */
describe('applyThemeMode (QUE-47)', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('--accent');
  });

  it('sets data-theme="dark" for the dark mode', () => {
    applyThemeMode('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('removes data-theme for light (the CSS :root default — no FOUC)', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    applyThemeMode('light');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it.each([undefined, null, '', 'blue', 'DARK'])(
    'treats a non-dark value %j as light (removes the attribute)',
    (value) => {
      document.documentElement.setAttribute('data-theme', 'dark');
      applyThemeMode(value);
      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    },
  );
});

describe('applyBrandColor (QUE-36, co-located leaf)', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--accent');
  });

  it('sets --accent for a valid hex', () => {
    applyBrandColor('#aabbcc');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#aabbcc');
  });

  it('ignores empty/invalid so the CSS default wins', () => {
    document.documentElement.style.setProperty('--accent', '#fallback');
    applyBrandColor('');
    applyBrandColor(null);
    applyBrandColor(undefined);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#fallback');
  });
});
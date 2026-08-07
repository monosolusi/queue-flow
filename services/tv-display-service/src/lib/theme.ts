/**
 * Applies the manager-configured brand color (QUE-36 `SystemConfiguration.brandColor`)
 * to the runtime `--accent` CSS custom property. The static `--accent:#2563eb`
 * in `_tokens.css` is the pre-fetch / fetch-failure fallback (it IS the default),
 * so there is no flash of the wrong accent before this resolves: the static value
 * shows until a real brandColor lands, and a fetch failure leaves it in place.
 *
 * A per-service leaf utility (not synced) — ~3 lines duplicated 4× is less
 * over-engineering than a shared/synced TS module crossing the standalone-service
 * boundary (NFR-MNT-02). Empty/invalid input is ignored so the CSS default wins.
 */
export function applyBrandColor(brandColor: string | undefined | null): void {
  if (brandColor && typeof brandColor === 'string' && brandColor.trim()) {
    document.documentElement.style.setProperty('--accent', brandColor.trim());
  }
}

/**
 * Applies this service's light/dark theme (QUE-47 `SystemConfiguration.serviceThemes`)
 * by toggling a `data-theme="dark"` attribute on <html>. Light is the CSS `:root`
 * default in `_tokens.css`, so the default case is applied by *omission* — no
 * `data-theme` attribute, no FOUC for the default (mirrors the `applyBrandColor`
 * fallback model: the static light palette shows until a real `dark` lands, and
 * a fetch failure / light value leaves the light default in place). Only `'dark'`
 * opts into the `[data-theme="dark"]` overrides; any other value (light,
 * undefined, null, an unknown string) removes the attribute → light.
 *
 * Per-service leaf (not synced) — the ~3-line `applyBrandColor` precedent
 * duplicated 4×. Each service calls this with its own surface key from the
 * `serviceThemes` map it fetches at boot (ISP — one key per service).
 */
export function applyThemeMode(mode: string | undefined | null): void {
  const el = document.documentElement;
  if (mode === 'dark') {
    el.setAttribute('data-theme', 'dark');
  } else {
    el.removeAttribute('data-theme');
  }
}
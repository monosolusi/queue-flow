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
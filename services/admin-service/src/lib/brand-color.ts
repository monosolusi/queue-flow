/**
 * Client-side brand-color validation (QUE-36). The wizard + admin panel use a
 * native `<input type="color">` synced with a hex `<input type="text">`; the
 * picker emits `#rrggbb` only, but a manager can also type into the hex field.
 * This guard mirrors the *UI-reachable* subset of the backend `BrandColor`
 * value object (`core-api`'s `domain/store-config/value-objects/brand-color.ts`)
 * — a 6-digit `#rrggbb` hex string — so the client never submits a color the
 * backend would reject with 400 `INVALID_VALUE_OBJECT`. Following the CLAUDE.md
 * rule: mirror the VO invariant in client validation AND keep invalid states
 * unconstructable (the save / `Lanjut` button stays disabled while the field is
 * invalid), rather than relying on a backend 400 round-trip.
 *
 * The backend VO additionally accepts `#rgb` shorthand, `#rrggbbaa` alpha hex,
 * and `oklch(...)` — but those are reachable only via a direct API call (the UI
 * picker cannot emit them), so over-validating them here would reject inputs
 * the backend happily persists. The two grammars MUST stay in lock-step for
 * the *UI-reachable* subset; a divergence is a bug.
 */

/** `#rrggbb` 6-digit hex (the only form the native color picker emits). */
const HEX6_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * @returns `true` when `input` is a valid `#rrggbb` hex color (the UI-reachable
 * subset of the backend `BrandColor` VO).
 */
export function isValidBrandColor(input: string): boolean {
  return HEX6_RE.test(input.trim());
}

/**
 * @returns a list of Indonesian error strings for `input`; empty when valid
 * (mirrors `validateCustomCategories`'s `string[]` contract — empty = valid).
 */
export function validateBrandColor(input: string): string[] {
  const errors: string[] = [];
  if (!input || !input.trim()) {
    errors.push('Warna brand wajib diisi.');
    return errors;
  }
  if (!isValidBrandColor(input)) {
    errors.push('Warna brand harus berupa hex 6 digit, contoh #2563eb.');
  }
  return errors;
}
import type { WizardCategoryDto } from '../api/types';

/**
 * Validate a category list against the backend `Category` value-object
 * invariants (mirrors `SaveSystemConfigurationUseCase.buildCategories` +
 * the `Category` VO): code `^[A-Z]+$`, non-empty name, no duplicate codes.
 * Returns a list of human-readable (Indonesian) error strings; empty means
 * valid. Per-row prefixes keep distinct rows distinguishable so the dedup
 * `Set` does not collapse two identical messages (e.g. two empty names).
 *
 * Shared by the wizard step-1 guard and the operational AdminPanel save
 * guard so the two editing surfaces enforce the same client-side contract
 * (CLAUDE.md: mirror backend invariants client-side, make invalid states
 * unconstructable rather than relying on a 400 round-trip).
 */
export function validateCustomCategories(cats: readonly WizardCategoryDto[]): string[] {
  const errors: string[] = [];
  // code -> first row it appeared on, so a duplicate points back to the original.
  const seenCodes = new Map<string, number>();
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    const row = i + 1;
    if (!c.code || !/^[A-Z]+$/.test(c.code)) {
      errors.push(`Kategori ${row}: kode harus huruf kapital (A-Z).`);
    } else if (seenCodes.has(c.code)) {
      errors.push(`Kategori ${row}: kode '${c.code}' duplikat dengan kategori ${seenCodes.get(c.code)}.`);
    } else {
      seenCodes.set(c.code, row);
    }
    if (!c.name || !c.name.trim()) errors.push(`Kategori ${row}: nama tidak boleh kosong.`);
  }
  return [...new Set(errors)];
}

/**
 * Validate the daily-reset `resetTicketNumberTo` floor: a positive integer
 * (mirrors the backend sequence semantics — ticket numbers start at 1). Returns
 * an Indonesian error string when invalid, `null` when valid. `0` (the result
 * of clearing a `<input type="number">`) and `NaN` (non-numeric input) are
 * rejected so a manager cannot submit a reset floor the backend would reject.
 */
export function validateResetTo(value: number): string | null {
  if (!Number.isInteger(value) || value < 1) {
    return 'Nomor antrian awal harus bilangan bulat ≥ 1.';
  }
  return null;
}
/**
 * Validate the store / branch name, mirroring the backend
 * `SystemConfiguration.storeName` presence invariant so neither editing surface
 * can submit a name the save would 400 on. Returns an Indonesian error string
 * when invalid, `null` when valid.
 *
 * Shared by the wizard's step-1 `Lanjut` guard and the operational
 * `AdminPanel`'s save guard, joining the other mirrored VO validators in
 * `src/lib/` (`cron.ts`, `categories.ts`, `brand-color.ts`, `retention.ts`) —
 * one definition of the rule and one string of copy, so the two surfaces cannot
 * drift (CLAUDE.md: mirror backend invariants client-side rather than relying on
 * a 400 round-trip).
 */
export function validateStoreName(storeName: string): string | null {
  return storeName.trim() ? null : 'Nama toko tidak boleh kosong.';
}

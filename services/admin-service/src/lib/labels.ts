import type { DailyResetMode, PriorityPolicy } from '../api/types';

/**
 * Friendly Bahasa Indonesia display labels for the enum values the manager
 * picks in the wizard / admin panel. The enum stays as the wire `value=` (the
 * `PUT /api/system/config` contract is unchanged — QUE-34 only swaps display
 * text, never the enum); these maps keep the human label next to the value so
 * the two never drift apart (a single source of truth for the friendly text).
 *
 * Mirrors the QUE-34 rule: no internal/technical terms in user-visible strings.
 * `FIFO_GLOBAL` / `CATEGORY_PRIORITY` / `AUTOMATIC_CRON` are backend enum names
 * and must never appear as display text — only as `value=`.
 *
 * The short `PRIORITY_POLICY_LABELS` (just the term) is what the manager sees
 * inline in the step-2 routing table and the `<select>` options — keeping the
 * column narrow and the dropdown scannable. The longer `PRIORITY_POLICY_DESCRIPTIONS`
 * carries the full explanation and is surfaced as a tooltip (table info glyph)
 * and an `aria-describedby` hint (modal select), so the short label never loses
 * the meaning the parenthetical used to inline (feedback: copy was too long).
 */
export const PRIORITY_POLICY_LABELS: Record<PriorityPolicy, string> = {
  FIFO_GLOBAL: 'Urutan masuk',
  CATEGORY_PRIORITY: 'Prioritas kategori',
};

/**
 * Full Bahasa Indonesia explanation of each priority policy. Surfaced as a
 * `title` tooltip on the step-2 table info glyph and as an `aria-describedby`
 * hint under the modal priority `<select>` — the long-form companion to the
 * short {@link PRIORITY_POLICY_LABELS}. Never sent to the backend (display
 * only), so it lives in this single source of truth beside the label map.
 */
export const PRIORITY_POLICY_DESCRIPTIONS: Record<PriorityPolicy, string> = {
  FIFO_GLOBAL: 'Tiket dilayani sesuai urutan masuk: yang lebih dulu mengambil antrian dilayani lebih dulu.',
  CATEGORY_PRIORITY: 'Kategori dengan prioritas lebih tinggi dilayani lebih dulu, meskipun baru masuk.',
};

export const DAILY_RESET_MODE_LABELS: Record<DailyResetMode, string> = {
  AUTOMATIC_CRON: 'Otomatis setiap hari',
  MANUAL: 'Manual (tombol reset)',
};
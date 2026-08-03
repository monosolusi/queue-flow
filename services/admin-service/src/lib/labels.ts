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
 */
export const PRIORITY_POLICY_LABELS: Record<PriorityPolicy, string> = {
  FIFO_GLOBAL: 'Urutan masuk (yang lebih dulu dilayani lebih dulu)',
  CATEGORY_PRIORITY: 'Prioritas per kategori',
};

export const DAILY_RESET_MODE_LABELS: Record<DailyResetMode, string> = {
  AUTOMATIC_CRON: 'Otomatis setiap hari',
  MANUAL: 'Manual (tombol reset)',
};
/**
 * Standby (idle) content for the TV display — FR-TV-03: "Menampilkan teks
 * berjalan (running text) pengumuman dan banner/video promosi saat antrian
 * idle."
 *
 * This is a **pure client-owned default**, not a `SystemConfiguration` field.
 * The PRD §7 config schema (the source of truth) carries no `runningText` /
 * `media` / `standby` field, and FR-ADM-01's reconfigurable list (routing,
 * categories, reset) excludes standby content, so manager-configurability is
 * out of scope. Standby media is a pure client concern — the backend never
 * displays media — mirroring the QUE-22 precedent that audio has no core-api
 * domain model. Idle content lives here as a single source of truth, exactly
 * like the vendored audio fragments in `public/audio/` (NFR-REL-01: all assets
 * local; a store replaces `public/media/*` and rebuilds to swap promos).
 *
 * The `runningText` may carry a `{storeName}` placeholder token resolved at
 * render time against the boot-loaded `state.storeName`, so this module stays
 * free of any store/IO dependency (pure data, trivially unit-testable).
 */

export type MediaKind = 'image' | 'video';

export interface MediaAsset {
  /** Filename inside `public/media/` (resolved to `/tv/media/<name>` at render). */
  readonly name: string;
  /** Explicit kind — robust + OCP-friendly (no file-extension sniffing). */
  readonly kind: MediaKind;
}

export interface StandbyContent {
  /**
   * Announcement running text. May contain a `{storeName}` placeholder token
   * resolved at render time; the default uses it so the greeting picks up the
   * configured store name without this module depending on store state.
   */
  readonly runningText: string;
  /** Media assets cycled by the standby player while idle (may be empty). */
  readonly media: readonly MediaAsset[];
}

/**
 * Default standby content (FR-TV-03). The running text preserves the original
 * "FR-TV-03 minimal" greeting (interpolating the store name) and pairs it with
 * a single bundled placeholder banner so the idle screen is never empty. Stores
 * drop their own promo image/video files into `public/media/` and list them
 * here to rotate promos.
 */
export const DEFAULT_STANDBY_CONTENT: StandbyContent = {
  runningText:
    'Selamat datang di {storeName} — mohon perhatikan nomor antrian Anda',
  media: [{ name: 'qms-promo.svg', kind: 'image' }],
};

/**
 * Resolves the `{storeName}` placeholder in a running-text string against the
 * given store name (falling back to a neutral label when unset). Pure — used by
 * the render layer so the content module holds no store reference.
 */
export function resolveRunningText(
  text: string,
  storeName: string | null | undefined,
): string {
  return text.replaceAll('{storeName}', storeName || 'layanan antrian kami');
}
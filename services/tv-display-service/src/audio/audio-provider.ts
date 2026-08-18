/**
 * AudioProvider — the OCP extension point for the TV announcement engine
 * (FR-TV-02). The board depends on this interface; concrete providers plug in
 * without the board changing. Tests inject a fake so no real audio plays in
 * jsdom.
 *
 * The unit is a whole **announcement**, addressed by URL, not a list of word
 * fragments. `tts-service` composes the Indonesian sentence, synthesizes it and
 * prepends the bell, returning one clip; the TV's only jobs are to play it and
 * to keep announcements from overlapping. That split is deliberate — Indonesian
 * number grammar used to live here, inside a rendering service, which meant the
 * announcement could only ever be a concatenation of pre-recorded words.
 */
export interface AudioProvider {
  /**
   * Play one announcement clip to completion.
   *
   * Resolves when the clip has finished, has been skipped because it could not
   * be loaded or played, or has been dropped by a `stop()`. **Never rejects**,
   * and never leaves its promise unsettled: the store fires this and forgets it,
   * and a decorator awaits it in a single-flight loop, so an unsettled promise
   * would wedge every later announcement rather than losing just this one.
   */
  playAnnouncement(url: string): Promise<void>;
  /**
   * Abandon in-flight playback and drop anything queued behind it.
   *
   * The in-flight clip's `playAnnouncement` promise settles immediately rather
   * than waiting for audio nobody is listening to — otherwise a decorator
   * awaiting it would stay busy long after the board moved on.
   */
  stop(): void;
}

/**
 * Optional capability: a provider whose playback the browser may refuse until a
 * user gesture (Chrome's autoplay policy). Deliberately **not** part of
 * `AudioProvider` — the announcement path only ever needs
 * `playAnnouncement`/`stop`, and forcing every fake to grow an `unlock()` it
 * never calls is exactly the coupling ISP warns about (`makeAudio()` in the
 * store's spec is used at 30-plus call sites).
 *
 * Discover it with {@link isAudioUnlockable} rather than assuming.
 */
export interface AudioUnlockable {
  /**
   * Subscribe to blocked-state changes. Emits the current value immediately so a
   * subscriber never has to guess the initial state. Returns an unsubscribe fn.
   */
  onBlockedChange(listener: (blocked: boolean) => void): () => void;
  /**
   * Probe whether playback is permitted, and — when called from inside a user
   * gesture handler — consume that gesture to lift the block.
   *
   * Never rejects; a failed unlock simply leaves the blocked state set, which is
   * the correct UX (the prompt stays on screen).
   */
  unlock(): Promise<void>;
}

/** Narrow an `AudioProvider` to one that can report/lift an autoplay block. */
export function isAudioUnlockable(
  provider: AudioProvider,
): provider is AudioProvider & AudioUnlockable {
  const candidate = provider as Partial<AudioUnlockable>;
  return (
    typeof candidate.onBlockedChange === 'function' && typeof candidate.unlock === 'function'
  );
}

/**
 * The minimal surface a provider needs from an HTML5 `Audio` element, so a test
 * fake can stand in without a real media pipeline (jsdom has none).
 */
export interface AudioLike {
  readonly src: string;
  play(): Promise<void> | void;
  /**
   * Optional so a minimal fake stays valid. A real `Audio` element has it, and
   * `stop()` calls it when present — which is what makes stopping produce actual
   * silence rather than merely settling a promise.
   */
  pause?(): void;
  addEventListener(event: 'ended' | 'error', handler: () => void): void;
  removeEventListener(event: 'ended' | 'error', handler: () => void): void;
}

/** Injectable audio constructor (the transport-constructor seam). */
export type AudioCtor = new (src: string) => AudioLike;

/**
 * Builds the URL of the announcement clip for a called ticket.
 *
 * Origin-relative on purpose: the same path resolves through the Vite dev
 * proxy (`/tts` → localhost:8000) and through the `gateway` (`location /tts/`),
 * so dev and production never diverge. The query is the whole cache identity —
 * `tts-service` returns a stable `ETag` for it, so the browser revalidates a
 * repeat "Panggil Ulang" instead of re-downloading.
 */
export function announcementUrl(ticketNumber: string, counterId: number): string {
  const params = new URLSearchParams({
    ticketNumber,
    counterId: String(counterId),
  });
  return `/tts/announcement?${params.toString()}`;
}

/** URL of the silent clip used to probe and unlock browser autoplay. */
export const AUDIO_PROBE_URL = '/tts/probe';

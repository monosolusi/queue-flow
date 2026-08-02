/**
 * AudioProvider — the OCP extension point for the TV announcement engine
 * (FR-TV-02). The TV board depends on this interface; concrete providers (MP3
 * fragment sequencer now, offline TTS later) plug in without the board
 * changing — mirroring the domain `AudioProvider` OCP note in CLAUDE.md. Tests
 * inject a fake provider so no real audio plays in jsdom.
 */
export interface AudioProvider {
  /**
   * Play a sequence of audio fragment ids one after another with no overlap.
   * Resolves once the whole sequence has finished (or been skipped on error).
   */
  playSequence(fragments: readonly string[]): Promise<void>;
  /**
   * Signal any in-flight playback to stop. The current fragment may finish
   * before playback halts (the concrete sequencer stops after the in-flight
   * fragment rather than cutting it mid-tone); queued announcements are
   * dropped. Callers must not rely on immediate silence.
   */
  stop(): void;
}

/**
 * The minimal surface the sequencer needs from an HTML5 `Audio` element, so a
 * test fake can stand in without a real media pipeline (jsdom has none).
 */
export interface AudioLike {
  readonly src: string;
  play(): Promise<void> | void;
  addEventListener(event: 'ended' | 'error', handler: () => void): void;
  removeEventListener(event: 'ended' | 'error', handler: () => void): void;
}

/** Injectable audio constructor (the transport-constructor seam). */
export type AudioCtor = new (src: string) => AudioLike;

/**
 * Builds the ordered fragment-id list for a "panggilan antrian" announcement
 * (FR-TV-02). The ticket number carries the category letter as its prefix
 * (e.g. `A-005` → category `A`, digits `0`,`0`,`5`), so no category lookup is
 * needed — the wire `TICKET_CALLED` payload only carries `ticketNumber` +
 * `counterId`. The ticket digits AND the counter id are each announced
 * digit-by-digit, so every fragment maps to an existing vendored
 * `/tv/audio/<digit>.mp3` — no multi-digit asset is required (NFR-REL-01: all
 * audio assets local). A counter id ≥ 10 therefore reuses `1.mp3`/`0.mp3`
 * rather than silently dropping (which a single `'10'` fragment would do, since
 * no `10.mp3` exists).
 *
 * @pre `counterId` is a positive integer (≥ 1). The backend guarantees this —
 * `buildRoutingRules` rejects non-integer/duplicate counter ids and the
 * wizard clamps the counter count to ≥ 1 — so the wire payload never carries 0
 * or a negative/fractional id. This function does not re-validate; a malformed
 * direct-WS frame would produce fragments with no matching asset that the
 * sequencer silently error-skips (the board degrades rather than crashes, per
 * the fire-and-forget contract in `tv-store`).
 *
 * Example: `buildCallFragments('A-005', 2)` →
 * `['bell','nomor-antrian','A','0','0','5','silakan-ke-counter','2']`.
 * Example: `buildCallFragments('B-013', 10)` →
 * `['bell','nomor-antrian','B','0','1','3','silakan-ke-counter','1','0']`.
 */
export function buildCallFragments(ticketNumber: string, counterId: number): string[] {
  const dash = ticketNumber.indexOf('-');
  const letter = dash === -1 ? ticketNumber : ticketNumber.slice(0, dash);
  const numPart = dash === -1 ? '' : ticketNumber.slice(dash + 1);
  const digits = numPart.split('');
  const counterDigits = String(counterId).split('');
  return ['bell', 'nomor-antrian', letter, ...digits, 'silakan-ke-counter', ...counterDigits];
}
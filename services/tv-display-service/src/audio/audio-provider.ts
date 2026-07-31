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
  /** Stop any in-flight playback immediately. */
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
 * `counterId`. Digits are announced one-by-one; the counter id is a single
 * fragment.
 *
 * Example: `buildCallFragments('A-005', 2)` →
 * `['bell','nomor-antrian','A','0','0','5','silakan-ke-counter','2']`.
 */
export function buildCallFragments(ticketNumber: string, counterId: number): string[] {
  const dash = ticketNumber.indexOf('-');
  const letter = dash === -1 ? ticketNumber : ticketNumber.slice(0, dash);
  const numPart = dash === -1 ? '' : ticketNumber.slice(dash + 1);
  const digits = numPart.split('');
  return ['bell', 'nomor-antrian', letter, ...digits, 'silakan-ke-counter', String(counterId)];
}
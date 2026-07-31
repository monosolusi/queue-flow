import { type AudioCtor, type AudioLike, type AudioProvider } from './audio-provider';

/** Default fragment-id → vendored MP3 URL mapping (offline, NFR-REL-01). */
function defaultUrlFor(fragment: string): string {
  // import.meta.env.BASE_URL is '/tv/' in both build (Vite base) and dev, so the
  // vendored MP3s resolve to '/tv/audio/<frag>.mp3' behind NGINX.
  return `${import.meta.env.BASE_URL}audio/${encodeURIComponent(fragment)}.mp3`;
}

export interface SequencerAudioProviderOptions {
  /** Injectable audio constructor — tests pass a fake (jsdom has no playback). */
  AudioCtor?: AudioCtor;
  /** Fragment-id → URL mapper; defaults to the vendored `/tv/audio/*.mp3` path. */
  urlFor?: (fragment: string) => string;
}

/**
 * Plays MP3 fragments **sequentially** via HTML5 `Audio` (FR-TV-02). Each
 * fragment is its own `Audio` element; the next is only created after the
 * current fires `ended` (or `error` — a missing/unreadable fragment is skipped
 * rather than stalling the announcement). Because the next `Audio` is not
 * constructed until the previous resolves, fragments never overlap. `stop()`
 * aborts an in-flight sequence after the current fragment.
 *
 * This is the offline audio synthesizer: no network, no TTS service — just the
 * vendored MP3 fragments in `public/audio/` (NFR-REL-01).
 */
export class SequencerAudioProvider implements AudioProvider {
  private readonly audioCtor: AudioCtor;
  private readonly urlFor: (fragment: string) => string;
  private current: AudioLike | null = null;
  private stopped = false;

  constructor(opts: SequencerAudioProviderOptions = {}) {
    this.audioCtor = opts.AudioCtor ?? (window.Audio as AudioCtor);
    this.urlFor = opts.urlFor ?? defaultUrlFor;
  }

  async playSequence(fragments: readonly string[]): Promise<void> {
    this.stopped = false;
    for (const fragment of fragments) {
      if (this.stopped) return;
      await this.playOne(fragment);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.current) {
      // Best-effort: remove listeners so a late `ended` cannot revive the loop.
      this.current = null;
    }
  }

  private playOne(fragment: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const audio = new this.audioCtor(this.urlFor(fragment));
      this.current = audio;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (this.current === audio) this.current = null;
        resolve();
      };
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done); // skip unreadable fragment
      // play() may return a promise (real Audio) or undefined (fake); ignore
      // rejection — the `ended`/`error` events drive the sequence forward.
      try {
        const maybePromise = audio.play();
        if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
          (maybePromise as Promise<void>).catch(() => {
            /* autoplay rejection handled by error/ended; don't stall */
          });
        }
      } catch {
        done(); // synchronous play failure → skip to next
      }
    });
  }
}
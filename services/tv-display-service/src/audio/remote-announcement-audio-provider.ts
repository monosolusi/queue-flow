import {
  AUDIO_PROBE_URL,
  type AudioCtor,
  type AudioLike,
  type AudioProvider,
  type AudioUnlockable,
} from './audio-provider';

export interface RemoteAnnouncementAudioProviderOptions {
  /** Injectable audio constructor — tests pass a fake (jsdom has no playback). */
  AudioCtor?: AudioCtor;
  /** URL of the silent probe clip; overridable so specs need no network. */
  probeUrl?: string;
}

/** Recognise the browser's "no user gesture yet" refusal. */
function isAutoplayBlocked(error: unknown): boolean {
  // Not `instanceof DOMException`: jsdom does not reliably expose it, and test
  // fakes reject with a plain Error carrying the right `name`.
  return (error as { name?: string } | null)?.name === 'NotAllowedError';
}

function isThenable(value: unknown): value is Promise<void> {
  return typeof (value as Promise<void> | undefined)?.then === 'function';
}

/**
 * Plays whole announcement clips fetched from `tts-service` over the LAN.
 *
 * Replaces the old fragment sequencer: the clip already contains the bell and
 * the full Indonesian sentence, so there is nothing to sequence *within* an
 * announcement. Serializing announcements against each other is a separate
 * concern and stays in `QueuedAudioProvider` (SRP).
 *
 * Also implements {@link AudioUnlockable}, because this is the layer that
 * actually observes the browser refusing to play.
 */
export class RemoteAnnouncementAudioProvider implements AudioProvider, AudioUnlockable {
  private readonly audioCtor: AudioCtor;
  private readonly probeUrl: string;
  private current: AudioLike | null = null;
  /** Settles the in-flight clip's promise; also the "is one in flight" flag. */
  private settleCurrent: (() => void) | null = null;
  private blocked = false;
  private readonly listeners = new Set<(blocked: boolean) => void>();

  constructor(opts: RemoteAnnouncementAudioProviderOptions = {}) {
    this.audioCtor = opts.AudioCtor ?? (window.Audio as unknown as AudioCtor);
    this.probeUrl = opts.probeUrl ?? AUDIO_PROBE_URL;
  }

  async playAnnouncement(url: string): Promise<void> {
    await this.play(url);
  }

  /**
   * Abandon the clip that is playing: silence it and settle its promise at once.
   *
   * Settling immediately is the load-bearing part. `SYSTEM_RESET` calls this, and
   * the queue decorator is `await`ing the in-flight clip inside a single-flight
   * loop — leaving that promise pending until a clip nobody is listening to
   * happens to end would hold the loop open and delay every later announcement.
   *
   * There is deliberately no sticky "stopped" state. An earlier version set a
   * flag here and cleared it at the top of `playAnnouncement`, which made the
   * flag unreadable by its own guard; worse, any version that *did* persist would
   * mute the board permanently after one daily reset.
   */
  stop(): void {
    const element = this.current;
    const settle = this.settleCurrent;
    this.current = null;
    this.settleCurrent = null;
    // `pause` is optional on AudioLike, so older fakes stay valid; a real element
    // has it, which is what makes this true silence rather than a promise trick.
    element?.pause?.();
    settle?.();
  }

  onBlockedChange(listener: (blocked: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.blocked); // emit current state so callers need no separate read
    return () => {
      this.listeners.delete(listener);
    };
  }

  async unlock(): Promise<void> {
    // Playing the silent probe both tests permission and, inside a gesture
    // handler, consumes that gesture to grant it. Silent so a successful probe
    // is inaudible to anyone in the store.
    await this.play(this.probeUrl);
  }

  private setBlocked(next: boolean): void {
    if (this.blocked === next) return;
    this.blocked = next;
    // Iterate a copy: a listener may unsubscribe in response.
    for (const listener of [...this.listeners]) listener(next);
  }

  private play(url: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const audio = new this.audioCtor(url);
      this.current = audio;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        // The old provider's stop() promised listener removal but never performed
        // it; without this a late `ended` from a superseded element could resolve
        // the wrong promise.
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        if (this.current === audio) this.current = null;
        if (this.settleCurrent === done) this.settleCurrent = null;
        resolve();
      };
      this.settleCurrent = done;
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done); // skip an unfetchable clip

      try {
        const started = audio.play();
        if (isThenable(started)) {
          started.then(
            () => {
              // Do NOT settle here. A real `play()` resolves when playback
              // BEGINS, so `ended` is still the completion signal; resolving now
              // would collapse the announcement into a single tick and let the
              // next one overlap it.
              this.setBlocked(false);
            },
            (error: unknown) => {
              // THE fix for a permanent-silence bug: a NotAllowedError rejection
              // fires neither `ended` nor `error`, so without settling here this
              // promise never resolves. The queue decorator awaits it inside a
              // single-flight loop, so one blocked play used to wedge every
              // later announcement until the page was reloaded.
              if (isAutoplayBlocked(error)) this.setBlocked(true);
              done();
            },
          );
        }
      } catch {
        done(); // synchronous play failure — skip
      }
    });
  }
}

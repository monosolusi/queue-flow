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
  /**
   * Every clip currently in flight, mapped to the callback that settles its
   * promise.
   *
   * A Map rather than a single `current` slot because two clips can legitimately
   * overlap: `unlock()` bypasses the FIFO queue on purpose (it must run inside
   * the user's gesture), so an overlay tap can land while an announcement that
   * started before the block is still audible. With one slot the probe evicted
   * the announcement, and a later `stop()` then paused the *probe* and left the
   * announcement playing — a `SYSTEM_RESET` that did not actually silence the
   * board.
   */
  private readonly live = new Map<AudioLike, () => void>();
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
   * Abandon every clip in flight: silence them and settle their promises at once.
   *
   * Settling immediately is the load-bearing part. `SYSTEM_RESET` calls this, and
   * the queue decorator is `await`ing the in-flight clip inside a single-flight
   * loop — leaving that promise pending until a clip nobody is listening to
   * happens to end would hold the loop open and delay every later announcement.
   *
   * *Every* clip, not just the newest: silencing is the whole point, so it must
   * not depend on which one happens to be in a slot.
   *
   * There is deliberately no sticky "stopped" state. An earlier version set a
   * flag here and cleared it at the top of `playAnnouncement`, which made the
   * flag unreadable by its own guard; worse, any version that *did* persist would
   * mute the board permanently after one daily reset.
   */
  stop(): void {
    // Copy first: each `settle` removes its own entry from the map.
    for (const [element, settle] of [...this.live]) {
      // `pause` is optional on AudioLike, so older fakes stay valid; a real
      // element has it, which is what makes this true silence rather than a
      // promise trick.
      element.pause?.();
      settle();
    }
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
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        // The old provider's stop() promised listener removal but never performed
        // it; without this a late `ended` from a superseded element could resolve
        // the wrong promise.
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        this.live.delete(audio);
        resolve();
      };
      this.live.set(audio, done);
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

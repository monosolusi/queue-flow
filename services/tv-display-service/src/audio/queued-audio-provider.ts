import type { AudioProvider } from './audio-provider';

export interface QueuedAudioProviderOptions {
  /**
   * Inner provider that already serializes fragments **within** one
   * announcement (e.g. {@link SequencerAudioProvider}). This decorator owns
   * the higher-level concern: serializing whole announcements relative to each
   * other so two back-to-back `TICKET_CALLED` events never overlap.
   */
  readonly inner: AudioProvider;
}

/** One queued announcement and the resolver for its `playSequence` promise. */
interface QueuedItem {
  readonly fragments: readonly string[];
  readonly resolve: () => void;
}

/**
 * Serializes announcements one-at-a-time FIFO (QUE-22, FR-TV-02). The TV store
 * fire-and-forgets `playSequence` per `TICKET_CALLED`; without this queue two
 * rapid calls would run their inner sequences concurrently and overlap. By
 * wrapping the fragment sequencer (which already guarantees no overlap *within*
 * a single announcement) this decorator guarantees no overlap *between*
 * announcements.
 *
 * SRP: the inner owns intra-announcement sequencing; this class owns
 * inter-announcement sequencing. OCP/LSP: this is a drop-in `AudioProvider` —
 * the board keeps depending on the interface, not on this decorator. One LSP
 * nuance: `playSequence` may resolve **later** than the inner would have
 * (it waits for prior queued announcements to finish); callers already treat it
 * as fire-and-forget (`void …` in the store), so the contract holds.
 */
export class QueuedAudioProvider implements AudioProvider {
  private readonly inner: AudioProvider;
  private queue: QueuedItem[] = [];
  private running = false;

  constructor(opts: QueuedAudioProviderOptions) {
    this.inner = opts.inner;
  }

  /**
   * Enqueue one announcement; resolves when THIS announcement has finished
   * playing (or has been dropped by a `stop()`). Never rejects — the inner
   * skips unreadable fragments rather than throwing, and the drain loop guards
   * against a rejecting inner so one bad announcement can't stall the queue.
   */
  playSequence(fragments: readonly string[]): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ fragments, resolve });
      void this.drain();
    });
  }

  /**
   * Drain loop. Single-flight guarded by `running` — the guard check AND the
   * `running = true` assignment both run synchronously before the first
   * `await`, so a second `playSequence` arriving while the inner is mid-fragment
   * only enqueues; it cannot start a second concurrent drain. Do not reorder
   * these two lines or push the assignment behind an `await`.
   */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.inner.playSequence(item.fragments);
        } catch {
          /* defense-in-depth: a rejecting inner must not stall the queue */
        }
        item.resolve();
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Drop all pending announcements and stop the in-flight one. Pending
   * `playSequence` promises resolve immediately so callers aren't hung; the
   * in-flight announcement is asked to stop after its current fragment (the
   * inner's `stop` semantics). The in-flight `playSequence` promise resolves
   * once the inner sequence settles.
   */
  stop(): void {
    const pending = this.queue;
    this.queue = [];
    for (const item of pending) item.resolve();
    this.inner.stop();
  }
}
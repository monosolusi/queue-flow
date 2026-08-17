import {
  isAudioUnlockable,
  type AudioProvider,
  type AudioUnlockable,
} from './audio-provider';

export interface QueuedAudioProviderOptions {
  /**
   * Inner provider that plays a single announcement clip (e.g.
   * {@link RemoteAnnouncementAudioProvider}). This decorator owns the
   * higher-level concern: serializing whole announcements relative to each other
   * so two back-to-back `TICKET_CALLED` events never overlap.
   */
  readonly inner: AudioProvider;
}

/** One queued announcement and the resolver for its `playAnnouncement` promise. */
interface QueuedItem {
  readonly url: string;
  readonly resolve: () => void;
}

/**
 * Serializes announcements one-at-a-time FIFO (QUE-22, FR-TV-02). The TV store
 * fire-and-forgets `playAnnouncement` per `TICKET_CALLED`; without this queue two
 * rapid calls would play over each other.
 *
 * SRP: the inner owns playing one clip; this class owns inter-announcement
 * ordering. OCP/LSP: a drop-in `AudioProvider` — the board keeps depending on the
 * interface. One LSP nuance: `playAnnouncement` may resolve **later** than the
 * inner would have (it waits for prior queued announcements); callers already
 * treat it as fire-and-forget (`void …` in the store), so the contract holds.
 *
 * It also forwards {@link AudioUnlockable}, because this decorator is the object
 * handed to the store — an unlockable inner would otherwise be unreachable.
 */
export class QueuedAudioProvider implements AudioProvider, AudioUnlockable {
  private readonly inner: AudioProvider;
  private queue: QueuedItem[] = [];
  private running = false;

  constructor(opts: QueuedAudioProviderOptions) {
    this.inner = opts.inner;
  }

  /**
   * Enqueue one announcement; resolves when THIS announcement has finished
   * playing (or has been dropped by a `stop()`). Never rejects.
   */
  playAnnouncement(url: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ url, resolve });
      void this.drain();
    });
  }

  /**
   * Drain loop. Single-flight guarded by `running` — the guard check AND the
   * `running = true` assignment both run synchronously before the first `await`,
   * so a second `playAnnouncement` arriving mid-clip only enqueues; it cannot
   * start a second concurrent drain. Do not reorder these two lines or push the
   * assignment behind an `await`.
   *
   * Note this loop is why the inner MUST always settle its promise. `catch` here
   * covers a *rejecting* inner, but a never-settling one would leave `running`
   * true forever (the `finally` never runs) and silently swallow every later
   * announcement.
   */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.inner.playAnnouncement(item.url);
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
   * Drop all pending announcements and stop the in-flight one. Pending promises
   * resolve immediately so callers aren't hung; the in-flight announcement is
   * asked to stop (the inner's `stop` semantics).
   */
  stop(): void {
    const pending = this.queue;
    this.queue = [];
    for (const item of pending) item.resolve();
    this.inner.stop();
  }

  /**
   * Forward blocked-state subscriptions to the inner when it supports them.
   *
   * Implemented unconditionally, degrading to a no-op, so consumers need one
   * type-guard (on this decorator) rather than two. Honest rather than lossy: an
   * inner that cannot be blocked never reports being blocked.
   */
  onBlockedChange(listener: (blocked: boolean) => void): () => void {
    if (!isAudioUnlockable(this.inner)) {
      listener(false);
      return () => {};
    }
    return this.inner.onBlockedChange(listener);
  }

  /**
   * Unlock the inner. Deliberately bypasses the queue: unlocking is not an
   * announcement, and it is called from a click handler that must consume the
   * user's gesture immediately — queueing it behind a blocked clip would spend
   * the gesture after it had already expired.
   */
  async unlock(): Promise<void> {
    if (!isAudioUnlockable(this.inner)) return;
    await this.inner.unlock();
  }
}

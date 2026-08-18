import type { AudioLike } from './audio-provider';

/**
 * Controllable fake HTML5 `Audio` for the audio specs. Records construction +
 * `play()` and lets a test drive the `ended`/`error` events so the provider
 * advances. Shared by the provider specs so both exercise the same
 * transport-constructor seam.
 */
export class FakeAudio implements AudioLike {
  static instances: FakeAudio[] = [];
  /**
   * When set, `play()` returns a promise rejecting with an error carrying this
   * `name` — the only way to reproduce Chrome's autoplay refusal, whose
   * defining property is that it fires NEITHER `ended` NOR `error` on the
   * element. A plain `Error` with the right `name` is enough: production code
   * reads `error.name` rather than testing `instanceof DOMException`, which jsdom
   * does not reliably provide.
   */
  static rejectPlayWith: string | null = null;

  readonly src: string;
  playCalls = 0;
  pauseCalls = 0;
  private endedHandlers: Array<() => void> = [];
  private errorHandlers: Array<() => void> = [];

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  /** Reset shared static state between tests (instances AND the reject switch). */
  static reset(): void {
    FakeAudio.instances = [];
    FakeAudio.rejectPlayWith = null;
  }

  /** Most recently constructed instance, or undefined if none. */
  static get last(): FakeAudio | undefined {
    return FakeAudio.instances[FakeAudio.instances.length - 1];
  }

  play(): Promise<void> | void {
    this.playCalls += 1;
    if (FakeAudio.rejectPlayWith !== null) {
      const error = new Error('play() refused');
      error.name = FakeAudio.rejectPlayWith;
      return Promise.reject(error);
    }
    // A real element's play() resolves when playback BEGINS, not when it ends.
    // Returning a resolved promise here keeps the fake faithful to that, which is
    // what makes the "resolve must not settle the announcement" behaviour testable.
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  addEventListener(event: 'ended' | 'error', handler: () => void): void {
    if (event === 'ended') this.endedHandlers.push(handler);
    else this.errorHandlers.push(handler);
  }

  removeEventListener(event: 'ended' | 'error', handler: () => void): void {
    const arr = event === 'ended' ? this.endedHandlers : this.errorHandlers;
    const idx = arr.indexOf(handler);
    if (idx !== -1) arr.splice(idx, 1);
  }

  /** True once the provider has detached its listeners (i.e. settled the clip). */
  get hasListeners(): boolean {
    return this.endedHandlers.length > 0 || this.errorHandlers.length > 0;
  }

  emitEnded(): void {
    for (const h of [...this.endedHandlers]) h();
  }

  emitError(): void {
    for (const h of [...this.errorHandlers]) h();
  }
}

/** Flush the microtask queue so promise-driven provider transitions advance. */
export const flushMicrotasks = (): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, 0));

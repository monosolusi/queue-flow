import type { AudioLike } from './audio-provider';

/**
 * Controllable fake HTML5 `Audio` for the audio specs. Records construction +
 * `play()` and lets a test drive the `ended`/`error` events so a sequencer
 * advances. Mirrors the inline fake previously duplicated across
 * `sequencer-audio-provider.test.ts`; shared here to keep the two specs in
 * lock-step (the transport-constructor seam is the same in both).
 */
export class FakeAudio implements AudioLike {
  static instances: FakeAudio[] = [];
  readonly src: string;
  playCalls = 0;
  private endedHandlers: Array<() => void> = [];
  private errorHandlers: Array<() => void> = [];

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  play(): void {
    this.playCalls += 1;
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

  emitEnded(): void {
    for (const h of [...this.endedHandlers]) h();
  }

  emitError(): void {
    for (const h of [...this.errorHandlers]) h();
  }
}

/** Flush the microtask queue so the async for-loop in playSequence advances. */
export const flushMicrotasks = (): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, 0));
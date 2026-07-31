import { describe, expect, it } from 'vitest';
import { SequencerAudioProvider } from './sequencer-audio-provider';
import type { AudioLike } from './audio-provider';

/** A controllable fake Audio element that records construction + play() and
 *  lets the test drive the `ended`/`error` events so the sequencer advances. */
class FakeAudio implements AudioLike {
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
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('SequencerAudioProvider (FR-TV-02)', () => {
  it('plays the fragments in exact order with no overlap', async () => {
    FakeAudio.instances = [];
    const fragments = ['bell', 'nomor-antrian', 'A', '0', '0', '5', 'silakan-ke-counter', '2'];
    const provider = new SequencerAudioProvider({
      AudioCtor: FakeAudio,
      urlFor: (f) => f, // raw fragment id as src for easy assertion
    });

    const done = provider.playSequence(fragments);

    // Only the first fragment is constructed + played; the second has NOT
    // started yet (no overlap — the next Audio is created only after `ended`).
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe('bell');
    expect(FakeAudio.instances[0].playCalls).toBe(1);

    // Drive each fragment to completion and assert the next one starts.
    for (const frag of fragments) {
      const current = FakeAudio.instances[FakeAudio.instances.length - 1];
      expect(current.src).toBe(frag);
      expect(current.playCalls).toBe(1);
      current.emitEnded();
      await flush();
    }
    await done;
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(fragments);
  });

  it('skips a fragment that errors and continues with the next', async () => {
    FakeAudio.instances = [];
    const provider = new SequencerAudioProvider({ AudioCtor: FakeAudio, urlFor: (f) => f });
    const done = provider.playSequence(['bell', 'bad', 'nomor-antrian']);

    expect(FakeAudio.instances[0].src).toBe('bell');
    FakeAudio.instances[0].emitEnded();
    await flush();

    expect(FakeAudio.instances[1].src).toBe('bad');
    FakeAudio.instances[1].emitError(); // unreadable fragment → skip
    await flush();

    expect(FakeAudio.instances[2].src).toBe('nomor-antrian');
    FakeAudio.instances[2].emitEnded();
    await done;
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(['bell', 'bad', 'nomor-antrian']);
  });

  it('stop() halts the sequence after the current fragment', async () => {
    FakeAudio.instances = [];
    const provider = new SequencerAudioProvider({ AudioCtor: FakeAudio, urlFor: (f) => f });
    void provider.playSequence(['bell', 'nomor-antrian', 'A']);

    expect(FakeAudio.instances[0].src).toBe('bell');
    provider.stop(); // abort before the first fragment ends
    FakeAudio.instances[0].emitEnded();
    await flush();
    // No further fragments are constructed after stop().
    expect(FakeAudio.instances).toHaveLength(1);
  });
});
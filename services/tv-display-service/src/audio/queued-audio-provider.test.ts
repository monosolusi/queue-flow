import { describe, expect, it } from 'vitest';
import { QueuedAudioProvider } from './queued-audio-provider';
import { SequencerAudioProvider } from './sequencer-audio-provider';
import { FakeAudio, flushMicrotasks } from './test-fake-audio';

describe('QueuedAudioProvider (QUE-22 — cross-call serialization, FR-TV-02)', () => {
  it('plays announcements strictly one-at-a-time FIFO — no overlap between calls', async () => {
    FakeAudio.instances = [];
    const inner = new SequencerAudioProvider({ AudioCtor: FakeAudio, urlFor: (f) => f });
    const provider = new QueuedAudioProvider({ inner });

    const first = ['bell', 'A', '1'];
    const second = ['bell', 'B', '2'];

    const p1 = provider.playSequence(first);
    const p2 = provider.playSequence(second);

    // First announcement starts immediately; only its first fragment exists.
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe('bell');

    // Drive all but the last fragment of the first announcement to `ended`.
    for (let i = 0; i < first.length - 1; i++) {
      const cur = FakeAudio.instances[FakeAudio.instances.length - 1];
      expect(cur.src).toBe(first[i]);
      cur.emitEnded();
      await flushMicrotasks();
    }

    // *** The load-bearing no-overlap assertion: BEFORE the first announcement's
    // last fragment fires `ended`, the second announcement must NOT have started
    // — none of its `Audio` elements exist yet. This is the falsifiable proof
    // for AC "Tidak ada overlap antar panggilan dapat diuji." ***
    expect(FakeAudio.instances).toHaveLength(first.length);
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(first);

    // Finish the first announcement.
    FakeAudio.instances[first.length - 1].emitEnded();
    await flushMicrotasks();
    await p1;

    // NOW the second announcement's first fragment is constructed.
    expect(FakeAudio.instances).toHaveLength(first.length + 1);
    expect(FakeAudio.instances[first.length].src).toBe('bell');

    // Drive the rest of the second announcement.
    for (let i = 0; i < second.length; i++) {
      const cur = FakeAudio.instances[FakeAudio.instances.length - 1];
      expect(cur.src).toBe(second[i]);
      cur.emitEnded();
      await flushMicrotasks();
    }
    await p2;

    expect(FakeAudio.instances.map((a) => a.src)).toEqual([...first, ...second]);
  });

  it('stop() drains the queue and resolves pending playSequence promises', async () => {
    FakeAudio.instances = [];
    const inner = new SequencerAudioProvider({ AudioCtor: FakeAudio, urlFor: (f) => f });
    const provider = new QueuedAudioProvider({ inner });

    const p1 = provider.playSequence(['bell', 'A', '1']); // in-flight
    const p2 = provider.playSequence(['bell', 'B', '2']); // queued, never starts

    expect(FakeAudio.instances[0].src).toBe('bell');
    provider.stop(); // aborts in-flight + drops pending

    // Resolve the in-flight fragment so the inner playSequence settles.
    FakeAudio.instances[0].emitEnded();
    await flushMicrotasks();

    await expect(p1).resolves.toBeUndefined(); // in-flight resolves after stop
    await expect(p2).resolves.toBeUndefined(); // pending resolves because stop() drained
    // The queued announcement never played.
    expect(FakeAudio.instances.filter((a) => a.src === 'B')).toHaveLength(0);
  });

  it('resolves immediately for an empty fragment list', async () => {
    FakeAudio.instances = [];
    const inner = new SequencerAudioProvider({ AudioCtor: FakeAudio, urlFor: (f) => f });
    const provider = new QueuedAudioProvider({ inner });

    await expect(provider.playSequence([])).resolves.toBeUndefined();
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('plays a rapid burst of N announcements in FIFO order with no inter-announcement overlap', async () => {
    FakeAudio.instances = [];
    const inner = new SequencerAudioProvider({ AudioCtor: FakeAudio, urlFor: (f) => f });
    const provider = new QueuedAudioProvider({ inner });

    const bursts = [
      ['bell', 'A', '1'],
      ['bell', 'B', '2'],
      ['bell', 'C', '3'],
    ];
    const pendings = bursts.map((b) => provider.playSequence(b));

    // *** Load-bearing: enqueueing all N announcements synchronously constructs
    // only the FIRST announcement's first fragment. Without the queue each
    // playSequence would eagerly construct its first Audio → N instances and
    // concurrent playback (overlap). One instance = serialized. ***
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe('bell');

    // Drive the whole stream fragment-by-fragment in announcement order; assert
    // each constructed fragment matches the expected FIFO flat sequence.
    for (const expected of bursts.flat()) {
      const cur = FakeAudio.instances[FakeAudio.instances.length - 1];
      expect(cur.src).toBe(expected);
      cur.emitEnded();
      await flushMicrotasks();
    }

    await Promise.all(pendings);
    expect(FakeAudio.instances.map((a) => a.src)).toEqual(bursts.flat());
  });
});
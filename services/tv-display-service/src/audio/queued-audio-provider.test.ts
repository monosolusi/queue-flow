import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioProvider } from './audio-provider';
import { QueuedAudioProvider } from './queued-audio-provider';
import { RemoteAnnouncementAudioProvider } from './remote-announcement-audio-provider';
import { FakeAudio, flushMicrotasks } from './test-fake-audio';

const A = '/tts/announcement?ticketNumber=A-001&counterId=1';
const B = '/tts/announcement?ticketNumber=B-002&counterId=2';
const C = '/tts/announcement?ticketNumber=C-003&counterId=3';

function buildStack() {
  const inner = new RemoteAnnouncementAudioProvider({ AudioCtor: FakeAudio });
  return { inner, provider: new QueuedAudioProvider({ inner }) };
}

beforeEach(() => {
  FakeAudio.reset();
});

describe('QueuedAudioProvider (QUE-22 — cross-call serialization, FR-TV-02)', () => {
  it('plays announcements strictly one-at-a-time FIFO — no overlap between calls', async () => {
    const { provider } = buildStack();

    const p1 = provider.playAnnouncement(A);
    const p2 = provider.playAnnouncement(B);
    await flushMicrotasks();

    // *** The load-bearing no-overlap assertion: enqueueing both synchronously
    // constructs only the FIRST clip. Without the queue each call would eagerly
    // construct its own Audio -> two elements playing at once. ***
    expect(FakeAudio.instances.map((a) => a.src)).toEqual([A]);

    FakeAudio.last!.emitEnded();
    await p1;
    await flushMicrotasks();

    // Only now does the second clip exist.
    expect(FakeAudio.instances.map((a) => a.src)).toEqual([A, B]);
    FakeAudio.last!.emitEnded();
    await p2;
  });

  it('plays a rapid burst of N announcements in FIFO order', async () => {
    const { provider } = buildStack();
    const pendings = [A, B, C].map((url) => provider.playAnnouncement(url));
    await flushMicrotasks();

    expect(FakeAudio.instances).toHaveLength(1);

    for (const expected of [A, B, C]) {
      expect(FakeAudio.last!.src).toBe(expected);
      FakeAudio.last!.emitEnded();
      await flushMicrotasks();
    }

    await Promise.all(pendings);
    expect(FakeAudio.instances.map((a) => a.src)).toEqual([A, B, C]);
  });

  it('a blocked announcement does not deadlock the queue — the next one still plays', async () => {
    // *** The integration proof for the permanent-silence bug. The inner used to
    // leave its promise unsettled when the browser refused play(), so this drain
    // loop stayed busy forever with `running = true` and EVERY later announcement
    // queued silently until the page was reloaded. ***
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const { provider } = buildStack();

    await provider.playAnnouncement(A); // refused, but must settle

    FakeAudio.rejectPlayWith = null;
    const second = provider.playAnnouncement(B);
    await flushMicrotasks();

    expect(FakeAudio.instances.map((a) => a.src)).toEqual([A, B]);
    FakeAudio.last!.emitEnded();
    await expect(second).resolves.toBeUndefined();
  });

  it('keeps draining after an inner announcement that rejects', async () => {
    let calls = 0;
    const flaky: AudioProvider = {
      playAnnouncement: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
      stop: () => {},
    };
    const provider = new QueuedAudioProvider({ inner: flaky });

    await expect(provider.playAnnouncement(A)).resolves.toBeUndefined();
    await expect(provider.playAnnouncement(B)).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('stop() drops the queue and resolves every pending promise', async () => {
    const { provider } = buildStack();

    const p1 = provider.playAnnouncement(A); // in-flight
    const p2 = provider.playAnnouncement(B); // queued, must never start
    await flushMicrotasks();

    provider.stop();

    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
    expect(FakeAudio.instances.map((a) => a.src)).toEqual([A]);
  });

  it('still accepts announcements after stop() — a daily reset must not mute the board', async () => {
    const { provider } = buildStack();
    provider.stop();

    const played = provider.playAnnouncement(A);
    await flushMicrotasks();
    FakeAudio.last!.emitEnded();

    await expect(played).resolves.toBeUndefined();
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it('forwards blocked-state changes from an unlockable inner', async () => {
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const { provider } = buildStack();
    const seen: boolean[] = [];
    provider.onBlockedChange((blocked) => seen.push(blocked));

    await provider.playAnnouncement(A);

    expect(seen).toEqual([false, true]);
  });

  it('forwards unlock() to an unlockable inner, bypassing the queue', async () => {
    // Bypassing matters: unlock() runs inside a click handler and must spend the
    // user's gesture immediately, not after whatever is queued ahead of it.
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const { provider } = buildStack();
    void provider.playAnnouncement(A);
    await flushMicrotasks();
    FakeAudio.reset();
    FakeAudio.rejectPlayWith = 'NotAllowedError';

    await provider.unlock();

    expect(FakeAudio.instances.map((a) => a.src)).toEqual(['/tts/probe']);
  });

  it('degrades to a no-op when the inner is not unlockable', async () => {
    // Keeps consumers to a single type-guard: this decorator is always unlockable,
    // and an inner that can never be blocked never reports being blocked.
    const plain: AudioProvider = {
      playAnnouncement: () => Promise.resolve(),
      stop: () => {},
    };
    const provider = new QueuedAudioProvider({ inner: plain });
    const listener = vi.fn();

    const unsubscribe = provider.onBlockedChange(listener);

    expect(listener).toHaveBeenCalledWith(false);
    expect(() => unsubscribe()).not.toThrow();
    await expect(provider.unlock()).resolves.toBeUndefined();
  });

  it('forwards stop() to the inner', async () => {
    const stop = vi.fn();
    const provider = new QueuedAudioProvider({
      inner: { playAnnouncement: () => Promise.resolve(), stop },
    });

    provider.stop();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});

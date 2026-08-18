import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteAnnouncementAudioProvider } from './remote-announcement-audio-provider';
import { FakeAudio, flushMicrotasks } from './test-fake-audio';

function build(probeUrl = '/tts/probe') {
  return new RemoteAnnouncementAudioProvider({
    AudioCtor: FakeAudio,
    probeUrl,
  });
}

beforeEach(() => {
  FakeAudio.reset();
});

describe('RemoteAnnouncementAudioProvider', () => {
  it('plays the announcement clip at the given URL', async () => {
    const provider = build();
    const played = provider.playAnnouncement('/tts/announcement?ticketNumber=A-005&counterId=2');
    await flushMicrotasks();

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.last!.src).toBe('/tts/announcement?ticketNumber=A-005&counterId=2');
    expect(FakeAudio.last!.playCalls).toBe(1);

    FakeAudio.last!.emitEnded();
    await expect(played).resolves.toBeUndefined();
  });

  it('does not resolve when play() starts — only when the clip ends', async () => {
    // A real play() resolves at playback START. Settling there would let the next
    // queued announcement begin over the top of this one.
    const provider = build();
    const settled = vi.fn();
    void provider.playAnnouncement('/tts/announcement?x=1').then(settled);

    await flushMicrotasks();
    expect(settled).not.toHaveBeenCalled();

    FakeAudio.last!.emitEnded();
    await flushMicrotasks();
    expect(settled).toHaveBeenCalled();
  });

  it('skips a clip that fails to load instead of hanging', async () => {
    const provider = build();
    const played = provider.playAnnouncement('/tts/announcement?x=1');
    await flushMicrotasks();

    FakeAudio.last!.emitError();

    await expect(played).resolves.toBeUndefined();
  });

  it('settles when play() is refused by the autoplay policy', async () => {
    // THE regression test. A NotAllowedError rejection fires neither `ended` nor
    // `error`, so before the fix this promise never settled.
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const provider = build();

    await expect(provider.playAnnouncement('/tts/announcement?x=1')).resolves.toBeUndefined();
  });

  it('settles when play() is refused for a non-autoplay reason', async () => {
    FakeAudio.rejectPlayWith = 'NotSupportedError';
    const provider = build();

    await expect(provider.playAnnouncement('/tts/announcement?x=1')).resolves.toBeUndefined();
  });

  it('reports blocked=true to subscribers when autoplay is refused', async () => {
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const provider = build();
    const seen: boolean[] = [];
    provider.onBlockedChange((blocked) => seen.push(blocked));

    await provider.playAnnouncement('/tts/announcement?x=1');

    expect(seen).toEqual([false, true]);
  });

  it('does not report blocked for a non-autoplay failure', async () => {
    // A missing clip is a server problem, not a permission problem — prompting
    // the viewer to tap would be misleading and would not fix anything.
    FakeAudio.rejectPlayWith = 'NotSupportedError';
    const provider = build();
    const seen: boolean[] = [];
    provider.onBlockedChange((blocked) => seen.push(blocked));

    await provider.playAnnouncement('/tts/announcement?x=1');

    expect(seen).toEqual([false]);
  });

  it('emits the current blocked state immediately on subscribe', async () => {
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const provider = build();
    await provider.playAnnouncement('/tts/announcement?x=1');

    const late = vi.fn();
    provider.onBlockedChange(late);

    expect(late).toHaveBeenCalledWith(true);
  });

  it('stops notifying after unsubscribe', async () => {
    const provider = build();
    const listener = vi.fn();
    const unsubscribe = provider.onBlockedChange(listener);
    listener.mockClear();
    unsubscribe();

    FakeAudio.rejectPlayWith = 'NotAllowedError';
    await provider.playAnnouncement('/tts/announcement?x=1');

    expect(listener).not.toHaveBeenCalled();
  });

  it('clears blocked once a later play succeeds', async () => {
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const provider = build();
    const seen: boolean[] = [];
    provider.onBlockedChange((blocked) => seen.push(blocked));
    await provider.playAnnouncement('/tts/announcement?x=1');

    FakeAudio.rejectPlayWith = null;
    const played = provider.playAnnouncement('/tts/announcement?x=2');
    await flushMicrotasks();
    FakeAudio.last!.emitEnded();
    await played;

    expect(seen).toEqual([false, true, false]);
  });

  it('unlock() plays the silent probe clip', async () => {
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const provider = build('/tts/probe');
    await provider.unlock();

    expect(FakeAudio.last!.src).toBe('/tts/probe');
  });

  it('unlock() clears blocked when the probe is allowed', async () => {
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const provider = build();
    const seen: boolean[] = [];
    provider.onBlockedChange((blocked) => seen.push(blocked));
    await provider.playAnnouncement('/tts/announcement?x=1');
    expect(seen).toEqual([false, true]);

    FakeAudio.rejectPlayWith = null;
    const unlocked = provider.unlock();
    await flushMicrotasks();
    FakeAudio.last!.emitEnded();
    await unlocked;

    expect(seen).toEqual([false, true, false]);
  });

  it('unlock() leaves blocked set when the probe is still refused', async () => {
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    const provider = build();
    const seen: boolean[] = [];
    provider.onBlockedChange((blocked) => seen.push(blocked));

    await provider.unlock();

    expect(seen).toEqual([false, true]);
  });

  it('unlock() never rejects, so a click handler cannot throw', async () => {
    FakeAudio.rejectPlayWith = 'NotAllowedError';
    await expect(build().unlock()).resolves.toBeUndefined();
  });

  it('detaches its listeners once a clip settles', async () => {
    // stop()'s contract promised listener removal that the old implementation
    // never performed; a late `ended` could then resolve a superseded promise.
    const provider = build();
    const played = provider.playAnnouncement('/tts/announcement?x=1');
    await flushMicrotasks();
    const element = FakeAudio.last!;
    expect(element.hasListeners).toBe(true);

    element.emitEnded();
    await played;

    expect(element.hasListeners).toBe(false);
  });

  it('stop() settles the in-flight announcement immediately', async () => {
    // SYSTEM_RESET calls stop() while a clip may be playing. The decorator awaits
    // this promise in a single-flight loop, so waiting for a clip nobody is
    // listening to would hold that loop open and delay every later announcement.
    const provider = build();
    const played = provider.playAnnouncement('/tts/announcement?x=1');
    await flushMicrotasks();

    provider.stop();

    await expect(played).resolves.toBeUndefined();
  });

  it('stop() silences the element rather than only settling its promise', async () => {
    const provider = build();
    void provider.playAnnouncement('/tts/announcement?x=1');
    await flushMicrotasks();
    const element = FakeAudio.last!;

    provider.stop();

    expect(element.pauseCalls).toBe(1);
  });

  it('stop() is not sticky — the next announcement still plays', async () => {
    // A sticky stop would mute the board permanently after the first daily reset.
    const provider = build();
    provider.stop();

    const played = provider.playAnnouncement('/tts/announcement?x=1');
    await flushMicrotasks();

    expect(FakeAudio.instances).toHaveLength(1);
    FakeAudio.last!.emitEnded();
    await expect(played).resolves.toBeUndefined();
  });

  it('stop() silences an announcement that an unlock probe overlapped', async () => {
    // unlock() deliberately bypasses the FIFO queue — it has to run inside the
    // user's gesture — so a tap can land while a clip that started before the
    // block is still audible. With one `current` slot the probe evicted the
    // announcement and stop() then paused the PROBE, leaving the board talking
    // through a SYSTEM_RESET.
    const provider = build();
    const announcement = provider.playAnnouncement('/tts/announcement?x=1');
    await flushMicrotasks();
    const clip = FakeAudio.last!;

    void provider.unlock(); // overlay tap mid-announcement
    await flushMicrotasks();
    const probe = FakeAudio.last!;
    expect(probe).not.toBe(clip);

    provider.stop();

    expect(clip.pauseCalls).toBe(1);
    expect(probe.pauseCalls).toBe(1);
    // And the announcement's promise settles, so the queue loop is not held open.
    await expect(announcement).resolves.toBeUndefined();
  });

  it('a late ended from a stopped clip does not settle a newer one', async () => {
    const provider = build();
    void provider.playAnnouncement('/tts/announcement?x=1');
    await flushMicrotasks();
    const abandoned = FakeAudio.last!;
    provider.stop();

    const settled = vi.fn();
    void provider.playAnnouncement('/tts/announcement?x=2').then(settled);
    await flushMicrotasks();

    abandoned.emitEnded(); // the superseded element fires late
    await flushMicrotasks();

    expect(settled).not.toHaveBeenCalled();
  });
});

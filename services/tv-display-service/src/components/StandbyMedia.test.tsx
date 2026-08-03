import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach as vitestAfterEach, describe, expect, it, vi } from 'vitest';
import { StandbyMedia } from './StandbyMedia';
import type { MediaAsset } from '../standby/standby-content';

const BASE = '/fake-tv/';

function image(name: string): MediaAsset {
  return { name, kind: 'image' };
}
function video(name: string): MediaAsset {
  return { name, kind: 'video' };
}

function imgEl(container: HTMLElement): HTMLImageElement {
  const el = container.querySelector('img');
  if (!el) throw new Error('expected an <img> element');
  return el;
}
function videoEl(container: HTMLElement): HTMLVideoElement {
  const el = container.querySelector('video');
  if (!el) throw new Error('expected a <video> element');
  return el;
}

describe('StandbyMedia', () => {
  vitestAfterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('renders the first image asset with a resolved local media URL', () => {
    const { container } = render(<StandbyMedia assets={[image('promo.svg')]} baseURL={BASE} />);
    expect(imgEl(container)).toHaveAttribute('src', `${BASE}media/promo.svg`);
  });

  it('renders nothing when the media list is empty', () => {
    const { container } = render(<StandbyMedia assets={[]} baseURL={BASE} />);
    expect(container.firstChild).toBeNull();
  });

  it('advances to the next image after the image duration', async () => {
    vi.useFakeTimers();
    const { container } = render(
      <StandbyMedia assets={[image('a.svg'), image('b.svg')]} baseURL={BASE} />,
    );
    expect(imgEl(container)).toHaveAttribute('src', `${BASE}media/a.svg`);
    // Wrapping in act() flushes the React 18 state update the timer fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(imgEl(container)).toHaveAttribute('src', `${BASE}media/b.svg`);
  });

  it('loops a single video asset instead of advancing on ended', () => {
    const { container } = render(
      <StandbyMedia assets={[video('promo.mp4')]} baseURL={BASE} />,
    );
    const v = videoEl(container);
    expect(v).toHaveAttribute('loop');
    expect(v).toHaveAttribute('src', `${BASE}media/promo.mp4`);
    // firing ended on a single (looping) video does not advance — it stays
    fireEvent.ended(v);
    expect(videoEl(container)).toHaveAttribute('src', `${BASE}media/promo.mp4`);
  });

  it('advances to the next video on ended when there is more than one', () => {
    const { container } = render(
      <StandbyMedia assets={[video('a.mp4'), video('b.mp4')]} baseURL={BASE} />,
    );
    fireEvent.ended(videoEl(container)); // a -> b
    expect(videoEl(container)).toHaveAttribute('src', `${BASE}media/b.mp4`);
  });

  it('skips a missing asset via onError and lands on the next', () => {
    const { container } = render(
      <StandbyMedia assets={[image('missing.svg'), image('good.svg')]} baseURL={BASE} />,
    );
    fireEvent.error(imgEl(container)); // missing -> good
    expect(imgEl(container)).toHaveAttribute('src', `${BASE}media/good.svg`);
  });

  it('cycles back to the first asset after the last', () => {
    const { container } = render(
      <StandbyMedia assets={[video('a.mp4'), video('b.mp4')]} baseURL={BASE} />,
    );
    fireEvent.ended(videoEl(container)); // a -> b
    fireEvent.ended(videoEl(container)); // b -> a (wrap)
    expect(videoEl(container)).toHaveAttribute('src', `${BASE}media/a.mp4`);
  });

  it('holds when every asset errors (no tight error loop)', () => {
    const { container } = render(
      <StandbyMedia assets={[image('bad1.svg'), image('bad2.svg')]} baseURL={BASE} />,
    );
    fireEvent.error(imgEl(container)); // -> second
    expect(imgEl(container)).toHaveAttribute('src', `${BASE}media/bad2.svg`);
    fireEvent.error(imgEl(container)); // all broken — hold on second
    expect(imgEl(container)).toHaveAttribute('src', `${BASE}media/bad2.svg`);
  });
});
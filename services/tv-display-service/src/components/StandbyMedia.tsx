import { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../standby/standby-content';

/** How long an image banner stays on screen before advancing (FR-TV-03). */
const IMAGE_DURATION_MS = 8000;

export interface StandbyMediaProps {
  readonly assets: readonly MediaAsset[];
  /**
   * Base URL for resolving media `src` to `/tv/media/<name>`. Injectable so
   * tests pass a fake `baseURL` and never touch the filesystem (the same seam
   * pattern as `SequencerAudioProvider`'s `urlFor`).
   */
  readonly baseURL?: string;
}

function defaultBaseUrl(): string {
  // import.meta.env.BASE_URL is '/tv/' in both build (Vite base) and dev, so
  // vendored media resolves to '/tv/media/<name>' behind NGINX (NFR-REL-01).
  return import.meta.env.BASE_URL;
}

function urlFor(base: string, name: string): string {
  return `${base}media/${encodeURIComponent(name)}`;
}

/**
 * Cycles bundled local banner/video promo assets while the queue is idle
 * (FR-TV-03). A `video` advances on `ended` (a single video loops instead); an
 * `image` advances on a timer. A missing/unreadable asset is skipped via
 * `onError` — mirroring the audio sequencer's error-skip — so a store with a
 * broken file degrades to the next promo rather than stalling on a broken
 * `<img>`. When every asset in the list has errored, the player holds (no tight
 * error loop); when the list is empty it renders nothing and the running text
 * becomes the sole idle content.
 *
 * All `src` are relative to the Vite base URL — no network (NFR-REL-01).
 */
export function StandbyMedia({ assets, baseURL }: StandbyMediaProps) {
  const base = baseURL ?? defaultBaseUrl();
  const [index, setIndex] = useState(0);
  const imageTimerRef = useRef<number | null>(null);
  // Consecutive errors without a successful load — once it reaches the list
  // length, every asset is broken and we hold rather than spin a tight loop.
  const errorStreakRef = useRef(0);

  const len = assets.length;
  const current = len > 0 ? assets[index % len] : null;
  const single = len === 1;

  // Image advance timer — only when there is more than one asset (a single
  // image holds). Cleaned up on every asset change + unmount. Hooks are called
  // unconditionally; the empty-list early return is below, after all hooks.
  useEffect(() => {
    if (imageTimerRef.current !== null) {
      clearTimeout(imageTimerRef.current);
      imageTimerRef.current = null;
    }
    if (current?.kind === 'image' && !single) {
      imageTimerRef.current = window.setTimeout(
        () => setIndex((i) => (i + 1) % len),
        IMAGE_DURATION_MS,
      );
    }
    return () => {
      if (imageTimerRef.current !== null) {
        clearTimeout(imageTimerRef.current);
        imageTimerRef.current = null;
      }
    };
  }, [index, len, current, single]);

  if (current === null) return null;

  const advance = () => setIndex((i) => (i + 1) % len);

  const handleEnded = () => {
    errorStreakRef.current = 0;
    advance();
  };

  const handleError = () => {
    errorStreakRef.current += 1;
    if (errorStreakRef.current >= len) return; // all broken — hold
    advance();
  };

  const handleLoaded = () => {
    errorStreakRef.current = 0;
  };

  const src = urlFor(base, current.name);

  return (
    <div className="standby__media" aria-label="Media promosi standby">
      {current.kind === 'video' ? (
        <video
          key={current.name}
          src={src}
          autoPlay
          muted
          playsInline
          loop={single}
          onEnded={handleEnded}
          onError={handleError}
          onLoadedData={handleLoaded}
        />
      ) : (
        <img
          key={current.name}
          src={src}
          alt=""
          onError={handleError}
          onLoad={handleLoaded}
        />
      )}
    </div>
  );
}
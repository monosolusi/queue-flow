import { useEffect, useRef } from 'react';

/**
 * Full-screen prompt shown only when the browser is refusing to play audio.
 *
 * Chrome's autoplay policy blocks `play()` until the page has seen a user
 * gesture, and a TV board has no other interactive element — so without this the
 * announcements are silent with nothing on screen to explain why. It appears only
 * after the audio provider actually reports a block, so a kiosk browser launched
 * with autoplay permitted never shows it.
 *
 * **Not a modal dialog, deliberately.** The repo's dialog convention (`role`
 * `dialog` + `aria-modal` + focus trap + return-focus) exists for admin modals
 * opened *by* a focusable control. Neither condition holds here: nothing opened
 * it, and `aria-modal="true"` would hide the board from assistive tech —
 * including `NowServingCard`'s `role="status" aria-live="assertive"`, the one
 * thing a queue board must never take away. There is also no "dismiss": any tap
 * is the wanted gesture, so a single full-screen `<button>` is both the simplest
 * and the most accessible shape (native role, Enter and Space both count as user
 * activation, whole screen is the hit target).
 */
export function AudioUnlockOverlay({ onUnlock }: { onUnlock: () => void }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Focus on mount so an HDMI stick's remote can activate it with OK — there is
    // no pointer on a wall-mounted TV.
    buttonRef.current?.focus();
  }, []);

  return (
    <button
      ref={buttonRef}
      type="button"
      className="tv-audio-unlock"
      onClick={onUnlock}
      data-testid="audio-unlock"
    >
      <span className="tv-audio-unlock__icon" aria-hidden="true">
        🔔
      </span>
      <span className="tv-audio-unlock__label">Ketuk untuk mengaktifkan suara</span>
      <span className="tv-audio-unlock__hint">
        Peramban memblokir suara sampai layar ini disentuh sekali
      </span>
    </button>
  );
}

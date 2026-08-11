import { useEffect, type RefObject } from 'react';

/**
 * The dismiss machinery for a **non-modal** popover — Escape and outside
 * pointer-down — extracted so `DateField` and `TimeField` share one
 * implementation instead of two hand-copied `useEffect`s that could drift
 * (SRP: one reason to change, the dismiss semantics). Same "extract the
 * machinery, keep the component a thin view" shape as `use-poll.ts`.
 *
 * `mousedown` (not `click`) is the outside-close trigger — the recipe
 * `SearchableCategorySelect` already uses — because it fires in jsdom and,
 * more importantly, beats the browser's focus handoff, so the popover is gone
 * before the newly-clicked control takes focus.
 *
 * The two document listeners are attached **only while open**, so a page with
 * several fields does not accumulate permanent global handlers.
 *
 * Focus-out dismissal is deliberately NOT here: it is a React `onBlur` on the
 * popover root (React's `onBlur` is the bubbling `focusout`), which the
 * component wires directly — no document listener needed.
 */
export function usePopoverDismiss({
  open,
  rootRef,
  onEscape,
  onOutside,
}: {
  /** Whether the popover is currently open. */
  open: boolean;
  /** The element that bounds "inside" — a pointer-down outside it dismisses. */
  rootRef: RefObject<HTMLElement | null>;
  /** Escape was pressed. The caller restores focus to its trigger. */
  onEscape: () => void;
  /** A pointer went down outside the root. The caller must NOT move focus. */
  onOutside: () => void;
}): void {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onEscape();
    }
    function onPointerDown(e: MouseEvent) {
      const root = rootRef.current;
      if (root && !root.contains(e.target as Node)) onOutside();
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, rootRef, onEscape, onOutside]);
}

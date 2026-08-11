import { useCallback, useRef, useState } from 'react';

/**
 * Hand-rolled pointer-events drag-to-reorder hook (no new npm dependency —
 * NFR-REL-01, the repo's minimal-dependency ethos). The pure `reorderPanels`
 * helper in `lib/tv-panel-layout` is the tested core; this hook is a thin UI
 * layer that wires pointer events to it.
 *
 * Usage: a vertical `<ul>` of draggable rows. Each row's drag handle calls
 * `onPointerDown(e, sourceIndex)`. While dragging, `dropIndex` is the target
 * insertion position (0..n), and `draggingIndex` is the source row (for the
 * `--dragging` visual). On pointerup the hook calls `onReorder(from, to)`.
 *
 * The hit-test is row-midpoint based: a pointer over the top half of a row
 * targets insertion above it, the bottom half targets insertion below. jsdom
 * has no real layout (`getBoundingClientRect` returns zeros), so the pointer-
 * move path is exercised only in a real browser; the up/down buttons are the
 * keyboard/AT-accessible reorder path (the tested backbone).
 *
 * The hook is single-flight: a second pointerdown while a drag is in flight is
 * ignored (the source is pinned until pointerup). Pointer capture is set on
 * the handle so pointermove/pointerup fire on the handle even when the pointer
 * leaves it (the standard drag pattern).
 */
export interface DragReorderState {
  /** The source row index being dragged, or `null` when idle. */
  draggingIndex: number | null;
  /** The target insertion index (0..n), or `null` when no drop target. */
  dropIndex: number | null;
}

export interface UseDragReorderResult extends DragReorderState {
  /** Attach to each row's drag handle `onPointerDown`. `sourceIndex` is the
   *  row's position in the content-panel order (0..n-1). */
  onHandlePointerDown: (e: React.PointerEvent, sourceIndex: number) => void;
  /** Attach to each row's `onPointerMove` (or a shared container's). Reads the
   *  row midpoints via `getBoundingClientRect` to compute `dropIndex`. */
  onRowPointerMove: (e: React.PointerEvent, rowEls: readonly HTMLElement[]) => void;
  /** Attach to each row's `onPointerUp` / `onPointerCancel`. Commits the
   *  reorder (if any) and clears drag state. */
  onPointerUp: () => void;
}

export function useDragReorder(
  onReorder: (from: number, to: number) => void,
): UseDragReorderResult {
  const [state, setState] = useState<DragReorderState>({
    draggingIndex: null,
    dropIndex: null,
  });
  // The source index is kept in a ref so the pointerup handler reads the
  // committed value without depending on a re-render (a state-only read would
  // race a re-render that hasn't flushed).
  const fromRef = useRef<number | null>(null);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent, sourceIndex: number) => {
      // Single-flight: ignore a second pointerdown while a drag is in flight.
      if (fromRef.current !== null) return;
      // Only the primary button starts a drag (not middle/right-click, not
      // touch+pen eraser). `isPrimary` guards multi-touch.
      if (!e.isPrimary || e.button !== 0) return;
      fromRef.current = sourceIndex;
      setState({ draggingIndex: sourceIndex, dropIndex: sourceIndex });
      // Capture on the target so pointermove/up fire on the handle even after
      // the pointer leaves it. `releasePointerCapture` fires on pointerup.
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw if the pointerId is unknown (a race on
        // some browsers when the pointer is already released); safe to ignore.
      }
    },
    [],
  );

  const onRowPointerMove = useCallback(
    (e: React.PointerEvent, rowEls: readonly HTMLElement[]) => {
      if (fromRef.current === null) return;
      const y = e.clientY;
      let dropIndex = rowEls.length;
      for (let i = 0; i < rowEls.length; i++) {
        const rect = rowEls[i].getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (y < mid) {
          dropIndex = i;
          break;
        }
      }
      setState((prev) =>
        prev.draggingIndex === fromRef.current && prev.dropIndex === dropIndex
          ? prev
          : { ...prev, dropIndex },
      );
    },
    [],
  );

  const onPointerUp = useCallback(() => {
    const from = fromRef.current;
    if (from !== null && state.dropIndex !== null) {
      // Only fire a reorder when the drop target differs from the source.
      if (state.dropIndex !== from) {
        onReorder(from, state.dropIndex);
      }
    }
    fromRef.current = null;
    setState({ draggingIndex: null, dropIndex: null });
  }, [onReorder, state.dropIndex]);

  return {
    ...state,
    onHandlePointerDown,
    onRowPointerMove,
    onPointerUp,
  };
}
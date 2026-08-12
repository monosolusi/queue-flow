import { useCallback, useRef, useState } from 'react';
import { GRID_COLS, GRID_MAX_ROWS, GRID_MIN_H, GRID_MIN_W, type TvWidget } from '../api/types';
import { hasOverlap } from './tv-grid-layout';

/**
 * Hand-rolled pointer-events drag-to-move + drag-to-resize hook for the
 * `/tv-layout` 12-col grid editor (no new npm dependency — NFR-REL-01, the
 * repo's minimal-dependency ethos). The pure `moveWidget`/`resizeWidget`
 * helpers in `lib/tv-grid-layout` are the tested core; this hook is a thin UI
 * layer that wires pointer events to them.
 *
 * The hook is **browser-only** — it reads the canvas `getBoundingClientRect`
 * on every pointermove to convert client coords into grid cell coords. jsdom
 * has no real layout (`getBoundingClientRect` returns zeros), so the pointer-
 * move path is exercised only in a real browser; the per-widget stepper
 * controls (Kolom/Baris/Lebar/Tinggi) are the keyboard/AT-accessible + jsdom-
 * tested path (the tested backbone), mirroring the `use-drag-reorder`
 * precedent.
 *
 * The hook is single-flight: a second pointerdown while a drag is in flight is
 * ignored (the active widget id is pinned in a ref before the first await).
 * Pointer capture is set on the source element so pointermove/pointerup fire
 * on it even when the pointer leaves it (the standard drag pattern).
 *
 * `onMove(id, x, y)` / `onResize(id, w, h)` fire on pointerup, only when the
 * preview is valid (non-overlapping) AND the position/size changed. The
 * `preview` state carries the in-flight `{ id, x, y, w, h, valid }` so the
 * editor can render a live ghost + an `--invalid` modifier on overlap.
 */
export interface GridDndPreview {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly valid: boolean;
}

export interface UseGridDndResult {
  /** The active widget id (move or resize), or `null` when idle. */
  activeId: string | null;
  /** The in-flight preview rect (live ghost), or `null` when idle. */
  preview: GridDndPreview | null;
  /** Attach to each widget card's `onPointerDown` (the move source). */
  onWidgetPointerDown: (e: React.PointerEvent, widget: TvWidget) => void;
  /** Attach to each resize handle's `onPointerDown` (the resize source). */
  onResizeHandlePointerDown: (e: React.PointerEvent, widget: TvWidget) => void;
  /** Attach to the canvas's `onPointerMove`. Reads the canvas rect + computes
   *  the target cell / new size. */
  onPointerMove: (e: React.PointerEvent) => void;
  /** Attach to the canvas's `onPointerUp` / `onPointerCancel`. Commits the
   *  move/resize (if valid + changed) and clears drag state. */
  onPointerUp: () => void;
}

export interface UseGridDndOptions {
  /** Ref to the grid canvas element (for `getBoundingClientRect`). */
  canvasRef: React.RefObject<HTMLElement | null>;
  /** The editor's fixed CSS row height in px (e.g. 56). */
  rowHeight: number;
  /** The current full layout (for overlap checks excluding the active widget). */
  layout: readonly TvWidget[];
  /** Called on a valid, changed move. */
  onMove: (id: string, x: number, y: number) => void;
  /** Called on a valid, changed resize. */
  onResize: (id: string, w: number, h: number) => void;
}

type Mode = 'move' | 'resize';

interface ActiveState {
  mode: Mode;
  id: string;
  // Starting pointer coords (clientX/Y) — for resize delta computation.
  startX: number;
  startY: number;
  // The widget's rect at drag start (for resize delta base).
  startW: number;
  startH: number;
}

export function useGridDnd(opts: UseGridDndOptions): UseGridDndResult {
  const { canvasRef, rowHeight, layout, onMove, onResize } = opts;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [preview, setPreview] = useState<GridDndPreview | null>(null);
  // Pinned in a ref so pointerup reads the committed value without depending
  // on a re-render (a state-only read would race a re-render that hasn't
  // flushed). Single-flight: a second pointerdown while a drag is in flight is
  // ignored because `activeRef.current` is still set.
  const activeRef = useRef<ActiveState | null>(null);

  const beginDrag = useCallback(
    (e: React.PointerEvent, widget: TvWidget, mode: Mode) => {
      if (activeRef.current !== null) return; // single-flight
      if (!e.isPrimary || e.button !== 0) return; // primary button only
      activeRef.current = {
        mode,
        id: widget.id,
        startX: e.clientX,
        startY: e.clientY,
        startW: widget.w,
        startH: widget.h,
      };
      setActiveId(widget.id);
      // Initial preview is the widget's own rect (no move yet).
      setPreview({ id: widget.id, x: widget.x, y: widget.y, w: widget.w, h: widget.h, valid: true });
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw on a stale pointerId race; safe to ignore.
      }
    },
    [],
  );

  const onWidgetPointerDown = useCallback(
    (e: React.PointerEvent, widget: TvWidget) => beginDrag(e, widget, 'move'),
    [beginDrag],
  );

  const onResizeHandlePointerDown = useCallback(
    (e: React.PointerEvent, widget: TvWidget) => beginDrag(e, widget, 'resize'),
    [beginDrag],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const active = activeRef.current;
      if (active === null) return;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const rect = canvas.getBoundingClientRect();
      const cellW = rect.width / GRID_COLS;
      // Find the source widget (its w/h matter for move clamping; for resize
      // we start from startW/startH).
      const source = layout.find((w) => w.id === active.id);
      if (source === undefined) return;
      if (active.mode === 'move') {
        const w = source.w;
        const h = source.h;
        const col = clampInt(
          Math.floor((e.clientX - rect.left) / cellW),
          0,
          GRID_COLS - w,
        );
        const row = clampInt(
          Math.floor((e.clientY - rect.top) / rowHeight),
          0,
          GRID_MAX_ROWS - h,
        );
        const valid = !hasOverlap(layout, { x: col, y: row, w, h }, active.id);
        setPreview((prev) =>
          prev !== null && prev.x === col && prev.y === row && prev.w === w && prev.h === h && prev.valid === valid
            ? prev
            : { id: active.id, x: col, y: row, w, h, valid },
        );
      } else {
        // resize
        const newW = clampInt(
          source.w + Math.round((e.clientX - active.startX) / cellW),
          GRID_MIN_W,
          GRID_COLS - source.x,
        );
        const newH = clampInt(
          source.h + Math.round((e.clientY - active.startY) / rowHeight),
          GRID_MIN_H,
          GRID_MAX_ROWS - source.y,
        );
        const valid = !hasOverlap(layout, { x: source.x, y: source.y, w: newW, h: newH }, active.id);
        setPreview((prev) =>
          prev !== null && prev.x === source.x && prev.y === source.y && prev.w === newW && prev.h === newH && prev.valid === valid
            ? prev
            : { id: active.id, x: source.x, y: source.y, w: newW, h: newH, valid },
        );
      }
    },
    [canvasRef, rowHeight, layout],
  );

  const onPointerUp = useCallback(() => {
    const active = activeRef.current;
    const pv = preview;
    if (active !== null && pv !== null && pv.valid) {
      const source = layout.find((w) => w.id === active.id);
      if (source !== undefined) {
        if (active.mode === 'move') {
          if (pv.x !== source.x || pv.y !== source.y) {
            onMove(active.id, pv.x, pv.y);
          }
        } else {
          if (pv.w !== source.w || pv.h !== source.h) {
            onResize(active.id, pv.w, pv.h);
          }
        }
      }
    }
    activeRef.current = null;
    setActiveId(null);
    setPreview(null);
  }, [preview, layout, onMove, onResize]);

  return {
    activeId,
    preview,
    onWidgetPointerDown,
    onResizeHandlePointerDown,
    onPointerMove,
    onPointerUp,
  };
}

function clampInt(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n | 0;
}
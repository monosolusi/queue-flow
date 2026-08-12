import { useCallback, useRef, useState } from 'react';
import {
  DEFAULT_WIDGET_SIZE,
  GRID_COLS,
  GRID_MAX_ROWS,
  type TvComponentType,
  type TvGridLayout,
} from '../api/types';
import { hasOverlap } from './tv-grid-layout';

/**
 * Hand-rolled pointer-events drag-from-palette hook for the `/tv-layout`
 * editor. The manager presses on a palette chip, drags over the grid canvas,
 * sees a live ghost preview at the drop cell, and releases to place the widget
 * at that cell — the TradingView-style palette-place affordance.
 *
 * Browser-only (reads `getBoundingClientRect` on pointermove); the click-to-
 * add path on each chip is the a11y + jsdom-tested fallback (the tested
 * backbone), mirroring the `useGridDnd` precedent. Single-flight: a second
 * pointerdown while a place is in flight is ignored.
 *
 * `onPlace(component, x, y)` fires on pointerup only when the drop cell is
 * non-overlapping (the editor then calls `addWidget(layout, component,
 * { x, y })`). If the pointerup lands outside the canvas or the rect would
 * overlap, the place is cancelled (no callback).
 */
export interface PalettePlacePreview {
  readonly component: TvComponentType;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly valid: boolean;
}

export interface UsePalettePlaceResult {
  /** The component type being dragged from the palette, or `null` when idle. */
  placing: TvComponentType | null;
  /** The in-flight ghost rect, or `null` when idle. */
  preview: PalettePlacePreview | null;
  /** Attach to each palette chip's `onPointerDown`. */
  onChipPointerDown: (e: React.PointerEvent, component: TvComponentType) => void;
  /** Attach to the canvas's `onPointerMove`. */
  onPointerMove: (e: React.PointerEvent) => void;
  /** Attach to the canvas's `onPointerUp` / `onPointerCancel`. */
  onPointerUp: () => void;
}

export interface UsePalettePlaceOptions {
  /** Ref to the grid canvas element (for `getBoundingClientRect`). */
  canvasRef: React.RefObject<HTMLElement | null>;
  /** The editor's fixed CSS row height in px. */
  rowHeight: number;
  /** The current full layout (for overlap checks). */
  layout: TvGridLayout;
  /** Called when a chip is dropped on a non-overlapping canvas cell. */
  onPlace: (component: TvComponentType, x: number, y: number) => void;
}

export function usePalettePlace(opts: UsePalettePlaceOptions): UsePalettePlaceResult {
  const { canvasRef, rowHeight, layout, onPlace } = opts;
  const [placing, setPlacing] = useState<TvComponentType | null>(null);
  const [preview, setPreview] = useState<PalettePlacePreview | null>(null);
  const componentRef = useRef<TvComponentType | null>(null);

  const onChipPointerDown = useCallback(
    (e: React.PointerEvent, component: TvComponentType) => {
      if (componentRef.current !== null) return; // single-flight
      if (!e.isPrimary || e.button !== 0) return;
      componentRef.current = component;
      setPlacing(component);
      const size = DEFAULT_WIDGET_SIZE[component];
      setPreview({ component, x: 0, y: 0, w: size.w, h: size.h, valid: !hasOverlap(layout, { x: 0, y: 0, w: size.w, h: size.h }) });
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw on a stale pointerId race; safe to ignore.
      }
    },
    [layout],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const component = componentRef.current;
      if (component === null) return;
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const rect = canvas.getBoundingClientRect();
      const cellW = rect.width / GRID_COLS;
      const size = DEFAULT_WIDGET_SIZE[component];
      const col = clampInt(
        Math.floor((e.clientX - rect.left) / cellW),
        0,
        GRID_COLS - size.w,
      );
      const row = clampInt(
        Math.floor((e.clientY - rect.top) / rowHeight),
        0,
        GRID_MAX_ROWS - size.h,
      );
      const valid = !hasOverlap(layout, { x: col, y: row, w: size.w, h: size.h });
      setPreview((prev) =>
        prev !== null && prev.component === component && prev.x === col && prev.y === row && prev.valid === valid
          ? prev
          : { component, x: col, y: row, w: size.w, h: size.h, valid },
      );
    },
    [canvasRef, rowHeight, layout],
  );

  const onPointerUp = useCallback(() => {
    const component = componentRef.current;
    const pv = preview;
    if (component !== null && pv !== null && pv.valid) {
      onPlace(component, pv.x, pv.y);
    }
    componentRef.current = null;
    setPlacing(null);
    setPreview(null);
  }, [preview, onPlace]);

  return {
    placing,
    preview,
    onChipPointerDown,
    onPointerMove,
    onPointerUp,
  };
}

function clampInt(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n | 0;
}
import '@testing-library/jest-dom/vitest';

// The admin panel does not consume the WebSocket surface (SRP): it is a
// config/wizard/analytics tool that QUE-44 expands into a read-only
// operational monitor via REST polling (no realtime participation), so there
// is no global WebSocket stub here. fetch is provided by jsdom; tests that need
// to stub network calls inject a fake IAdminApi into the components directly
// (the seam is the API interface, not the global fetch).

// --- jsdom polyfills for React Flow (@xyflow/react v12) -----------------------
// React Flow measures nodes/viewport geometry via `ResizeObserver` and (for the
// optional `<Controls>`/minimap) `IntersectionObserver`, neither of which jsdom
// implements. `ResizeObserver` is load-bearing: React Flow defers rendering
// EDGES until nodes are measured (its `nodesInitialized` gate), and jsdom has no
// layout so element dimensions are 0 — so a pure no-op leaves the canvas with
// nodes but zero edges (the transition labels never mount). The stub below
// fires the callback once per `observe` with a default content rect, which lets
// React Flow mark nodes initialized and render the edges. Tests assert via
// classes/attributes/text (vitest `css: false`), never computed geometry, so
// the synthetic size only needs to be non-zero. `IntersectionObserver` stays a
// no-op (only the optional Controls/minimap use it; not on the assertion path).
const DEFAULT_NODE_SIZE = { width: 200, height: 60 };
class ResizeObserverStub {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    const entry = {
      target,
      contentRect: { ...DEFAULT_NODE_SIZE, x: 0, y: 0 },
      borderBoxSize: [{ inlineSize: DEFAULT_NODE_SIZE.width, blockSize: DEFAULT_NODE_SIZE.height }],
      contentBoxSize: [{ inlineSize: DEFAULT_NODE_SIZE.width, blockSize: DEFAULT_NODE_SIZE.height }],
      devicePixelContentBoxSize: [],
    } as unknown as ResizeObserverEntry;
    this.cb([entry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}
class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root = null;
  rootMargin = '';
  thresholds = [];
}
// `globalThis` assignment so the types resolve under the jsdom + node lib types.
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;

// `DOMMatrixReadOnly` is used by React Flow's `updateNodeInternals` to parse the
// viewport's CSS `transform` (it reads `m22`, the y-scale/zoom). jsdom does not
// ship it, so `new window.DOMMatrixReadOnly(style.transform)` throws and node
// measurement never completes — edges never render. The stub parses the 2D
// `matrix(a,b,c,d,e,f)` form (m22 = d) and treats `none`/empty as identity
// (m22 = 1), which is all React Flow reads here.
class DOMMatrixReadOnlyStub {
  readonly m22: number;
  constructor(transform: string) {
    if (!transform || transform === 'none') {
      this.m22 = 1;
    } else {
      const m = /matrix\(([^)]+)\)/.exec(transform);
      const parts = m ? m[1].split(',').map(Number) : [];
      this.m22 = parts[3] ?? 1;
    }
  }
}
globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;

// jsdom returns 0 for `offsetWidth`/`offsetHeight` (no layout engine). React
// Flow's `getDimensions` (used inside `updateNodeInternals`) reads these to
// decide whether to (re)measure a node: `doUpdate = !!(width && height && …)`.
// With zeros, `doUpdate` is false, so `handleBounds` is never set,
// `isNodeInitialized` stays false, `getEdgePosition` returns `nullPosition`,
// and edges (with their editable label inputs) never mount. Patch both to a
// non-zero default so nodes measure and edges render. The original getter is
// preserved and read first (symmetric with `getBoundingClientRect` below): if a
// future jsdom version gains a layout engine and reports a real dimension, that
// value wins; we only fall back to the synthetic default when jsdom reports 0.
// Tests assert via classes/attributes/text (vitest `css: false`), never
// geometry, so a fixed synthetic size is sufficient and does not affect
// non-React-Flow tests.
const _origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement): number {
    const orig = _origOffsetWidth?.get?.call(this) ?? 0;
    return orig || DEFAULT_NODE_SIZE.width;
  },
});
const _origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement): number {
    const orig = _origOffsetHeight?.get?.call(this) ?? 0;
    return orig || DEFAULT_NODE_SIZE.height;
  },
});

// jsdom's `getBoundingClientRect` returns all zeros (no layout engine). React
// Flow's `getHandleBounds` (run inside `updateNodeInternals`) reads the handle
// + node rects to derive each handle's offset within its node; with zeros the
// handle bounds are degenerate, `getEdgePosition` returns `nullPosition`, and
// `EdgeWrapper` short-circuits to `null` — so edges (and their editable label
// inputs) never mount. Prefer the original rect and fall back to a non-zero
// synthetic rect only when jsdom reports a degenerate (zero) one — symmetric
// with the `offsetWidth`/`offsetHeight` patch above. In jsdom every element
// reports the same zero rect, so every element falls back to the SAME
// synthetic rect; `SearchableCategorySelect` therefore still hits its cramped
// branch (identical rects ⇒ `spaceBelow`/`spaceAbove` ≤ 0). Tests assert via
// classes/attributes/text (vitest `css: false`), never geometry, so a fixed
// synthetic rect is sufficient.
const _origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (): DOMRect {
  const orig = _origGetBoundingClientRect.call(this) as DOMRect;
  if (orig.width > 0 && orig.height > 0) return orig;
  return {
    ...orig,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: DEFAULT_NODE_SIZE.width,
    bottom: DEFAULT_NODE_SIZE.height,
    width: DEFAULT_NODE_SIZE.width,
    height: DEFAULT_NODE_SIZE.height,
    toJSON(): unknown {
      return { x: 0, y: 0, top: 0, left: 0, right: DEFAULT_NODE_SIZE.width, bottom: DEFAULT_NODE_SIZE.height, width: DEFAULT_NODE_SIZE.width, height: DEFAULT_NODE_SIZE.height };
    },
  } as DOMRect;
};
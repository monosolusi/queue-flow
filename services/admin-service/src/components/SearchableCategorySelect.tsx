import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Hand-rolled multi-select combobox for assigning categories by **name**.
 *
 * Replaces the per-counter checkbox group in the wizard's Step 2 routing matrix
 * (FR-WZD-03). The checkbox group labeled categories by their raw code ("A",
 * "B", "C"), which does not scale once a store has many categories and forces
 * the manager to mentally map codes to the names they entered one step earlier.
 * This combobox filters by name, shows selected items as name-labeled chips, and
 * keeps the wire contract intact — `onChange` emits the selected **codes**
 * (`assignedCategoryCodes` is codes; the backend resolves codes→ids at save).
 *
 * No external dependency (NFR-REL-01 — offline, no CDN), mirroring the
 * minimal-dependency ethos of the audio-sequencer and RecapCharts SVG. The
 * dropdown is positioned absolutely inside the parent's positioning context
 * (the edit modal), so no portal is needed.
 *
 * Scroll-safe positioning (feedback): when the listbox opens inside a scroll
 * container (the edit modal has `overflow-y: auto`), an uncapped listbox would
 * extend the container's scrollable area and push the action buttons out of
 * view — the modal would scroll and cover Simpan/Batal. So the listbox is
 * capped to the available space within the nearest scrollable ancestor and
 * flips above the input when there is not enough room below, guaranteeing it
 * never adds to the container's scroll. A manual close toggle (▾/✕) lets the
 * manager dismiss the listbox explicitly ("bisa ditutup manual juga"), in
 * addition to Escape and outside-click.
 */
interface CategoryLike {
  readonly code: string;
  readonly name: string;
}

interface SearchableCategorySelectProps {
  /** The full category list to choose from. */
  categories: readonly CategoryLike[];
  /** Controlled selection (category codes). */
  selectedCodes: readonly string[];
  /** Emits the new selection (codes). */
  onChange: (codes: string[]) => void;
  /** Stable id prefix for the combobox + listbox (a11y wiring). */
  idPrefix?: string;
  /** Visible field label. */
  label?: string;
  /** Search input placeholder. */
  placeholder?: string;
}

/** Natural listbox height (~6 rows). Used as the preferred cap when space allows. */
const LISTBOX_NATURAL_PX = 192;
/** Minimum listbox height when the container is cramped (keeps ≥2 rows usable). */
const LISTBOX_MIN_PX = 80;
/** Padding margin between the listbox edge and the container edge (px). */
const EDGE_MARGIN_PX = 8;

/** Walk up from `el` to the nearest ancestor with a scrollable overflow-y axis. */
function nearestScrollContainer(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

export function SearchableCategorySelect({
  categories,
  selectedCodes,
  onChange,
  idPrefix,
  label = 'Kategori dilayani',
  placeholder = 'Cari kategori…',
}: SearchableCategorySelectProps) {
  const reactId = useId();
  const baseId = idPrefix ?? reactId;
  const listboxId = `${baseId}-listbox`;
  const inputId = `${baseId}-input`;
  const toggleId = `${baseId}-toggle`;

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  // Whether the listbox opens above (`'up'`) or below (`'down'`) the input, and
  // the pixel max-height that keeps it inside the scroll container. Recomputed
  // on every open via a layout effect that measures the input against its
  // nearest scrollable ancestor (the modal). Defaults keep jsdom (zero rects)
  // working: downward, natural height — option queries still find the listbox.
  const [placement, setPlacement] = useState<{ direction: 'up' | 'down'; maxHeight: number }>({
    direction: 'down',
    maxHeight: LISTBOX_NATURAL_PX,
  });

  const selectedSet = useMemo(() => new Set(selectedCodes), [selectedCodes]);
  const codeToName = useMemo(
    () => new Map(categories.map((c) => [c.code, c.name])),
    [categories],
  );
  const selected = useMemo(
    () => selectedCodes.map((code) => ({ code, name: codeToName.get(code) ?? code })),
    [selectedCodes, codeToName],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
  }, [categories, query]);

  // Keep the highlighted index inside the filtered list bounds.
  useEffect(() => {
    if (highlighted >= filtered.length) setHighlighted(Math.max(0, filtered.length - 1));
  }, [filtered.length, highlighted]);

  // Measure the available space inside the nearest scrollable ancestor each
  // time the listbox opens, and pick a direction + max-height that keeps the
  // listbox inside the container — so it never extends the container's
  // scrollable area (no modal scroll). Prefers downward; flips up only when
  // there isn't room below. Runs as a layout effect so the listbox is sized
  // before paint. In jsdom (no layout engine) every element reports the same
  // degenerate rect, so `spaceBelow`/`spaceAbove` are ≤ 0 and the cramped
  // branch keeps the downward default — the existing option-based assertions
  // still find the listbox.
  useLayoutEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (!input) return;
    const inputRect = input.getBoundingClientRect();
    const scrollEl = nearestScrollContainer(input);
    const boundsRect = scrollEl ? scrollEl.getBoundingClientRect() : { top: 0, bottom: 0 };
    const spaceBelow = boundsRect.bottom - inputRect.bottom - EDGE_MARGIN_PX;
    const spaceAbove = inputRect.top - boundsRect.top - EDGE_MARGIN_PX;
    if (spaceBelow >= LISTBOX_NATURAL_PX) {
      setPlacement({ direction: 'down', maxHeight: LISTBOX_NATURAL_PX });
    } else if (spaceAbove >= LISTBOX_NATURAL_PX) {
      setPlacement({ direction: 'up', maxHeight: LISTBOX_NATURAL_PX });
    } else {
      // Cramped container: pick the roomier side and cap to it (≥ min). Keeps
      // the listbox on-screen without scrolling, even if both sides are tight.
      const direction = spaceAbove > spaceBelow ? 'up' : 'down';
      const room = Math.max(spaceBelow, spaceAbove);
      setPlacement({ direction, maxHeight: Math.max(LISTBOX_MIN_PX, room) });
    }
  }, [open]);

  // Close on outside pointer down (jsdom-safe: mousedown fires in jsdom).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function toggle(code: string) {
    const next = new Set(selectedCodes);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange([...next]);
  }

  function toggleOpen() {
    setOpen((o) => !o);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      if (open && filtered[highlighted]) {
        e.preventDefault();
        toggle(filtered[highlighted].code);
      }
      return;
    }
  }

  return (
    <div className="category-select" ref={containerRef}>
      <span className="field__label" id={`${baseId}-label`}>
        {label}
      </span>

      {selected.length > 0 ? (
        <ul className="category-select__chips" aria-label="Kategori terpilih">
          {selected.map((c) => (
            <li key={c.code} className="category-select__chip">
              {c.name}
              <button
                type="button"
                className="category-select__chip-remove"
                aria-label={`Hapus ${c.name}`}
                onClick={() => toggle(c.code)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="category-select__empty-inline">Belum ada kategori dipilih</p>
      )}

      <div className="category-select__input">
        <input
          id={inputId}
          ref={inputRef}
          className="field__input category-select__field"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-labelledby={`${baseId}-label`}
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlighted(0);
          }}
          onKeyDown={onKeyDown}
        />
        {/* Manual open/close toggle (feedback: "bisa ditutup manual juga"). A
            dedicated button gives an explicit dismiss affordance beyond Escape
            and outside-click, and its `aria-expanded` mirrors the combobox so
            AT users have a second control to collapse the listbox. `tabindex={-1}`
            keeps it from adding a second tab stop next to the combobox itself. */}
        <button
          type="button"
          id={toggleId}
          className="category-select__toggle"
          aria-label={open ? 'Tutup daftar kategori' : 'Buka daftar kategori'}
          aria-expanded={open}
          aria-controls={listboxId}
          tabIndex={-1}
          onClick={(e) => {
            e.preventDefault();
            toggleOpen();
            if (!open) inputRef.current?.focus();
          }}
        >
          {open ? '✕' : '▾'}
        </button>
        {open && filtered.length > 0 && (
          <ul
            id={listboxId}
            role="listbox"
            className={`category-select__listbox${
              placement.direction === 'up' ? ' category-select__listbox--up' : ''
            }`}
            style={{ maxHeight: `${placement.maxHeight}px` }}
          >
            {filtered.map((c, i) => {
              const isSel = selectedSet.has(c.code);
              const isHi = i === highlighted;
              return (
                <li
                  key={c.code}
                  role="option"
                  aria-selected={isSel}
                  data-code={c.code}
                  className={`category-select__option${isHi ? ' category-select__option--highlighted' : ''}`}
                  onMouseDown={(e) => {
                    // mousedown (not click) so the input does not blur before the toggle.
                    e.preventDefault();
                    toggle(c.code);
                  }}
                  onMouseEnter={() => setHighlighted(i)}
                >
                  <span>{c.name}</span>
                  {isSel && (
                    <span className="category-select__option-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
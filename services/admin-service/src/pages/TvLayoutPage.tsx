import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IAdminApi } from '../api/admin-api';
import { useSystemConfigContext } from '../config/system-config-context';
import {
  GRID_COLS,
  GRID_MAX_ROWS,
  GRID_MIN_H,
  GRID_MIN_W,
  TV_COMPONENT_TYPES,
  type TvComponentType,
  type TvGridLayout,
  type TvWidget,
} from '../api/types';
import {
  TV_COMPONENT_LABELS,
  addWidget,
  coerceTvGridLayout,
  defaultTvGridLayout,
  isValidTvGridLayout,
  moveWidget,
  removeWidget,
  resizeWidget,
} from '../lib/tv-grid-layout';
import { useGridDnd } from '../lib/use-grid-dnd';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../toast/useToast';
import { toForm } from './admin-config/form';
import { toEdgeRoutingLayoutDto, toNodeActionsDto, toNodePositionsDto, toStateMachineDto } from '../lib/state-machine';

/**
 * The TV-display grid layout page — a two-mode WYSIWYG flow.
 *
 * **Preview mode (default):** a read-only miniature "TV" rendering the layout
 * at a small scale so the manager sees how the result looks BEFORE editing —
 * each widget renders a representative visual of its component (a fake
 * now-serving number, a waiting list, counter chips, a marquee strip), placed
 * at its real grid rect. A single "Edit Tampilan" button opens the editor.
 *
 * **Edit mode:** a full-viewport fixed-overlay WYSIWYG editor (`role="dialog"
 * aria-modal="true"`) — the palette + a large 12-column canvas that fills the
 * viewport (no 70vh cap), so it finally reads as a WYSIWYG editor instead of a
 * cramped embedded panel. "Selesai" (or Escape) returns to the preview; a
 * successful save also returns to the preview so the manager sees the saved
 * result. The overlay sits at `z-index: 40` — above the app shell (topbar
 * `z-index: 10`, sticky sidebar) but below the toast viewport (`z-index: 60`),
 * so a save toast stays readable above it (same layering rationale as the
 * routing modal at `z-index: 50`).
 *
 * The page is a thin editor over the existing config save surface: it reads
 * the full config (`GET /api/system/config` via the shared
 * `SystemConfigProvider`), lets the manager edit ONLY `tvPanelLayout`, and
 * PUTs the full payload back (`PUT /api/system/config`) — passthrough of every
 * other field (storeName, stateMachine, dailyReset, categories, routingRules,
 * brandColor, serviceThemes) unchanged, mirroring the AdminPanel full-save
 * pattern (DRY — one atomic, audited save use case). On success it toasts
 * "Tampilan TV disimpan" and calls the shared `refresh()` so every consumer
 * sees the new layout.
 *
 * SRP split: {@link TvLayoutPreview} + {@link TvPreviewWidget} are
 * presentational (fed by `layout`); {@link TvLayoutEditOverlay} is the
 * presentational dialog chrome around the reusable {@link TvLayoutEditor}
 * (palette + canvas, fed by `layout` + `onChange`); this page owns the config
 * read, the local draft, the mode, and the save. The pure `lib/tv-grid-layout`
 * helpers own validation/move/resize/add/remove (the tested core); the
 * in-canvas pointer DnD hook (`useGridDnd`) is the browser-only UI layer;
 * palette add is click-to-add (a11y + jsdom-tested).
 *
 * `runningText` is no longer special-cased — it is a first-class widget placed
 * on the grid like the other four (the TV renders it wherever its rect lands,
 * not always pinned as a footer).
 */
export function TvLayoutPage({ api }: { api: IAdminApi }) {
  const toast = useToast();
  const { config, refresh } = useSystemConfigContext();
  const [layout, setLayout] = useState<TvGridLayout | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // Preview-first WYSIWYG flow: the manager sees the small result, then opens
  // the full-page editor. The draft persists across the two modes (it is the
  // same `layout` state), so a "Selesai" that returns to the preview still
  // shows the in-progress edits — the preview is a live preview of the draft.
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  // A11y (WCAG 2.4.3): capture the "Edit Tampilan" trigger at click time so the
  // overlay can restore focus to it on close. By mount time `document.activeElement`
  // has already moved into the dialog, so the trigger must be captured in the
  // click handler — mirrors the established `UserCreateModal` `returnFocusTo`
  // pattern (see `UsersPage`).
  const [editTrigger, setEditTrigger] = useState<HTMLElement | null>(null);
  // Stable close handler so the overlay's Escape `useEffect` does not re-subscribe
  // on every parent render (the listener is idempotent, but a fresh inline `onClose`
  // each render would churn the deps needlessly).
  const closeEditor = useCallback(() => setMode('preview'), []);

  // Initialize the local draft from the resolved config (coerced — a corrupt
  // GET projection never breaks the editor). `config` is `null` until the
  // shared probe resolves; the page renders a loading state until then. The
  // draft is re-initialized when the config identity changes (a refresh after a
  // save resolves a new object), so the editor reflects the persisted state.
  useEffect(() => {
    if (config === null) return;
    setLayout(coerceTvGridLayout(config.tvPanelLayout));
  }, [config]);

  // The full editable form is rebuilt from the config so the passthrough fields
  // (categories with ids, routing codes, state-machine strip) map exactly as
  // AdminPanel does — no duplicated mapping logic. Memoized on the config
  // identity so it re-derives only when the resolved config changes.
  const form = useMemo(() => (config !== null ? toForm(config) : null), [config]);

  const valid = layout !== null && isValidTvGridLayout(layout);

  async function save() {
    // Synchronous in-flight guard — `disabled` only takes effect after a
    // re-render, so two clicks in the same tick both pass a state guard.
    if (savingRef.current) return;
    if (layout === null || !valid || form === null) return;
    savingRef.current = true;
    setSaving(true);
    try {
      try {
        await api.saveSystemConfig({
          storeName: form.storeName,
          // Strip the client-only `mode` preset — never on the wire — via the
          // same shared mapper AdminPanel uses. Sides travel in the separate
          // sparse `edgeRoutingLayout` map and node positions in `nodePositions`
          // (this page edits neither, so both are whatever `toForm` merged from
          // the GET — passthrough).
          stateMachine: toStateMachineDto(form.stateMachine),
          edgeRoutingLayout: toEdgeRoutingLayoutDto(form.stateMachine),
          nodePositions: toNodePositionsDto(form.stateMachine),
          // Node actions — payload-only passthrough (this page edits neither
          // node actions nor the graph); mirrors `nodePositions`.
          nodeActions: toNodeActionsDto(form.stateMachine),
          brandColor: form.brandColor,
          serviceThemes: form.serviceThemes,
          // The one field this page edits.
          tvPanelLayout: layout,
          // Payload-only passthrough — the printer editor lives on the dedicated
          // `/printer-config` page; the full PUT must still carry the field so
          // the required `printerConfiguration` wire field is never dropped
          // (mirrors the other passthrough fields this page does not edit).
          printerConfiguration: form.printerConfiguration,
          dailyReset: {
            mode: form.dailyReset.mode,
            cronExpression:
              form.dailyReset.mode === 'AUTOMATIC_CRON' ? form.dailyReset.cronExpression : null,
            resetTicketNumberTo: form.dailyReset.resetTicketNumberTo,
            archivePreviousDayData: form.dailyReset.archivePreviousDayData,
            timezone: form.dailyReset.timezone,
          },
          // Preserve `id` on existing categories; omit it for rows the manager
          // added (the backend mints fresh ids). Mirrors AdminPanel.
          categories: form.categories.map((c) =>
            c.id ? { id: c.id, code: c.code, name: c.name } : { code: c.code, name: c.name },
          ),
          // Strip the client-only `rowKey` (a React key) at the boundary.
          routingRules: form.routingRules.map(({ rowKey, ...rest }) => rest),
        });
      } catch (err) {
        toast.error(`Gagal menyimpan: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      toast.success('Tampilan TV disimpan.');
      // Re-read the shared snapshot so every consumer (the TV service on its
      // next boot, the app chrome) sees the new layout.
      await refresh();
      // A successful save returns to the preview so the manager sees the
      // persisted result. A failed save stays in the editor so they can retry.
      setMode('preview');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function resetToDefault() {
    setLayout(defaultTvGridLayout());
  }

  if (layout === null) {
    return (
      <div className="page tv-layout-page tv-layout-page--loading">
        <p className="tv-layout-page__loading">Memuat konfigurasi TV…</p>
      </div>
    );
  }

  // The preview + header stay mounted while editing (the overlay floats above
  // them as a sibling). They are `aria-hidden` while the modal is open so AT
  // does not reach the background content behind the dialog — the overlay is
  // rendered as a sibling OUTSIDE the `aria-hidden` subtree, so the dialog
  // itself stays in the a11y tree.
  return (
    <>
      <div className="page tv-layout-page" aria-hidden={mode === 'edit' ? true : undefined}>
        <PageHeader
          title="Tampilan TV"
          subtitle="Susun komponen TV Display pada kisi 12 kolom. Perubahan diterapkan saat TV Display dimuat ulang."
          actions={
            <button
              type="button"
              className="btn btn--primary"
              onClick={(e) => {
                setEditTrigger(e.currentTarget as HTMLElement);
                setMode('edit');
              }}
              data-testid="tv-layout-edit"
            >
              Edit Tampilan
            </button>
          }
        />
        <TvLayoutPreview layout={layout} />
      </div>
      {mode === 'edit' && (
        <TvLayoutEditOverlay
          layout={layout}
          onChange={setLayout}
          saving={saving}
          valid={valid}
          onSave={save}
          onReset={resetToDefault}
          onClose={closeEditor}
          returnFocusTo={editTrigger}
        />
      )}
    </>
  );
}

// --- preview (read-only miniature TV) ---

interface TvLayoutPreviewProps {
  layout: TvGridLayout;
}

/** The preview's fixed CSS row height in px (a scaled-down miniature). */
const PREVIEW_ROW_PX = 30;

/**
 * The read-only miniature "TV" — a small-scale rendering of the layout so the
 * manager sees how the result looks before pressing "Edit Tampilan". Each
 * widget is placed at its real grid rect and shows a representative visual of
 * its component (fake data — a now-serving number, a waiting list, counter
 * chips, a marquee strip). The grid is `aria-hidden` because the miniature is
 * a decorative visual; the page heading + hint carry the a11y meaning.
 *
 * Presentational (SRP): fed by `layout`, no callbacks, no config context.
 */
function TvLayoutPreview({ layout }: TvLayoutPreviewProps) {
  return (
    <section className="tv-layout-preview" aria-labelledby="tv-layout-preview-title">
      <div className="tv-layout-preview__caption">
        <h2 id="tv-layout-preview-title" className="tv-layout-preview__title">
          Pratinjau Tampilan TV
        </h2>
        <p className="tv-layout-preview__hint">
          Ini tampilan TV Display dengan tata letak saat ini. Tekan &quot;Edit Tampilan&quot; untuk membuka editor halaman penuh.
        </p>
      </div>
      <div className="tv-preview" data-testid="tv-preview">
        <div className="tv-preview__bezel" data-testid="tv-preview__bezel">
          <div className="tv-preview__screen">
            <div
              className="tv-preview__grid"
              style={{
                gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
                gridAutoRows: `${PREVIEW_ROW_PX}px`,
              }}
              aria-hidden="true"
            >
              {layout.map((widget) => (
                <div
                  key={widget.id}
                  className="tv-preview__widget"
                  style={{
                    gridColumn: `${widget.x + 1} / span ${widget.w}`,
                    gridRow: `${widget.y + 1} / span ${widget.h}`,
                  }}
                  data-testid={`tv-preview__widget--${widget.id}`}
                >
                  <TvPreviewWidget component={widget.component} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A representative miniature visual for one TV component. The content is
 * illustrative fake data (a placeholder number/list/chips/marquee) — it is NOT
 * wired to live queue state. The preview answers "what will the TV look
 * like?", not "what is being served right now?" (that is the TV board itself).
 * The parent grid is `aria-hidden`, so this content is not exposed to AT.
 */
function TvPreviewWidget({ component }: { component: TvComponentType }) {
  switch (component) {
    case 'nowServing':
      return (
        <div className="tv-preview__now">
          <span className="tv-preview__eyebrow">PERGI KE COUNTER</span>
          <span className="tv-preview__num">A-001</span>
          <span className="tv-preview__counter">Counter 1</span>
        </div>
      );
    case 'waitingQueue':
      return (
        <ul className="tv-preview__list">
          <li>A-002</li>
          <li>A-003</li>
          <li>A-004</li>
        </ul>
      );
    case 'callHistory':
      return (
        <ul className="tv-preview__list tv-preview__list--muted">
          <li>A-001 · Counter 1</li>
          <li>B-001 · Counter 2</li>
        </ul>
      );
    case 'countersServing':
      return (
        <div className="tv-preview__counters">
          <span>1: A-001</span>
          <span>2: —</span>
          <span>3: B-002</span>
        </div>
      );
    case 'runningText':
      return (
        <div className="tv-preview__marquee">
          Nomor antrian tidak selalu berurutan — harap perhatikan panggilan nomor Anda.
        </div>
      );
  }
}

// --- full-page edit overlay (WYSIWYG editor chrome) ---

interface TvLayoutEditOverlayProps {
  layout: TvGridLayout;
  onChange: (next: TvGridLayout) => void;
  saving: boolean;
  valid: boolean;
  onSave: () => void;
  onReset: () => void;
  onClose: () => void;
  /** The element to return focus to when the dialog closes (WCAG 2.4.3) —
   *  captured at trigger-click time by the parent page. */
  returnFocusTo: HTMLElement | null;
}

/**
 * The full-viewport editor dialog — a fixed overlay (`position: fixed; inset:
 * 0`) that escapes the app shell for a true full-page WYSIWYG experience. It
 * is a modal dialog (`role="dialog" aria-modal="true"`): Escape or "Selesai"
 * returns to the preview. The header carries the save/reset/close actions; the
 * body is the reusable presentational {@link TvLayoutEditor} (palette + large
 * canvas).
 *
 * **Focus management (WCAG 2.4.3)** follows the established `UserCreateModal`
 * shape: on open, focus moves into the dialog (the container is `tabindex={-1}`
 * so it can receive focus; Tab then reaches the first control); on close,
 * focus restores to the "Edit Tampilan" trigger captured by the parent.
 * Presentational (SRP) — fed by `layout` + callbacks; owns no state except the
 * focus + Escape listeners.
 */
function TvLayoutEditOverlay({
  layout,
  onChange,
  saving,
  valid,
  onSave,
  onReset,
  onClose,
  returnFocusTo,
}: TvLayoutEditOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // A11y (WCAG 2.4.3): move focus into the dialog on open. The dialog container
  // is `tabindex={-1}` so it can receive focus; Tab then moves to the first
  // control (the "Kembalikan ke Default" button). Mirrors `UserCreateModal`'s
  // `autoFocus` pattern (the editor has no primary input to focus, so the
  // dialog container itself is the focus target).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // A11y (WCAG 2.4.3): restore focus to the "Edit Tampilan" trigger when the
  // dialog unmounts (Selesai / Escape / a successful save). `returnFocusTo` was
  // captured at click time before focus moved into the dialog.
  useEffect(() => {
    return () => {
      returnFocusTo?.focus?.();
    };
  }, [returnFocusTo]);

  // Escape closes the dialog (guarded while saving so a mid-save Escape does
  // not yank the manager out before the toast lands). The draft persists in
  // the page's `layout` state, so close is non-destructive — "Selesai" is a
  // view switch, not a discard. `onClose` is stable (parent `useCallback`).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  return (
    <div
      className="tv-layout-editor-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Sunting Tampilan TV"
      tabIndex={-1}
      ref={dialogRef}
      data-testid="tv-layout-editor-overlay"
    >
      <header className="tv-layout-editor-overlay__header">
        <div className="tv-layout-editor-overlay__heading">
          <h2 className="tv-layout-editor-overlay__title">Sunting Tampilan TV</h2>
          <p className="tv-layout-editor-overlay__subtitle">
            Klik komponen di panel kiri untuk menambah. Seret kartu untuk memindahkan, seret gagang sudut untuk mengubah ukuran.
          </p>
        </div>
        <div className="tv-layout-editor-overlay__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onReset}
            data-testid="tv-layout-reset"
          >
            Kembalikan ke Default
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onSave}
            disabled={saving || !valid}
            data-testid="tv-layout-save"
          >
            {saving ? 'Menyimpan…' : 'Simpan'}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={saving}
            data-testid="tv-layout-close"
          >
            Selesai
          </button>
        </div>
      </header>
      <div className="tv-layout-editor-overlay__body">
        <TvLayoutEditor layout={layout} onChange={onChange} />
      </div>
    </div>
  );
}

// --- presentational editor ---

interface TvLayoutEditorProps {
  layout: TvGridLayout;
  onChange: (next: TvGridLayout) => void;
}

/** The editor's fixed CSS row height in px (matches `grid-auto-rows` in CSS). */
const ROW_HEIGHT_PX = 56;

/**
 * The presentational editor: a palette of click-to-add component chips + a
 * 12-column grid canvas of placed widgets. Fed by `layout` + `onChange` — no
 * config context, no save (SRP). The in-canvas pointer DnD (move card + drag
 * the corner grip to resize) is the fast path; the per-widget steppers are
 * the precise + a11y path. Adding a component is click-to-add (the chip's
 * `onClick` calls `addWidget(layout, component)` → free-spot placement).
 */
function TvLayoutEditor({ layout, onChange }: TvLayoutEditorProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const dnd = useGridDnd({
    canvasRef,
    rowHeight: ROW_HEIGHT_PX,
    layout,
    onMove: (id, x, y) => onChange(moveWidget(layout, id, x, y)),
    onResize: (id, w, h) => onChange(resizeWidget(layout, id, w, h)),
  });

  // A tiny local toast channel for the palette's "no room" message — the page-
  // level toast is owned by `TvLayoutPage` (SRP); the editor reports a no-room
  // add via a callback prop instead. For now the editor holds a ref to a
  // micro-queue that the next render flushes through a status region.
  const toastQueue = useEditorStatus();

  function handleChipClick(component: TvComponentType) {
    const result = addWidget(layout, component);
    if (result === null) {
      // No free spot — surface via the canvas status region.
      toastQueue.push('Tidak ada ruang kosong untuk komponen baru.');
      return;
    }
    onChange(result.layout);
  }

  return (
    <div className="tv-layout-editor">
      <div className="tv-layout__page">
        <div className="tv-layout__palette" role="group" aria-label="Komponen TV" data-testid="tv-layout__palette">
          <p className="tv-layout__caption tv-layout__palette-caption">Komponen</p>
          {TV_COMPONENT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="tv-layout__chip"
              onClick={() => handleChipClick(type)}
              aria-label={`Tambah ${TV_COMPONENT_LABELS[type]}`}
              data-testid={`tv-layout__chip--${type}`}
            >
              <span className="tv-layout__chip-label">{TV_COMPONENT_LABELS[type]}</span>
              <span className="tv-layout__chip-plus" aria-hidden="true">+</span>
            </button>
          ))}
        </div>

        <div className="tv-layout__tv-area">
          <p className="tv-layout__caption">Layar TV</p>
          <div className="tv-layout__tv-bezel" data-testid="tv-layout__tv-bezel">
            <div className="tv-layout__tv-screen">
              <div
                className="tv-layout__canvas"
                ref={canvasRef}
                onPointerMove={dnd.onPointerMove}
                onPointerUp={dnd.onPointerUp}
                onPointerCancel={dnd.onPointerUp}
                data-testid="tv-layout__canvas"
              >
                <div
                  className="tv-layout__grid"
                  style={{
                    gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
                    gridAutoRows: `${ROW_HEIGHT_PX}px`,
                  }}
                  aria-label="Kisi tata letak TV"
                >
                  {layout.map((widget) => {
                    const isDragging = dnd.activeId === widget.id;
                    const preview = dnd.preview?.id === widget.id ? dnd.preview : null;
                    const invalid = preview !== null && !preview.valid;
                    // When dragging, render the widget at its preview rect so the
                    // manager sees the live move; otherwise at its committed rect.
                    const x = preview?.x ?? widget.x;
                    const y = preview?.y ?? widget.y;
                    const w = preview?.w ?? widget.w;
                    const h = preview?.h ?? widget.h;
                    return (
                      <div
                        key={widget.id}
                        className={
                          `tv-layout__widget` +
                          (isDragging ? ' tv-layout__widget--dragging' : '') +
                          (invalid ? ' tv-layout__widget--invalid' : '')
                        }
                        style={{
                          gridColumn: `${x + 1} / span ${w}`,
                          gridRow: `${y + 1} / span ${h}`,
                        }}
                        onPointerDown={(e) => dnd.onWidgetPointerDown(e, widget)}
                        data-testid={`tv-layout__widget--${widget.id}`}
                      >
                        <div className="tv-layout__widget-header">
                          <span className="tv-layout__widget-name">{TV_COMPONENT_LABELS[widget.component]}</span>
                          <button
                            type="button"
                            className="tv-layout__widget-remove"
                            aria-label="Hapus Komponen"
                            onClick={(e) => {
                              e.stopPropagation();
                              onChange(removeWidget(layout, widget.id));
                            }}
                            // Stop pointerdown from bubbling to the widget card's drag
                            // handler. Without this, pressing × in a real browser begins
                            // a drag + setPointerCapture on the card, which redirects
                            // the pointerup to the card so the click never reaches the
                            // button — delete appears broken (manager feedback: "tidak
                            // dapat dihapus"). jsdom cannot reproduce pointer-capture
                            // (RTL's fireEvent.pointerDown strips isPrimary/button and
                            // the global PointerEvent ctor is absent in this env), so
                            // this is a real-browser-only fix verified by reasoning + the
                            // existing resize-handle stopPropagation precedent — same
                            // class as that jsdom-untested stopPropagation.
                            onPointerDown={(e) => e.stopPropagation()}
                            data-testid={`tv-layout__remove--${widget.id}`}
                          >
                            ×
                          </button>
                        </div>
                        <div className="tv-layout__widget-body" aria-hidden="true">
                          {TV_COMPONENT_LABELS[widget.component]}
                        </div>
                        <WidgetSteppers
                          widget={widget}
                          layout={layout}
                          onChange={onChange}
                        />
                        <div
                          className="tv-layout__resize-handle"
                          role="slider"
                          aria-label="Ubah Ukuran"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            dnd.onResizeHandlePointerDown(e, widget);
                          }}
                          data-testid={`tv-layout__resize--${widget.id}`}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <p className="tv-layout__canvas-hint">
            Klik komponen di panel kiri untuk menambah. Seret kartu untuk memindahkan, seret gagang sudut untuk mengubah ukuran.
          </p>
          <p className="tv-layout__status" role="status" aria-live="polite">
            {toastQueue.message}
          </p>
        </div>
      </div>
    </div>
  );
}

// --- per-widget steppers (a11y / jsdom-tested backbone) ---

interface WidgetSteppersProps {
  widget: TvWidget;
  layout: TvGridLayout;
  onChange: (next: TvGridLayout) => void;
}

function WidgetSteppers({ widget, layout, onChange }: WidgetSteppersProps) {
  return (
    <div
      className="tv-layout__steppers"
      role="group"
      aria-label={`Ukuran ${TV_COMPONENT_LABELS[widget.component]}`}
      // Stop pointerdown from bubbling to the widget card's drag handler so the
      // +/- buttons + number input are clickable in a real browser. Without this,
      // pressing a stepper control begins a drag + setPointerCapture on the card,
      // which redirects the pointerup to the card so the click never reaches the
      // stepper — the +/- appear "tidak berguna" (manager feedback). Position is
      // set by dragging the card; only the size (Lebar/Tinggi) steppers remain —
      // the Kolom/Baris position steppers were removed per the manager's "jangan
      // tampilkan, tampilkan hanya yang digunakan" (unclear + redundant with
      // drag). jsdom cannot reproduce pointer-capture (see the remove-button
      // comment above), so this is a real-browser-only fix verified by reasoning
      // + the resize-handle stopPropagation precedent — same class.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Stepper
        label="Lebar"
        value={widget.w}
        min={GRID_MIN_W}
        max={GRID_COLS - widget.x}
        testId={`tv-layout__stepper-w--${widget.id}`}
        onChange={(nw) => onChange(resizeWidget(layout, widget.id, nw, widget.h))}
      />
      <Stepper
        label="Tinggi"
        value={widget.h}
        min={GRID_MIN_H}
        max={GRID_MAX_ROWS - widget.y}
        testId={`tv-layout__stepper-h--${widget.id}`}
        onChange={(nh) => onChange(resizeWidget(layout, widget.id, widget.w, nh))}
      />
    </div>
  );
}

interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  testId: string;
  onChange: (next: number) => void;
}

function Stepper({ label, value, min, max, testId, onChange }: StepperProps) {
  const atMin = value <= min;
  const atMax = value >= max;
  return (
    <div className="tv-layout__stepper" data-testid={testId}>
      <span className="tv-layout__stepper-label">{label}</span>
      <div className="tv-layout__stepper-controls">
        <button
          type="button"
          className="tv-layout__stepper-btn"
          aria-label={`${label} kurang`}
          disabled={atMin}
          onClick={() => onChange(clampInt(value - 1, min, max))}
        >−</button>
        <input
          type="number"
          className="tv-layout__stepper-input"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const raw = e.target.value === '' ? value : Number(e.target.value);
            if (!Number.isFinite(raw)) return;
            onChange(clampInt(Math.trunc(raw), min, max));
          }}
          aria-label={label}
        />
        <button
          type="button"
          className="tv-layout__stepper-btn"
          aria-label={`${label} tambah`}
          disabled={atMax}
          onClick={() => onChange(clampInt(value + 1, min, max))}
        >+</button>
      </div>
    </div>
  );
}

// --- editor-local status channel (no-room add message) ---

/**
 * A tiny status channel for the editor to surface a "no room" palette-add
 * message through the canvas `role="status"` region. Kept local to the editor
 * (SRP) — the page-level success/error toast is owned by `TvLayoutPage`. The
 * `push` method writes into a ref + schedules a state flush so a same-tick
 * second push overwrites the first (last-write-wins, no queue drift).
 */
function useEditorStatus(): { message: string; push: (msg: string) => void } {
  const [message, setMessage] = useState('');
  const pendingRef = useRef<string | null>(null);
  function push(msg: string) {
    pendingRef.current = msg;
    // Schedule a microtask flush so multiple synchronous pushes collapse to
    // the last (a no-room add followed by a successful add would otherwise
    // leave a stale "no room" message).
    Promise.resolve().then(() => {
      if (pendingRef.current !== null) {
        setMessage(pendingRef.current);
        pendingRef.current = null;
      }
    });
  }
  return { message, push };
}

function clampInt(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return Math.trunc(n);
}
import { useEffect, useMemo, useRef, useState } from 'react';
import type { IAdminApi } from '../api/admin-api';
import { useSystemConfigContext } from '../config/system-config-context';
import {
  type TvPanelKey,
  type TvPanelLayoutMap,
  DEFAULT_TV_PANEL_LAYOUT,
} from '../api/types';
import {
  CONTENT_PANEL_KEYS,
  TV_PANEL_SIZE_LABELS,
  coerceTvPanelLayout,
  isValidTvPanelLayout,
  reorderPanels,
  setPanelSize,
  setPanelVisible,
} from '../lib/tv-panel-layout';
import { TV_PANEL_LABELS } from '../lib/labels';
import { useDragReorder } from '../lib/use-drag-reorder';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../toast/useToast';
import { toForm } from './admin-config/form';
import { toStateMachineDto } from '../lib/state-machine';

/**
 * The TV-display panel layout editor (FR — user feedback: "/admin/config pada
 * bagian tampilan tv hanya berupa checkbox tidak bisa drag and drop dan set
 * ukuran"). A dedicated `/tv-layout` page with drag-and-drop reorder + a
 * per-panel segmented size control (Kecil/Sedang/Besar/Penuh → 1..4) + a
 * visibility toggle, replacing the old checkbox section that lived in
 * `/admin/config`.
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
 * SRP split: {@link TvLayoutEditor} is presentational (fed by `layout` +
 * `onChange`); this page owns the config read, the local draft, and the save.
 * The pure `lib/tv-panel-layout` helpers own validation/reorder/size (the
 * tested core); the {@link useDragReorder} hook is the pointer-event UI layer.
 *
 * `runningText` is a fixed marquee footer — its `order`/`size` are stored for
 * map uniformity but ignored by the TV, so the editor exposes only a
 * visibility toggle for it (no drag handle, no size control). The 4 content
 * panels (`nowServing`/`waitingQueue`/`callHistory`/`countersServing`) are the
 * draggable + resizable set.
 */
export function TvLayoutPage({ api }: { api: IAdminApi }) {
  const toast = useToast();
  const { config, refresh } = useSystemConfigContext();
  const [panelLayout, setPanelLayout] = useState<TvPanelLayoutMap | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // Initialize the local draft from the resolved config (coerced — a corrupt
  // GET projection never breaks the editor). `config` is `null` until the
  // shared probe resolves; the page renders a loading state until then. The
  // draft is re-initialized when the config identity changes (a refresh after a
  // save resolves a new object), so the editor reflects the persisted state.
  useEffect(() => {
    if (config === null) return;
    setPanelLayout(coerceTvPanelLayout(config.tvPanelLayout ?? DEFAULT_TV_PANEL_LAYOUT));
  }, [config]);

  // The full editable form is rebuilt from the config so the passthrough fields
  // (categories with ids, routing codes, state-machine strip) map exactly as
  // AdminPanel does — no duplicated mapping logic. Memoized on the config
  // identity so it re-derives only when the resolved config changes (not on
  // every re-render of an unrelated state like `saving`), and never written
  // during render (the ref-during-render anti-pattern).
  const form = useMemo(() => (config !== null ? toForm(config) : null), [config]);

  const valid = panelLayout !== null && isValidTvPanelLayout(panelLayout);

  async function save() {
    // Synchronous in-flight guard — `disabled` only takes effect after a
    // re-render, so two clicks in the same tick both pass a state guard.
    if (savingRef.current) return;
    if (panelLayout === null || !valid || form === null) return;
    savingRef.current = true;
    setSaving(true);
    try {
      try {
        await api.saveSystemConfig({
          storeName: form.storeName,
          // Strip the client-only `mode` preset — never on the wire — via the
          // same shared mapper AdminPanel uses.
          stateMachine: toStateMachineDto(form.stateMachine),
          brandColor: form.brandColor,
          serviceThemes: form.serviceThemes,
          // The one field this page edits.
          tvPanelLayout: panelLayout,
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
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (panelLayout === null) {
    return (
      <div className="page tv-layout-page tv-layout-page--loading">
        <p className="tv-layout-page__loading">Memuat konfigurasi TV…</p>
      </div>
    );
  }

  return (
    <div className="page tv-layout-page">
      <PageHeader
        title="Tampilan TV"
        subtitle="Atur urutan dan ukuran panel yang tampil di TV Display. Perubahan diterapkan saat TV Display dimuat ulang."
      />
      <TvLayoutEditor layout={panelLayout} onChange={setPanelLayout} />
      <div className="tv-layout-page__save">
        <button
          type="button"
          className="btn btn--primary"
          onClick={save}
          disabled={saving || !valid}
          data-testid="tv-layout-save"
        >
          {saving ? 'Menyimpan…' : 'Simpan'}
        </button>
      </div>
    </div>
  );
}

// --- presentational editor ---

interface TvLayoutEditorProps {
  layout: TvPanelLayoutMap;
  onChange: (next: TvPanelLayoutMap) => void;
}

/**
 * The presentational editor: a vertical list of the 4 content panels in
 * `order`, each with a drag handle, name, size segmented control, visibility
 * checkbox, and up/down buttons; a `runningText` footer row with visibility
 * only; and a live preview mirroring the configured order + sizes. Fed by
 * `layout` + `onChange` — no state, no context (SRP).
 */
function TvLayoutEditor({ layout, onChange }: TvLayoutEditorProps) {
  const contentRows = useMemo(
    () =>
      [...CONTENT_PANEL_KEYS].sort((a, b) => layout[a].order - layout[b].order),
    [layout],
  );

  const drag = useDragReorder((from, to) => {
    onChange(reorderPanels(layout, from, to));
  });

  // Row element refs for the pointer-move hit-test. Indexed by render position.
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  function moveBy(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= contentRows.length) return;
    onChange(reorderPanels(layout, index, to));
  }

  function handleRowPointerMove(e: React.PointerEvent) {
    if (drag.draggingIndex === null) return;
    const els = rowRefs.current.filter((el): el is HTMLLIElement => el !== null);
    drag.onRowPointerMove(e, els);
  }

  return (
    <div className="tv-layout-editor">
      <ul
        className="tv-layout-list"
        onPointerMove={handleRowPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerUp}
      >
        {contentRows.map((key, index) => {
          const cfg = layout[key];
          const isDragging = drag.draggingIndex === index;
          const showDropBefore = drag.dropIndex === index && drag.draggingIndex !== null && drag.draggingIndex !== index;
          const isLast = index === contentRows.length - 1;
          const showDropAfter =
            isLast && drag.dropIndex === contentRows.length && drag.draggingIndex !== null;
          return (
            <li
              key={key}
              ref={(el) => {
                rowRefs.current[index] = el;
              }}
              className={`tv-layout-row${isDragging ? ' tv-layout-row--dragging' : ''}`}
              data-testid={`tv-layout-row-${key}`}
            >
              {showDropBefore && <div className="tv-layout__drop-indicator" aria-hidden="true" />}
              <div className="tv-layout-row__main">
                <button
                  type="button"
                  className="tv-layout-row__handle"
                  aria-label={`Seret ${TV_PANEL_LABELS[key]} untuk mengatur urutan`}
                  aria-grabbed={isDragging}
                  onPointerDown={(e) => drag.onHandlePointerDown(e, index)}
                  data-testid={`tv-layout-handle-${key}`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    focusable="false"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx={9} cy={6} r={1} />
                    <circle cx={15} cy={6} r={1} />
                    <circle cx={9} cy={12} r={1} />
                    <circle cx={15} cy={12} r={1} />
                    <circle cx={9} cy={18} r={1} />
                    <circle cx={15} cy={18} r={1} />
                  </svg>
                </button>
                <span className="tv-layout-row__name">{TV_PANEL_LABELS[key]}</span>
                <SizeSegmentedControl
                  panelKey={key}
                  size={cfg.size}
                  onChange={(next) => onChange(setPanelSize(layout, key, next))}
                />
                <label className="tv-layout-row__vis">
                  <input
                    type="checkbox"
                    checked={cfg.visible}
                    onChange={(e) => onChange(setPanelVisible(layout, key, e.target.checked))}
                    data-testid={`tv-layout-vis-${key}`}
                  />
                  <span>Tampilkan</span>
                </label>
                <div className="tv-layout-row__move">
                  <button
                    type="button"
                    className="tv-layout-row__move-btn"
                    aria-label={`Naikkan ${TV_PANEL_LABELS[key]}`}
                    disabled={index === 0}
                    onClick={() => moveBy(index, -1)}
                    data-testid={`tv-layout-up-${key}`}
                  >
                    Naik
                  </button>
                  <button
                    type="button"
                    className="tv-layout-row__move-btn"
                    aria-label={`Turunkan ${TV_PANEL_LABELS[key]}`}
                    disabled={isLast}
                    onClick={() => moveBy(index, 1)}
                    data-testid={`tv-layout-down-${key}`}
                  >
                    Turun
                  </button>
                </div>
              </div>
              {showDropAfter && <div className="tv-layout__drop-indicator" aria-hidden="true" />}
            </li>
          );
        })}
      </ul>

      <div className="tv-layout__running-text-row">
        <label className="tv-layout-row__vis">
          <input
            type="checkbox"
            checked={layout.runningText.visible}
            onChange={(e) => onChange(setPanelVisible(layout, 'runningText', e.target.checked))}
            data-testid="tv-layout-vis-runningText"
          />
          <span>{TV_PANEL_LABELS.runningText}</span>
        </label>
        <p className="tv-layout__running-text-hint">Teks berjalan selalu di bagian bawah.</p>
      </div>

      <TvLayoutPreview layout={layout} contentRows={contentRows} />
    </div>
  );
}

// --- size segmented control ---

interface SizeSegmentedControlProps {
  panelKey: TvPanelKey;
  size: number;
  onChange: (next: number) => void;
}

function SizeSegmentedControl({ panelKey, size, onChange }: SizeSegmentedControlProps) {
  const sizes = [1, 2, 3, 4];
  return (
    <div
      className="tv-layout-row__size"
      role="radiogroup"
      aria-label={`Ukuran panel ${TV_PANEL_LABELS[panelKey]}`}
      data-testid={`tv-layout-size-${panelKey}`}
    >
      {sizes.map((s) => {
        const checked = size === s;
        return (
          <label
            key={s}
            className={`tv-layout-row__size-option${checked ? ' tv-layout-row__size-option--selected' : ''}`}
          >
            <input
              type="radio"
              name={`tv-layout-size-${panelKey}`}
              value={s}
              checked={checked}
              onChange={() => onChange(s)}
              data-testid={`tv-layout-size-${panelKey}-${s}`}
            />
            <span>{TV_PANEL_SIZE_LABELS[s]}</span>
          </label>
        );
      })}
    </div>
  );
}

// --- live preview ---

interface TvLayoutPreviewProps {
  layout: TvPanelLayoutMap;
  contentRows: readonly TvPanelKey[];
}

function TvLayoutPreview({ layout, contentRows }: TvLayoutPreviewProps) {
  const visiblePanels = contentRows
    .filter((key) => layout[key].visible)
    .map((key) => ({ key, size: layout[key].size }));
  const runningTextVisible = layout.runningText.visible;
  return (
    <div
      className="tv-layout-preview"
      role="img"
      aria-label="Pratinjau tata letak TV"
      data-testid="tv-layout-preview"
    >
      {visiblePanels.length === 0 && runningTextVisible === false ? (
        <div className="tv-layout-preview__empty">Tidak ada panel yang ditampilkan.</div>
      ) : (
        visiblePanels.map(({ key, size }) => (
          <div
            key={key}
            className="tv-layout-preview__bar"
            style={{ flex: `${size} 1 0` }}
            data-testid={`tv-layout-preview-bar-${key}`}
          >
            <span className="tv-layout-preview__label">{TV_PANEL_LABELS[key]}</span>
            <span className="tv-layout-preview__size">{TV_PANEL_SIZE_LABELS[size]}</span>
          </div>
        ))
      )}
      {runningTextVisible && (
        <div className="tv-layout-preview__footer" data-testid="tv-layout-preview-footer">
          <span className="tv-layout-preview__label">{TV_PANEL_LABELS.runningText}</span>
        </div>
      )}
    </div>
  );
}
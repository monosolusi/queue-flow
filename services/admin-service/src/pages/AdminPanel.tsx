import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  DailyResetMode,
  ServiceSurface,
  ThemeMode,
} from '../api/types';
import { DEFAULT_BRAND_COLOR } from '../api/types';
import { isValidBrandColor } from '../lib/brand-color';
import { validateRetentionDays } from '../lib/retention';
import { DAILY_RESET_MODE_LABELS, SERVICE_SURFACE_LABELS, SERVICE_THEME_LABELS } from '../lib/labels';
import { SERVICE_SURFACES } from '../lib/service-themes';
import { timeToCron, cronToTime } from '../lib/daily-reset';
import { timezoneSelectOptions } from '../lib/timezone';
import { CounterRoutingEditor } from '../components/CounterRoutingEditor';
import { PageHeader } from '../components/PageHeader';
import { TimeField } from '../components/TimeField';
import { useToast } from '../toast/useToast';
import {
  addCategory,
  addRouting,
  removeCategory,
  removeRouting,
  updateCategory,
  updateRouting,
} from './admin-config/form';
import { DEFAULT_SECTION, type SectionId } from './admin-config/config-sections';
import { ConfigSectionNav } from './admin-config/ConfigSectionNav';
import { useConfigDraft } from './admin-config/config-draft-context';
import { computeFormValidity } from './admin-config/validity';

/**
 * AC6 — wire a field error message to its input via `aria-describedby` +
 * `aria-invalid`. Returns a spreadable props object (empty when there is no
 * error) so the happy-path markup stays clean. Duplicated from WizardPage
 * rather than shared: the repo has no shared UI lib and the error shapes are
 * heterogeneous (mirrors the `theme.ts` duplication precedent).
 */
function describedBy(
  errorId: string,
  hasError: boolean,
): { 'aria-describedby': string; 'aria-invalid': boolean } | Record<string, never> {
  return hasError ? { 'aria-describedby': errorId, 'aria-invalid': true } : {};
}

/**
 * The operational configuration panel (FR-ADM-01 / QUE-24). After first-run
 * setup the manager edits every operational area here — store name, state
 * machine, categories, counter routing, the daily-reset policy, and the brand
 * color — without re-running the guided wizard. The wizard is first-run only
 * (gated by {@link WizardGuard}), so the store-name + state-machine editing
 * that used to live only in the wizard now lives here too (no functionality
 * lost). The state-machine EDITOR moved to a dedicated full-page designer at
 * `/config/alur-status` (large canvas + JSON source view — the inline diagram
 * was too small per manager feedback); this section now shows a live-ticket
 * warning, a summary, and a "Lihat Diagram" link to that designer. The designer
 * edits the SAME draft this panel does (see below), so the two ride one save.
 *
 * The panel is a thin editor over the existing config save surface: it reads
 * the shared mutable config draft from {@link useConfigDraft} (the
 * `/config`-route {@link ConfigDraftProvider}), lets the manager edit the
 * in-scope sections, and the provider PUTs the full payload back
 * (`PUT /api/system/config`) — mapping the form to the wire shape through the
 * shared `toStateMachineDto`, which strips the client-only `stateMachine.mode`
 * preset and force-resets the default graph exactly as the wizard's finalize
 * does. That reuses the single atomic, audited save use case (DRY — no
 * duplicated audit/tx wiring). Category ids are preserved across edits so
 * re-save does not orphan tickets' `categoryId`; routing `assignedCategoryIds`
 * are mapped to codes on load (the PUT expects codes). The panel consumes only
 * `IAdminApi` (via the provider — ISP) and owns no realtime/WS surface (SRP).
 *
 * Because it is now the ONLY post-setup editor, it also carries the two safety
 * rails the wizard used to own alone: the degenerate-routing guard (`routingValid`
 * — an all-unassigned matrix is unsavable) and the live-ticket warning on the
 * state-machine section (removing a status a live ticket occupies strands it).
 *
 * The draft is owned by the {@link ConfigDraftProvider} (the `/config` route
 * element rendering `<Outlet/>`), not this panel: the provider stays mounted
 * across `/config ↔ /config/alur-status`, so the draft + a cross-section edit
 * ride ONE full-payload save and navigation between the panel and the designer
 * loses no in-progress edits. The provider keeps its OWN config read rather than
 * consuming the shared `SystemConfigProvider` snapshot (a mutable draft must not
 * be clobbered by a `refresh()`), and calls the shared `refresh()` after a
 * successful save so app-wide chrome (the shell's sidebar store name) reflects
 * the new configuration without a page reload. Per-section validity
 * (`sectionValidity` / `wholeFormValid` / `smErrors` / …) is computed once from
 * the shared form by the pure {@link computeFormValidity} helper, shared with
 * the designer so both surfaces agree on the save-gate + nav badges (DRY).
 *
 * Section navigation: the panel renders one section at a time behind a left
 * in-content ARIA tablist (`ConfigSectionNav`) — the manager no longer
 * scrolls one long form. `activeSection` is a SEPARATE `useState` from
 * `PanelState`: the post-save reload replaces `PanelState`, so bundling would
 * snap the manager back to the default section on every save. The draft stays
 * centralized (all fields), so switching sections changes visibility only — a
 * manager can edit profile, switch to state-machine, edit, then save once and
 * both edits ride the one full-payload PUT. Each saved section renders its
 * own save button (`data-testid="admin-save"` stays unique — only the active
 * section renders); the `manual` section has no save (its operations are
 * separate POSTs). The full PUT requires a valid whole payload, so each
 * section's save is disabled unless the WHOLE form is valid, and the nav shows
 * an error badge on items whose own section is invalid.
 *
 * Save / reset / cleanup outcomes are announced through the app-wide toast
 * stack (`useToast`) — auto-dismissing for successes, sticky for errors. The
 * inline banners that used to sit here were set and never cleared; inline
 * messaging is reserved for page content (the config-load failure and every
 * `*-errors` validation list below).
 */
export function AdminPanel() {
  // The shared config draft (load/save/reload/retry) is owned by the
  // `/config`-route ConfigDraftProvider so this panel and the
  // `/config/alur-status` designer edit ONE draft and ride ONE full save.
  const { api, state, setState, save, submitting, retry } = useConfigDraft();
  const toast = useToast();
  // The active in-content section. DELIBERATELY separate from the provider's
  // `PanelState`: the post-save reload replaces `PanelState`, so bundling
  // `activeSection` there would snap the manager back to the default section
  // every time they saved. Separate state → saving routing keeps them on routing.
  const [activeSection, setActiveSection] = useState<SectionId>(DEFAULT_SECTION);
  // Shared `useId()` base so each nav tab's `aria-controls` resolves to the
  // panel this component renders with the matching `${idBase}-panel-${id}` id.
  const idBase = useId();

  // --- Manual override operations (FR-ADM-02 / QUE-25) ---
  // Manual daily-reset state + the synchronous in-flight guard (double-tap).
  const [resetting, setResetting] = useState(false);
  const resetInFlight = useRef(false);
  // Transaction-log cleanup state + its own in-flight guard. retentionDays
  // defaults to 90 (the UI default); the backend-enforced 7-day floor is
  // mirrored client-side via validateRetentionDays so the button stays disabled
  // on an invalid value.
  const [retentionDays, setRetentionDays] = useState(90);
  const [cleaning, setCleaning] = useState(false);
  const cleanupInFlight = useRef(false);
  const retentionError = validateRetentionDays(retentionDays);

  if (state.status === 'loading') {
    return <div className="page admin-panel admin-panel--loading">Memuat konfigurasi…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="page admin-panel">
        <p className="admin-panel__error" role="alert">
          Gagal memuat konfigurasi: {state.message}
        </p>
        {/* The panel only loads post-setup (SetupGuard wraps the route), so the
            wizard is blocked (WizardGuard bounces /wizard → /). A "Buka Wizard"
            escape hatch would loop; the retry re-runs the provider's fetch in
            place, matching the two config guards' "Coba Lagi" affordance. */}
        <button type="button" className="btn btn--primary" onClick={retry} data-testid="config-retry"
        >
          Coba Lagi
        </button>
      </div>
    );
  }

  const { form } = state;

  // Per-section validity bag — computed once from the shared form by the pure
  // `computeFormValidity` helper, shared with the `/config/alur-status` designer
  // so both surfaces agree on the save-gate + nav badges (DRY — one computation,
  // two consumers of the same draft). Each validator mirrors a wizard-step guard
  // so the operational panel cannot save a value the backend would 400; see
  // `validity.ts` for the per-field rationale. `PUT /api/system/config` is a FULL
  // save — every section's save button sends the whole draft — so each section's
  // save is disabled unless the WHOLE form is valid (`wholeFormValid`). The nav
  // shows an error badge on the items whose own section is invalid so
  // cross-section invalidity is visible wherever the manager is.
  const {
    storeNameError,
    brandColorErrors,
    serviceThemesErrors,
    catErrors,
    cronError,
    resetToError,
    routingValid,
    smErrors,
    sectionValidity,
    wholeFormValid,
  } = computeFormValidity(form);

  // Manual daily-reset override (FR-ADM-02). Confirms before triggering — a
  // reset rolls the per-category sequence back to its start value and archives
  // prior-day tickets, so it is a destructive operational action. The
  // synchronous in-flight guard ensures two taps produce exactly one reset.
  async function triggerReset() {
    if (resetInFlight.current) return;
    if (!window.confirm('Reset antrian harian sekarang? Nomor antrian akan dikembalikan ke awal.')) return;
    resetInFlight.current = true;
    setResetting(true);
    try {
      const result = await api.triggerManualReset();
      toast.success(
        `Reset berhasil — nomor kembali ke ${result.resetTo} (${result.date})${
          result.archivedCount !== undefined ? `, ${result.archivedCount} tiket diarsipkan` : ''
        }.`,
      );
    } catch (err) {
      toast.error(`Gagal reset: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      resetInFlight.current = false;
      setResetting(false);
    }
  }

  // Transaction-log cleanup override (FR-ADM-02). Confirms before triggering —
  // the purge permanently deletes archived transactions older than the
  // retention window. The synchronous in-flight guard ensures two taps produce
  // exactly one cleanup. The audit log itself is never purged (server-side).
  async function runCleanup() {
    if (cleanupInFlight.current) return;
    if (retentionError) return;
    if (
      !window.confirm(
        `Hapus permanen transaksi arsip yang lebih lama dari ${retentionDays} hari?`,
      )
    )
      return;
    cleanupInFlight.current = true;
    setCleaning(true);
    try {
      const result = await api.cleanupTransactionLogs(retentionDays);
      toast.success(
        `${result.deletedCount} transaksi arsip dihapus (retensi ${result.retentionDays} hari).`,
      );
    } catch (err) {
      toast.error(`Gagal membersihkan log: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      cleanupInFlight.current = false;
      setCleaning(false);
    }
  }

  // One save button element, rendered at the foot of whichever saved section
  // is active. Exactly one is in the DOM at a time (only the active section
  // renders), so `data-testid="admin-save"` stays unique. The PUT is a FULL
  // save — every section sends the whole draft — so the button is disabled
  // unless the WHOLE form is valid, regardless of which section it sits on.
  const saveButton = (
    <button
      type="button"
      className="btn btn--primary admin-config__section-save"
      onClick={save}
      disabled={submitting || !wholeFormValid}
      data-testid="admin-save"
    >
      {submitting ? 'Menyimpan…' : 'Simpan'}
    </button>
  );

  return (
    <div className="page admin-panel">
      <PageHeader title={form.storeName || 'QMS Admin'} subtitle="Konfigurasi Operasional" />

      {/* Save / reset / cleanup outcomes are announced by the app-wide toast
          stack (auto-dismissing for successes, sticky for errors). The inline
          paragraphs that used to sit here were set and never cleared. Inline
          messaging is reserved for page content: the config-load failure above
          and every `*-errors` validation list below. */}

      <div className="admin-config__layout">
        <ConfigSectionNav
          active={activeSection}
          onSelect={setActiveSection}
          sectionValidity={sectionValidity}
          idBase={idBase}
        />
        {/* Only the active section renders — switching changes visibility, not
            the draft, so a manager can edit profile, switch to state-machine,
            edit, then save once → both edits in one payload. The panel owns one
            centralized draft; every save sends the full payload.
            ARIA note: this single panel is re-identified per active section
            (`id`/`aria-labelledby` carry the active `SectionId`), so a non-active
            tab's `aria-controls` points at a panel id that is NOT currently in
            the DOM. This is an intentional trade-off of the one-section-at-a-time
            design (mounting all six panels `hidden` would defeat the "don't show
            all configurations" requirement) — the active tab's `aria-controls`
            always resolves, and a manager activates a tab before reading its
            panel, so the practical impact is limited. Do not "fix" by mounting
            all panels; do not file the dangling references as a bug. */}
        <section
          className="admin-config__content"
          role="tabpanel"
          id={`${idBase}-panel-${activeSection}`}
          aria-labelledby={`${idBase}-tab-${activeSection}`}
          tabIndex={0}
        >
          {activeSection === 'profile' && (
            <>
              {/* Store profile — store name (migrated from the wizard; the
                  wizard is first-run only now). */}
              <section className="config-card" data-testid="store-profile-section">
                <h2 className="config-card__title">Profil Toko</h2>
                <label className="field" htmlFor="admin-store-name">
                  <span className="field__label">
                    Nama toko / cabang<span aria-hidden="true"> *</span>
                  </span>
                  <input
                    id="admin-store-name"
                    className="field__input"
                    type="text"
                    value={form.storeName}
                    onChange={(e) => setState({ status: 'ready', form: { ...form, storeName: e.target.value } })}
                    placeholder="mis. Apotek Sehat Sentosa"
                    required
                    aria-required="true"
                    data-testid="admin-store-name"
                    {...describedBy('store-name-errors', storeNameError !== null)}
                  />
                </label>
                {storeNameError !== null && (
                  <ul className="wizard__errors" id="store-name-errors" data-testid="store-name-errors">
                    <li>{storeNameError}</li>
                  </ul>
                )}
              </section>

              {/* Brand color — re-theme the store accent post-setup (QUE-36). */}
              <section className="config-card" data-testid="brand-color-section">
                <h2 className="config-card__title">Warna Brand</h2>
                <div className="brand-color__controls">
                  <input
                    className="brand-color__picker"
                    type="color"
                    value={isValidBrandColor(form.brandColor) ? form.brandColor : DEFAULT_BRAND_COLOR}
                    onChange={(e) => setState({ status: 'ready', form: { ...form, brandColor: e.target.value } })}
                    aria-label="Pilih warna brand"
                  />
                  <input
                    className="field__input brand-color__hex"
                    type="text"
                    value={form.brandColor}
                    onChange={(e) => setState({ status: 'ready', form: { ...form, brandColor: e.target.value } })}
                    placeholder="#2563eb"
                    aria-label="Kode hex warna brand"
                    {...describedBy('brand-color-errors', brandColorErrors.length > 0)}
                  />
                </div>
                {brandColorErrors.length > 0 && (
                  <ul
                    className="wizard__errors"
                    id="brand-color-errors"
                    data-testid="brand-color-errors"
                    style={{ marginTop: '0.75rem' }}
                  >
                    {brandColorErrors.map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Per-service light/dark theme (QUE-47) — the manager sets each
                  service's theme from this one panel; each service applies its
                  own surface key at boot via applyThemeMode. Constrained
                  selects (light/dark) make an invalid value unconstructable. */}
              <section className="config-card" data-testid="service-themes-section">
                <h2 className="config-card__title">Tema Layanan</h2>
                <p className="admin-panel__hint">
                  Pilih mode tampilan untuk masing-masing layanan. Pilihan diterapkan
                  saat layanan tersebut dimuat ulang.
                </p>
                <div className="service-themes__grid">
                  {SERVICE_SURFACES.map((surface: ServiceSurface) => (
                    <div className="service-themes__row" key={surface}>
                      <label htmlFor={`theme-${surface}`} className="service-themes__label">
                        {SERVICE_SURFACE_LABELS[surface]}
                      </label>
                      <select
                        id={`theme-${surface}`}
                        className="field__input"
                        value={form.serviceThemes[surface]}
                        onChange={(e) =>
                          setState({
                            status: 'ready',
                            form: {
                              ...form,
                              serviceThemes: { ...form.serviceThemes, [surface]: e.target.value as ThemeMode },
                            },
                          })
                        }
                        data-testid={`theme-select-${surface}`}
                      >
                        {(Object.keys(SERVICE_THEME_LABELS) as ThemeMode[]).map((mode) => (
                          <option key={mode} value={mode}>
                            {SERVICE_THEME_LABELS[mode]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                {serviceThemesErrors.length > 0 && (
                  <ul className="wizard__errors" data-testid="service-themes-errors" style={{ marginTop: '0.75rem' }}>
                    {serviceThemesErrors.map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                )}
              </section>
              {saveButton}
            </>
          )}

          {activeSection === 'categories' && (
            <>
              {/* Categories — add / edit / remove (FR-ADM-01). */}
              <section className="config-card">
                <h2 className="config-card__title">Kategori</h2>
                {catErrors.length > 0 && (
                  <ul className="wizard__errors" id="cat-errors" data-testid="cat-errors">
                    {catErrors.map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                )}
                <ul className="entry-list">
                  {form.categories.map((cat, i) => (
                    <li key={cat.rowKey} className="entry-row">
                      <input
                        className="field__input entry-row__code"
                        type="text"
                        value={cat.code}
                        onChange={(e) => updateCategory(form, setState, i, { code: e.target.value.toUpperCase() })}
                        placeholder="A"
                        aria-label={`Kategori ${i + 1} kode`}
                        aria-required="true"
                      />
                      <input
                        className="field__input entry-row__name"
                        type="text"
                        value={cat.name}
                        onChange={(e) => updateCategory(form, setState, i, { name: e.target.value })}
                        placeholder="Nama kategori"
                        aria-label={`Kategori ${i + 1} nama`}
                        aria-required="true"
                      />
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => removeCategory(form, setState, i)}
                        disabled={form.categories.length <= 1}
                      >
                        Hapus
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn btn--secondary" onClick={() => addCategory(form, setState)}>
                  + Tambah Kategori
                </button>
              </section>
              {saveButton}
            </>
          )}

          {activeSection === 'routing' && (
            <>
              {/* Counter & routing — add / edit / remove + category assignment
                  (FR-ADM-01). Unified with the wizard's Step 2 table + Edit-modal
                  design (QUE-43). counterId is auto-managed by the parent helpers. */}
              <section className="config-card">
                <h2 className="config-card__title">Counter &amp; Routing</h2>
                <CounterRoutingEditor
                  routingRules={form.routingRules}
                  categories={form.categories}
                  onUpdate={(i, patch) => updateRouting(form, setState, i, patch)}
                  onAdd={() => addRouting(form, setState)}
                  onRemove={(i) => removeRouting(form, setState, i)}
                  canRemove={() => form.routingRules.length > 1}
                  idPrefix="routing"
                />
                {!routingValid && (
                  <p className="wizard__hint wizard__hint--required" data-testid="routing-empty-hint">
                    Pilih minimal satu kategori pada salah satu counter. Tanpa itu tidak ada tiket yang
                    bisa dilayani, jadi konfigurasi belum bisa disimpan.
                  </p>
                )}
              </section>
              {saveButton}
            </>
          )}

          {activeSection === 'daily-reset' && (
            <>
              {/* Daily reset policy — mode / cron / resetTo / archive (FR-ADM-01). */}
              <section className="config-card">
                <h2 className="config-card__title">Kebijakan Reset Harian</h2>
                <label className="field">
                  <span className="field__label">Mode</span>
                  <select
                    className="field__input"
                    value={form.dailyReset.mode}
                    onChange={(e) =>
                      setState({ status: 'ready', form: { ...form, dailyReset: { ...form.dailyReset, mode: e.target.value as DailyResetMode } } })
                    }
                  >
                    {(Object.keys(DAILY_RESET_MODE_LABELS) as DailyResetMode[]).map((m) => (
                      <option key={m} value={m}>
                        {DAILY_RESET_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </label>
                {form.dailyReset.mode === 'AUTOMATIC_CRON' && (
                  <>
                    <TimeField
                      label="Waktu reset harian"
                      value={cronToTime(form.dailyReset.cronExpression) ?? '00:00'}
                      onChange={(hhmm) =>
                        setState({ status: 'ready', form: { ...form, dailyReset: { ...form.dailyReset, cronExpression: timeToCron(hhmm) } } })
                      }
                      ariaLabel="Waktu reset harian"
                      required
                      invalid={Boolean(cronError)}
                      describedById={cronError ? 'cron-error' : undefined}
                    >
                      {cronError && (
                        <span className="field__error" id="cron-error" data-testid="cron-error">
                          {cronError}
                        </span>
                      )}
                    </TimeField>
                    <label className="field">
                      <span className="field__label">Zona waktu</span>
                      <select
                        className="field__input"
                        value={form.dailyReset.timezone}
                        onChange={(e) =>
                          setState({
                            status: 'ready',
                            form: { ...form, dailyReset: { ...form.dailyReset, timezone: e.target.value } },
                          })
                        }
                        aria-label="Zona waktu"
                        data-testid="tz-select"
                      >
                        {timezoneSelectOptions(form.dailyReset.timezone).map((tz) => (
                          <option key={tz} value={tz}>
                            {tz}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label className="field">
                  <span className="field__label">
                    Reset nomor antrian ke<span aria-hidden="true"> *</span>
                  </span>
                  <input
                    className="field__input"
                    type="number"
                    min={1}
                    value={form.dailyReset.resetTicketNumberTo}
                    onChange={(e) =>
                      setState({
                        status: 'ready',
                        form: { ...form, dailyReset: { ...form.dailyReset, resetTicketNumberTo: Number(e.target.value) } },
                      })
                    }
                    required
                    {...describedBy('reset-to-errors', resetToError !== null)}
                  />
                  {resetToError !== null && (
                    <ul className="wizard__errors" id="reset-to-errors" data-testid="reset-to-errors">
                      <li>{resetToError}</li>
                    </ul>
                  )}
                </label>
                <label className="field field--inline">
                  <input
                    type="checkbox"
                    checked={form.dailyReset.archivePreviousDayData}
                    onChange={(e) =>
                      setState({
                        status: 'ready',
                        form: { ...form, dailyReset: { ...form.dailyReset, archivePreviousDayData: e.target.checked } },
                      })
                    }
                  />
                  <span>Arsipkan data hari sebelumnya</span>
                </label>
                <p className="admin-panel__hint">
                  Saat diaktifkan, data antrian hari sebelumnya dipindahkan ke arsip saat reset berikutnya berjalan.
                  Perubahan jadwal reset harian berlaku segera setelah disimpan.
                </p>
              </section>
              {saveButton}
            </>
          )}

          {activeSection === 'state-machine' && (
            <>
              {/* State machine — editable (migrated from the wizard; the wizard
                  is first-run only now). The visual diagram moved to a dedicated
                  full-page designer at `/config/alur-status` (the inline canvas was
                  too small per manager feedback); this section summarizes the current
                  graph, surfaces any validation errors, states the live-ticket risk,
                  and links into the designer. The designer edits the SAME shared
                  draft (ConfigDraftProvider), so an edit there is reflected here on
                  return and both ride one full save. */}
              <section className="config-card">
                <h2 className="config-card__title">Alur Status Tiket</h2>
                <p className="admin-panel__hint">
                  Pilih alur status standar atau susun sendiri. Label aksi menjadi tombol di panel caller.
                </p>
                {/* Summary of the current graph — mode + counts — so the manager
                    sees the shape without opening the diagram. */}
                <p className="sm-summary" data-testid="sm-summary">
                  Alur {form.stateMachine.mode === 'default' ? 'standar' : 'kustom'} —{' '}
                  {form.stateMachine.states.length} status,{' '}
                  {form.stateMachine.transitions.length} transisi.
                </p>
                {/* Inline validation errors (custom mode only). The designer's
                    diagram view also renders an `sm-errors` list inside its
                    StateMachineWorkflow; this one keeps the section's nav-badge story
                    visible without navigating, and reflects a designer edit on
                    return (shared draft). Default mode is always valid → empty. */}
                {smErrors.length > 0 && (
                  <ul className="wizard__errors" data-testid="sm-errors">
                    {smErrors.map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                )}
                {/* Live-ticket warning at the DECISION POINT — immediately before
                    the "Lihat Diagram" action, not above the <h2>. Manager feedback
                    moved this twice: first from the bottom of the card (where it was
                    dempet-dempet against the editor and got missed) to the VERY TOP
                    via `--top`; that overcorrected — a caution floating above the
                    title detaches from the context of what the manager is about to
                    do, and breaks the title-first rhythm every other config section
                    follows. The right spot is right before the action: the
                    consequence caution carries maximum persuasive weight at the
                    moment the manager is about to act, and the title-first invariant
                    now matches the rest of the section. The `--top` modifier is
                    dropped (no longer in CSS); the base `.admin-panel__warning`
                    margin gives breathing room, and `admin-panel__card-action` adds
                    the top spacing the link needs following the warning.

                    The active alur status is resolved per operation, so a ticket
                    sitting in a status that this save removes or renames has no
                    legal next step: the caller's action buttons for it disappear and
                    the ticket can only be cleared by a daily reset. The wizard framed
                    this as one-time guided setup; here it sits next to Kategori on a
                    panel the manager opens daily, so the risk has to be stated. A
                    backend guard is out of scope for this change.

                    The complementary hazard — a custom flow that DROPS a standard
                    status, which breaks a caller action (and the report's
                    service-time average) for every FUTURE ticket — is warned about
                    inside the designer's StateMachineWorkflow (it derives from the
                    form alone, so the designer gets it with no prop threading). */}
                <p className="admin-panel__warning" data-testid="state-machine-warning">
                  Perhatian: mengubah atau menghapus status yang sedang dipakai tiket aktif membuat tiket
                  tersebut tidak bisa dilanjutkan — tombol aksinya hilang di panel caller. Ubah alur status
                  saat antrian kosong, misalnya setelah reset harian.
                </p>
                {/* Open the dedicated full-page diagram designer. A relative Link
                    (→ /config/alur-status) so it is a real anchor: keyboard-
                    accessible, bookmarkable, and testable. The shared draft persists
                    across the navigation (ConfigDraftProvider is the route element).

                    Secondary (not primary): the section's single commit action is
                    `Simpan` (`admin-config__section-save`, `btn--primary`) — every
                    other config section reserves `btn--primary` for save. A
                    navigation link is subordinate, so `btn--secondary` (surface-2)
                    gives it a distinct, non-colliding visual rather than a second
                    accent bar stacked against the save button. */}
                <Link
                  to="alur-status"
                  className="btn btn--secondary admin-panel__card-action"
                  data-testid="sm-open-designer"
                >
                  Lihat Diagram
                </Link>
              </section>
              {saveButton}
            </>
          )}

          {activeSection === 'manual' && (
            // Manual override operations (FR-ADM-02 / QUE-25). No save button —
            // the two operations are separate POSTs, not the full-config PUT.
            <section className="config-card" data-testid="manual-operations">
              <h2 className="config-card__title">Operasi Manual</h2>

              <div className="entry-row entry-row--override">
                <div className="entry-row__label">
                  <span className="field__label">Reset Antrian Harian</span>
                  <span className="admin-panel__hint">
                    Kembalikan nomor antrian ke awal &amp; arsipkan tiket hari sebelumnya.
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={triggerReset}
                  disabled={resetting}
                  data-testid="manual-reset"
                >
                  {resetting ? 'Meriset…' : 'Reset Harian Sekarang'}
                </button>
              </div>

              <div className="entry-row entry-row--override">
                <div className="entry-row__label">
                  <span className="field__label">Bersihkan Log Transaksi</span>
                  <span className="admin-panel__hint">
                    Hapus permanen transaksi arsip yang lebih lama dari retensi (audit log tidak dihapus).
                  </span>
                </div>
                <label className="field field--inline">
                  <span className="field__label">
                    Retensi (hari)<span aria-hidden="true"> *</span>
                  </span>
                  <input
                    className="field__input"
                    type="number"
                    min={7}
                    value={retentionDays}
                    onChange={(e) => setRetentionDays(Number(e.target.value))}
                    aria-label="Retensi hari"
                    data-testid="retention-days"
                    required
                    {...describedBy('retention-error', retentionError !== null)}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={runCleanup}
                  disabled={cleaning || retentionError !== null}
                  data-testid="cleanup-run"
                >
                  {cleaning ? 'Membersihkan…' : 'Bersihkan Sekarang'}
                </button>
              </div>
              {retentionError && (
                <p className="admin-panel__error" id="retention-error" data-testid="retention-error">
                  {retentionError}
                </p>
              )}
            </section>
          )}
        </section>
      </div>
    </div>
  );
}

// --- form construction + mutation helpers live in ./admin-config/form.ts ---
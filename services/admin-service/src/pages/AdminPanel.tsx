import { useEffect, useRef, useState } from 'react';
import type { IAdminApi } from '../api/admin-api';
import { useSystemConfigContext } from '../config/system-config-context';
import type {
  DailyResetMode,
  PriorityPolicy,
  ServiceSurface,
  ServiceThemesMap,
  SystemConfigurationDto,
  ThemeMode,
} from '../api/types';
import { DEFAULT_BRAND_COLOR, DEFAULT_SERVICE_THEMES } from '../api/types';
import { validateCronExpression } from '../lib/cron';
import { validateBrandColor, isValidBrandColor } from '../lib/brand-color';
import { validateRetentionDays } from '../lib/retention';
import { DAILY_RESET_MODE_LABELS, SERVICE_SURFACE_LABELS, SERVICE_THEME_LABELS } from '../lib/labels';
import { SERVICE_SURFACES, validateServiceThemes, coerceServiceThemes } from '../lib/service-themes';
import { timeToCron, cronToTime } from '../lib/daily-reset';
import { BROWSER_TIMEZONE, timezoneSelectOptions } from '../lib/timezone';
import { applyBrandColor, applyThemeMode } from '../lib/theme';
import { validateCustomCategories, validateResetTo } from '../lib/categories';
import { validateStoreName } from '../lib/store-name';
import { CounterRoutingEditor } from '../components/CounterRoutingEditor';
import { StateMachineEditor } from '../components/StateMachineEditor';
import { TimeField } from '../components/TimeField';
import { useToast } from '../toast/useToast';
import {
  type StateMachineForm,
  isDefaultGraph,
  toStateMachineDto,
  validateCustomStateMachine,
} from '../lib/state-machine';

/**
 * One editable category row. `id` is carried for categories that already exist
 * in the store so the backend reuses it (`Identifier.of(id)`) and existing
 * tickets' `categoryId` stay valid. Rows the manager adds in this session
 * have no `id` and are minted server-side on save.
 */
interface CategoryRow {
  readonly id?: string;
  /** Stable React key — set once at load/add, never mutated, stripped before save. */
  readonly rowKey: string;
  code: string;
  name: string;
}

/** One editable counter routing row. Categories are referenced by code. */
interface RoutingRow {
  /** Stable React key — set once at load/add, never mutated, stripped before save. */
  readonly rowKey: string;
  counterId: number;
  counterName: string;
  /** `readonly` so the shared `CounterRoutingEditor`'s `RoutingRuleRow`
   *  (also `readonly string[]`) is structurally compatible with the
   *  `Partial<RoutingRow>` patch it emits — the editor's draft is mutable
   *  internally but the patch it emits is treated as readonly at the
   *  boundary. None of the admin helpers mutate the array in place; they all
   *  create new arrays (the `readonly` is a type-level guarantee, not a
   *  runtime constraint). */
  readonly assignedCategoryCodes: readonly string[];
  priorityPolicy: PriorityPolicy;
}

interface AdminForm {
  /** Editable — the manager changes the store / branch name post-setup. */
  storeName: string;
  /** Editable state-machine form slice (shared with the wizard via
   *  {@link StateMachineEditor}). The client-only `mode` preset is stripped at
   *  save (never sent to core-api) — same pattern as the wizard's finalize. */
  stateMachine: StateMachineForm;
  /** Editable brand color (QUE-36) — the manager re-themes `--accent` post-setup. */
  brandColor: string;
  /** Editable per-service light/dark theme map (QUE-47) — the manager sets each
   *  service's theme from this one panel; each service applies its own key at boot. */
  serviceThemes: ServiceThemesMap;
  categories: CategoryRow[];
  routingRules: RoutingRow[];
  dailyReset: {
    mode: DailyResetMode;
    cronExpression: string;
    resetTicketNumberTo: number;
    archivePreviousDayData: boolean;
    /** IANA timezone the daily-reset cron fires in (QUE-42). */
    timezone: string;
  };
}

type PanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; form: AdminForm };

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
 * lost). The state-machine editor is the same shared {@link StateMachineEditor}
 * + pure `lib/state-machine` validation the wizard uses (DRY — one editor, one
 * validation module).
 *
 * The panel is a thin editor over the existing config save surface: it loads
 * the full config (`GET /api/system/config`), lets the manager edit the
 * in-scope sections, and PUTs the full payload back (`PUT /api/system/config`)
 * — mapping the form to the wire shape through the shared `toStateMachineDto`,
 * which strips the client-only `stateMachine.mode` preset and force-resets the
 * default graph exactly as the wizard's finalize does. That reuses the single
 * atomic, audited save use case (DRY — no duplicated audit/tx wiring). Category
 * ids are preserved across edits so re-save does not orphan tickets'
 * `categoryId`; routing `assignedCategoryIds` are mapped to codes on load (the
 * PUT expects codes). The panel consumes only `IAdminApi` (ISP) and owns no
 * realtime/WS surface (SRP).
 *
 * Because it is now the ONLY post-setup editor, it also carries the two safety
 * rails the wizard used to own alone: the degenerate-routing guard (`routingValid`
 * — an all-unassigned matrix is unsavable) and the live-ticket warning on the
 * state-machine section (removing a status a live ticket occupies strands it).
 *
 * The panel keeps its own config read rather than consuming the shared
 * `SystemConfigProvider` snapshot: it owns a mutable draft, and re-deriving that
 * draft from a shared value any `refresh()` can change would clobber the
 * manager's in-progress edits. It calls the shared `refresh()` after a
 * successful save so the app-wide chrome (the shell's sidebar store name) still
 * reflects the new configuration without a page reload.
 *
 * (Noted, deliberately not done here: the file is on an SRP trajectory that
 * warrants splitting each `config-card` into its own section component. That is
 * a separate refactor — out of scope for this fix.)
 */
export function AdminPanel({ api }: { api: IAdminApi }) {
  const toast = useToast();
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  // Bumped by the error state's "Coba Lagi" to re-run the load effect. Driving
  // the retry through the effect's own dependency (rather than calling a shared
  // `load()` from the button) means React tears down the previous run's
  // `cancelled` flag for us, so every attempt — not just the first — is
  // genuinely cancellable on unmount.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous in-flight guard so two clicks in the same tick produce exactly
  // one save (mirrors the kiosk double-tap guard; `disabled` alone lags a
  // re-render).
  const submittingRef = useRef(false);

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
  // The app-wide configuration. The panel keeps its own load (below) because it
  // owns a mutable draft the shared snapshot must never overwrite mid-edit; it
  // calls `refreshSharedConfig` after a successful save so the chrome that reads
  // the shared snapshot — notably the shell's sidebar store name — reflects a
  // rename immediately instead of after a full page reload.
  const { refresh: refreshSharedConfig } = useSystemConfigContext();

  useEffect(() => {
    let cancelled = false;
    api
      .getSystemConfig()
      .then((config) => {
        if (!cancelled) setState({ status: 'ready', form: toForm(config) });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, loadAttempt]);

  if (state.status === 'loading') {
    return <div className="admin-panel admin-panel--loading">Memuat konfigurasi…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="admin-panel">
        <p className="admin-panel__error" role="alert">
          Gagal memuat konfigurasi: {state.message}
        </p>
        {/* The panel only loads post-setup (SetupGuard wraps the route), so the
            wizard is blocked (WizardGuard bounces /wizard → /). A "Buka Wizard"
            escape hatch would loop; the retry re-runs the fetch in place,
            matching the two config guards' "Coba Lagi" affordance. */}
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setState({ status: 'loading' });
            setLoadAttempt((n) => n + 1);
          }}
          data-testid="config-retry"
        >
          Coba Lagi
        </button>
      </div>
    );
  }

  const { form } = state;

  // Step-4-style cron validation, mirrored here so the operational panel cannot
  // save a malformed cron either (FR-WZD-05 / QUE-16). In MANUAL mode there is no
  // cron field, so the cron is always valid. Used both for the inline message and
  // to disable the save button — same single source of truth as the wizard.
  const cronError =
    form.dailyReset.mode === 'AUTOMATIC_CRON' ? validateCronExpression(form.dailyReset.cronExpression) : null;
  const resetToError = validateResetTo(form.dailyReset.resetTicketNumberTo);
  const dailyResetValid = cronError === null && resetToError === null;
  // Brand-color validation (QUE-36) — mirrors the wizard step-1 guard so the
  // operational panel cannot save a malformed color either. The error list
  // drives the inline message and disables the save button (single source of
  // truth, same pattern as the cron guard above).
  const brandColorErrors = validateBrandColor(form.brandColor);
  const brandColorValid = brandColorErrors.length === 0;
  // Per-service theme validation (QUE-47) — the selects are constrained to
  // light/dark so this is defense-in-depth for a corrupt prefill; the error
  // list drives the inline message and disables the save button.
  const serviceThemesErrors = validateServiceThemes(form.serviceThemes);
  const serviceThemesValid = serviceThemesErrors.length === 0;
  // Category invariants (code `^[A-Z]+$`, non-empty name, no dupes) — mirrors
  // the wizard step-1 guard via the shared `validateCustomCategories` helper so
  // the operational panel cannot save a list the backend would 400. Drives the
  // inline error list and disables the save button.
  const catErrors = validateCustomCategories(form.categories);
  const categoriesValid = catErrors.length === 0;
  // Store-name validation — shares the wizard step-1 guard's `lib/store-name`
  // validator so the operational panel cannot save an empty name (the backend
  // would 400) and the two surfaces cannot drift on the rule or the copy.
  // Drives the inline error and disables the save button. Now editable here (the
  // wizard is first-run only; store-name editing migrated to the panel).
  const storeNameError = validateStoreName(form.storeName);
  const storeNameValid = storeNameError === null;
  // Degenerate-routing guard, mirrored from the wizard's step-2 `Lanjut` gate:
  // at least one counter must serve at least one category. An all-unassigned
  // matrix means every counter is dead and no ticket can ever be routed. The
  // backend has no such invariant and the wizard is first-run only now, so
  // without this mirror the panel — the only post-setup routing editor — could
  // PUT a configuration that silently breaks the whole queue. Minimal by design
  // (same as the wizard): it blocks only the fully-unassigned matrix, not a
  // single idle counter alongside a wired one.
  const routingValid = form.routingRules.some((r) => r.assignedCategoryCodes.length > 0);
  // State-machine validation — mirrors the wizard step-3 guard via the shared
  // pure `validateCustomStateMachine` helper so the operational panel cannot
  // save a graph the backend would 400. Default mode is always valid (the PRD
  // §7 graph is). Drives the editor's inline error list and disables the save
  // button. Now editable here (the wizard is first-run only; state-machine
  // editing migrated to the panel).
  const smErrors = form.stateMachine.mode === 'custom' ? validateCustomStateMachine(form.stateMachine) : [];
  const stateMachineValid = smErrors.length === 0;

  /**
   * PUTs the whole configuration, then re-reads it so server-minted category
   * ids land back in the editable draft.
   *
   * **The write and the follow-up re-read have separate `catch`es**, because
   * they fail for different reasons and the manager must be told which one
   * happened. Sharing one `catch` would report a failed *re-read* as
   * `Gagal menyimpan: …` ("failed to save") right next to the success toast —
   * telling the manager their change was both saved and not saved. The re-read
   * only re-seeds the local draft and app chrome; the write has already
   * committed, so its message says so explicitly.
   */
  async function save() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    // The outer try owns the in-flight guard, so the button stays disabled for
    // the WHOLE sequence (write + re-read) exactly as it did before the split.
    try {
      try {
        await api.saveSystemConfig({
          storeName: form.storeName,
          // Strip the client-only `mode` preset — never on the wire — via the same
          // shared mapper the wizard's finalize uses. It ALSO force-resets to the
          // PRD §7 graph in default mode: relying on the editor's default-radio
          // having already replaced the graph would make this surface silently PUT
          // a half-edited custom graph as "the default" the day that radio changes.
          stateMachine: toStateMachineDto(form.stateMachine),
          brandColor: form.brandColor,
          serviceThemes: form.serviceThemes,
          dailyReset: {
            mode: form.dailyReset.mode,
            cronExpression:
              form.dailyReset.mode === 'AUTOMATIC_CRON' ? form.dailyReset.cronExpression : null,
            resetTicketNumberTo: form.dailyReset.resetTicketNumberTo,
            archivePreviousDayData: form.dailyReset.archivePreviousDayData,
            timezone: form.dailyReset.timezone,
          },
          // Preserve `id` on existing categories; omit it for rows added this
          // session so the backend mints fresh ids.
          categories: form.categories.map((c) =>
            c.id ? { id: c.id, code: c.code, name: c.name } : { code: c.code, name: c.name },
          ),
          // Strip the client-only `rowKey` (a React key) at the boundary so it
          // never travels on the wire — `WizardRoutingRuleDto` carries no
          // `rowKey`, and the PUT payload type is `readonly WizardRoutingRuleDto[]`.
          routingRules: form.routingRules.map(({ rowKey, ...rest }) => rest),
        });
      } catch (err) {
        // The `Gagal menyimpan: ` prefix is load-bearing — existing assertions
        // match a backend validation message inside it.
        toast.error(`Gagal menyimpan: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      toast.success('Konfigurasi tersimpan.');

      try {
        // Reload so newly added categories get their server-minted ids into the
        // form (keeps a subsequent edit id-stable) and the UI reflects saved state.
        // This read is the panel's own: it re-seeds the editable draft, which the
        // shared snapshot must not do (a later `refresh()` would clobber an
        // in-progress edit).
        const config = await api.getSystemConfig();
        // Re-apply the runtime `--accent` so a manager who changed the brand color
        // sees it take effect immediately, without a full page reload (QUE-35).
        applyBrandColor(config.brandColor);
        // Re-apply this panel's own theme so the admin UI reflects an admin-theme
        // change immediately (QUE-47 — mirrors the brandColor re-apply). Both
        // re-applies are idempotent with the App-level effect that runs off the
        // shared refresh below; they are kept so the panel still re-themes when
        // rendered standalone (its own spec does exactly that).
        applyThemeMode(config.serviceThemes.admin);
        setState({ status: 'ready', form: toForm(config) });
        // Re-read the shared snapshot so app-wide chrome fed by it updates now —
        // above all the shell's sidebar brand, which would otherwise keep showing
        // the OLD store name until a full page reload.
        await refreshSharedConfig();
      } catch (err) {
        // The write already committed — say so, so the manager does not re-submit
        // a change that is already persisted. Only the local view is stale.
        toast.error(
          `Gagal memuat ulang konfigurasi (perubahan sudah tersimpan): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

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

  return (
    <div className="admin-panel">
      <header className="admin-panel__header">
        <div>
          <h1 className="admin-panel__title">{form.storeName || 'QMS Admin'}</h1>
          <p className="admin-panel__subtitle">Konfigurasi Operasional</p>
        </div>
      </header>

      {/* Save / reset / cleanup outcomes are announced by the app-wide toast
          stack (auto-dismissing for successes, sticky for errors). The inline
          paragraphs that used to sit here were set and never cleared. Inline
          messaging is reserved for page content: the config-load failure above
          and every `*-errors` validation list below. */}

      {/* Store profile — store name (migrated from the wizard; the wizard is
          first-run only now). */}
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

      {/* Per-service light/dark theme (QUE-47) — the manager sets each service's
          theme from this one panel; each service applies its own surface key at
          boot via applyThemeMode. Constrained selects (light/dark) make an
          invalid value unconstructable through the UI. */}
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

      {/* Counter & routing — add / edit / remove + category assignment (FR-ADM-01).
          Unified with the wizard's Step 2 table + Edit-modal design (QUE-43).
          counterId is auto-managed by the parent helpers (not hand-editable). */}
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

      {/* State machine — editable (migrated from the wizard; the wizard is
          first-run only now). Uses the same shared StateMachineEditor + pure
          lib/state-machine validation the wizard uses (DRY — one editor). */}
      <section className="config-card">
        <h2 className="config-card__title">Alur Status Tiket</h2>
        <p className="admin-panel__hint">
          Pilih alur status standar atau susun sendiri. Label aksi menjadi tombol di panel caller.
        </p>
        {/* Live-ticket warning (arch-review). The active alur status is resolved
            per operation, so a ticket sitting in a status that this save removes
            or renames has no legal next step: the caller's action buttons for it
            disappear and the ticket can only be cleared by a daily reset. The
            wizard framed this as one-time guided setup; here it sits next to
            Kategori on a panel the manager opens daily, so the risk has to be
            stated. A backend guard is out of scope for this change.

            The complementary hazard — a custom flow that DROPS a standard status,
            which breaks a caller action (and the report's service-time average)
            for every FUTURE ticket, not just the live ones — is warned about by
            the shared StateMachineEditor itself: it derives from the form alone,
            so this panel and the wizard both get it with no prop threading. */}
        <p className="admin-panel__warning" data-testid="state-machine-warning">
          Perhatian: mengubah atau menghapus status yang sedang dipakai tiket aktif membuat tiket
          tersebut tidak bisa dilanjutkan — tombol aksinya hilang di panel caller. Ubah alur status
          saat antrian kosong, misalnya setelah reset harian.
        </p>
        <StateMachineEditor
          value={form.stateMachine}
          onChange={(sm) => setState({ status: 'ready', form: { ...form, stateMachine: sm } })}
          errors={smErrors}
        />
      </section>

      {/* Manual override operations (FR-ADM-02 / QUE-25). */}
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

      <footer className="admin-panel__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={save}
          disabled={
            submitting ||
            !dailyResetValid ||
            !brandColorValid ||
            !serviceThemesValid ||
            !categoriesValid ||
            !storeNameValid ||
            !routingValid ||
            !stateMachineValid
          }
          data-testid="admin-save"
        >
          {submitting ? 'Menyimpan…' : 'Simpan Konfigurasi'}
        </button>
      </footer>
    </div>
  );
}

// --- form construction + mutation helpers (module-local; pure over the form slice) ---

/** Maps the config projection into the editable form, preserving category ids
 *  and converting routing `assignedCategoryIds` -> codes. */
function toForm(config: SystemConfigurationDto): AdminForm {
  const idToCode = new Map(config.categories.map((c) => [c.id, c.code]));
  return {
    storeName: config.storeName,
    // Build a StateMachineForm with the client-only `mode` preset inferred by
    // deep-equal against the PRD §7 default graph (mirrors the wizard's prefill
    // inference). `mode` is stripped at save (never on the wire).
    stateMachine: {
      mode: isDefaultGraph(config.stateMachine.states, config.stateMachine.transitions) ? 'default' : 'custom',
      states: [...config.stateMachine.states],
      transitions: config.stateMachine.transitions.map((t) => ({ ...t })),
    },
    brandColor: config.brandColor || DEFAULT_BRAND_COLOR,
    // Coerce a partial/degraded GET projection into a complete 4-surface map
    // (defaults an unknown surface to light — mirrors the backend VO).
    serviceThemes: coerceServiceThemes(config.serviceThemes ?? DEFAULT_SERVICE_THEMES),
    categories:
      config.categories.length > 0
        ? config.categories.map((c) => ({ id: c.id, rowKey: `cat-${c.id}`, code: c.code, name: c.name }))
        : [{ rowKey: 'cat-new-1', code: 'A', name: '' }],
    routingRules:
      config.routingRules.length > 0
        ? config.routingRules.map((r) => ({
            rowKey: `route-${r.counterId}`,
            counterId: r.counterId,
            counterName: r.counterName,
            assignedCategoryCodes: r.assignedCategoryIds
              .map((id) => idToCode.get(id))
              .filter((code): code is string => Boolean(code)),
            priorityPolicy: r.priorityPolicy,
          }))
        : [
            {
              rowKey: 'route-new-1',
              counterId: 1,
              counterName: 'Counter 1',
              assignedCategoryCodes: [],
              priorityPolicy: 'FIFO_GLOBAL',
            },
          ],
    dailyReset: {
      mode: config.dailyResetPolicy.mode,
      cronExpression: config.dailyResetPolicy.cronExpression ?? '',
      resetTicketNumberTo: config.dailyResetPolicy.resetTicketNumberTo,
      archivePreviousDayData: config.dailyResetPolicy.archivePreviousDayData,
      timezone: config.dailyResetPolicy.timezone || BROWSER_TIMEZONE,
    },
  };
}

function updateCategory(
  form: AdminForm,
  setState: (s: PanelState) => void,
  i: number,
  patch: Partial<CategoryRow>,
) {
  const categories = form.categories.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
  setState({ status: 'ready', form: { ...form, categories } });
}
function addCategory(form: AdminForm, setState: (s: PanelState) => void) {
  // `rowKey` is unique per add (a loaded category's key is `cat-<uuid>`).
  const rowKey = `cat-new-${form.categories.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
  setState({ status: 'ready', form: { ...form, categories: [...form.categories, { rowKey, code: '', name: '' }] } });
}
function removeCategory(form: AdminForm, setState: (s: PanelState) => void, i: number) {
  setState({ status: 'ready', form: { ...form, categories: form.categories.filter((_, idx) => idx !== i) } });
}

function updateRouting(
  form: AdminForm,
  setState: (s: PanelState) => void,
  i: number,
  patch: Partial<RoutingRow>,
) {
  const routingRules = form.routingRules.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
  setState({ status: 'ready', form: { ...form, routingRules } });
}
function addRouting(form: AdminForm, setState: (s: PanelState) => void) {
  // Derive the next counterId from the max, not the count — after a remove the
  // count shrinks below the max id, so `length + 1` would collide with a
  // surviving row and the backend rejects duplicate counter ids with a 400.
  const nextId =
    form.routingRules.length === 0
      ? 1
      : Math.max(...form.routingRules.map((r) => r.counterId)) + 1;
  const rowKey = `route-new-${nextId}-${Math.random().toString(36).slice(2, 8)}`;
  setState({
    status: 'ready',
    form: {
      ...form,
      routingRules: [
        ...form.routingRules,
        { rowKey, counterId: nextId, counterName: `Counter ${nextId}`, assignedCategoryCodes: [], priorityPolicy: 'FIFO_GLOBAL' },
      ],
    },
  });
}
function removeRouting(form: AdminForm, setState: (s: PanelState) => void, i: number) {
  setState({ status: 'ready', form: { ...form, routingRules: form.routingRules.filter((_, idx) => idx !== i) } });
}
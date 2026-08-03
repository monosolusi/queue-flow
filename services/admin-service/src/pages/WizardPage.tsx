import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import {
  type DailyResetMode,
  type PriorityPolicy,
  DEFAULT_CATEGORIES,
  DEFAULT_STATE_MACHINE,
  DEFAULT_DAILY_RESET,
  DEFAULT_BRAND_COLOR,
  type StateMachineDto,
  type WizardCategoryDto,
  type WizardRoutingRuleDto,
} from '../api/types';
import { validateCronExpression } from '../lib/cron';
import { validateBrandColor, isValidBrandColor } from '../lib/brand-color';
import { PRIORITY_POLICY_LABELS, DAILY_RESET_MODE_LABELS } from '../lib/labels';
import { timeToCron, cronToTime } from '../lib/daily-reset';

/** One transition edge in the editable state machine. */
interface Transition {
  from: string;
  to: string;
  actionLabel: string;
}

/**
 * The editable state-machine form slice. `mode` is a **client-only preset** —
 * it is never sent to core-api (the PUT payload is always the full
 * `{ states, transitions }` graph). `'default'` locks the form to the PRD §7
 * default graph; `'custom'` opens the states + transitions editor. It is
 * inferred on prefill (deep-equal to {@link DEFAULT_STATE_MACHINE} ⇒ default)
 * so a re-edit of a store that never customized stays in default mode.
 */
interface StateMachineForm {
  mode: 'default' | 'custom';
  states: string[];
  transitions: Transition[];
}

/**
 * `categoriesMode` is a **client-only preset** — never sent to core-api (the PUT
 * payload is always the full `WizardCategoryDto[]` list, mirroring how
 * `stateMachine.mode` is stripped). `'default'` locks the form to the PRD §7
 * {@link DEFAULT_CATEGORIES} template (read-only); `'custom'` opens the code/name
 * editor. It is inferred on prefill (deep-equal to `DEFAULT_CATEGORIES` by
 * code+name, ignoring `id`) so a re-edit of a store that never customized stays in
 * default mode. The `finalize` force-reset preserves any existing ids by
 * code-match (see {@link defaultCategoriesWithIds}), because
 * `QueueTicket.categoryId` stores the category UUID and minting new ids on a
 * re-save would orphan every ticket — the one real difference from the state-
 * machine preset, whose graph carries no ids.
 */
/** The editable wizard form model (mirrors the PUT payload pieces). */
interface WizardForm {
  storeName: string;
  brandColor: string;
  categories: WizardCategoryDto[];
  categoriesMode: 'default' | 'custom';
  routingRules: WizardRoutingRuleDto[];
  stateMachine: StateMachineForm;
  dailyReset: { mode: DailyResetMode; cronExpression: string; resetTicketNumberTo: number; archivePreviousDayData: boolean };
}

const TOTAL_STEPS = 5;

function defaultStateMachineForm(): StateMachineForm {
  return {
    mode: 'default',
    states: [...DEFAULT_STATE_MACHINE.states],
    transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
  };
}

function emptyForm(): WizardForm {
  return {
    storeName: '',
    brandColor: DEFAULT_BRAND_COLOR,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    categoriesMode: 'default',
    routingRules: [{ counterId: 1, counterName: 'Counter 1', assignedCategoryCodes: [], priorityPolicy: 'FIFO_GLOBAL' as PriorityPolicy }],
    stateMachine: defaultStateMachineForm(),
    dailyReset: { ...DEFAULT_DAILY_RESET, cronExpression: DEFAULT_DAILY_RESET.cronExpression ?? '' },
  };
}

/** Structural deep-equal against the PRD §7 default categories (prefill mode inference). */
function isDefaultCategories(cats: readonly WizardCategoryDto[]): boolean {
  if (cats.length !== DEFAULT_CATEGORIES.length) return false;
  // Compare code+name only — `id` is load-bearing for persistence but irrelevant
  // to whether the manager chose the default template (a re-edit carries ids the
  // default preset never had, so an id-aware compare would wrongly infer custom).
  return cats.every((c, i) => c.code === DEFAULT_CATEGORIES[i].code && c.name === DEFAULT_CATEGORIES[i].name);
}

/**
 * The PRD §7 default categories, preserving any existing id from `existing` by
 * code-match. Callers pass the **prefill pool** (the categories as originally
 * loaded from the store, with their persisted ids — `loadedCategoriesRef`), NOT
 * the live `form.categories`: a custom detour that removes a row would
 * otherwise drop the original id from the editable list, and switching back to
 * default would mint a fresh UUID — orphaning every `QueueTicket.categoryId`
 * that referenced it. Drawing from the prefill pool keeps the original ids
 * across any custom round-trip. Categories whose code is new to the store carry
 * no `id` and the backend mints one — the wizard's "send existing id for
 * unchanged, omit for new" rule.
 */
function defaultCategoriesWithIds(existing: readonly WizardCategoryDto[]): WizardCategoryDto[] {
  return DEFAULT_CATEGORIES.map((dc) => {
    const match = existing.find((c) => c.code === dc.code);
    return match?.id ? { id: match.id, code: dc.code, name: dc.name } : { code: dc.code, name: dc.name };
  });
}

/**
 * Validate a custom category list, mirroring the backend `Category` value-object
 * invariants (`core-api` `domain/queue/entities/category.ts`) so the wizard
 * never submits a list the backend would reject with a 400: code `^[A-Z]+$`,
 * non-empty name, no duplicate codes. Returns a list of human-readable
 * (Indonesian) error strings; empty means valid. (Default mode is always valid —
 * `DEFAULT_CATEGORIES` satisfies the invariants by construction.)
 */
function validateCustomCategories(cats: readonly WizardCategoryDto[]): string[] {
  const errors: string[] = [];
  // code -> first row it appeared on, so a duplicate points back to the original.
  const seenCodes = new Map<string, number>();
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    const row = i + 1;
    if (!c.code || !/^[A-Z]+$/.test(c.code)) {
      errors.push(`Kategori ${row}: kode harus huruf kapital (A-Z).`);
    } else if (seenCodes.has(c.code)) {
      errors.push(`Kategori ${row}: kode '${c.code}' duplikat dengan kategori ${seenCodes.get(c.code)}.`);
    } else {
      seenCodes.set(c.code, row);
    }
    if (!c.name || !c.name.trim()) errors.push(`Kategori ${row}: nama tidak boleh kosong.`);
  }
  // De-duplicate identical messages, but per-row prefixes keep distinct rows
  // distinguishable (two empty names no longer collapse to one `li`).
  return [...new Set(errors)];
}

/** Structural deep-equal against the PRD §7 default graph (prefill mode inference). */
function isDefaultGraph(states: readonly string[], transitions: readonly Transition[]): boolean {
  if (states.length !== DEFAULT_STATE_MACHINE.states.length) return false;
  if (transitions.length !== DEFAULT_STATE_MACHINE.transitions.length) return false;
  const sameStates = states.every((s, i) => s === DEFAULT_STATE_MACHINE.states[i]);
  if (!sameStates) return false;
  return transitions.every((t, i) => {
    const d = DEFAULT_STATE_MACHINE.transitions[i];
    return t.from === d.from && t.to === d.to && t.actionLabel === d.actionLabel;
  });
}

/**
 * Validate a custom state machine, mirroring the backend invariants
 * (`StateMachine` / `StateSchema` in `core-api`) so the wizard never submits a
 * graph the backend would reject with a 400. Returns a list of human-readable
 * (Indonesian) error strings; empty means valid.
 */
function validateCustomStateMachine(form: StateMachineForm): string[] {
  const errors: string[] = [];
  const { states, transitions } = form;
  if (states.length === 0) errors.push('State machine harus memiliki minimal satu state.');
  if (transitions.length === 0) errors.push('State machine harus memiliki minimal satu transisi.');
  const seenStates = new Set<string>();
  for (const s of states) {
    if (!s || !s.trim()) errors.push('Nama state tidak boleh kosong.');
    else if (seenStates.has(s)) errors.push(`State '${s}' duplikat.`);
    seenStates.add(s);
  }
  const seenEdges = new Set<string>();
  for (const t of transitions) {
    if (!t.actionLabel || !t.actionLabel.trim()) errors.push('Label aksi tidak boleh kosong.');
    if (!seenStates.has(t.from)) errors.push(`Transisi '${t.from}'→'${t.to}': state '${t.from}' tidak dikenal.`);
    if (!seenStates.has(t.to)) errors.push(`Transisi '${t.from}'→'${t.to}': state '${t.to}' tidak dikenal.`);
    const edge = `${t.from}->${t.to}`;
    if (seenEdges.has(edge)) errors.push(`Transisi '${t.from}'→'${t.to}' duplikat.`);
    seenEdges.add(edge);
  }
  // De-duplicate identical messages (e.g. several empty labels).
  return [...new Set(errors)];
}

/** States referenced by at least one transition — removing these would dangle an edge. */
function referencedStates(form: StateMachineForm): Set<string> {
  const refs = new Set<string>();
  for (const t of form.transitions) {
    refs.add(t.from);
    refs.add(t.to);
  }
  return refs;
}

/**
 * AC6 — wire a field error message to its input via `aria-describedby` +
 * `aria-invalid`. Returns a spreadable props object (empty when there is no
 * error) so the happy-path markup stays clean. Inline per-page rather than a
 * shared `<Field>` component: the repo has no shared UI lib and the error
 * shapes are heterogeneous (list vs single string) across the wizard/admin
 * surfaces (mirrors the `theme.ts` duplication precedent).
 */
function describedBy(
  errorId: string,
  hasError: boolean,
): { 'aria-describedby': string; 'aria-invalid': boolean } | Record<string, never> {
  return hasError ? { 'aria-describedby': errorId, 'aria-invalid': true } : {};
}

/**
 * The first-run setup wizard (FR-WZD-02..06). Five steps:
 *  1. Store profile + categories — store name, active counter count, and the
 *     category list with a PRD §7 Default / Custom preset template (FR-WZD-02).
 *     The counter count drives the routing-rule rows edited on step 2; the
 *     category preset mirrors the state-machine `mode` pattern (client-only,
 *     stripped at finalize, with id-preserving force-reset).
 *  2. Routing matrix — for each counter, the served categories + priority
 *     policy (FR-WZD-03). Counter count is owned by step 1; this step only
 *     assigns categories to the counters already created there.
 *  3. State-machine designer — states + transitions + Indonesian action labels,
 *     PRD §7 default graph prefilled (FR-WZD-04).
 *  4. Daily-reset policy — mode/cron/resetTo/archive (FR-WZD-05). The cron field
 *     is validated client-side ({@link validateCronExpression}) so the wizard
 *     never submits an expression the boot-time scheduler would reject.
 *  5. Review — a read-only summary of the whole assembled configuration before
 *     the manager activates it (FR-WZD-06). No API call; renders from the
 *     in-memory form. The `Simpan & Aktifkan` button lives here.
 *
 * On mount it loads the current config (`GET /api/system/config`) to prefill the
 * form, so the wizard also serves as a re-editor after initial setup. On
 * finalize it calls `PUT /api/system/config` (which flips
 * `isInitialSetupCompleted` server-side via `completeInitialSetup`) and
 * navigates to `/admin`. The wizard owns no realtime/WS surface (SRP).
 */
export function WizardPage({ api }: { api: IAdminApi }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<WizardForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The categories as loaded from the store at prefill (with their persisted
  // ids). The default-mode force-reset (radio onChange + finalize) draws its id
  // pool from THIS, not the live `form.categories`, so a custom detour that
  // removes a row cannot lose the original id — switching back to default still
  // reuses the persisted UUIDs and never mints new ones (which would orphan
  // every `QueueTicket.categoryId`). See `defaultCategoriesWithIds`.
  const loadedCategoriesRef = useRef<WizardCategoryDto[]>([]);

  // Prefill from the current config (supports re-edit after initial setup).
  useEffect(() => {
    let cancelled = false;
    api
      .getSystemConfig()
      .then((config) => {
        if (cancelled) return;
        // Preserve existing category ids across re-edit so re-save does not
        // mint new ids and orphan tickets' `categoryId` (QueueTicket stores the
        // category UUID). Map routing `assignedCategoryIds` -> codes so the
        // checkbox matrix reflects the saved assignments instead of resetting
        // to empty (the prior prefill dropped both).
        const idToCode = new Map(config.categories.map((c) => [c.id, c.code]));
        const loadedCategories: WizardCategoryDto[] =
          config.categories.length > 0
            ? config.categories.map((c) => ({ id: c.id, code: c.code, name: c.name }))
            : DEFAULT_CATEGORIES.map((c) => ({ ...c }));
        loadedCategoriesRef.current = loadedCategories;
        setForm({
          storeName: config.storeName,
          brandColor: config.brandColor || DEFAULT_BRAND_COLOR,
          categories: loadedCategories,
          // Infer the preset by code+name deep-equal (id-agnostic) so a re-edit
          // of a store that kept the default template stays in default mode and
          // re-uses the existing category ids (preserved at finalize).
          categoriesMode: isDefaultCategories(loadedCategories) ? 'default' : 'custom',
          routingRules:
            config.routingRules.length > 0
              ? config.routingRules.map((r) => ({
                  counterId: r.counterId,
                  counterName: r.counterName,
                  assignedCategoryCodes: r.assignedCategoryIds
                    .map((id) => idToCode.get(id))
                    .filter((code): code is string => Boolean(code)),
                  priorityPolicy: r.priorityPolicy,
                }))
              : [
                  {
                    counterId: 1,
                    counterName: 'Counter 1',
                    assignedCategoryCodes: [],
                    priorityPolicy: 'FIFO_GLOBAL',
                  },
                ],
          stateMachine: {
            mode: isDefaultGraph(config.stateMachine.states, config.stateMachine.transitions) ? 'default' : 'custom',
            states: [...config.stateMachine.states],
            transitions: config.stateMachine.transitions.map((t) => ({ ...t })),
          },
          dailyReset: {
            mode: config.dailyResetPolicy.mode,
            cronExpression: config.dailyResetPolicy.cronExpression ?? '',
            resetTicketNumberTo: config.dailyResetPolicy.resetTicketNumberTo,
            archivePreviousDayData: config.dailyResetPolicy.archivePreviousDayData,
          },
        });
        setLoading(false);
      })
      .catch(() => {
        // Clean store read returns a default DTO (never throws); a network
        // failure still lets the wizard open with defaults.
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const categoryCodes = useMemo(() => form.categories.map((c) => c.code), [form.categories]);

  // Step 1 category validation. Default mode is always valid (DEFAULT_CATEGORIES
  // satisfies the Category invariants by construction); custom mode mirrors the
  // backend `Category` VO so the wizard never submits a list the backend would
  // 400. The error list drives both the inline UI and the Lanjut guard.
  const catErrors = useMemo(
    () => (form.categoriesMode === 'custom' ? validateCustomCategories(form.categories) : []),
    [form.categoriesMode, form.categories],
  );
  // Brand color validation (step 1). Mirrors the UI-reachable subset of the
  // backend `BrandColor` VO (#rrggbb) so the wizard never submits a color the
  // backend would 400. The native color picker emits valid hex by itself; this
  // guards the companion hex text input a manager can type into.
  const brandColorErrors = useMemo(() => validateBrandColor(form.brandColor), [form.brandColor]);
  const step1Valid = catErrors.length === 0 && brandColorErrors.length === 0;

  // Step 3 is the only step with structural validation; the others are free-form
  // (the backend validates store name / categories / routing). Compute the
  // custom-state-machine errors once so the UI and the next/finalize guard share
  // one source of truth. Default mode is always valid (the PRD §7 graph is).
  const smErrors = useMemo(
    () => (form.stateMachine.mode === 'custom' ? validateCustomStateMachine(form.stateMachine) : []),
    [form.stateMachine],
  );
  const step3Valid = smErrors.length === 0;
  // States referenced by at least one transition — hoisted out of the render
  // loop so the states editor's remove-guard reads one shared set.
  const referencedStateSet = useMemo(
    () => (form.stateMachine.mode === 'custom' ? referencedStates(form.stateMachine) : new Set<string>()),
    [form.stateMachine],
  );

  // Step 4 cron validation. The cron field is only relevant in AUTOMATIC_CRON
  // mode; in MANUAL mode there is no field, so the step is always valid. The
  // error string drives both the inline message and the Lanjut guard so the
  // manager cannot advance to the review step with a cron the scheduler would
  // reject at boot.
  const cronError = useMemo(
    () => (form.dailyReset.mode === 'AUTOMATIC_CRON' ? validateCronExpression(form.dailyReset.cronExpression) : null),
    [form.dailyReset.mode, form.dailyReset.cronExpression],
  );
  const step4Valid = cronError === null;

  const next = () => {
    // Block advancing past step 1 while the custom category list is invalid so
    // the manager never reaches the routing matrix with categories the backend
    // would 400 on save.
    if (step === 1 && !step1Valid) return;
    // Block advancing past step 3 while the custom state machine is invalid so
    // the manager never reaches finalize with a graph the backend would 400.
    if (step === 3 && !step3Valid) return;
    // Block advancing past step 4 while the cron is malformed so the manager
    // never reaches the review step with a cron the scheduler would reject.
    if (step === 4 && !step4Valid) return;
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  };
  const back = () => setStep((s) => Math.max(1, s - 1));

  async function finalize() {
    setSubmitting(true);
    setError(null);
    try {
      // `mode` is a client-only preset; never sent to core-api. In default mode
      // force the PRD §7 graph so a half-edited custom graph the manager
      // abandoned does not leak into the payload.
      const sm: StateMachineDto =
        form.stateMachine.mode === 'default'
          ? {
              states: [...DEFAULT_STATE_MACHINE.states],
              transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
            }
          : { states: form.stateMachine.states, transitions: form.stateMachine.transitions };
      // `categoriesMode` is likewise a client-only preset. In default mode force
      // the PRD §7 categories, preserving any existing id by code-match so a
      // re-save of a store that used the default template reuses its category
      // UUIDs instead of minting new ones (which would orphan every
      // `QueueTicket.categoryId`). A half-edited custom list the manager
      // abandoned cannot leak — same defense as the state-machine force-reset,
      // adapted for load-bearing ids.
      const categories =
        form.categoriesMode === 'default' ? defaultCategoriesWithIds(loadedCategoriesRef.current) : form.categories;
      await api.saveSystemConfig({
        storeName: form.storeName,
        stateMachine: sm,
        dailyReset: {
          mode: form.dailyReset.mode,
          cronExpression: form.dailyReset.mode === 'AUTOMATIC_CRON' ? form.dailyReset.cronExpression : null,
          resetTicketNumberTo: form.dailyReset.resetTicketNumberTo,
          archivePreviousDayData: form.dailyReset.archivePreviousDayData,
        },
        categories,
        routingRules: form.routingRules,
        brandColor: form.brandColor,
        actor: 'admin',
      });
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="wizard wizard--loading">Menyiapkan wizard…</div>;
  }

  return (
    <div className="wizard">
      <header className="wizard__header">
        <h1 className="wizard__title">Setup Awal Sistem</h1>
        <p className="wizard__progress">
          Langkah {step} / {TOTAL_STEPS}
        </p>
      </header>

      <ol className="wizard__steps-bar" aria-label="Langkah wizard">
        {[1, 2, 3, 4, 5].map((n) => (
          <li
            key={n}
            className={`wizard__step-dot ${n === step ? 'is-current' : ''} ${n < step ? 'is-done' : ''}`}
            aria-current={n === step ? 'step' : undefined}
          >
            {n}
          </li>
        ))}
      </ol>

      <div className="wizard__body">
        {step === 1 && (
          <section className="wizard__step" data-testid="step-1">
            <h2 className="wizard__step-title">Profil Toko &amp; Kategori</h2>
            <label className="field">
              <span className="field__label">
                Nama toko / cabang<span aria-hidden="true"> *</span>
              </span>
              <input
                className="field__input"
                type="text"
                value={form.storeName}
                onChange={(e) => setForm({ ...form, storeName: e.target.value })}
                placeholder="mis. Apotek Sehat Sentosa"
                required
                autoFocus
              />
            </label>

            <label className="field">
              <span className="field__label">
                Jumlah counter aktif<span aria-hidden="true"> *</span>
              </span>
              <input
                className="field__input"
                type="number"
                min={1}
                value={form.routingRules.length}
                onChange={(e) => setCounterCount(form, setForm, Number(e.target.value))}
                aria-label="Jumlah counter aktif"
                required
              />
            </label>

            <div className="field" data-testid="brand-color">
              <span className="field__label">Warna brand</span>
              <div className="brand-color__controls">
                <input
                  className="brand-color__picker"
                  type="color"
                  // The native picker can only represent `#rrggbb`; a non-hex
                  // brandColor (e.g. an oklch set via direct API) falls back to
                  // the default for display only — the text input carries the
                  // real value, and the picker's onChange overwrites it with
                  // the chosen `#rrggbb`.
                  value={isValidBrandColor(form.brandColor) ? form.brandColor : DEFAULT_BRAND_COLOR}
                  onChange={(e) => setForm({ ...form, brandColor: e.target.value })}
                  aria-label="Pilih warna brand"
                />
                <input
                  className="field__input brand-color__hex"
                  type="text"
                  value={form.brandColor}
                  onChange={(e) => setForm({ ...form, brandColor: e.target.value })}
                  placeholder="#2563eb"
                  aria-label="Kode hex warna brand"
                  {...describedBy('brand-color-errors', brandColorErrors.length > 0)}
                />
              </div>
              {brandColorErrors.length > 0 && (
                <ul className="wizard__errors" id="brand-color-errors" data-testid="brand-color-errors">
                  {brandColorErrors.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              )}
            </div>

            <fieldset className="radio-group" data-testid="cat-mode">
              <legend>Jenis kategori</legend>
              <label className="radio-group__item">
                <input
                  type="radio"
                  name="cat-mode"
                  value="default"
                  checked={form.categoriesMode === 'default'}
                  onChange={() =>
                    setForm({
                      ...form,
                      categoriesMode: 'default',
                      categories: defaultCategoriesWithIds(loadedCategoriesRef.current),
                    })
                  }
                />
                Gunakan kategori standar
              </label>
              <label className="radio-group__item">
                <input
                  type="radio"
                  name="cat-mode"
                  value="custom"
                  checked={form.categoriesMode === 'custom'}
                  onChange={() => setForm({ ...form, categoriesMode: 'custom' })}
                />
                Susun kategori sendiri
              </label>
            </fieldset>

            {form.categoriesMode === 'default' ? (
              <div data-testid="cat-readonly">
                <p className="wizard__hint">Kategori standar (hanya lihat):</p>
                <ul className="entry-list">
                  {form.categories.map((c, i) => (
                    <li key={i} className="entry-row">
                      <span className="entry-row__code">{c.code}</span>
                      <span className="entry-row__name">{c.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div
                data-testid="cat-editor"
                role="group"
                aria-label="Daftar kategori"
                aria-describedby={catErrors.length > 0 ? 'cat-errors' : undefined}
              >
                <ul className="entry-list">
                  {form.categories.map((cat, i) => (
                    <li key={i} className="entry-row">
                      <input
                        className="field__input entry-row__code"
                        type="text"
                        value={cat.code}
                        onChange={(e) => updateCategory(form, setForm, i, { code: e.target.value.toUpperCase() })}
                        placeholder="A"
                        aria-label={`Kategori ${i + 1} kode`}
                        aria-required="true"
                      />
                      <input
                        className="field__input entry-row__name"
                        type="text"
                        value={cat.name}
                        onChange={(e) => updateCategory(form, setForm, i, { name: e.target.value })}
                        placeholder="Nama kategori"
                        aria-label={`Kategori ${i + 1} nama`}
                        aria-required="true"
                      />
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => removeCategory(form, setForm, i)}
                        disabled={form.categories.length <= 1}
                      >
                        Hapus
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn btn--secondary" onClick={() => addCategory(form, setForm)}>
                  + Tambah Kategori
                </button>

                {catErrors.length > 0 && (
                  <ul className="wizard__errors" id="cat-errors" data-testid="cat-errors">
                    {catErrors.map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        {step === 2 && (
          <section className="wizard__step" data-testid="step-2">
            <h2 className="wizard__step-title">Matriks Routing Counter</h2>
            <p className="wizard__hint">
              Pasang kategori yang dilayani tiap counter. Jumlah counter diatur di Langkah 1.
            </p>

            <ul className="entry-list">
              {form.routingRules.map((rule, i) => (
                <li key={i} className="entry-row entry-row--routing">
                  <span className="entry-row__counter-title">Counter {i + 1}</span>
                  <label className="field">
                    <span className="field__label">Nama counter</span>
                    <input
                      className="field__input"
                      type="text"
                      value={rule.counterName}
                      onChange={(e) => updateRouting(form, setForm, i, { counterName: e.target.value })}
                      placeholder="mis. Loket 1"
                      aria-label={`Counter ${i + 1} nama`}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Kebijakan prioritas</span>
                    <select
                      className="field__input"
                      value={rule.priorityPolicy}
                      onChange={(e) => updateRouting(form, setForm, i, { priorityPolicy: e.target.value as PriorityPolicy })}
                      aria-label={`Counter ${i + 1} kebijakan prioritas`}
                    >
                      {(Object.keys(PRIORITY_POLICY_LABELS) as PriorityPolicy[]).map((p) => (
                        <option key={p} value={p}>
                          {PRIORITY_POLICY_LABELS[p]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset className="checkbox-group">
                    <legend>Kategori dilayani</legend>
                    {categoryCodes.map((code) => (
                      <label key={code} className="checkbox-group__item">
                        <input
                          type="checkbox"
                          checked={rule.assignedCategoryCodes.includes(code)}
                          onChange={(e) => toggleRoutingCategory(form, setForm, i, code, e.target.checked)}
                        />
                        {code}
                      </label>
                    ))}
                  </fieldset>
                </li>
              ))}
            </ul>
          </section>
        )}

        {step === 3 && (
          <section className="wizard__step" data-testid="step-3">
            <h2 className="wizard__step-title">Alur Status Tiket</h2>
            <p className="wizard__hint">
              Pilih alur status standar atau susun sendiri. Label aksi menjadi tombol di panel caller.
            </p>

            <fieldset className="radio-group" data-testid="sm-mode">
              <legend>Jenis alur status</legend>
              <label className="radio-group__item">
                <input
                  type="radio"
                  name="sm-mode"
                  value="default"
                  checked={form.stateMachine.mode === 'default'}
                  onChange={() => setForm({ ...form, stateMachine: defaultStateMachineForm() })}
                />
                Gunakan alur status standar
              </label>
              <label className="radio-group__item">
                <input
                  type="radio"
                  name="sm-mode"
                  value="custom"
                  checked={form.stateMachine.mode === 'custom'}
                  onChange={() =>
                    setForm({ ...form, stateMachine: { ...form.stateMachine, mode: 'custom' } })
                  }
                />
                Susun alur status sendiri
              </label>
            </fieldset>

            {form.stateMachine.mode === 'default' ? (
              <div className="sm-readonly" data-testid="sm-readonly">
                <p className="wizard__hint">Alur status tiket standar (hanya lihat):</p>
                <ul className="entry-list">
                  {form.stateMachine.transitions.map((t, i) => (
                    <li key={i} className="entry-row entry-row--transition">
                      <span className="entry-row__state">{t.from}</span>
                      <span className="entry-row__arrow">→</span>
                      <span className="entry-row__state">{t.to}</span>
                      <span className="entry-row__label">{t.actionLabel}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div
                data-testid="sm-editor"
                role="group"
                aria-label="Editor alur status"
                aria-describedby={smErrors.length > 0 ? 'sm-errors' : undefined}
              >
                <h3 className="wizard__subhead">States</h3>
                <ul className="entry-list">
                  {form.stateMachine.states.map((s, i) => {
                    const referenced = referencedStateSet.has(s);
                    return (
                      <li key={i} className="entry-row entry-row--state">
                        <input
                          className="field__input entry-row__state"
                          type="text"
                          value={s}
                          onChange={(e) => updateState(form, setForm, i, e.target.value.toUpperCase())}
                          aria-label={`State ${i + 1}`}
                          aria-required="true"
                        />
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => removeState(form, setForm, i)}
                          disabled={referenced}
                          title={referenced ? 'State sedang dipakai transisi' : 'Hapus state'}
                        >
                          Hapus
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <button type="button" className="btn btn--secondary" onClick={() => addState(form, setForm)}>
                  + Tambah State
                </button>

                <h3 className="wizard__subhead">Transisi</h3>
                <ul className="entry-list">
                  {form.stateMachine.transitions.map((t, i) => (
                    <li key={i} className="entry-row entry-row--transition">
                      <select
                        className="field__input entry-row__state"
                        value={t.from}
                        onChange={(e) => updateTransition(form, setForm, i, { from: e.target.value })}
                        aria-label={`Transisi ${i + 1} from`}
                        aria-required="true"
                      >
                        {form.stateMachine.states.map((s, si) => (
                          <option key={`${si}-${s}`} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <span className="entry-row__arrow">→</span>
                      <select
                        className="field__input entry-row__state"
                        value={t.to}
                        onChange={(e) => updateTransition(form, setForm, i, { to: e.target.value })}
                        aria-label={`Transisi ${i + 1} to`}
                        aria-required="true"
                      >
                        {form.stateMachine.states.map((s, si) => (
                          <option key={`${si}-${s}`} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <input
                        className="field__input entry-row__label"
                        type="text"
                        value={t.actionLabel}
                        onChange={(e) => updateTransition(form, setForm, i, { actionLabel: e.target.value })}
                        placeholder="Label aksi (Indonesia)"
                        aria-label={`Transisi ${i + 1} label aksi`}
                        aria-required="true"
                      />
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => removeTransition(form, setForm, i)}
                        disabled={form.stateMachine.transitions.length <= 1}
                      >
                        Hapus
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn btn--secondary" onClick={() => addTransition(form, setForm)}>
                  + Tambah Transisi
                </button>

                {smErrors.length > 0 && (
                  <ul className="wizard__errors" id="sm-errors" data-testid="sm-errors">
                    {smErrors.map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        {step === 4 && (
          <section className="wizard__step" data-testid="step-4">
            <h2 className="wizard__step-title">Kebijakan Reset Harian</h2>
            <label className="field">
              <span className="field__label">Mode</span>
              <select
                className="field__input"
                value={form.dailyReset.mode}
                onChange={(e) => setForm({ ...form, dailyReset: { ...form.dailyReset, mode: e.target.value as DailyResetMode } })}
              >
                {(Object.keys(DAILY_RESET_MODE_LABELS) as DailyResetMode[]).map((m) => (
                  <option key={m} value={m}>
                    {DAILY_RESET_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            {form.dailyReset.mode === 'AUTOMATIC_CRON' && (
              <label className="field">
                <span className="field__label">
                  Waktu reset harian<span aria-hidden="true"> *</span>
                </span>
                <input
                  className="field__input"
                  type="time"
                  value={cronToTime(form.dailyReset.cronExpression) ?? '00:00'}
                  onChange={(e) =>
                    setForm({ ...form, dailyReset: { ...form.dailyReset, cronExpression: timeToCron(e.target.value) } })
                  }
                  aria-label="Waktu reset harian"
                  required
                  {...describedBy('cron-error', Boolean(cronError))}
                />
                {cronError && (
                  <span className="field__error" id="cron-error" data-testid="cron-error">
                    {cronError}
                  </span>
                )}
              </label>
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
                  setForm({ ...form, dailyReset: { ...form.dailyReset, resetTicketNumberTo: Number(e.target.value) } })
                }
                required
              />
            </label>
            <label className="field field--inline">
              <input
                type="checkbox"
                checked={form.dailyReset.archivePreviousDayData}
                onChange={(e) =>
                  setForm({ ...form, dailyReset: { ...form.dailyReset, archivePreviousDayData: e.target.checked } })
                }
              />
              <span>Arsipkan data hari sebelumnya</span>
            </label>
          </section>
        )}

        {step === 5 && (
          <section className="wizard__step" data-testid="step-5">
            <h2 className="wizard__step-title">Tinjau &amp; Aktifkan</h2>
            <p className="wizard__hint">
              Tinjau konfigurasi sebelum disimpan. Setelah aktif, sistem keluar dari mode setup awal.
            </p>

            <div className="wizard__review" data-testid="wizard-review">
              <div className="wizard__review-block">
                <h3 className="wizard__review-label">Nama Toko</h3>
                <p className="wizard__review-value" data-testid="review-store-name">
                  {form.storeName || '—'}
                </p>
              </div>

              <div className="wizard__review-block">
                <h3 className="wizard__review-label">Warna Brand</h3>
                <p className="wizard__review-value" data-testid="review-brand-color">
                  <span
                    className="brand-color__swatch"
                    style={{ backgroundColor: isValidBrandColor(form.brandColor) ? form.brandColor : DEFAULT_BRAND_COLOR }}
                    aria-hidden="true"
                  />
                  {form.brandColor || '—'}
                </p>
              </div>

              <div className="wizard__review-block">
                <h3 className="wizard__review-label">Kategori</h3>
                <ul className="wizard__review-list" data-testid="review-categories">
                  {form.categories.map((c, i) => (
                    <li key={i}>
                      <strong>{c.code || '—'}</strong> — {c.name || '—'}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="wizard__review-block">
                <h3 className="wizard__review-label">Counter &amp; Routing</h3>
                <ul className="wizard__review-list" data-testid="review-routing">
                  {form.routingRules.map((r, i) => (
                    <li key={i}>
                      <strong>{r.counterName || 'Counter'}</strong> ({PRIORITY_POLICY_LABELS[r.priorityPolicy]}) →{' '}
                      {r.assignedCategoryCodes.length > 0 ? r.assignedCategoryCodes.join(', ') : 'tidak ada kategori'}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="wizard__review-block">
                <h3 className="wizard__review-label">Alur Status Tiket</h3>
                <p className="wizard__review-value" data-testid="review-state-machine">
                  {form.stateMachine.mode === 'default'
                    ? `Standar — ${form.stateMachine.states.length} state, ${form.stateMachine.transitions.length} transisi`
                    : `Susunan sendiri — ${form.stateMachine.states.length} state, ${form.stateMachine.transitions.length} transisi`}
                </p>
              </div>

              <div className="wizard__review-block">
                <h3 className="wizard__review-label">Kebijakan Reset Harian</h3>
                <p className="wizard__review-value" data-testid="review-daily-reset">
                  {form.dailyReset.mode === 'AUTOMATIC_CRON'
                    ? `Otomatis setiap hari pukul ${cronToTime(form.dailyReset.cronExpression) ?? '00:00'}`
                    : 'Manual (tombol reset)'}
                  {' · '}reset ke {form.dailyReset.resetTicketNumberTo}
                  {' · '}arsip hari sebelumnya: {form.dailyReset.archivePreviousDayData ? 'aktif' : 'nonaktif'}
                </p>
              </div>
            </div>
          </section>
        )}
      </div>

      {error && <p className="wizard__error">Gagal menyimpan: {error}</p>}

      <footer className="wizard__nav">
        <button type="button" className="btn btn--secondary" onClick={back} disabled={step === 1 || submitting}>
          Kembali
        </button>
        {step < TOTAL_STEPS ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={next}
            disabled={(step === 1 && !step1Valid) || (step === 3 && !step3Valid) || (step === 4 && !step4Valid) || submitting}
            data-testid="wizard-next"
          >
            Lanjut
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={finalize} disabled={submitting} data-testid="wizard-finalize">
            {submitting ? 'Menyimpan…' : 'Simpan & Aktifkan'}
          </button>
        )}
      </footer>
    </div>
  );
}

// --- form mutation helpers (kept module-local; pure over the form slice) ----

function updateCategory(form: WizardForm, setForm: (f: WizardForm) => void, i: number, patch: Partial<WizardCategoryDto>) {
  const categories = form.categories.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
  setForm({ ...form, categories });
}
function addCategory(form: WizardForm, setForm: (f: WizardForm) => void) {
  setForm({ ...form, categories: [...form.categories, { code: '', name: '' }] });
}
function removeCategory(form: WizardForm, setForm: (f: WizardForm) => void, i: number) {
  setForm({ ...form, categories: form.categories.filter((_, idx) => idx !== i) });
}

function updateRouting(form: WizardForm, setForm: (f: WizardForm) => void, i: number, patch: Partial<WizardRoutingRuleDto>) {
  const routingRules = form.routingRules.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
  setForm({ ...form, routingRules });
}
/**
 * Sync the routing-rule rows to the counter count entered on step 1. Growing
 * appends default-named counters (`Counter N`, auto `counterId`, empty
 * assignments, `FIFO_GLOBAL`); shrinking truncates. **No renumber** — counter
 * identity (`counterId`, which `QueueTicket.counterId` references) is preserved
 * and gaps are not closed, matching the prior add/remove semantics. The count is
 * clamped `>=1` so the wizard can never construct an empty counter set.
 */
function setCounterCount(form: WizardForm, setForm: (f: WizardForm) => void, count: number) {
  const n = Math.max(1, Math.floor(count) || 1);
  const rules = [...form.routingRules];
  if (rules.length > n) rules.length = n;
  // max(existing counterId)+1, NOT length+1: a re-edit can load a gapped /
  // non-sequential set of counterIds (e.g. `[1, 3, 5]` from a non-wizard editor),
  // and length+1 would collide (duplicate `counterId` 5) — the backend
  // `buildRoutingRules` rejects duplicate counterIds with a 400. No renumber —
  // existing counter identities are preserved (gaps are not closed).
  let nextId = rules.reduce((m, r) => Math.max(m, r.counterId), 0) + 1;
  while (rules.length < n) {
    rules.push({
      counterId: nextId,
      counterName: `Counter ${nextId}`,
      assignedCategoryCodes: [],
      priorityPolicy: 'FIFO_GLOBAL' as PriorityPolicy,
    });
    nextId++;
  }
  setForm({ ...form, routingRules: rules });
}
function toggleRoutingCategory(form: WizardForm, setForm: (f: WizardForm) => void, i: number, code: string, checked: boolean) {
  const routingRules = form.routingRules.map((r, idx) => {
    if (idx !== i) return r;
    const set = new Set(r.assignedCategoryCodes);
    if (checked) set.add(code);
    else set.delete(code);
    return { ...r, assignedCategoryCodes: [...set] };
  });
  setForm({ ...form, routingRules });
}

function updateTransition(form: WizardForm, setForm: (f: WizardForm) => void, i: number, patch: Partial<{ from: string; to: string; actionLabel: string }>) {
  const transitions = form.stateMachine.transitions.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
  setForm({ ...form, stateMachine: { ...form.stateMachine, transitions } });
}
function addTransition(form: WizardForm, setForm: (f: WizardForm) => void) {
  // Seed a new edge from the first state to itself (or empty when no states yet)
  // so the dropdowns always carry a valid value; the manager adjusts from there.
  const firstState = form.stateMachine.states[0] ?? '';
  setForm({
    ...form,
    stateMachine: {
      ...form.stateMachine,
      transitions: [...form.stateMachine.transitions, { from: firstState, to: firstState, actionLabel: '' }],
    },
  });
}
function removeTransition(form: WizardForm, setForm: (f: WizardForm) => void, i: number) {
  setForm({ ...form, stateMachine: { ...form.stateMachine, transitions: form.stateMachine.transitions.filter((_, idx) => idx !== i) } });
}

function updateState(form: WizardForm, setForm: (f: WizardForm) => void, i: number, value: string) {
  const states = form.stateMachine.states.map((s, idx) => (idx === i ? value : s));
  // Renaming a state must propagate to any transition that referenced the old
  // name, so a rename never leaves a dangling edge (the dropdowns would then
  // show the old value which is no longer in the states list).
  const oldName = form.stateMachine.states[i];
  const transitions = form.stateMachine.transitions.map((t) => ({
    from: t.from === oldName ? value : t.from,
    to: t.to === oldName ? value : t.to,
    actionLabel: t.actionLabel,
  }));
  setForm({ ...form, stateMachine: { ...form.stateMachine, states, transitions } });
}
function addState(form: WizardForm, setForm: (f: WizardForm) => void) {
  setForm({ ...form, stateMachine: { ...form.stateMachine, states: [...form.stateMachine.states, ''] } });
}
function removeState(form: WizardForm, setForm: (f: WizardForm) => void, i: number) {
  setForm({ ...form, stateMachine: { ...form.stateMachine, states: form.stateMachine.states.filter((_, idx) => idx !== i) } });
}
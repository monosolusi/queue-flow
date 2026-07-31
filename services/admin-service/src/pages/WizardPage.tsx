import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import {
  type DailyResetMode,
  type PriorityPolicy,
  DEFAULT_STATE_MACHINE,
  DEFAULT_DAILY_RESET,
  type StateMachineDto,
  type WizardCategoryDto,
  type WizardRoutingRuleDto,
} from '../api/types';
import { validateCronExpression } from '../lib/cron';

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

/** The editable wizard form model (mirrors the PUT payload pieces). */
interface WizardForm {
  storeName: string;
  categories: WizardCategoryDto[];
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
    categories: [{ code: 'A', name: '' }],
    routingRules: [{ counterId: 1, counterName: 'Counter 1', assignedCategoryCodes: [], priorityPolicy: 'FIFO_GLOBAL' as PriorityPolicy }],
    stateMachine: defaultStateMachineForm(),
    dailyReset: { ...DEFAULT_DAILY_RESET, cronExpression: DEFAULT_DAILY_RESET.cronExpression ?? '' },
  };
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
 * The first-run setup wizard (FR-WZD-02..06). Five steps:
 *  1. Store name (FR-WZD-02).
 *  2. Counters + categories + routing matrix + priority policy (FR-WZD-03).
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
        setForm({
          storeName: config.storeName,
          categories:
            config.categories.length > 0
              ? config.categories.map((c) => ({ id: c.id, code: c.code, name: c.name }))
              : [{ code: 'A', name: '' }],
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
      await api.saveSystemConfig({
        storeName: form.storeName,
        stateMachine: sm,
        dailyReset: {
          mode: form.dailyReset.mode,
          cronExpression: form.dailyReset.mode === 'AUTOMATIC_CRON' ? form.dailyReset.cronExpression : null,
          resetTicketNumberTo: form.dailyReset.resetTicketNumberTo,
          archivePreviousDayData: form.dailyReset.archivePreviousDayData,
        },
        categories: form.categories,
        routingRules: form.routingRules,
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

      <ol className="wizard__steps-bar">
        {[1, 2, 3, 4, 5].map((n) => (
          <li key={n} className={`wizard__step-dot ${n === step ? 'is-current' : ''} ${n < step ? 'is-done' : ''}`}>
            {n}
          </li>
        ))}
      </ol>

      <div className="wizard__body">
        {step === 1 && (
          <section className="wizard__step" data-testid="step-1">
            <h2 className="wizard__step-title">Nama Toko</h2>
            <label className="field">
              <span className="field__label">Nama toko / cabang</span>
              <input
                className="field__input"
                type="text"
                value={form.storeName}
                onChange={(e) => setForm({ ...form, storeName: e.target.value })}
                placeholder="mis. Apotek Sehat Sentosa"
                autoFocus
              />
            </label>
          </section>
        )}

        {step === 2 && (
          <section className="wizard__step" data-testid="step-2">
            <h2 className="wizard__step-title">Kategori, Counter &amp; Routing</h2>

            <h3 className="wizard__subhead">Kategori</h3>
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
                  />
                  <input
                    className="field__input entry-row__name"
                    type="text"
                    value={cat.name}
                    onChange={(e) => updateCategory(form, setForm, i, { name: e.target.value })}
                    placeholder="Nama kategori"
                    aria-label={`Kategori ${i + 1} nama`}
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

            <h3 className="wizard__subhead">Counter &amp; Routing</h3>
            <ul className="entry-list">
              {form.routingRules.map((rule, i) => (
                <li key={i} className="entry-row entry-row--routing">
                  <input
                    className="field__input entry-row__counter-id"
                    type="number"
                    min={1}
                    value={rule.counterId}
                    onChange={(e) => updateRouting(form, setForm, i, { counterId: Number(e.target.value) })}
                    aria-label={`Counter ${i + 1} id`}
                  />
                  <input
                    className="field__input entry-row__name"
                    type="text"
                    value={rule.counterName}
                    onChange={(e) => updateRouting(form, setForm, i, { counterName: e.target.value })}
                    placeholder="Nama counter"
                    aria-label={`Counter ${i + 1} nama`}
                  />
                  <select
                    className="field__input"
                    value={rule.priorityPolicy}
                    onChange={(e) => updateRouting(form, setForm, i, { priorityPolicy: e.target.value as PriorityPolicy })}
                    aria-label={`Counter ${i + 1} priority policy`}
                  >
                    <option value="FIFO_GLOBAL">FIFO_GLOBAL</option>
                    <option value="CATEGORY_PRIORITY">CATEGORY_PRIORITY</option>
                  </select>
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
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => removeRouting(form, setForm, i)}
                    disabled={form.routingRules.length <= 1}
                  >
                    Hapus
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn--secondary" onClick={() => addRouting(form, setForm)}>
              + Tambah Counter
            </button>
          </section>
        )}

        {step === 3 && (
          <section className="wizard__step" data-testid="step-3">
            <h2 className="wizard__step-title">State Machine</h2>
            <p className="wizard__hint">
              Pilih state machine default (PRD §7) atau susun sendiri. Label aksi menjadi tombol di panel caller.
            </p>

            <fieldset className="radio-group" data-testid="sm-mode">
              <legend>Jenis state machine</legend>
              <label className="radio-group__item">
                <input
                  type="radio"
                  name="sm-mode"
                  value="default"
                  checked={form.stateMachine.mode === 'default'}
                  onChange={() => setForm({ ...form, stateMachine: defaultStateMachineForm() })}
                />
                Gunakan state machine default (PRD §7)
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
                Susun state machine sendiri
              </label>
            </fieldset>

            {form.stateMachine.mode === 'default' ? (
              <div className="sm-readonly" data-testid="sm-readonly">
                <p className="wizard__hint">State machine default (read-only):</p>
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
              <div className="sm-editor" data-testid="sm-editor">
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
                  <ul className="wizard__errors" data-testid="sm-errors">
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
                <option value="AUTOMATIC_CRON">Otomatis (cron)</option>
                <option value="MANUAL">Manual</option>
              </select>
            </label>
            {form.dailyReset.mode === 'AUTOMATIC_CRON' && (
              <label className="field">
                <span className="field__label">Cron expression</span>
                <input
                  className="field__input"
                  type="text"
                  value={form.dailyReset.cronExpression}
                  onChange={(e) => setForm({ ...form, dailyReset: { ...form.dailyReset, cronExpression: e.target.value } })}
                  placeholder="0 0 * * *"
                  aria-label="Cron expression"
                />
                {cronError && (
                  <span className="field__error" data-testid="cron-error">
                    {cronError}
                  </span>
                )}
              </label>
            )}
            <label className="field">
              <span className="field__label">Reset nomor antrian ke</span>
              <input
                className="field__input"
                type="number"
                min={1}
                value={form.dailyReset.resetTicketNumberTo}
                onChange={(e) =>
                  setForm({ ...form, dailyReset: { ...form.dailyReset, resetTicketNumberTo: Number(e.target.value) } })
                }
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
                      <strong>{r.counterName || `Counter ${r.counterId}`}</strong> ({r.priorityPolicy}) →{' '}
                      {r.assignedCategoryCodes.length > 0 ? r.assignedCategoryCodes.join(', ') : 'tidak ada kategori'}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="wizard__review-block">
                <h3 className="wizard__review-label">State Machine</h3>
                <p className="wizard__review-value" data-testid="review-state-machine">
                  {form.stateMachine.mode === 'default'
                    ? `Default (PRD §7) — ${form.stateMachine.states.length} state, ${form.stateMachine.transitions.length} transisi`
                    : `Custom — ${form.stateMachine.states.length} state, ${form.stateMachine.transitions.length} transisi`}
                </p>
              </div>

              <div className="wizard__review-block">
                <h3 className="wizard__review-label">Kebijakan Reset Harian</h3>
                <p className="wizard__review-value" data-testid="review-daily-reset">
                  {form.dailyReset.mode === 'AUTOMATIC_CRON'
                    ? `Otomatis (cron: ${form.dailyReset.cronExpression || '—'})`
                    : 'Manual'}
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
            disabled={(step === 3 && !step3Valid) || (step === 4 && !step4Valid) || submitting}
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
function addRouting(form: WizardForm, setForm: (f: WizardForm) => void) {
  setForm({
    ...form,
    routingRules: [
      ...form.routingRules,
      { counterId: form.routingRules.length + 1, counterName: `Counter ${form.routingRules.length + 1}`, assignedCategoryCodes: [], priorityPolicy: 'FIFO_GLOBAL' },
    ],
  });
}
function removeRouting(form: WizardForm, setForm: (f: WizardForm) => void, i: number) {
  setForm({ ...form, routingRules: form.routingRules.filter((_, idx) => idx !== i) });
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
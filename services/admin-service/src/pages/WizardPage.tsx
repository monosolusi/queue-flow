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

/** The editable wizard form model (mirrors the PUT payload pieces). */
interface WizardForm {
  storeName: string;
  categories: WizardCategoryDto[];
  routingRules: WizardRoutingRuleDto[];
  stateMachine: { states: string[]; transitions: { from: string; to: string; actionLabel: string }[] };
  dailyReset: { mode: DailyResetMode; cronExpression: string; resetTicketNumberTo: number; archivePreviousDayData: boolean };
}

const TOTAL_STEPS = 4;

function emptyForm(): WizardForm {
  return {
    storeName: '',
    categories: [{ code: 'A', name: '' }],
    routingRules: [{ counterId: 1, counterName: 'Counter 1', assignedCategoryCodes: [], priorityPolicy: 'FIFO_GLOBAL' as PriorityPolicy }],
    stateMachine: { states: [...DEFAULT_STATE_MACHINE.states], transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })) },
    dailyReset: { ...DEFAULT_DAILY_RESET, cronExpression: DEFAULT_DAILY_RESET.cronExpression ?? '' },
  };
}

/**
 * The first-run setup wizard (FR-WZD-02..06). Four steps:
 *  1. Store name (FR-WZD-02).
 *  2. Counters + categories + routing matrix + priority policy (FR-WZD-03).
 *  3. State-machine designer — states + transitions + Indonesian action labels,
 *     PRD §7 default graph prefilled (FR-WZD-04).
 *  4. Daily-reset policy — mode/cron/resetTo/archive (FR-WZD-05).
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
        setForm({
          storeName: config.storeName,
          categories:
            config.categories.length > 0
              ? config.categories.map((c) => ({ code: c.code, name: c.name }))
              : [{ code: 'A', name: '' }],
          routingRules:
            config.routingRules.length > 0
              ? config.routingRules.map((r) => ({
                  counterId: r.counterId,
                  counterName: r.counterName,
                  assignedCategoryCodes: [],
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

  const next = () => setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  const back = () => setStep((s) => Math.max(1, s - 1));

  async function finalize() {
    setSubmitting(true);
    setError(null);
    try {
      await api.saveSystemConfig({
        storeName: form.storeName,
        stateMachine: form.stateMachine as StateMachineDto,
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
        {[1, 2, 3, 4].map((n) => (
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
              Transisi default dari PRD §7 sudah terisi. Label aksi menjadi tombol di panel caller.
            </p>
            <ul className="entry-list">
              {form.stateMachine.transitions.map((t, i) => (
                <li key={i} className="entry-row entry-row--transition">
                  <input
                    className="field__input entry-row__state"
                    type="text"
                    value={t.from}
                    onChange={(e) => updateTransition(form, setForm, i, { from: e.target.value.toUpperCase() })}
                    aria-label={`Transisi ${i + 1} from`}
                  />
                  <span className="entry-row__arrow">→</span>
                  <input
                    className="field__input entry-row__state"
                    type="text"
                    value={t.to}
                    onChange={(e) => updateTransition(form, setForm, i, { to: e.target.value.toUpperCase() })}
                    aria-label={`Transisi ${i + 1} to`}
                  />
                  <input
                    className="field__input entry-row__label"
                    type="text"
                    value={t.actionLabel}
                    onChange={(e) => updateTransition(form, setForm, i, { actionLabel: e.target.value })}
                    placeholder="Label aksi (Indonesia)"
                    aria-label={`Transisi ${i + 1} label aksi`}
                  />
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn--secondary" onClick={() => addTransition(form, setForm)}>
              + Tambah Transisi
            </button>
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
                />
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
      </div>

      {error && <p className="wizard__error">Gagal menyimpan: {error}</p>}

      <footer className="wizard__nav">
        <button type="button" className="btn btn--secondary" onClick={back} disabled={step === 1 || submitting}>
          Kembali
        </button>
        {step < TOTAL_STEPS ? (
          <button type="button" className="btn btn--primary" onClick={next} data-testid="wizard-next">
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
  setForm({ ...form, stateMachine: { ...form.stateMachine, transitions: [...form.stateMachine.transitions, { from: '', to: '', actionLabel: '' }] } });
}
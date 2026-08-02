import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type {
  DailyResetMode,
  PriorityPolicy,
  StateMachineDto,
  SystemConfigurationDto,
} from '../api/types';
import { validateCronExpression } from '../lib/cron';

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
  assignedCategoryCodes: string[];
  priorityPolicy: PriorityPolicy;
}

interface AdminForm {
  /** Passthrough — read-only here; the wizard owns store-name editing. */
  storeName: string;
  /** Passthrough — read-only here; the wizard owns state-machine editing. */
  stateMachine: StateMachineDto;
  categories: CategoryRow[];
  routingRules: RoutingRow[];
  dailyReset: {
    mode: DailyResetMode;
    cronExpression: string;
    resetTicketNumberTo: number;
    archivePreviousDayData: boolean;
  };
}

type PanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; form: AdminForm };

/**
 * The operational configuration panel (FR-ADM-01 / QUE-24). After first-run
 * setup the manager edits the three operational areas here — categories,
 * counter routing, and the daily-reset policy — without re-running the guided
 * wizard. The store name and state machine stay read-only (the wizard owns
 * those; an "Ubah Konfigurasi" link re-opens it).
 *
 * The panel is a thin editor over the existing config save surface: it loads
 * the full config (`GET /api/system/config`), lets the manager edit the three
 * in-scope sections, and PUTs the full payload back (`PUT /api/system/config`)
 * — passing the unchanged `storeName` + `stateMachine` through. That reuses
 * the single atomic, audited save use case (DRY — no duplicated audit/tx
 * wiring). Category ids are preserved across edits so re-save does not orphan
 * tickets' `categoryId`; routing `assignedCategoryIds` are mapped to codes on
 * load (the PUT expects codes). The panel consumes only `IAdminApi` (ISP) and
 * owns no realtime/WS surface (SRP).
 */
export function AdminPanel({ api }: { api: IAdminApi }) {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Synchronous in-flight guard so two clicks in the same tick produce exactly
  // one save (mirrors the kiosk double-tap guard; `disabled` alone lags a
  // re-render).
  const submittingRef = useRef(false);

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
  }, [api]);

  // Derived from `state` so the hook order is stable across loading/ready
  // (Rules of Hooks: hooks must run before any early return).
  const categoryCodes = useMemo(
    () => (state.status === 'ready' ? state.form.categories.map((c) => c.code) : []),
    [state],
  );

  if (state.status === 'loading') {
    return <div className="admin-panel admin-panel--loading">Memuat konfigurasi…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="admin-panel">
        <p className="admin-panel__error">Gagal memuat konfigurasi: {state.message}</p>
        <Link className="btn btn--primary" to="/wizard">
          Buka Wizard
        </Link>
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
  const dailyResetValid = cronError === null;

  async function save() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSaveError(null);
    try {
      await api.saveSystemConfig({
        storeName: form.storeName,
        stateMachine: form.stateMachine,
        dailyReset: {
          mode: form.dailyReset.mode,
          cronExpression:
            form.dailyReset.mode === 'AUTOMATIC_CRON' ? form.dailyReset.cronExpression : null,
          resetTicketNumberTo: form.dailyReset.resetTicketNumberTo,
          archivePreviousDayData: form.dailyReset.archivePreviousDayData,
        },
        // Preserve `id` on existing categories; omit it for rows added this
        // session so the backend mints fresh ids.
        categories: form.categories.map((c) =>
          c.id ? { id: c.id, code: c.code, name: c.name } : { code: c.code, name: c.name },
        ),
        routingRules: form.routingRules,
        actor: 'admin',
      });
      setSavedAt(Date.now());
      // Reload so newly added categories get their server-minted ids into the
      // form (keeps a subsequent edit id-stable) and the UI reflects saved state.
      const config = await api.getSystemConfig();
      setState({ status: 'ready', form: toForm(config) });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="admin-panel">
      <header className="admin-panel__header">
        <div>
          <h1 className="admin-panel__title">{form.storeName || 'QMS Admin'}</h1>
          <p className="admin-panel__subtitle">Konfigurasi Operasional</p>
        </div>
        <div className="admin-panel__nav">
          <Link className="btn btn--secondary" to="/analytics">
            Analitik
          </Link>
          <Link className="btn btn--secondary" to="/wizard">
            Ubah Konfigurasi (Wizard)
          </Link>
        </div>
      </header>

      {savedAt && !saveError && (
        <p className="admin-panel__success" role="status">
          Konfigurasi tersimpan.
        </p>
      )}
      {saveError && <p className="admin-panel__error">Gagal menyimpan: {saveError}</p>}

      {/* Categories — add / edit / remove (FR-ADM-01). */}
      <section className="config-card">
        <h2 className="config-card__title">Kategori</h2>
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
              />
              <input
                className="field__input entry-row__name"
                type="text"
                value={cat.name}
                onChange={(e) => updateCategory(form, setState, i, { name: e.target.value })}
                placeholder="Nama kategori"
                aria-label={`Kategori ${i + 1} nama`}
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

      {/* Counter & routing — add / edit / remove + category assignment (FR-ADM-01). */}
      <section className="config-card">
        <h2 className="config-card__title">Counter &amp; Routing</h2>
        <ul className="entry-list">
          {form.routingRules.map((rule, i) => (
            <li key={rule.rowKey} className="entry-row entry-row--routing">
              <input
                className="field__input entry-row__counter-id"
                type="number"
                min={1}
                value={rule.counterId}
                onChange={(e) => updateRouting(form, setState, i, { counterId: Number(e.target.value) })}
                aria-label={`Counter ${i + 1} id`}
              />
              <input
                className="field__input entry-row__name"
                type="text"
                value={rule.counterName}
                onChange={(e) => updateRouting(form, setState, i, { counterName: e.target.value })}
                placeholder="Nama counter"
                aria-label={`Counter ${i + 1} nama`}
              />
              <select
                className="field__input"
                value={rule.priorityPolicy}
                onChange={(e) => updateRouting(form, setState, i, { priorityPolicy: e.target.value as PriorityPolicy })}
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
                      onChange={(e) => toggleRoutingCategory(form, setState, i, code, e.target.checked)}
                    />
                    {code}
                  </label>
                ))}
              </fieldset>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => removeRouting(form, setState, i)}
                disabled={form.routingRules.length <= 1}
              >
                Hapus
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn--secondary" onClick={() => addRouting(form, setState)}>
          + Tambah Counter
        </button>
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
              onChange={(e) =>
                setState({ status: 'ready', form: { ...form, dailyReset: { ...form.dailyReset, cronExpression: e.target.value } } })
              }
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
              setState({
                status: 'ready',
                form: { ...form, dailyReset: { ...form.dailyReset, resetTicketNumberTo: Number(e.target.value) } },
              })
            }
          />
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
          Perubahan cron/mode berlaku setelah restart layanan (scheduler di-armed saat boot).
        </p>
      </section>

      {/* Read-only state machine — the wizard owns editing (out of QUE-24 scope). */}
      <section className="config-card">
        <h2 className="config-card__title">State Machine (read-only)</h2>
        <ul className="transition-list">
          {form.stateMachine.transitions.map((t, i) => (
            <li key={i} className="transition-list__item">
              <span className="transition-list__state">{t.from}</span>
              <span className="transition-list__arrow">→</span>
              <span className="transition-list__state">{t.to}</span>
              <span className="transition-list__label">{t.actionLabel}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="admin-panel__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={save}
          disabled={submitting || !dailyResetValid}
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
    stateMachine: config.stateMachine,
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
function toggleRoutingCategory(
  form: AdminForm,
  setState: (s: PanelState) => void,
  i: number,
  code: string,
  checked: boolean,
) {
  const routingRules = form.routingRules.map((r, idx) => {
    if (idx !== i) return r;
    const set = new Set(r.assignedCategoryCodes);
    if (checked) set.add(code);
    else set.delete(code);
    return { ...r, assignedCategoryCodes: [...set] };
  });
  setState({ status: 'ready', form: { ...form, routingRules } });
}
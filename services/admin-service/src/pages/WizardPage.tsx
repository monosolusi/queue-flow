import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IAdminApi, IAuthApi } from '../api/admin-api';
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
  type ServiceThemesMap,
  DEFAULT_SERVICE_THEMES,
} from '../api/types';
import { writeToken } from '../auth/token-store';
import { validateCronExpression } from '../lib/cron';
import { validateBrandColor, isValidBrandColor } from '../lib/brand-color';
import { DAILY_RESET_MODE_LABELS } from '../lib/labels';
import { timeToCron, cronToTime } from '../lib/daily-reset';
import { BROWSER_TIMEZONE, timezoneSelectOptions } from '../lib/timezone';
import { validateCustomCategories, validateResetTo } from '../lib/categories';
import { RoutingGraph } from '../components/RoutingGraph';
import { CounterRoutingEditor } from '../components/CounterRoutingEditor';

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
  // Per-service light/dark theme map (QUE-47). Payload-only here — the wizard
  // carries no theme UI (the admin panel owns the per-service settings surface);
  // the field is prefilled from GET and passed through finalize so the required
  // `serviceThemes` wire field is always sent on the PUT (never dropped).
  serviceThemes: ServiceThemesMap;
  categories: WizardCategoryDto[];
  categoriesMode: 'default' | 'custom';
  /** Raw text value of the step-1 "Jumlah counter aktif" input (digits only,
   *  empty allowed). Kept separate from `routingRules.length` (the routing-rule
   *  source of truth) so the manager can clear the field — a number input bound
   *  to `routingRules.length` snaps back to the clamped length on clear, making
   *  the number impossible to delete. `routingRules` stays at its last valid
   *  state while the field is empty/invalid; `step1Valid` blocks advance. */
  counterCount: string;
  routingRules: WizardRoutingRuleDto[];
  stateMachine: StateMachineForm;
  dailyReset: {
    mode: DailyResetMode;
    cronExpression: string;
    resetTicketNumberTo: number;
    archivePreviousDayData: boolean;
    /** IANA timezone the daily-reset cron fires in (QUE-42). */
    timezone: string;
  };
  /** First-run admin credentials (QUE-43). Only entered on the first-run path;
   *  on a re-edit (setup already complete) the step-5 form is hidden and these
   *  fields are ignored by finalize. The username/password invariants mirror
   *  core-api's `Username` VO + password-≥8 guard so the wizard never submits a
   *  shape the `POST /api/auth/setup-admin` endpoint would 400. */
  adminUsername: string;
  adminPassword: string;
  adminPasswordConfirm: string;
}

const TOTAL_STEPS = 6;

/**
 * Computes the UTC offset (`UTC±HH:MM`, zero-padded) of a given IANA timezone
 * using `Intl.DateTimeFormat`. The offset is computed for "now" so it reflects
 * current DST rules (a zone with seasonal DST flips its offset through the
 * year). Falls back to the browser's offset when `tz` is empty or unresolvable
 * (defensive — the constrained `<select>` never produces an unresolvable
 * value, so this is belt-and-suspenders). The `Intl` `shortOffset` format
 * returns variable-width strings like `GMT+7` / `GMT-4` / `GMT+5:30`, so we
 * parse the sign + hours + minutes and re-emit zero-padded `UTC±HH:MM` to
 * match the existing test regex (`UTC[+-]\d{2}:\d{2}`).
 */
function tzOffsetFor(tz: string): string {
  if (!tz) return formatTzOffset(-new Date().getTimezoneOffset());
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(new Date());
    const offsetPart = parts.find((p) => p.type === 'timeZoneName');
    if (offsetPart) {
      const match = /^GMT([+-])(\d{1,2})(?::(\d{1,2}))?$/.exec(offsetPart.value);
      if (match) {
        const sign = match[1];
        const hh = String(Number(match[2])).padStart(2, '0');
        const mm = match[3] ? String(Number(match[3])).padStart(2, '0') : '00';
        return `UTC${sign}${hh}:${mm}`;
      }
      // A bare `GMT` (no offset, for UTC itself) → `UTC+00:00`.
      if (offsetPart.value === 'GMT') return 'UTC+00:00';
    }
  } catch {
    // fall through to browser offset
  }
  return formatTzOffset(-new Date().getTimezoneOffset());
}

function formatTzOffset(totalMinutes: number): string {
  const sign = totalMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(totalMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

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
    serviceThemes: { ...DEFAULT_SERVICE_THEMES },
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    categoriesMode: 'default',
    counterCount: '1',
    routingRules: [{ counterId: 1, counterName: 'Counter 1', assignedCategoryCodes: [], priorityPolicy: 'FIFO_GLOBAL' as PriorityPolicy }],
    stateMachine: defaultStateMachineForm(),
    dailyReset: {
      ...DEFAULT_DAILY_RESET,
      cronExpression: DEFAULT_DAILY_RESET.cronExpression ?? '',
      timezone: BROWSER_TIMEZONE,
    },
    adminUsername: '',
    adminPassword: '',
    adminPasswordConfirm: '',
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

/** Username invariant mirror (QUE-43 — mirrors core-api's `Username` VO). */
const ADMIN_USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const ADMIN_PASSWORD_MIN = 8;

/**
 * Validates the first-run admin credentials (step 5), mirroring the backend
 * `Username` / password invariants so the wizard never submits credentials the
 * `POST /api/auth/setup-admin` endpoint would 400. Returns a list of Indonesian
 * error strings; empty means valid. Mirrors the per-step validation pattern.
 */
function validateAdminCredentials(form: WizardForm): string[] {
  const errors: string[] = [];
  if (!ADMIN_USERNAME_RE.test(form.adminUsername)) {
    errors.push('Username 3–32 karakter (huruf, angka, titik, garis bawah, strip).');
  }
  if (form.adminPassword.length < ADMIN_PASSWORD_MIN) {
    errors.push(`Kata sandi minimal ${ADMIN_PASSWORD_MIN} karakter.`);
  }
  if (form.adminPassword !== form.adminPasswordConfirm) {
    errors.push('Konfirmasi kata sandi tidak cocok.');
  }
  return errors;
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
 * The first-run setup wizard (FR-WZD-02..06). Six steps:
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
 *  5. Admin credentials (QUE-43) — first-run only: the manager picks the initial
 *     administrator username + password (mirrors the backend `Username` /
 *     password-≥8 invariants). On a re-edit (setup already complete) the step is
 *     a read-only notice and finalize skips setup-admin + login.
 *  6. Review — a read-only summary of the whole assembled configuration before
 *     the manager activates it (FR-WZD-06). No API call; renders from the
 *     in-memory form. The `Simpan & Aktifkan` button lives here.
 *
 * On mount it loads the current config (`GET /api/system/config`) to prefill the
 * form, so the wizard also serves as a re-editor after initial setup. On
 * finalize (first-run) it calls `POST /api/auth/setup-admin` (before the config
 * save, since setup-admin only works while setup is incomplete), then
 * `PUT /api/system/config` (which flips `isInitialSetupCompleted` server-side),
 * then `POST /api/auth/login` + stores the token, and navigates to `/`. On a
 * re-edit it just saves the config (the admin is already authenticated). The
 * wizard owns no realtime/WS surface (SRP).
 */
export function WizardPage({ api }: { api: IAdminApi & IAuthApi }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<WizardForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether this is a first-run (setup not yet complete) vs a re-edit (setup
  // already complete). Decides whether finalize runs the setup-admin + login
  // dance (first-run) or just saves the config (re-edit — the admin is already
  // authenticated). Read from the prefill config's `isInitialSetupCompleted`.
  const isFirstRun = useRef(true);
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
        isFirstRun.current = !config.isInitialSetupCompleted;
        const routingRules =
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
                  priorityPolicy: 'FIFO_GLOBAL' as PriorityPolicy,
                },
              ];
        setForm({
          storeName: config.storeName,
          brandColor: config.brandColor || DEFAULT_BRAND_COLOR,
          serviceThemes: config.serviceThemes
            ? { ...DEFAULT_SERVICE_THEMES, ...config.serviceThemes }
            : { ...DEFAULT_SERVICE_THEMES },
          categories: loadedCategories,
          // Infer the preset by code+name deep-equal (id-agnostic) so a re-edit
          // of a store that kept the default template stays in default mode and
          // re-uses the existing category ids (preserved at finalize).
          categoriesMode: isDefaultCategories(loadedCategories) ? 'default' : 'custom',
          counterCount: String(routingRules.length),
          routingRules,
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
            timezone: config.dailyResetPolicy.timezone,
          },
          // The admin credentials are only entered on the first-run path; on a
          // re-edit (setup already complete) the step-5 form is hidden and
          // finalize ignores these fields, so blank them on prefill.
          adminUsername: '',
          adminPassword: '',
          adminPasswordConfirm: '',
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

  // code→name lookup for Step 2 was hoisted into the shared
  // `CounterRoutingEditor` (the editor builds its own). `RoutingGraph` on
  // Step 5 builds its own code→name map as well, so no shared lookup is needed
  // here anymore.

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
  // Step 1 counter-count validation. The text input is clearable (the manager
  // could not delete the number in the old number input — it snapped back to the
  // clamped length), but the count must be a positive integer to advance, so an
  // empty or non-positive field blocks Lanjut. Mirrors the step-1 category/brand
  // color guard pattern: one error list drives both the inline UI and the guard.
  const counterCountErrors = useMemo(() => {
    const n = Number(form.counterCount);
    if (form.counterCount === '') return ['Jumlah counter aktif wajib diisi.'];
    if (!Number.isInteger(n) || n < 1) return ['Jumlah counter aktif minimal 1.'];
    return [];
  }, [form.counterCount]);
  const storeNameError = form.storeName.trim() ? null : 'Nama toko tidak boleh kosong.';
  const step1Valid =
    storeNameError === null &&
    catErrors.length === 0 &&
    brandColorErrors.length === 0 &&
    counterCountErrors.length === 0;

  // Step 2 routing validity (FR-WZD-03): at least one counter must serve at
  // least one category before the manager can advance. An all-empty routing
  // matrix is a degenerate config (every counter is dead — no ticket can ever
  // be routed), and the feedback was that the manager could sail past step 2
  // without assigning anything. This guard mirrors the step-1/3/4 guard
  // pattern: drive both the inline hint and the Lanjut disabled state from one
  // boolean so the UI and the `next()` guard share a single source of truth.
  // Minimal-by-design: it blocks only the fully-unassigned matrix ("belum ada
  // kategori dilayani"), not a counter that happens to be idle while another is
  // wired — a per-counter "every counter must serve ≥1" rule would over-restrict
  // legitimate multi-counter layouts and is not what the feedback asked for.
  const step2Valid = useMemo(
    () => form.routingRules.some((r) => r.assignedCategoryCodes.length > 0),
    [form.routingRules],
  );

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
  const resetToError = useMemo(
    () => validateResetTo(form.dailyReset.resetTicketNumberTo),
    [form.dailyReset.resetTicketNumberTo],
  );
  const step4Valid = cronError === null && resetToError === null;

  // Step 5 admin credentials (first-run only). On a re-edit (setup already
  // complete) the step is a read-only notice and always valid — there is nothing
  // to enter and finalize never calls setup-admin. On first-run the
  // username/password/confirm invariants (mirroring the backend VOs) drive both
  // the inline UI and the Lanjut guard.
  const adminCredErrors = useMemo(
    () => (isFirstRun.current ? validateAdminCredentials(form) : []),
    [form],
  );
  const step5Valid = adminCredErrors.length === 0;

  const next = () => {
    // Block advancing past step 1 while the custom category list is invalid so
    // the manager never reaches the routing matrix with categories the backend
    // would 400 on save.
    if (step === 1 && !step1Valid) return;
    // Block advancing past step 2 while no counter serves any category so the
    // manager never reaches the state-machine step with a degenerate (all-empty)
    // routing matrix — matches the Lanjut disabled state (single source of
    // truth: step2Valid).
    if (step === 2 && !step2Valid) return;
    // Block advancing past step 3 while the custom state machine is invalid so
    // the manager never reaches finalize with a graph the backend would 400.
    if (step === 3 && !step3Valid) return;
    // Block advancing past step 4 while the cron is malformed so the manager
    // never reaches the review step with a cron the scheduler would reject.
    if (step === 4 && !step4Valid) return;
    // Block advancing past step 5 while the first-run admin credentials are
    // invalid so the manager never reaches the review step with credentials the
    // setup-admin endpoint would 400.
    if (step === 5 && !step5Valid) return;
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
      // On first-run, create the initial admin BEFORE saving the config —
      // `POST /api/auth/setup-admin` only works while `isInitialSetupCompleted`
      // is false, and `PUT /api/system/config` flips it true server-side, so the
      // order is load-bearing (setup-admin first, then the config save that
      // completes setup). The audit actor is now the authenticated admin's
      // username (server-derived from the bearer token), so the PUT payload no
      // longer carries `actor` — on this pre-setup path there is no token yet,
      // so the server uses a 'system' sentinel (no client change needed beyond
      // dropping the field). On a re-edit (setup already complete) the admin is
      // already authenticated, so skip setup-admin + login and just save.
      if (isFirstRun.current) {
        await api.setupInitialAdmin(form.adminUsername, form.adminPassword);
      }
      await api.saveSystemConfig({
        storeName: form.storeName,
        stateMachine: sm,
        dailyReset: {
          mode: form.dailyReset.mode,
          cronExpression: form.dailyReset.mode === 'AUTOMATIC_CRON' ? form.dailyReset.cronExpression : null,
          resetTicketNumberTo: form.dailyReset.resetTicketNumberTo,
          archivePreviousDayData: form.dailyReset.archivePreviousDayData,
          timezone: form.dailyReset.timezone,
        },
        categories,
        routingRules: form.routingRules,
        brandColor: form.brandColor,
        serviceThemes: form.serviceThemes,
      });
      if (isFirstRun.current) {
        // Now that setup-admin created the account and the config save completed
        // setup, log in with the just-created credentials and store the token so
        // the operational routes (gated by RequireAuth) admit the manager.
        const { token } = await api.login(form.adminUsername, form.adminPassword);
        writeToken(token);
      }
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
        {[1, 2, 3, 4, 5, 6].map((n) => (
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
                {...describedBy('store-name-errors', storeNameError !== null)}
              />
              {storeNameError !== null && (
                <ul className="wizard__errors" id="store-name-errors" data-testid="store-name-errors">
                  <li>{storeNameError}</li>
                </ul>
              )}
            </label>

            <label className="field">
              <span className="field__label">
                Jumlah counter aktif<span aria-hidden="true"> *</span>
              </span>
              <input
                className="field__input"
                type="text"
                inputMode="numeric"
                value={form.counterCount}
                onChange={(e) => setCounterCount(form, setForm, e.target.value)}
                aria-label="Jumlah counter aktif"
                aria-required="true"
                {...describedBy('counter-count-errors', counterCountErrors.length > 0)}
              />
            </label>
            {counterCountErrors.length > 0 && (
              <ul className="wizard__errors" id="counter-count-errors" data-testid="counter-count-errors">
                {counterCountErrors.map((msg) => (
                  <li key={msg}>{msg}</li>
                ))}
              </ul>
            )}

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
              Pasang kategori yang dilayani tiap counter. Jumlah counter diatur di Langkah 1. Klik
              Edit untuk mengubah kategori yang dilayani.
            </p>

            <CounterRoutingEditor
              routingRules={form.routingRules}
              categories={form.categories}
              onUpdate={(i, patch) => updateRouting(form, setForm, i, patch)}
              idPrefix="routing"
            />

            {!step2Valid && (
              <p className="wizard__hint wizard__hint--required" data-testid="routing-empty-hint">
                Pilih minimal satu kategori pada salah satu counter untuk melanjutkan.
              </p>
            )}
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
              <>
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
                <label className="field">
                  <span className="field__label">Zona waktu</span>
                  <select
                    className="field__input"
                    value={form.dailyReset.timezone}
                    onChange={(e) =>
                      setForm({ ...form, dailyReset: { ...form.dailyReset, timezone: e.target.value } })
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
                  {/* The hint shows the selected zone's UTC offset (not the
                      browser's) so the manager sees which offset the cron
                      fires in. `data-testid="tz-hint"` is retained so the
                      existing test's `Waktu setempat: <zone> (UTC±HH:MM)`
                      regex still matches (loosened, CI-machine tz-agnostic). */}
                  <p className="wizard__hint" data-testid="tz-hint">
                    Waktu setempat: {form.dailyReset.timezone} ({tzOffsetFor(form.dailyReset.timezone)})
                  </p>
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
                  setForm({ ...form, dailyReset: { ...form.dailyReset, resetTicketNumberTo: Number(e.target.value) } })
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
                  setForm({ ...form, dailyReset: { ...form.dailyReset, archivePreviousDayData: e.target.checked } })
                }
              />
              <span>Arsipkan data hari sebelumnya</span>
            </label>
          </section>
        )}

        {step === 5 && (
          <section className="wizard__step" data-testid="step-5">
            <h2 className="wizard__step-title">Kredensial Administrator</h2>
            {isFirstRun.current ? (
              <>
                <p className="wizard__hint">
                  Buat akun administrator pertama. Kredensial ini dipakai untuk masuk setelah setup selesai.
                </p>
                <label className="field" htmlFor="admin-username">
                  <span className="field__label">
                    Username<span aria-hidden="true"> *</span>
                  </span>
                  <input
                    id="admin-username"
                    className="field__input"
                    type="text"
                    value={form.adminUsername}
                    onChange={(e) => setForm({ ...form, adminUsername: e.target.value })}
                    autoComplete="off"
                    required
                    aria-required="true"
                    {...describedBy('admin-cred-errors', adminCredErrors.length > 0)}
                    data-testid="admin-username"
                  />
                </label>
                <label className="field" htmlFor="admin-password">
                  <span className="field__label">
                    Kata sandi<span aria-hidden="true"> *</span>
                  </span>
                  <input
                    id="admin-password"
                    className="field__input"
                    type="password"
                    value={form.adminPassword}
                    onChange={(e) => setForm({ ...form, adminPassword: e.target.value })}
                    autoComplete="new-password"
                    required
                    aria-required="true"
                    {...describedBy('admin-cred-errors', adminCredErrors.length > 0)}
                    data-testid="admin-password"
                  />
                </label>
                <label className="field" htmlFor="admin-password-confirm">
                  <span className="field__label">
                    Konfirmasi kata sandi<span aria-hidden="true"> *</span>
                  </span>
                  <input
                    id="admin-password-confirm"
                    className="field__input"
                    type="password"
                    value={form.adminPasswordConfirm}
                    onChange={(e) => setForm({ ...form, adminPasswordConfirm: e.target.value })}
                    autoComplete="new-password"
                    required
                    aria-required="true"
                    {...describedBy('admin-cred-errors', adminCredErrors.length > 0)}
                    data-testid="admin-password-confirm"
                  />
                </label>
                {adminCredErrors.length > 0 && (
                  <ul className="wizard__errors" id="admin-cred-errors" data-testid="admin-cred-errors">
                    {adminCredErrors.map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="wizard__hint" data-testid="admin-readonly">
                Akun administrator sudah dibuat saat setup awal. Kelola pengguna di halaman Pengguna.
              </p>
            )}
          </section>
        )}

        {step === 6 && (
          <section className="wizard__step" data-testid="step-6">
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
                <RoutingGraph
                  routingRules={form.routingRules}
                  categories={form.categories}
                />
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
                    ? `Otomatis setiap hari pukul ${cronToTime(form.dailyReset.cronExpression) ?? '00:00'} Waktu setempat (${form.dailyReset.timezone}, ${tzOffsetFor(form.dailyReset.timezone)})`
                    : 'Manual (tombol reset)'}
                  {' · '}reset ke {form.dailyReset.resetTicketNumberTo}
                  {' · '}arsip hari sebelumnya: {form.dailyReset.archivePreviousDayData ? 'aktif' : 'nonaktif'}
                </p>
              </div>

              {isFirstRun.current && (
                <div className="wizard__review-block">
                  <h3 className="wizard__review-label">Administrator</h3>
                  <p className="wizard__review-value" data-testid="review-admin-username">
                    {form.adminUsername || '—'}
                  </p>
                </div>
              )}
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
            disabled={(step === 1 && !step1Valid) || (step === 2 && !step2Valid) || (step === 3 && !step3Valid) || (step === 4 && !step4Valid) || (step === 5 && !step5Valid) || submitting}
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
 * Sync the routing-rule rows to the counter count text entered on step 1.
 * The input is a free-text field (digits only, empty allowed) so the manager
 * can clear the number — but clearing or entering an invalid value leaves the
 * field empty/invalid and the Lanjut guard blocks advance (the routingRules are
 * left at their last valid state, never emptied). Growing appends default-named
 * counters (`Counter N`, auto `counterId`, empty assignments, `FIFO_GLOBAL`);
 * shrinking truncates. **No renumber** — counter identity (`counterId`, which
 * `QueueTicket.counterId` references) is preserved and gaps are not closed.
 */
function setCounterCount(form: WizardForm, setForm: (f: WizardForm) => void, raw: string) {
  // Digits only; allow empty so the field can be cleared.
  const count = raw.replace(/[^0-9]/g, '');
  const n = Number(count);
  if (count !== '' && Number.isInteger(n) && n >= 1) {
    const rules = [...form.routingRules];
    if (rules.length > n) rules.length = n;
    // max(existing counterId)+1, NOT length+1: a re-edit can load a gapped /
    // non-sequential set of counterIds (e.g. `[1, 3, 5]` from a non-wizard
    // editor), and length+1 would collide (duplicate `counterId` 5) — the
    // backend `buildRoutingRules` rejects duplicate counterIds with a 400. No
    // renumber — existing counter identities are preserved (gaps are not
    // closed).
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
    setForm({ ...form, counterCount: count, routingRules: rules });
  } else {
    // Empty or invalid (e.g. "0"): store the raw text but leave routingRules at
    // their last valid state. step1Valid blocks advance while empty/invalid.
    setForm({ ...form, counterCount: count });
  }
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
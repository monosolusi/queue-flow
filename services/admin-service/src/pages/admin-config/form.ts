import type { SystemConfigurationDto } from '../../api/types';
import { DEFAULT_BRAND_COLOR, DEFAULT_SERVICE_THEMES, DEFAULT_TV_GRID_LAYOUT } from '../../api/types';
import type { DailyResetMode, PriorityPolicy, ServiceThemesMap, TvGridLayout } from '../../api/types';
import { coerceServiceThemes } from '../../lib/service-themes';
import { coerceTvGridLayout } from '../../lib/tv-grid-layout';
import { BROWSER_TIMEZONE } from '../../lib/timezone';
import {
  type StateMachineForm,
  isDefaultGraph,
} from '../../lib/state-machine';

/**
 * One editable category row. `id` is carried for categories that already exist
 * in the store so the backend reuses it (`Identifier.of(id)`) and existing
 * tickets' `categoryId` stay valid. Rows the manager adds in this session
 * have no `id` and are minted server-side on save.
 */
export interface CategoryRow {
  readonly id?: string;
  /** Stable React key — set once at load/add, never mutated, stripped before save. */
  readonly rowKey: string;
  code: string;
  name: string;
}

/** One editable counter routing row. Categories are referenced by code. */
export interface RoutingRow {
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

export interface AdminForm {
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
  /** TV-display grid layout (a list of placed widgets on a 12-col grid).
   *  Payload-only here — the dedicated `/tv-layout` page owns the TV-display
   *  editing surface; this field is prefilled from GET and passed through the
   *  full-payload PUT unchanged so the required `tvPanelLayout` wire field is
   *  always sent (never dropped). */
  tvPanelLayout: TvGridLayout;
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

export type PanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; form: AdminForm };

// --- form construction + mutation helpers (module-local; pure over the form slice) ---

/** Maps the config projection into the editable form, preserving category ids
 *  and converting routing `assignedCategoryIds` -> codes. */
export function toForm(config: SystemConfigurationDto): AdminForm {
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
    // Coerce a partial/degraded GET projection into a valid widget array
    // (falls back to the PRD default on a corrupt shape — mirrors the backend VO).
    tvPanelLayout: coerceTvGridLayout(config.tvPanelLayout ?? DEFAULT_TV_GRID_LAYOUT),
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

export function updateCategory(
  form: AdminForm,
  setState: (s: PanelState) => void,
  i: number,
  patch: Partial<CategoryRow>,
) {
  const categories = form.categories.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
  setState({ status: 'ready', form: { ...form, categories } });
}
export function addCategory(form: AdminForm, setState: (s: PanelState) => void) {
  // `rowKey` is unique per add (a loaded category's key is `cat-<uuid>`).
  const rowKey = `cat-new-${form.categories.length + 1}-${Math.random().toString(36).slice(2, 8)}`;
  setState({ status: 'ready', form: { ...form, categories: [...form.categories, { rowKey, code: '', name: '' }] } });
}
export function removeCategory(form: AdminForm, setState: (s: PanelState) => void, i: number) {
  setState({ status: 'ready', form: { ...form, categories: form.categories.filter((_, idx) => idx !== i) } });
}

export function updateRouting(
  form: AdminForm,
  setState: (s: PanelState) => void,
  i: number,
  patch: Partial<RoutingRow>,
) {
  const routingRules = form.routingRules.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
  setState({ status: 'ready', form: { ...form, routingRules } });
}
export function addRouting(form: AdminForm, setState: (s: PanelState) => void) {
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
export function removeRouting(form: AdminForm, setState: (s: PanelState) => void, i: number) {
  setState({ status: 'ready', form: { ...form, routingRules: form.routingRules.filter((_, idx) => idx !== i) } });
}
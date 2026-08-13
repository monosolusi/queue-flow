import { validateCronExpression } from '../../lib/cron';
import { validateBrandColor } from '../../lib/brand-color';
import { validateCustomCategories, validateResetTo } from '../../lib/categories';
import { validateStoreName } from '../../lib/store-name';
import { validateServiceThemes } from '../../lib/service-themes';
import { validateCustomStateMachine } from '../../lib/state-machine';
import type { AdminForm } from './form';

/**
 * Per-section validity for the saved sections of the config panel. Each flag
 * is `true` when that section's inputs are valid. The `manual` section has no
 * save button and so carries no validity flag here. The `stateMachine` flag
 * stays even though the state-machine editor is now the dedicated
 * `/config/alur-status` designer route (not an `AdminPanel` section): the full
 * PUT includes the state machine, and `computeFormValidity` still gates the
 * whole-form save on it, so the designer's save + the panel's save agree on the
 * save-gate (the designer shares the same draft).
 *
 * Moved here from `ConfigSectionNav.tsx` (deleted with the tablist): validity
 * is about validity, so it belongs with the computation that produces it.
 */
export interface SectionValidity {
  readonly profile: boolean;
  readonly categories: boolean;
  readonly routing: boolean;
  readonly dailyReset: boolean;
  readonly stateMachine: boolean;
}

/**
 * The full per-section validity bag for an {@link AdminForm} — every error
 * array + scalar the config surface needs to render inline error lists, drive
 * the nav error badges, and gate the full-save button. Pure over the form.
 *
 * Extracted from `AdminPanel` so the operational panel and the dedicated
 * `AlurStatusDesigner` page share ONE computation (DRY — the designer needs
 * `smErrors` for the visual editor's error list and `wholeFormValid` to gate its
 * save button, while the panel needs the whole bag). Both surfaces edit the
 * same shared draft in {@link ConfigDraftProvider}, so a validity recomputation
 * here from either surface's edit reflects everywhere.
 *
 * Each validator mirrors a wizard-step guard so the operational surface cannot
 * save a value the backend would 400 — see the individual validator docs. The
 * degenerate-routing guard (`routingValid`) blocks only the fully-unassigned
 * matrix, matching the wizard's minimal gate.
 */
export interface AdminFormValidity {
  storeNameError: string | null;
  brandColorErrors: string[];
  serviceThemesErrors: string[];
  catErrors: string[];
  cronError: string | null;
  resetToError: string | null;
  routingValid: boolean;
  smErrors: string[];
  sectionValidity: SectionValidity;
  wholeFormValid: boolean;
}

export function computeFormValidity(form: AdminForm): AdminFormValidity {
  const cronError =
    form.dailyReset.mode === 'AUTOMATIC_CRON' ? validateCronExpression(form.dailyReset.cronExpression) : null;
  const resetToError = validateResetTo(form.dailyReset.resetTicketNumberTo);
  const dailyResetValid = cronError === null && resetToError === null;
  const brandColorErrors = validateBrandColor(form.brandColor);
  const brandColorValid = brandColorErrors.length === 0;
  const serviceThemesErrors = validateServiceThemes(form.serviceThemes);
  const serviceThemesValid = serviceThemesErrors.length === 0;
  const catErrors = validateCustomCategories(form.categories);
  const categoriesValid = catErrors.length === 0;
  const storeNameError = validateStoreName(form.storeName);
  const storeNameValid = storeNameError === null;
  const routingValid = form.routingRules.some((r) => r.assignedCategoryCodes.length > 0);
  const smErrors = form.stateMachine.mode === 'custom' ? validateCustomStateMachine(form.stateMachine) : [];
  const stateMachineValid = smErrors.length === 0;

  const sectionValidity: SectionValidity = {
    profile: storeNameValid && brandColorValid && serviceThemesValid,
    categories: categoriesValid,
    routing: routingValid,
    dailyReset: dailyResetValid,
    stateMachine: stateMachineValid,
  };
  const wholeFormValid =
    sectionValidity.profile &&
    sectionValidity.categories &&
    sectionValidity.routing &&
    sectionValidity.dailyReset &&
    sectionValidity.stateMachine;

  return {
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
  };
}
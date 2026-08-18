import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import type { IAdminApi } from '../../api/admin-api';
import { useSystemConfigContext } from '../../config/system-config-context';
import { applyBrandColor, applyThemeMode } from '../../lib/theme';
import { toEdgeRoutingLayoutDto, toEndSourcesDto, toNodeActionsDto, toNodePositionsDto, toStartSourcesDto, toStateMachineDto, toTerminalNodesDto } from '../../lib/state-machine';
import { useToast } from '../../toast/useToast';
import { type PanelState, toForm } from './form';

/**
 * The shared, mutable configuration draft for the `/config*` routes.
 *
 * Historically `AdminPanel` owned the whole draft (`PanelState`), the load
 * effect, and `save()`. The Alur Status Tiket diagram now lives on its own
 * route (`/config/alur-status`) so the canvas can be full-width and large, but
 * it must still edit the SAME draft as the panel — a per-section save sends the
 * FULL payload, so a store-name edit on `/config` and a transition-label edit on
 * `/config/alur-status` must ride ONE save, and navigating between the two must
 * not lose in-progress edits. Lifting the draft into a context that is the
 * `/config` route element (rendering `<Outlet/>`) keeps the provider mounted
 * across `/config ↔ /config/alur-status` — only the outlet child swaps — so the
 * draft + `save()` persist. The provider mounts only inside `SetupGuard` +
 * `RequireAuth` (the route element is wrapped by both), so it never probes
 * `/api/system/config` on a clean store or for an unauthed visitor.
 *
 * Like `AdminPanel` before it, the provider keeps its OWN config read rather than
 * deriving a draft from the shared `SystemConfigProvider` snapshot: it owns a
 * mutable draft, and re-deriving it from a shared value any `refresh()` can
 * change would clobber the manager's in-progress edits. It calls the shared
 * `refresh()` after a successful save so the app-wide chrome (the shell's sidebar
 * store name) still reflects the new configuration without a page reload.
 */
export interface ConfigDraftContextValue {
  /**
   * The full admin API surface. The provider's OWN responsibility is only the
   * config draft + save lifecycle (it uses `api.getSystemConfig` /
   * `api.saveSystemConfig`); `api` is exposed here so `AdminPanel` can reach the
   * two NON-draft operational POSTs it owns — `triggerManualReset` +
   * `cleanupTransactionLogs` (the `manual` section, separate from the full PUT).
   * `AdminPanel` deliberately takes no `api` prop so the test harness MUST mount
   * it through the provider exactly as production routes it (a second context
   * for one consumer would over-segregate); the ISP cost is this one field.
   */
  api: IAdminApi;
  state: PanelState;
  /** Same signature the `form.ts` mutation helpers expect — agnostic to ownership. */
  setState: (s: PanelState) => void;
  submitting: boolean;
  /** Full PUT + re-GET + re-apply brand/theme + shared refresh. No-op if not ready. */
  save: () => Promise<void>;
  /** Re-run the load effect from the error state's "Coba Lagi". */
  retry: () => void;
}

const ConfigDraftContext = createContext<ConfigDraftContextValue | null>(null);

export function ConfigDraftProvider({
  api,
  children,
}: {
  api: IAdminApi;
  children?: ReactNode;
}) {
  const toast = useToast();
  const { refresh: refreshSharedConfig } = useSystemConfigContext();
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  // Bumped by the error state's "Coba Lagi" to re-run the load effect. Driving
  // the retry through the effect's own dependency means React tears down the
  // previous run's `cancelled` flag for us, so every attempt is genuinely
  // cancellable on unmount.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous in-flight guard so two clicks in the same tick produce exactly
  // one save (mirrors the kiosk double-tap guard; `disabled` alone lags a
  // re-render).
  const submittingRef = useRef(false);
  // Latest state held in a ref so `save` can read the current form without being
  // recreated every render (keeps the function identity stable for deep children
  // and avoids stale-closure bugs).
  const stateRef = useRef(state);
  stateRef.current = state;

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

  /**
   * PUTs the whole configuration, then re-reads it so server-minted category ids
   * land back in the editable draft. **The write and the follow-up re-read have
   * separate `catch`es** (moved verbatim from `AdminPanel.save`): they fail for
   * different reasons and the manager must be told which one happened — sharing
   * one catch would report a failed re-read as "Gagal menyimpan" right next to
   * the success toast.
   */
  const save = useCallback(async () => {
    if (submittingRef.current) return;
    const current = stateRef.current;
    if (current.status !== 'ready') return;
    const form = current.form;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      try {
        await api.saveSystemConfig({
          storeName: form.storeName,
          // Strip the client-only `mode` preset + force the PRD §7 default graph
          // in default mode via the shared mapper (same one the wizard's finalize
          // uses — neither surface can drift). Sides are NOT on the wire
          // StateTransitionDto; they travel in the separate sparse
          // `edgeRoutingLayout` map. Node positions travel in the separate
          // `nodePositions` map (the client is the source of truth for both
          // handle routing and canvas positions now).
          stateMachine: toStateMachineDto(form.stateMachine),
          edgeRoutingLayout: toEdgeRoutingLayoutDto(form.stateMachine),
          nodePositions: toNodePositionsDto(form.stateMachine),
          // Node-level actions travel the wire in the separate `nodeActions`
          // map (the client is the source of truth — the properties panel
          // "Aksi" editor builds it). Mirrors `nodePositions` passthrough.
          nodeActions: toNodeActionsDto(form.stateMachine),
          // Start/End terminal-marker states travel the wire in the separate
          // `terminalNodes` field (the client is the source of truth — the
          // diagram marker editor builds it). Mirrors `nodeActions` passthrough.
          terminalNodes: toTerminalNodesDto(form.stateMachine),
          // Explicit End connections travel the wire in the separate
          // `endSources` field (the client is the source of truth — the
          // `onConnect`-to-End path + the panel "Transisi masuk" delete build
          // it). Mirrors `terminalNodes` passthrough.
          endSources: toEndSourcesDto(form.stateMachine),
          // Explicit Start connections travel the wire in the separate
          // `startSources` field (the client is the source of truth — the
          // `onConnect`-from-Start path + the panel "Transisi keluar" delete
          // build it). Mirrors `endSources` passthrough. Start is manual-only.
          startSources: toStartSourcesDto(form.stateMachine),
          brandColor: form.brandColor,
          serviceThemes: form.serviceThemes,
          // Payload-only passthrough — the TV-layout editor lives on the
          // dedicated `/tv-layout` page; the full PUT must still carry the field
          // so the required `tvPanelLayout` wire field is never dropped.
          tvPanelLayout: form.tvPanelLayout,
          // Payload-only passthrough — the printer editor lives on the dedicated
          // `/printer-config` page; the full PUT must still carry the field so
          // the required `printerConfiguration` wire field is never dropped
          // (mirrors `tvPanelLayout`).
          printerConfiguration: form.printerConfiguration,
          // Same passthrough for the announcement delivery (`/tts-config` owns it).
          ttsConfiguration: form.ttsConfiguration,
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
          // Strip the client-only `rowKey` (a React key) at the boundary.
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
        const config = await api.getSystemConfig();
        // Re-apply the runtime `--accent` + admin theme so a brand-color / theme
        // change is visible immediately without a full page reload (QUE-35/QUE-47).
        applyBrandColor(config.brandColor);
        applyThemeMode(config.serviceThemes.admin);
        setState({ status: 'ready', form: toForm(config) });
        // Re-read the shared snapshot so app-wide chrome fed by it updates now.
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
  }, [api, toast, refreshSharedConfig]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setLoadAttempt((n) => n + 1);
  }, []);

  const value: ConfigDraftContextValue = {
    api,
    state,
    setState,
    submitting,
    save,
    retry,
  };

  return <ConfigDraftContext.Provider value={value}>{children ?? <Outlet />}</ConfigDraftContext.Provider>;
}

/** Reads the shared config draft. Throws if used outside a `ConfigDraftProvider`. */
export function useConfigDraft(): ConfigDraftContextValue {
  const ctx = useContext(ConfigDraftContext);
  if (ctx === null) {
    throw new Error('useConfigDraft must be used inside a ConfigDraftProvider.');
  }
  return ctx;
}
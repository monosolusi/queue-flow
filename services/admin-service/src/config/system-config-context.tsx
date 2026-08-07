import { createContext, useContext, type ReactNode } from 'react';
import type { ISystemConfigApi } from '../api/admin-api';
import { useSystemConfig, type SystemConfigState } from './useSystemConfig';

/**
 * Shared store-configuration state for the admin app — the config sibling of
 * `AuthProvider`. The provider wraps the shell + routes and resolves
 * `GET /api/system/config` once via {@link useSystemConfig}; {@link SetupGuard},
 * {@link WizardGuard}, the shell's store-name chrome, the runtime brand
 * color/theme, and the dashboard's category labels all consume it, so the
 * endpoint is probed exactly once per page load and every consumer sees the
 * SAME snapshot (the precedent `RequireAuth` documents for `/me`).
 *
 * Beyond de-duplicating the probes this fixes the divergent-snapshot bug: with
 * four independent fetches, a wizard finalize (or a store rename in the panel)
 * updated only the fetcher that ran after it — the shell kept the old store name
 * and the dashboard kept the pre-setup empty category list until a full reload.
 * A single owner + an explicit `refresh()` after each successful save keeps
 * every consumer coherent.
 *
 * The default value reads as "unresolved" (`config: null`, `loading: true`) so a
 * component rendered without a provider in an isolation test shows the neutral
 * loading state rather than a false outage error.
 */
const SystemConfigContext = createContext<SystemConfigState>({
  config: null,
  loading: true,
  error: false,
  refresh: async () => {},
});

export function SystemConfigProvider({
  api,
  children,
}: {
  api: ISystemConfigApi;
  children: ReactNode;
}) {
  const state = useSystemConfig(api);
  return <SystemConfigContext.Provider value={state}>{children}</SystemConfigContext.Provider>;
}

/** The shared store configuration. Components must be inside a {@link SystemConfigProvider}. */
export function useSystemConfigContext(): SystemConfigState {
  return useContext(SystemConfigContext);
}

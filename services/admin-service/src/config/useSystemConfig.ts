import { useCallback, useEffect, useRef, useState } from 'react';
import type { ISystemConfigApi } from '../api/admin-api';
import type { SystemConfigurationDto } from '../api/types';

export interface SystemConfigState {
  /** The store configuration, or `null` until the first probe resolves. */
  readonly config: SystemConfigurationDto | null;
  /** `true` while a `GET /api/system/config` probe is in flight. */
  readonly loading: boolean;
  /** `true` when the last probe rejected (a real core-api outage — the read
   *  returns a default DTO on a clean store, it never throws "not configured"). */
  readonly error: boolean;
  /** Re-read the configuration (after a wizard finalize / an admin save, or as
   *  the retry affordance behind a failed probe). */
  readonly refresh: () => Promise<void>;
}

/**
 * Resolves + holds the store {@link SystemConfigurationDto} for the whole admin
 * app (the config sibling of `useAuth`). On mount it probes
 * `GET /api/system/config` **once**; every consumer — `App` (the runtime
 * `--accent` + theme + the shell's store-name chrome + the dashboard's category
 * labels), {@link SetupGuard}, {@link WizardGuard} — reads the one resolved
 * snapshot instead of firing its own probe. That removes the four redundant
 * first-run probes AND the divergent-snapshot bug they caused: after the wizard
 * finalized (or the panel renamed the store) each holder kept its own stale copy
 * until a full page reload.
 *
 * **Stale-while-revalidate is load-bearing.** `refresh()` sets `loading` while
 * the re-read is in flight but does NOT clear `config`, and the guards branch on
 * `config !== null` first — so a post-save refresh never flashes the loading
 * banner (which would unmount the page mid-save) and a refresh that fails leaves
 * the last known config in place rather than bouncing a working session to an
 * error screen.
 *
 * **Cancellation covers every load, not just the first.** The in-flight
 * generation counter is bumped by each `refresh()` and by unmount, and each load
 * compares its own generation before touching state — so the retry path (a
 * second `refresh()` while the first is still pending, or an unmount mid-retry)
 * is genuinely cancelled. A `let cancelled` closure registered only as the
 * effect's first cleanup would silently protect the mount probe alone.
 */
export function useSystemConfig(api: ISystemConfigApi): SystemConfigState {
  const [config, setConfig] = useState<SystemConfigurationDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Keep the api in a ref so `refresh` stays referentially stable (a changing
  // identity would re-run the mount effect and re-probe on every render).
  const apiRef = useRef(api);
  apiRef.current = api;
  // Monotonic in-flight token: a load whose generation is stale (superseded by a
  // newer refresh, or invalidated by unmount) drops its result.
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const next = await apiRef.current.getSystemConfig();
      if (generation !== generationRef.current) return;
      setConfig(next);
      setError(false);
      setLoading(false);
    } catch {
      // A real outage — the read returns a default DTO on a clean store, so a
      // rejection is never a "not configured" signal. Keep any previously
      // resolved config (stale-while-revalidate) and surface the error flag.
      if (generation !== generationRef.current) return;
      setError(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      // Invalidate whatever load is in flight (mount probe OR retry) so a late
      // resolve never setStates on an unmounted provider.
      generationRef.current += 1;
    };
  }, [refresh]);

  return { config, loading, error, refresh };
}

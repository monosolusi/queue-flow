import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A REST polling hook for the live operational dashboard (FR-ADM-03 / QUE-44).
 *
 * admin-service deliberately has no WebSocket (`src/test/setup.ts` SRP note):
 * the dashboard is a read-only operational monitor, so a fixed-cadence REST poll
 * keeps the SRP/ISP boundary clean (no realtime participation, no caller/tv
 * DTO leakage). This hook owns the polling machinery — `setInterval`, a
 * per-run race guard, `visibilitychange` pause/resume, and unmount cleanup — so
 * the page stays a thin view over `{ data, error, loading, refresh, lastUpdated }`.
 *
 * Behaviour:
 *  - **Initial load** sets `loading: true` until the first fetch resolves; the
 *    page renders its skeleton during that window.
 *  - **Refresh ticks** (interval + manual `refresh()` + re-fetch on tab return)
 *    do NOT flip back to `loading` — the last good `data` stays visible so the
 *    board never flashes a skeleton every 8 s. A failed refresh surfaces
 *    `error` but keeps the stale `data` (the manager still sees the last board).
 *  - **Stale-result guard:** each run carries an incrementing id; a result from
 *    a superseded run is dropped so an old slow fetch can't clobber a newer one.
 *  - **Visibility:** when the tab hides the interval is cleared (no wasted LAN
 *    traffic); when it returns, a fetch fires immediately and the interval
 *    resumes (the manager never sees a stale board on return).
 *  - **Unmount:** the mounted flag + interval are cleaned up so no `setState`
 *    fires after the page is gone.
 *
 * `fetcher` is read through a ref so a new closure identity on every render
 * (e.g. `() => loadLiveDashboard(api, configRef.current)`) does NOT re-arm the
 * interval — the poll cadence depends only on `intervalMs` + `enabled`.
 */
export interface UsePollOptions {
  /** When `false`, no fetches run and `loading` is forced false. Default `true`. */
  readonly enabled?: boolean;
}

export interface PollResult<T> {
  /** The latest successful result, or `null` before the first successful fetch. */
  readonly data: T | null;
  /** The latest error message, or `null` when the last fetch succeeded. */
  readonly error: string | null;
  /** `true` only during the initial load (before the first result). */
  readonly loading: boolean;
  /** Bump a manual refresh (re-runs the fetcher immediately). */
  readonly refresh: () => void;
  /** Epoch-ms of the last successful fetch, or `null` before the first success. */
  readonly lastUpdated: number | null;
}

export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  { enabled = true }: UsePollOptions = {},
): PollResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // `tick` is bumped by `refresh()` to retrigger the run effect.
  const [tick, setTick] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);
  const firstRunRef = useRef(true);

  const run = useCallback(() => {
    const id = ++runIdRef.current;
    // Only the very first run shows the skeleton; refreshes keep the last data.
    if (firstRunRef.current) setLoading(true);
    fetcherRef
      .current()
      .then((result) => {
        if (!mountedRef.current || id !== runIdRef.current) return;
        firstRunRef.current = false;
        setData(result);
        setError(null);
        setLastUpdated(Date.now());
        setLoading(false);
      })
      .catch((err) => {
        if (!mountedRef.current || id !== runIdRef.current) return;
        firstRunRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Mark mounted for the stale-result + unmount guards.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // (Re)run on enable + manual refresh. `run` is stable; `tick` is the refresh bump.
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    run();
  }, [enabled, tick, run]);

  // Interval + visibility pause/resume. Re-armed only on `enabled`/`intervalMs`
  // change (NOT on fetcher identity — it's read through a ref).
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const schedule = () => {
      timer = setInterval(() => run(), intervalMs);
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      } else if (timer === undefined) {
        // Re-fetch immediately on return so the board is fresh, then resume.
        run();
        schedule();
      }
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs, run]);

  return { data, error, loading, refresh, lastUpdated };
}
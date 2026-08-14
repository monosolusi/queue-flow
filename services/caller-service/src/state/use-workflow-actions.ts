import { useEffect, useMemo, useState } from 'react';
import type { ICallerApi } from '../api/caller-api';
import type { WorkflowActionsDto } from '../api/types';

/** The counter panel's action surface as the workspace sees it. */
export interface WorkflowActionsState {
  /** The actions of the active flow, or `null` while they have never loaded. */
  readonly workflow: WorkflowActionsDto | null;
  /** Indonesian hint shown when they could not be (re)loaded. */
  readonly error: string | null;
}

/** Honest for both failure shapes: on a first-load failure the panel falls back
 *  to call-next only; on a refresh failure the last known actions are still
 *  shown but may be out of date. Either way the buttons may not match the design. */
const LOAD_ERROR =
  'Alur status gagal dimuat — tombol aksi mungkin tidak lengkap. Coba muat ulang halaman.';

/**
 * Loads the counter panel's action surface (`GET /api/queue/actions`) — the
 * source of truth for every action button in the workspace (FR-CLR-02). It
 * carries the active flow's transitions grouped by source status, each with the
 * action the manager declared for it, so the panel needs no second fetch of the
 * raw graph and no routing table of its own.
 *
 * Owned by the page rather than a single component because two children derive
 * from the same surface (the action panel and the waiting list), and a second
 * fetch would be both wasteful and a chance for the two to disagree.
 *
 * `configVersion` is the store's monotonic `SYSTEM_CONFIG_CHANGED` counter: a
 * bump re-runs the fetch so an admin re-saving the flow mid-shift is reflected
 * without a reload.
 *
 * A failed refetch keeps the last known actions rather than blanking the panel —
 * a transient blip must not strip the staff's buttons. The stale risk is
 * bounded: a since-removed transition is rejected server-side (409) and surfaces
 * inline.
 */
export function useWorkflowActions(api: ICallerApi, configVersion?: number): WorkflowActionsState {
  const [workflow, setWorkflow] = useState<WorkflowActionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getWorkflowActions()
      .then((actions) => {
        if (cancelled) return;
        setWorkflow(actions);
        setError(null);
      })
      .catch(() => {
        // System not configured (409) or network failure.
        if (!cancelled) setError(LOAD_ERROR);
      });
    return () => {
      cancelled = true;
    };
  }, [api, configVersion]);

  return useMemo(() => ({ workflow, error }), [workflow, error]);
}

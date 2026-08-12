import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ICallerApi } from '../api/caller-api';
import type { StateMachineDto, StateTransitionDto, TicketStateDto } from '../api/types';
import type { BoundCounter } from '../state/counter-binding';

/** Maps a transition's target state to the caller command that drives it.
 *  The default PRD §7 graph covers SERVING/SKIPPED/COMPLETED/CALLING; WAITING
 *  is the configurable "Pindah Kategori" (transfer) target (FR-CLR-03). Edges
 *  to states outside this set are custom-target transitions driven by the
 *  generic apply-transition endpoint (QUE-33) — every configured transition
 *  still produces a button, per the PRD. */
const COMMAND_BY_TARGET: Readonly<Record<string, 'serve' | 'complete' | 'skip' | 'recall' | 'transfer'>> = {
  SERVING: 'serve',
  COMPLETED: 'complete',
  SKIPPED: 'skip',
  CALLING: 'recall',
  WAITING: 'transfer',
};

export interface ActionControlsProps {
  readonly api: ICallerApi;
  readonly bound: BoundCounter;
  /** The active ticket (null when none). Buttons per-edge render from its status. */
  readonly active: TicketStateDto | null;
  /** Test seam: inject the state machine directly instead of fetching it. */
  readonly stateMachine?: StateMachineDto | null;
  /** Monotonic counter bumped by the store on every `SYSTEM_CONFIG_CHANGED`
   *  WS event. A bump re-runs the fetch effect so the panel reflects the
   *  admin-designed flow + its `actionLabel` wording without a reload
   *  (FR-CLR-02). Omitted in unit tests that inject {@link stateMachine}. */
  readonly configVersion?: number;
}

/**
 * Dynamic action buttons driven by the active state machine (FR-CLR-02 /
 * QUE-20). The always-present primary call-next button issues `call-next` for
 * the bound counter (it is not tied to a specific ticket) and is labeled with
 * the admin-configured `WAITING → CALLING` transition's `actionLabel`, so the
 * panel honors the admin's wording for that edge too (not a hardcoded literal). It
 * is **disabled while an unresolved active ticket occupies the counter**: the
 * caller store projects `active` to only non-terminal in-progress tickets
 * (CALLING / SERVING / a custom in-progress state), so `active !== null` means
 * staff must resolve the current ticket first (serve / skip / complete) before
 * calling the next one — calling next on top of an unresolved ticket would
 * strand it in CALLING forever and corrupt analytics. The per-edge buttons
 * (Mulai Melayani / Lewati / Absen / Selesai Layan / Panggil Ulang) guide the
 * staff to resolve it; once the active ticket leaves the counter (COMPLETED /
 * SKIPPED / transferred) `active` becomes `null` and call-next re-enables. For
 * the active ticket's current status, one button per outgoing edge is rendered,
 * labeled with the transition's `actionLabel` (Indonesian). Edge → command is
 * mapped by the target state (see {@link COMMAND_BY_TARGET}). Commands are
 * fire-and-forget: the resulting TICKET_CALLED / STATUS_UPDATED /
 * TICKET_TRANSFERRED event arrives over the WebSocket and updates the store; a
 * pending flag guards against double-fire. Illegal transitions surface as an
 * inline error (core-api returns 409).
 */
export function ActionControls({ api, bound, active, stateMachine, configVersion }: ActionControlsProps) {
  const [sm, setSm] = useState<StateMachineDto | null>(stateMachine ?? null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Transfer chooser: when the active ticket has a "Pindah Kategori" edge and
  // the counter serves ≥2 *other* categories, the transfer button expands an
  // inline chooser so staff pick the destination (FR-CLR-03).
  const [transferOpen, setTransferOpen] = useState(false);
  // Stable id linking the transfer toggle (`aria-controls`) to its chooser, so AT
  // can associate the expanded options with the toggle (FR-CLR-03 a11y, QUE-40 AC4).
  const chooserId = useId();
  // Synchronous in-flight guard. `pending` (state) only updates after a
  // re-render, so two taps in the same tick both see `pending === null` and
  // both fire — the trap CLAUDE.md calls out for touch surfaces. The ref is
  // flipped before the first `await` so the second tap is blocked synchronously.
  const inFlightRef = useRef(false);

  // Load the active state machine, and refetch it whenever the store signals a
  // SYSTEM_CONFIG_CHANGED event (bumps `configVersion`). The injected test seam
  // short-circuits the fetch; a `configVersion` bump under the seam just re-sets
  // the seam (harmless — no fetch), so the prop is a no-op in seam-backed tests.
  useEffect(() => {
    if (stateMachine !== undefined) {
      setSm(stateMachine);
      return;
    }
    let cancelled = false;
    api
      .getActiveStateMachine()
      .then((graph) => {
        if (!cancelled) setSm(graph);
      })
      .catch((err) => {
        // System not configured (409) or network failure: degrade to call-next
        // only (the caller can still call next; the error surfaces on tap).
        if (!cancelled) setError(err instanceof Error ? err.message : 'Gagal memuat state machine');
      });
    return () => {
      cancelled = true;
    };
  }, [api, stateMachine, configVersion]);

  /** The admin-configured label for the `WAITING → CALLING` transition — the
   *  one the call-next button actually drives (callNext pulls a WAITING ticket
   *  and the aggregate validates that exact edge, so it must exist whenever
   *  call-next is functional). The button therefore uses the admin's wording,
   *  not a hardcoded literal, falling back to the PRD default when the edge is
   *  absent or the graph has not loaded yet (FR-CLR-02). */
  const callNextLabel = useMemo(() => {
    if (!sm) return 'Panggil Berikutnya';
    return (
      sm.transitions.find((t) => t.from === 'WAITING' && t.to === 'CALLING')?.actionLabel ??
      'Panggil Berikutnya'
    );
  }, [sm]);

  const edges = useMemo<readonly StateTransitionDto[]>(() => {
    if (!sm || !active) return [];
    return sm.transitions.filter((t) => t.from === active.status);
  }, [sm, active]);

  /** Categories the active ticket could be transferred to (i.e. the bound
   *  counter's assigned categories minus the ticket's own). Used by the
   *  transfer chooser (FR-CLR-03). Falls back to id-only labels for a binding
   *  persisted before `assignedCategories` existed. */
  const otherCategories = useMemo<readonly { readonly id: string; readonly name: string }[]>(() => {
    if (!active) return [];
    if (bound.assignedCategories.length > 0) {
      return bound.assignedCategories
        .filter((c) => c.id !== active.categoryId)
        .map((c) => ({ id: c.id, name: c.name }));
    }
    return bound.assignedCategoryIds
      .filter((id) => id !== active.categoryId)
      .map((id) => ({ id, name: id }));
  }, [bound.assignedCategories, bound.assignedCategoryIds, active]);

  // Collapse the chooser when the active ticket changes (different ticket or
  // it leaves the active slot after the transfer's STATUS_UPDATED).
  useEffect(() => {
    setTransferOpen(false);
  }, [active?.ticketId]);

  async function run(command: string, invoker: () => Promise<void>) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(command);
    setError(null);
    try {
      await invoker();
      // The WebSocket event updates the store; nothing to do here.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Perintah gagal');
    } finally {
      inFlightRef.current = false;
      setPending(null);
    }
  }

  return (
    <section className="action-controls" aria-label="Aksi">
      <button
        type="button"
        className="btn btn--primary action-controls__call-next"
        onClick={() => run('call-next', () => api.callNext(bound.counterId))}
        disabled={pending === 'call-next' || active !== null}
        title={active !== null ? 'Selesaikan tiket aktif terlebih dahulu (layani, lewati, atau selesaikan)' : undefined}
      >
        {pending === 'call-next' ? 'Memanggil…' : callNextLabel}
      </button>

      {/* "Panggil Lagi" — re-announce the currently-calling ticket. A fixed
          affordance (NOT edge-driven) shown only while a ticket is in CALLING,
          so staff can repeat the TV/audio announcement when the customer didn't
          hear it. Reuses the same run/pending/in-flight guard machinery as the
          edge buttons; no new state. */}
      {active?.status === 'CALLING' && (
        <button
          type="button"
          className="btn btn--secondary action-controls__reannounce"
          data-testid="action-reannounce"
          onClick={() => void run('reannounce', () => api.reannounce(active!.ticketId))}
          disabled={pending === 'reannounce'}
        >
          {pending === 'reannounce' ? 'Memanggil…' : 'Panggil Lagi'}
        </button>
      )}

      {edges.map((edge) => {
        const command = COMMAND_BY_TARGET[edge.to];
        if (!command) {
          // A custom-target transition (an edge to a state outside the 5-state
          // command map, e.g. SERVING -> PREPARING). Backed by the generic
          // apply-transition endpoint (QUE-33) — fire-and-forget like the fixed
          // commands; the STATUS_UPDATED event drives the store.
          const busy = pending === 'apply-transition';
          return (
            <button
              key={`${edge.from}-${edge.to}`}
              type="button"
              className="btn btn--secondary action-controls__edge"
              data-testid={`action-apply-transition-${edge.to}`}
              onClick={() => void run('apply-transition', () => api.applyTransition(active!.ticketId, edge.to))}
              disabled={busy}
            >
              {busy ? '…' : edge.actionLabel}
            </button>
          );
        }
        if (command === 'transfer') {
          if (otherCategories.length === 0) {
            return (
              <button
                key={`${edge.from}-${edge.to}`}
                type="button"
                className="btn btn--secondary action-controls__edge action-controls__unsupported"
                data-testid="action-transfer"
                disabled
                title="Tidak ada kategori lain untuk dituju"
              >
                {edge.actionLabel} (tidak ada kategori lain)
              </button>
            );
          }
          if (otherCategories.length === 1) {
            const only = otherCategories[0];
            const busy = pending === 'transfer';
            return (
              <button
                key={`${edge.from}-${edge.to}`}
                type="button"
                className="btn btn--secondary action-controls__edge"
                data-testid="action-transfer"
                onClick={() => void run('transfer', () => api.transfer(active!.ticketId, only.id))}
                disabled={busy}
              >
                {busy ? '…' : edge.actionLabel}
              </button>
            );
          }
          // ≥2 candidate categories: expand an inline chooser so staff pick the
          // destination (FR-CLR-03).
          const busy = pending === 'transfer';
          return (
            <div key={`${edge.from}-${edge.to}`} className="action-controls__transfer">
              <button
                type="button"
                className="btn btn--secondary action-controls__edge"
                data-testid="action-transfer"
                aria-expanded={transferOpen}
                aria-controls={chooserId}
                onClick={() => setTransferOpen((o) => !o)}
                disabled={busy}
              >
                {busy ? '…' : edge.actionLabel}
              </button>
              {transferOpen && (
                <div
                  id={chooserId}
                  className="action-controls__transfer-chooser"
                  data-testid="transfer-chooser"
                  role="group"
                  aria-label="Kategori tujuan"
                >
                  {otherCategories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="btn action-controls__transfer-option"
                      data-testid={`transfer-target-${c.id}`}
                      onClick={() => {
                        void run('transfer', () => api.transfer(active!.ticketId, c.id)).finally(() =>
                          setTransferOpen(false),
                        );
                      }}
                      disabled={busy}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }
        const busy = pending === command;
        return (
          <button
            key={`${edge.from}-${edge.to}`}
            type="button"
            className="btn btn--secondary action-controls__edge"
            data-testid={`action-${command}`}
            onClick={() => void run(command, () => api[command](active!.ticketId))}
            disabled={busy}
          >
            {busy ? '…' : edge.actionLabel}
          </button>
        );
      })}

      {error && <p className="action-controls__error">{error}</p>}
    </section>
  );
}
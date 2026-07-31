import { useEffect, useMemo, useState } from 'react';
import type { ICallerApi } from '../api/caller-api';
import type { StateMachineDto, StateTransitionDto, TicketStateDto } from '../api/types';
import type { BoundCounter } from '../state/counter-binding';

/** Maps a transition's target state to the caller command that drives it.
 *  The default PRD §7 graph covers SERVING/SKIPPED/COMPLETED/CALLING; WAITING
 *  is the configurable "Pindah Kategori" (transfer) target (FR-CLR-03). Edges to
 *  states outside this set are not backed by a core-api command endpoint and are
 *  not rendered (a documented limitation of the fixed command surface — custom
 *  transitions beyond these five are not endpoint-wired). */
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
}

/**
 * Dynamic action buttons driven by the active state machine (FR-CLR-02 /
 * QUE-20). The always-present primary "Panggil Berikutnya" button issues
 * `call-next` for the bound counter (it is not tied to a specific ticket). For
 * the active ticket's current status, one button per outgoing edge is rendered,
 * labeled with the transition's `actionLabel` (Indonesian — "Mulai Melayani",
 * "Lewati / Absen", "Selesai Layan", "Panggil Ulang"). Edge → command is mapped
 * by the target state (see {@link COMMAND_BY_TARGET}). Commands are
 * fire-and-forget: the resulting TICKET_CALLED / STATUS_UPDATED /
 * TICKET_TRANSFERRED event arrives over the WebSocket and updates the store; a
 * pending flag guards against double-fire. Illegal transitions surface as an
 * inline error (core-api returns 409).
 */
export function ActionControls({ api, bound, active, stateMachine }: ActionControlsProps) {
  const [sm, setSm] = useState<StateMachineDto | null>(stateMachine ?? null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the active state machine once (or use the injected test seam).
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
  }, [api, stateMachine]);

  const edges = useMemo<readonly StateTransitionDto[]>(() => {
    if (!sm || !active) return [];
    return sm.transitions.filter((t) => t.from === active.status);
  }, [sm, active]);

  async function run(command: string, invoker: () => Promise<void>) {
    if (pending) return;
    setPending(command);
    setError(null);
    try {
      await invoker();
      // The WebSocket event updates the store; nothing to do here.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Perintah gagal');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="action-controls" aria-label="Aksi">
      <button
        type="button"
        className="btn btn--primary action-controls__call-next"
        onClick={() => run('call-next', () => api.callNext(bound.counterId))}
        disabled={pending === 'call-next'}
      >
        {pending === 'call-next' ? 'Memanggil…' : 'Panggil Berikutnya'}
      </button>

      {edges.map((edge) => {
        const command = COMMAND_BY_TARGET[edge.to];
        if (!command) return null;
        const busy = pending === command;
        return (
          <button
            key={`${edge.from}-${edge.to}`}
            type="button"
            className="btn btn--secondary action-controls__edge"
            data-testid={`action-${command}`}
            onClick={() => {
              if (command === 'transfer') {
                // Transfer needs a target category — use the first assigned
                // category that differs from the active ticket's own category
                // (falling back to the first assigned). The default graph has
                // no transfer edge, so this only renders when the wizard
                // configures a CALLING→WAITING transition (FR-CLR-03).
                const target =
                  bound.assignedCategoryIds.find((id) => id !== active?.categoryId) ??
                  bound.assignedCategoryIds[0];
                if (!target) return;
                void run('transfer', () => api.transfer(active!.ticketId, target));
              } else {
                void run(command, () => api[command](active!.ticketId));
              }
            }}
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
import { ActiveTicketCard } from '../components/ActiveTicketCard';
import { ActionControls } from '../components/ActionControls';
import { CounterHeader } from '../components/CounterHeader';
import { WaitingQueueList } from '../components/WaitingQueueList';
import type { BoundCounter } from '../state/counter-binding';
import { useQueueStore } from '../state/queue-store';

export interface WorkspacePageProps {
  readonly bound: BoundCounter;
  readonly onUnbind: () => void;
}

/**
 * The active queue workspace: header (counter identity + WS status + change
 * counter), the prominent active ticket, the live waiting list, and the
 * dynamic action controls (FR-CLR-02). Action buttons are rendered from the
 * active state machine + the active ticket's status by {@link ActionControls};
 * the store delivers the resulting lifecycle event over the WebSocket so the
 * workspace updates without a manual refetch.
 */
export function WorkspacePage({ bound, onUnbind }: WorkspacePageProps) {
  const { state, api } = useQueueStore();
  const active = state.active[0] ?? null;

  return (
    <main className="workspace">
      <CounterHeader bound={bound} connection={state.connection} onUnbind={onUnbind} />
      {state.loadStatus === 'loading' && <p className="workspace__hint">Memuat antrian…</p>}
      {state.loadStatus === 'error' && (
        <p className="workspace__hint workspace__hint--error">
          {state.loadError ?? 'Gagal memuat antrian.'}
        </p>
      )}
      {state.loadStatus === 'loaded' && (
        <div className="workspace__body">
          <ActiveTicketCard ticket={active} />
          <WaitingQueueList tickets={state.waiting} waitingCount={state.waitingCount} />
          <ActionControls api={api} bound={bound} active={active} />
        </div>
      )}
    </main>
  );
}
import { ActiveTicketCard } from '../components/ActiveTicketCard';
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
 * counter), the prominent active ticket, and the live waiting list. Action
 * controls (call next / skip / complete / recall) are deliberately NOT wired
 * here — that is QUE-20.
 */
export function WorkspacePage({ bound, onUnbind }: WorkspacePageProps) {
  const { state } = useQueueStore();
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
          {/* QUE-20: dynamic action controls (Panggil Berikutnya / Lewati / Selesai Layan / Panggil Ulang). */}
          <section className="workspace__actions" aria-label="Aksi" />
        </div>
      )}
    </main>
  );
}
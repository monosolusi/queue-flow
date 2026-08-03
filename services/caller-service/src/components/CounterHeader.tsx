import type { BoundCounter } from '../state/counter-binding';
import { ConnectionStatus } from './ConnectionStatus';

export interface CounterHeaderProps {
  readonly bound: BoundCounter;
  readonly connection: import('../realtime/queue-socket').ConnectionStatus;
  readonly onUnbind: () => void;
}

/** Workspace header: bound counter identity + WS status + "Ganti Counter". */
export function CounterHeader({ bound, connection, onUnbind }: CounterHeaderProps) {
  return (
    <header className="counter-header">
      <div className="counter-header__identity">
        <span className="counter-header__label">Loket</span>
        <span className="counter-header__name">{bound.counterName}</span>
      </div>
      <div className="counter-header__actions">
        <ConnectionStatus status={connection} />
        <button type="button" className="btn btn--secondary" onClick={onUnbind}>
          Ganti Counter
        </button>
      </div>
    </header>
  );
}
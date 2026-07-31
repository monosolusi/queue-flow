import type { ConnectionStatus } from '../realtime/queue-socket';

/** Small WS connection indicator (top-right of the board). */
export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span className={`connection-status connection-status--${status}`}>
      <span className="connection-status__dot" />
      {status === 'open' ? 'Terhubung' : status === 'connecting' ? 'Menghubungkan…' : 'Terputus'}
    </span>
  );
}
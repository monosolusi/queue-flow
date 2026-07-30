import type { ConnectionStatus as Status } from '../realtime/queue-socket';

const LABEL: Record<Status, string> = {
  open: 'Terhubung',
  connecting: 'Menghubungkan…',
  closed: 'Terputus',
};

const MODIFIER: Record<Status, string> = {
  open: 'connection-status--open',
  connecting: 'connection-status--connecting',
  closed: 'connection-status--closed',
};

/** Small live indicator for the WS connection state. */
export function ConnectionStatus({ status }: { status: Status }) {
  return (
    <span className={`connection-status ${MODIFIER[status]}`} role="status" aria-live="polite">
      <span className="connection-status__dot" aria-hidden="true" />
      {LABEL[status]}
    </span>
  );
}
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { IssuedTicket } from './CategorySelectPage';

/**
 * Shows the ticket just issued at the kiosk (FR-KSK-01 / QUE-17). The issued
 * ticket is received via router state from {@link CategorySelectPage}; if the
 * page is reached directly (no state — e.g. a refresh on a public kiosk), it
 * redirects back to the category screen. Thermal printing of this ticket is
 * QUE-18 and is not wired here.
 */
export function TicketResultPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const issued = location.state as IssuedTicket | null;

  // No state means a direct load/refresh on a public kiosk — go back to pick a
  // category rather than showing a blank ticket.
  if (!issued) {
    return <Navigate to="/" replace />;
  }

  const { ticket, categoryName } = issued;

  return (
    <main className="kiosk-result">
      <p className="kiosk-result__label">Nomor Antrian Anda</p>
      <p className="kiosk-result__number">{ticket.ticketNumber}</p>
      <p className="kiosk-result__category">{categoryName}</p>
      {/* QUE-18: hook silent thermal printing of `ticket` here. */}
      <button
        type="button"
        className="btn btn--primary kiosk-result__done"
        onClick={() => navigate('/', { replace: true })}
      >
        Selesai
      </button>
    </main>
  );
}
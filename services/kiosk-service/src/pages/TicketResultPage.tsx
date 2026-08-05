import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { IssuedTicket } from './CategorySelectPage';

/**
 * Auto-return delay (FR-KSK, QUE-38 AC1). A visitor who walks away without
 * tapping "Selesai" would otherwise leave their ticket number visible to the
 * next visitor (privacy + confusion). 10s sits in the 8–12s band. The timer is
 * a client-owned default — the PRD §7 config schema carries no auto-return
 * field, so manager-configurability is out of scope (mirrors the audio MP3
 * client-owned-default precedent). Hardcoded, not configurable.
 */
const AUTO_RETURN_MS = 10_000;

/**
 * Shows the ticket just issued at the kiosk (FR-KSK-01 / QUE-17). The issued
 * ticket is received via router state from {@link CategorySelectPage}; if the
 * page is reached directly (no state — e.g. a refresh on a public kiosk), it
 * redirects back to the category screen. Thermal printing is fired by
 * {@link CategorySelectPage} immediately after issuance (within the 1.5 s
 * budget, NFR-PERF-03, fire-and-forget so it never blocks this screen); this
 * page only displays the already-issued/already-printed ticket and must NOT
 * print — `IssuedTicket` carries only display fields, not the `waitingAhead` /
 * `storeName` a `PrintPayload` requires.
 *
 * Auto-return (QUE-38 AC1): the result screen returns to `/` after
 * {@link AUTO_RETURN_MS} so an abandoned kiosk self-resets. Tapping "Selesai"
 * navigates away → unmounts this page → the timer cleanup runs, so a manual
 * return never races the timer. The in-flight double-tap guard lives in
 * {@link CategorySelectPage}, which unmounted on navigation to `/tiket`; the
 * auto-return remounts it fresh (a new `useRef(false)`), so the guard resets
 * automatically — no extra reset wiring here.
 */
export function TicketResultPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const issued = location.state as IssuedTicket | null;

  // Auto-return to the attract screen. The effect runs before the early return
  // (Rules of Hooks) and guards on `issued` so the no-state path — which
  // `<Navigate>`s immediately below — does not arm a pointless timer. The
  // cleanup clears the timeout on unmount (manual "Selesai" or this auto-return
  // both unmount the page), so the timer never fires after navigation.
  useEffect(() => {
    if (!issued) return;
    const timer = setTimeout(() => navigate('/', { replace: true }), AUTO_RETURN_MS);
    return () => clearTimeout(timer);
  }, [navigate, issued]);

  // No state means a direct load/refresh on a public kiosk — go back to pick a
  // category rather than showing a blank ticket.
  if (!issued) {
    return <Navigate to="/" replace />;
  }

  const { ticket, categoryName } = issued;

  return (
    <main className="kiosk-result">
      <h1 className="kiosk-result__label">Nomor Antrian Anda</h1>
      <p className="kiosk-result__number">{ticket.ticketNumber}</p>
      <p className="kiosk-result__category">{categoryName}</p>
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
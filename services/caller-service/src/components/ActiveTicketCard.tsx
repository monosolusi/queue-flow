import type { TicketStateDto } from '../api/types';

export interface ActiveTicketCardProps {
  /** The CALLING/SERVING ticket at this counter, or null when idle. */
  readonly ticket: TicketStateDto | null;
}

/** Prominent display of the ticket currently being served at this counter. */
export function ActiveTicketCard({ ticket }: ActiveTicketCardProps) {
  if (!ticket) {
    return (
      <section className="active-ticket active-ticket--empty" aria-label="Tiket Aktif">
        <p className="active-ticket__empty-text">Belum ada tiket aktif</p>
        <p className="active-ticket__empty-hint">Tekan "Panggil Berikutnya" untuk memanggil antrian.</p>
      </section>
    );
  }
  return (
    <section className="active-ticket" aria-label="Tiket Aktif">
      <span className="active-ticket__label">SEDANG DILAYANI</span>
      <span className="active-ticket__number">{ticket.ticketNumber}</span>
      <span className="active-ticket__status">{statusLabel(ticket.status)}</span>
    </section>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'CALLING':
      return 'Memanggil';
    case 'SERVING':
      return 'Melayani';
    default:
      return status;
  }
}
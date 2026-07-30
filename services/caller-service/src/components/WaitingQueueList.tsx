import type { TicketStateDto } from '../api/types';

export interface WaitingQueueListProps {
  readonly tickets: readonly TicketStateDto[];
  readonly waitingCount: number;
}

/** The list of WAITING tickets for this counter's categories. */
export function WaitingQueueList({ tickets, waitingCount }: WaitingQueueListProps) {
  return (
    <section className="waiting-queue" aria-label="Antrian Menunggu">
      <header className="waiting-queue__header">
        <h2 className="waiting-queue__title">Antrian Menunggu</h2>
        <span className="waiting-queue__count">{waitingCount} tiket</span>
      </header>
      {tickets.length === 0 ? (
        <p className="waiting-queue__empty">Tidak ada antrian menunggu.</p>
      ) : (
        <ol className="waiting-queue__list">
          {tickets.map((t) => (
            <li key={t.ticketId} className="waiting-queue__item">
              <span className="waiting-queue__number">{t.ticketNumber}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
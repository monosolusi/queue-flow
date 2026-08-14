import type { TicketStateDto } from '../api/types';
import type { WorkflowAction } from '../lib/workflow-actions';
import type { BoundCounter } from '../state/counter-binding';
import { TicketRowActions, runnableRowActions } from './TicketRowActions';

export interface WaitingQueueListProps {
  readonly tickets: readonly TicketStateDto[];
  readonly waitingCount: number;
  /** The outgoing actions of the WAITING status, taken by the workspace from the
   *  server's action surface (the counter-level call-next edge is already
   *  excluded). Empty — the PRD-default flow's only WAITING edge is `→ CALLING`
   *  — renders the plain list. */
  readonly actions?: readonly WorkflowAction[];
  /** The counter binding, for the transfer destinations. Required to render
   *  a `→ WAITING` (Pindah Kategori) action. */
  readonly bound?: BoundCounter;
  /** Key of the command currently in flight (see `actionRunKey`), or `null`. */
  readonly pending?: string | null;
  /** Message from the last failed waiting-list command. */
  readonly error?: string | null;
  /** Hint from a tap turned away because another row's command was in flight. */
  readonly notice?: string | null;
  readonly onAction?: (
    ticket: TicketStateDto,
    action: WorkflowAction,
    targetCategoryId?: string,
  ) => void;
}

/**
 * The list of WAITING tickets for this counter's categories, each row offering
 * the actions the admin-designed flow allows from WAITING (FR-CLR-02) — the
 * manager's own example: "dari waiting transisi keluar ada apa saja, itu
 * buttonnya harusnya sesuai". The `→ CALLING` edge is not among them: calling is
 * counter-level (call-next picks by routing/priority), so it lives in the action
 * panel.
 *
 * Presentational — it neither fetches the flow nor decides which command runs an
 * action; the workspace resolves both and passes them in.
 */
export function WaitingQueueList({
  tickets,
  waitingCount,
  actions = [],
  bound,
  pending = null,
  error = null,
  notice = null,
  onAction,
}: WaitingQueueListProps) {
  const runnable = runnableRowActions(actions, bound, onAction !== undefined);
  const actionable = runnable.length > 0;

  return (
    <section className="waiting-queue" aria-label="Antrian Menunggu">
      <header className="waiting-queue__header">
        <h2 className="waiting-queue__title">Antrian Menunggu</h2>
        <span className="waiting-queue__count">{waitingCount} tiket</span>
      </header>
      {tickets.length === 0 ? (
        <p className="waiting-queue__empty">Tidak ada antrian menunggu.</p>
      ) : (
        // The list is a capped scroll container (styles.css), and a scroller
        // whose contents hold no focusable element is unreachable by keyboard
        // (WCAG 2.1.1). Chrome 127+/Firefox make scrollers focusable on their
        // own; `tabIndex={0}` makes that guarantee universal here. The
        // surrounding <section> carries the accessible name, so the <ol> needs
        // no label of its own — it is a scroll stop, not a widget.
        <ol
          className={`waiting-queue__list${actionable ? ' waiting-queue__list--actionable' : ''}`}
          tabIndex={0}
        >
          {tickets.map((t) => (
            <li
              key={t.ticketId}
              className={`waiting-queue__item${actionable ? ' waiting-queue__item--actionable' : ''}`}
            >
              <span className="waiting-queue__number">{t.ticketNumber}</span>
              {actionable && onAction && (
                <TicketRowActions
                  ticket={t}
                  actions={runnable}
                  bound={bound}
                  pending={pending}
                  testIdStem="waiting-action"
                  onAction={onAction}
                />
              )}
            </li>
          ))}
        </ol>
      )}
      {notice && <p className="waiting-queue__notice">{notice}</p>}
      {error && <p className="waiting-queue__error">{error}</p>}
    </section>
  );
}

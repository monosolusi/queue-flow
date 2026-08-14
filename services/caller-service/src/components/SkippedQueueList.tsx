import type { TicketStateDto } from '../api/types';
import type { WorkflowAction } from '../lib/workflow-actions';
import type { BoundCounter } from '../state/counter-binding';
import { TicketRowActions, runnableRowActions } from './TicketRowActions';

export interface SkippedQueueListProps {
  readonly tickets: readonly TicketStateDto[];
  /** The outgoing actions of the SKIPPED status, taken by the workspace from the
   *  server's action surface. In the PRD §7 default flow that is "Panggil Ulang"
   *  (SKIPPED → CALLING); a manager may configure more. */
  readonly actions?: readonly WorkflowAction[];
  /** The counter binding, for the transfer destinations. Required to render
   *  a category-move action. */
  readonly bound?: BoundCounter;
  /** Key of the command currently in flight (see `actionRunKey`), or `null`. */
  readonly pending?: string | null;
  /** Message from the last failed skipped-list command. */
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
 * The tickets this counter skipped ("Lewati / Absen") and has not resolved yet,
 * each row offering the actions the admin-designed flow allows from SKIPPED
 * (FR-CLR-02) — "Panggil Ulang" in the PRD §7 default flow.
 *
 * The surface exists because SKIPPED is a live status, not an ending: without a
 * list holding these tickets they leave the panel the moment they are skipped
 * and the recall action, though published by the flow, can never be tapped —
 * the counter would have no way to serve a customer who came back.
 *
 * Presentational, mirroring {@link WaitingQueueList}: it neither fetches the
 * flow nor decides which command runs an action; the workspace resolves both and
 * passes them in.
 */
export function SkippedQueueList({
  tickets,
  actions = [],
  bound,
  pending = null,
  error = null,
  notice = null,
  onAction,
}: SkippedQueueListProps) {
  const runnable = runnableRowActions(actions, bound, onAction !== undefined);
  const actionable = runnable.length > 0;

  return (
    <section className="skipped-queue" aria-label="Tiket Dilewati">
      <header className="skipped-queue__header">
        <h2 className="skipped-queue__title">Tiket Dilewati</h2>
        <span className="skipped-queue__count">{tickets.length} tiket</span>
      </header>
      {tickets.length === 0 ? (
        <p className="skipped-queue__empty">Tidak ada tiket yang dilewati.</p>
      ) : (
        <>
          <p className="skipped-queue__hint">
            Tiket yang tidak hadir saat dipanggil. Panggil ulang kalau orangnya sudah datang.
          </p>
          <ol
            className={`skipped-queue__list${actionable ? ' skipped-queue__list--actionable' : ''}`}
          >
            {tickets.map((t) => (
              <li
                key={t.ticketId}
                className={`skipped-queue__item${actionable ? ' skipped-queue__item--actionable' : ''}`}
              >
                <span className="skipped-queue__number">{t.ticketNumber}</span>
                {actionable && onAction && (
                  <TicketRowActions
                    ticket={t}
                    actions={runnable}
                    bound={bound}
                    pending={pending}
                    testIdStem="skipped-action"
                    onAction={onAction}
                  />
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {notice && <p className="skipped-queue__notice">{notice}</p>}
      {error && <p className="skipped-queue__error">{error}</p>}
    </section>
  );
}

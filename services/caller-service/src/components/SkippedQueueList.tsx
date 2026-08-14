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
  /** Why the flow surface could not be read, when it could not (see
   *  `useWorkflowActions`). Distinct from {@link error}, which reports a failed
   *  command: this one explains why the rows have no buttons at all. */
  readonly workflowError?: string | null;
  readonly onAction?: (
    ticket: TicketStateDto,
    action: WorkflowAction,
    targetCategoryId?: string,
  ) => void;
}

/** How the list explains itself above the rows. */
interface SkippedListHint {
  readonly text: string;
  /** `notice` — a configuration fact worth reading (nothing is broken, the flow
   *  simply offers nothing here), so it is set apart from the everyday hint. */
  readonly tone: 'muted' | 'notice';
}

/** The flow published a recall the panel can run — the promise the copy has
 *  always made, now only made when it is true. */
const RECALL_HINT =
  'Tiket yang tidak hadir saat dipanggil. Panggil ulang kalau orangnya sudah datang.';
/** Runnable actions, but none of them re-calls the ticket: point at the row
 *  buttons instead of promising a recall that this flow does not have. */
const OTHER_ACTIONS_HINT =
  'Tiket yang tidak hadir saat dipanggil. Pilih tindakan yang tersedia di tombol tiap tiket.';
/** Transitions are configured but none is executable from the counter (e.g. a
 *  self-loop that would change nothing, or a category move with nowhere to go). */
const UNRUNNABLE_ACTIONS_HINT =
  'Lanjutan dari status Dilewati sudah diatur di alur status, tetapi belum bisa dijalankan ' +
  'dari panel loket.';
/** Appended only when those transitions actually rendered as buttons — each one
 *  carries its own reason, so send staff there rather than leaving them
 *  unexplained. Without buttons there is nothing to point at. */
const UNRUNNABLE_REASONS_SUFFIX = ' Alasannya tertulis di bawah tombol tiap tiket.';
/** Nothing at all to offer, and the flow was read successfully — so this IS the
 *  configuration: the active alur status has no transition leaving "Dilewati".
 *  States where it is set WITHOUT telling this reader to go and do it: the
 *  counter panel's user is `caller-staff`, who is RBAC-blocked from /admin. */
const NO_ACTIONS_HINT =
  'Tiket yang dilewati belum bisa dipanggil ulang: alur status yang dipakai sekarang tidak ' +
  'punya lanjutan dari status Dilewati. Lanjutannya diatur di halaman Alur Status Tiket ' +
  'pada panel admin.';
/** The action surface could not be read at all (`GET /api/queue/actions` failed,
 *  or 409'd because the system is not configured yet). Held apart from
 *  {@link NO_ACTIONS_HINT} even though `ticketActionsFor` yields the same empty
 *  list for both: this one is a transient read failure, and sending the manager
 *  off to redraw a flow because the network hiccuped would have them fix
 *  something that is not broken. */
const FLOW_UNREAD_HINT =
  'Daftar tindakan belum bisa dibaca, jadi tombol untuk tiket di bawah belum muncul. ' +
  'Coba muat ulang halaman.';

/**
 * The hint above the rows, derived from the actions the flow actually published.
 * The panel already takes the admin-designed flow as the source of truth for its
 * buttons; the copy must obey the same rule, or it advertises a "Panggil Ulang"
 * that no button offers — the manager read the old unconditional hint, found no
 * button, and asked why the description says a skipped ticket can be re-called.
 *
 * Presentation only: it reads the `command` core-api already resolved for each
 * edge and derives no routing of its own.
 */
function skippedListHint(
  /** What the rows actually render — `published` minus what this list dropped. */
  rendered: readonly WorkflowAction[],
  /** What the flow published for SKIPPED. Only a claim ABOUT THE FLOW may be
   *  made from this one; everything describing buttons reads `rendered`. */
  published: readonly WorkflowAction[],
  workflowError: string | null,
  /** Whether a category move has anywhere to go: `TransferAction` renders a
   *  destination-less transfer disabled, so on a single-category counter a
   *  configured `→ WAITING` edge is a button that cannot be tapped. */
  transferPossible: boolean,
): SkippedListHint {
  // Checked first: an unread surface is indistinguishable from an empty one by
  // its actions alone, and only the workspace knows which happened.
  if (workflowError !== null && published.length === 0) {
    return { text: FLOW_UNREAD_HINT, tone: 'notice' };
  }
  const tappable = (a: WorkflowAction) =>
    a.command !== null && (a.command !== 'TRANSFER' || transferPossible);
  if (rendered.some((a) => a.command === 'RECALL')) return { text: RECALL_HINT, tone: 'muted' };
  if (rendered.some(tappable)) return { text: OTHER_ACTIONS_HINT, tone: 'muted' };
  // Configured, but nothing here can run it. Point at the per-button reasons
  // only when there are buttons to point at.
  if (published.length > 0) {
    return {
      text: UNRUNNABLE_ACTIONS_HINT + (rendered.length > 0 ? UNRUNNABLE_REASONS_SUFFIX : ''),
      tone: 'notice',
    };
  }
  return { text: NO_ACTIONS_HINT, tone: 'notice' };
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
  workflowError = null,
  onAction,
}: SkippedQueueListProps) {
  const runnable = runnableRowActions(actions, bound, onAction !== undefined);
  const actionable = runnable.length > 0;
  // Every ticket in this bucket was called at this counter, so its category is
  // one the counter serves: a second assigned category is exactly the condition
  // under which `transferCandidates` can yield a destination for any row.
  const transferPossible = (bound?.assignedCategoryIds.length ?? 0) > 1;
  // Two lists, deliberately: the wording about BUTTONS follows what the rows
  // rendered (a transfer dropped for want of a binding leaves no button, so it
  // must not leave a hint pointing at one), while the wording about the FLOW
  // may only be derived from what the flow published.
  const hint = skippedListHint(runnable, actions, workflowError, transferPossible);

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
          <p
            className={`skipped-queue__hint${
              hint.tone === 'notice' ? ' skipped-queue__hint--notice' : ''
            }`}
            data-testid="skipped-hint"
          >
            {hint.text}
          </p>
          <ol
            className={`skipped-queue__list${actionable ? ' skipped-queue__list--actionable' : ''}`}
            // Capped scroll container (styles.css) — see WaitingQueueList for
            // why the scroller carries its own tab stop (WCAG 2.1.1).
            tabIndex={0}
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

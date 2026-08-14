import { useCallback, useMemo } from 'react';
import { ActiveTicketCard } from '../components/ActiveTicketCard';
import { ActionControls } from '../components/ActionControls';
import { CounterHeader } from '../components/CounterHeader';
import { SkippedQueueList } from '../components/SkippedQueueList';
import { WaitingQueueList } from '../components/WaitingQueueList';
import type { TicketStateDto } from '../api/types';
import type { ICallerApi } from '../api/caller-api';
import { actionRunKey, ticketActionsFor, type WorkflowAction } from '../lib/workflow-actions';
import { invokeWorkflowAction } from '../lib/workflow-commands';
import type { BoundCounter } from '../state/counter-binding';
import { useWorkflowActions } from '../state/use-workflow-actions';
import { useCommandRunner, type CommandRunner } from '../state/use-command-runner';
import { useQueueStore } from '../state/queue-store';

export interface WorkspacePageProps {
  readonly bound: BoundCounter;
  readonly onUnbind: () => void;
}

/**
 * A queue list's command channel: its own runner plus the row handler that feeds
 * it. One per list, so the one-at-a-time rule — and the pending / error /
 * notice it produces — is scoped to the surface that displays it: a failure on a
 * skipped row must not print its message under the waiting list.
 */
function useListCommands(api: ICallerApi): {
  readonly runner: CommandRunner;
  readonly onAction: (
    ticket: TicketStateDto,
    action: WorkflowAction,
    targetCategoryId?: string,
  ) => void;
} {
  const runner = useCommandRunner();
  const { run } = runner;
  const onAction = useCallback(
    (ticket: TicketStateDto, action: WorkflowAction, targetCategoryId?: string) => {
      void run(actionRunKey(ticket.ticketId, action), () =>
        invokeWorkflowAction(api, action, ticket.ticketId, targetCategoryId),
      );
    },
    [api, run],
  );
  return { runner, onAction };
}

/**
 * The active queue workspace: header (counter identity + WS status + change
 * counter), the prominent active ticket, the live waiting list, the skipped
 * tickets awaiting a re-call, and the dynamic action controls (FR-CLR-02).
 *
 * The page owns the action surface (`useWorkflowActions`) because three children
 * derive their buttons from it: {@link ActionControls} for the ticket at the
 * counter, {@link WaitingQueueList} for the queued ones, {@link SkippedQueueList}
 * for the absent ones. A single fetch keeps them in lock-step and refreshes them
 * all on a `SYSTEM_CONFIG_CHANGED` bump. Commands are fire-and-forget — the
 * resulting lifecycle event arrives over the WebSocket and updates the store.
 */
export function WorkspacePage({ bound, onUnbind }: WorkspacePageProps) {
  const { state, api } = useQueueStore();
  const active = state.active[0] ?? null;
  const { workflow, error: flowError } = useWorkflowActions(api, state.configVersion);

  // The rows of a list all share one status, so their actions resolve once.
  const waitingActions = useMemo(() => ticketActionsFor(workflow, 'WAITING'), [workflow]);
  const skippedActions = useMemo(() => ticketActionsFor(workflow, 'SKIPPED'), [workflow]);
  const waitingCommands = useListCommands(api);
  const skippedCommands = useListCommands(api);

  return (
    <main className="workspace">
      <CounterHeader bound={bound} connection={state.connection} onUnbind={onUnbind} />
      {state.loadStatus === 'loading' && (
        <div className="workspace__body" role="status" aria-busy="true" data-testid="workspace-loading">
          <span className="sr-only">Memuat antrian…</span>
          <div className="skeleton skeleton--block skeleton--wide" aria-hidden="true" />
          <div className="skeleton skeleton--row skeleton--wide" aria-hidden="true" />
          <div className="skeleton skeleton--row skeleton--wide" aria-hidden="true" />
        </div>
      )}
      {state.loadStatus === 'error' && (
        <p className="workspace__hint workspace__hint--error">
          {state.loadError ?? 'Gagal memuat antrian.'}
        </p>
      )}
      {state.loadStatus === 'loaded' && (
        <div className="workspace__body">
          <ActiveTicketCard ticket={active} />
          <WaitingQueueList
            tickets={state.waiting}
            waitingCount={state.waitingCount}
            actions={waitingActions}
            bound={bound}
            pending={waitingCommands.runner.pending}
            error={waitingCommands.runner.error}
            notice={waitingCommands.runner.notice}
            onAction={waitingCommands.onAction}
          />
          <SkippedQueueList
            tickets={state.skipped}
            actions={skippedActions}
            bound={bound}
            pending={skippedCommands.runner.pending}
            error={skippedCommands.runner.error}
            notice={skippedCommands.runner.notice}
            onAction={skippedCommands.onAction}
          />
          <ActionControls
            api={api}
            bound={bound}
            active={active}
            workflow={workflow}
            workflowError={flowError}
          />
        </div>
      )}
    </main>
  );
}

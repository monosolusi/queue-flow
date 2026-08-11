import { useTvStore } from '../state/tv-store';
import { NowServingCard } from '../components/NowServingCard';
import { CallHistory } from '../components/CallHistory';
import { WaitingQueue } from '../components/WaitingQueue';
import { CountersServing } from '../components/CountersServing';
import { ConnectionStatusBadge } from '../components/ConnectionStatus';
import { RunningText } from '../components/RunningText';

/**
 * The TV queue board (FR-TV-01..02). Shows the big now-serving number + the
 * waiting queue + the counters currently serving + recent call history. Each
 * panel's visibility is gated by the manager-configured `tvDisplayOptions`
 * (all-visible by default — zero visual regression). When the queue is idle
 * (`nowServing == null`) the {@link NowServingCard} renders its own empty
 * state ("Menunggu panggilan berikutnya…") inside the active board — that is
 * the sole idle state. All realtime + audio wiring is owned by the
 * surrounding {@link TvStoreProvider}, so this page stays a pure projection
 * (SRP — it renders + announces nothing on its own).
 */
export function TvBoardPage() {
  const { state } = useTvStore();
  const opts = state.displayOptions;

  return (
    <div className="tv-board">
      <header className="tv-board__header">
        <h1 className="tv-board__storename">{state.storeName || 'Antrian'}</h1>
        <ConnectionStatusBadge status={state.connection} />
      </header>

      <main className="tv-board__main">
        <div className="tv-board__active" data-testid="board-active">
          <div className="tv-board__active-grid">
            {/* showNowServing=false renders the hero's empty state so the grid
                column stays mounted and the layout stays stable. */}
            <NowServingCard nowServing={opts.showNowServing ? state.nowServing : null} />
            {/* The 1fr right column stacks the counters-serving list (top),
                the waiting queue (middle, flex:1), and the call history
                (bottom); the now-serving card stays the 2fr hero on the left. */}
            <div className="tv-board__active-side">
              {opts.showCountersServing && (
                <CountersServing countersServing={state.countersServing} />
              )}
              {opts.showWaitingQueue && (
                <WaitingQueue waiting={state.waiting} categories={state.categories} />
              )}
              {opts.showCallHistory && <CallHistory history={state.history} />}
            </div>
          </div>
        </div>
      </main>

      {opts.showRunningText && <RunningText />}
    </div>
  );
}
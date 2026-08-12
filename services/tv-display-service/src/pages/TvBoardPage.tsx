import { useTvStore } from '../state/tv-store';
import { NowServingCard } from '../components/NowServingCard';
import { CallHistory } from '../components/CallHistory';
import { WaitingQueue } from '../components/WaitingQueue';
import { CountersServing } from '../components/CountersServing';
import { ConnectionStatusBadge } from '../components/ConnectionStatus';
import { RunningText } from '../components/RunningText';
import type { TvComponentType } from '../api/types';

/**
 * The TV queue board (FR-TV-01..02). Renders the manager-configured 12-column
 * CSS grid of placed widgets (`tvPanelLayout` — an ordered list of
 * `{ id, component, x, y, w, h }`). Each widget is placed via inline
 * `grid-column` / `grid-row` spans; the widget wrapper is a flex column so the
 * inner component fills its cell. `runningText` is now just another widget
 * rendered inside its grid cell (no special footer case — the old fixed-footer
 * special-casing is collapsed). When the queue is idle (`nowServing == null`)
 * the {@link NowServingCard} renders its own empty state ("Menunggu panggilan
 * berikutnya…") inside its cell — that is the sole idle state. An empty
 * `panelLayout` (no placed widgets) renders the board empty-state status. All
 * realtime + audio wiring is owned by the surrounding {@link TvStoreProvider},
 * so this page stays a pure projection (SRP — it renders + announces nothing
 * on its own).
 */
export function TvBoardPage() {
  const { state } = useTvStore();
  const layout = state.panelLayout;

  return (
    <div className="tv-board">
      <header className="tv-board__header">
        <h1 className="tv-board__storename">{state.storeName || 'Antrian'}</h1>
        <ConnectionStatusBadge status={state.connection} />
      </header>

      <main className="tv-board__main">
        <div className="tv-board__active" data-testid="board-active">
          {layout.length === 0 ? (
            <div className="tv-board__panels-empty" role="status">
              Tidak ada panel yang ditampilkan — aktifkan panel di Tampilan TV.
            </div>
          ) : (
            <div className="tv-board__grid">
              {layout.map((widget) => (
                <div
                  key={widget.id}
                  className="tv-board__widget"
                  style={{
                    gridColumn: `${widget.x + 1} / span ${widget.w}`,
                    gridRow: `${widget.y + 1} / span ${widget.h}`,
                  }}
                  data-testid={`tv-board__widget--${widget.component}`}
                >
                  {renderWidget(widget.component, state)}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** Renders the component for a given widget type. Kept as a function (not a
 * lookup table) so the props stay type-checked at each call site. `runningText`
 * is rendered here like any other widget — it is no longer a special footer. */
function renderWidget(
  component: TvComponentType,
  state: ReturnType<typeof useTvStore>['state'],
) {
  switch (component) {
    case 'nowServing':
      return <NowServingCard nowServing={state.nowServing} />;
    case 'waitingQueue':
      return <WaitingQueue waiting={state.waiting} categories={state.categories} />;
    case 'callHistory':
      return <CallHistory history={state.history} />;
    case 'countersServing':
      return <CountersServing countersServing={state.countersServing} />;
    case 'runningText':
      return <RunningText />;
    default:
      return null;
  }
}
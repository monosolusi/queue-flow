import { useTvStore } from '../state/tv-store';
import { NowServingCard } from '../components/NowServingCard';
import { CallHistory } from '../components/CallHistory';
import { WaitingQueue } from '../components/WaitingQueue';
import { CountersServing } from '../components/CountersServing';
import { ConnectionStatusBadge } from '../components/ConnectionStatus';
import { RunningText } from '../components/RunningText';
import type { TvPanelKey } from '../api/types';
import { TV_PANEL_KEYS } from '../api/types';

/**
 * The TV queue board (FR-TV-01..02). Renders a flex column of visible content
 * panels in the manager-configured `order`, each with `flex: <size> 1 0`
 * (proportional height share from `tvPanelLayout`). When the queue is idle
 * (`nowServing == null`) the {@link NowServingCard} renders its own empty
 * state ("Menunggu panggilan berikutnya…") inside its panel — that is the
 * sole idle state. `runningText` is a fixed footer (visibility-gated only;
 * its `order`/`size` are stored for map uniformity but ignored here). All
 * realtime + audio wiring is owned by the surrounding {@link TvStoreProvider},
 * so this page stays a pure projection (SRP — it renders + announces nothing
 * on its own).
 */
export function TvBoardPage() {
  const { state } = useTvStore();
  const layout = state.panelLayout;

  // Build the ordered list of visible CONTENT panels (runningText excluded —
  // it is rendered as the fixed footer below). Sorted by `order` ascending;
  // ties keep insertion (TV_PANEL_KEYS) order via the stable sort.
  const panels = TV_PANEL_KEYS.filter((k) => k !== 'runningText')
    .map((k) => ({ key: k, ...layout[k] }))
    .filter((p) => p.visible)
    .sort((a, b) => a.order - b.order);

  return (
    <div className="tv-board">
      <header className="tv-board__header">
        <h1 className="tv-board__storename">{state.storeName || 'Antrian'}</h1>
        <ConnectionStatusBadge status={state.connection} />
      </header>

      <main className="tv-board__main">
        <div className="tv-board__active" data-testid="board-active">
          {panels.length === 0 ? (
            <div className="tv-board__panels-empty" role="status">
              Tidak ada panel yang ditampilkan — aktifkan panel di Tampilan TV.
            </div>
          ) : (
            <div className="tv-board__panels">
              {panels.map((p) => (
                <div
                  key={p.key}
                  className="tv-board__panel"
                  style={{ flex: `${p.size} 1 0` }}
                  data-testid={`tv-board__panel--${p.key}`}
                >
                  {renderPanel(p.key, state)}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {layout.runningText.visible && <RunningText />}
    </div>
  );
}

/** Renders the panel component for a given key. Kept as a function (not a
 * lookup table) so the props stay type-checked at each call site. */
function renderPanel(
  key: TvPanelKey,
  state: ReturnType<typeof useTvStore>['state'],
) {
  switch (key) {
    case 'nowServing':
      return <NowServingCard nowServing={state.nowServing} />;
    case 'waitingQueue':
      return <WaitingQueue waiting={state.waiting} categories={state.categories} />;
    case 'callHistory':
      return <CallHistory history={state.history} />;
    case 'countersServing':
      return <CountersServing countersServing={state.countersServing} />;
    default:
      // runningText is handled as the footer above; never reached here.
      return null;
  }
}
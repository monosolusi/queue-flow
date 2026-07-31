import { useTvStore } from '../state/tv-store';
import { NowServingCard } from '../components/NowServingCard';
import { CallHistory } from '../components/CallHistory';
import { ConnectionStatusBadge } from '../components/ConnectionStatus';

/**
 * The TV queue board (FR-TV-01..03). Big now-serving number, recent call
 * history, a CSS-marquee running text of the store name when idle (FR-TV-03
 * minimal), and a connection indicator. All realtime + audio wiring is owned by
 * the surrounding {@link TvStoreProvider}; this page is a pure projection of
 * the store state (SRP — it renders + announces nothing on its own).
 */
export function TvBoardPage() {
  const { state } = useTvStore();

  return (
    <div className="tv-board">
      <header className="tv-board__header">
        <h1 className="tv-board__storename">{state.storeName || 'Antrian'}</h1>
        <ConnectionStatusBadge status={state.connection} />
      </header>

      <main className="tv-board__main">
        <NowServingCard nowServing={state.nowServing} />
        <CallHistory history={state.history} />
      </main>

      {/* Running text idle (FR-TV-03 minimal): a CSS marquee of the store name. */}
      <footer className="tv-board__marquee" aria-hidden={state.nowServing ? 'true' : 'false'}>
        <div className="marquee__track">
          Selamat datang di {state.storeName || 'layanan antrian kami'} — mohon perhatikan nomor antrian Anda
        </div>
      </footer>
    </div>
  );
}
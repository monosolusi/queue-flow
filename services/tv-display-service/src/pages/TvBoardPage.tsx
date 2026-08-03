import { useTvStore } from '../state/tv-store';
import { NowServingCard } from '../components/NowServingCard';
import { CallHistory } from '../components/CallHistory';
import { ConnectionStatusBadge } from '../components/ConnectionStatus';
import { StandbyMedia } from '../components/StandbyMedia';
import { DEFAULT_STANDBY_CONTENT, resolveRunningText } from '../standby/standby-content';

/**
 * A CSS-marquee running text (FR-TV-03). `prominent` renders it as the primary
 * idle announcement (large, full-width, announced to assistive tech); the
 * non-prominent variant is the decorative footer shown alongside the active
 * board. The prose is sourced once from `DEFAULT_STANDBY_CONTENT.runningText`
 * with the `{storeName}` placeholder resolved against the boot-loaded store
 * name, so it never lives as a hardcoded string in the page.
 */
function RunningText({ text, prominent }: { readonly text: string; readonly prominent: boolean }) {
  return (
    <div
      className={`tv-board__marquee${prominent ? ' tv-board__marquee--prominent' : ''}`}
      aria-hidden={prominent ? 'false' : 'true'}
    >
      <div className="marquee__track">{text}</div>
    </div>
  );
}

/**
 * The TV queue board (FR-TV-01..03). When a ticket is being called it shows the
 * big now-serving number + recent call history (FR-TV-01). When the queue is
 * idle (`nowServing == null`) it shows the standby panel — bundled banner/video
 * promo media cycled by {@link StandbyMedia} plus a prominent running-text
 * announcement (FR-TV-03). The idle→active handoff is driven by the store's
 * `nowServing` projection; all realtime + audio wiring is owned by the
 * surrounding {@link TvStoreProvider}, so this page stays a pure projection
 * (SRP — it renders + announces nothing on its own).
 */
export function TvBoardPage() {
  const { state } = useTvStore();
  const idle = state.nowServing === null;
  const runningText = resolveRunningText(
    DEFAULT_STANDBY_CONTENT.runningText,
    state.storeName,
  );

  return (
    <div className="tv-board">
      <header className="tv-board__header">
        <h1 className="tv-board__storename">{state.storeName || 'Antrian'}</h1>
        <ConnectionStatusBadge status={state.connection} />
      </header>

      <main className="tv-board__main">
        {idle ? (
          <section className="standby" aria-label="Mode standby" data-testid="standby">
            <StandbyMedia assets={DEFAULT_STANDBY_CONTENT.media} />
            <RunningText text={runningText} prominent />
          </section>
        ) : (
          <>
            <NowServingCard nowServing={state.nowServing} />
            <CallHistory history={state.history} />
          </>
        )}
      </main>

      {/* Active-mode footer running text (decorative). When idle the prominent
          running text lives inside the standby section above. */}
      {!idle && <RunningText text={runningText} prominent={false} />}
    </div>
  );
}
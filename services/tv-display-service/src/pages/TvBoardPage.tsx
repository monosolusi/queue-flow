import { useTvStore } from '../state/tv-store';
import { NowServingCard } from '../components/NowServingCard';
import { CallHistory } from '../components/CallHistory';
import { WaitingQueue } from '../components/WaitingQueue';
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
      <div className="marquee__track">
        {/* Two copies so the loop is seamless: as one copy scrolls out left the
            next follows with no blank gap. The duplicate is hidden from AT so
            the announcement is read once (AC7). */}
        <span>{text}</span>
        <span className="marquee__dup" aria-hidden="true">{text}</span>
      </div>
    </div>
  );
}

/**
 * The TV queue board (FR-TV-01..03). When a ticket is being called it shows the
 * big now-serving number + recent call history (FR-TV-01). When the queue is
 * idle (`nowServing == null`) it shows the standby panel — the waiting queue
 * shares the idle screen with (now smaller) promo media cycled by
 * {@link StandbyMedia}, plus a prominent running-text announcement (FR-TV-03).
 * The idle→active handoff is driven by the store's `nowServing` projection;
 * all realtime + audio wiring is owned by the surrounding
 * {@link TvStoreProvider}, so this page stays a pure projection (SRP — it
 * renders + announces nothing on its own).
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
        {/* Both layers are always mounted and crossfade via opacity+visibility
            (AC6). The inactive layer carries a `--hidden` modifier (visibility
            hides it from AT as well as visually). The now-serving live region
            (AC1) lives only on the populated block below, which mounts exactly
            when this layer is visible (nowServing != null) — so the live region
            is never hidden; it mounts fresh with content on each call. */}
        <div
          className={`tv-board__active${idle ? ' tv-board__active--hidden' : ''}`}
          data-testid="board-active"
        >
          <div className="tv-board__active-grid">
            <NowServingCard nowServing={state.nowServing} />
            {/* The 1fr right column stacks the waiting queue (top) above the
                call history (bottom); the now-serving card stays the 2fr hero
                on the left. */}
            <div className="tv-board__active-side">
              <WaitingQueue waiting={state.waiting} categories={state.categories} />
              <CallHistory history={state.history} />
            </div>
          </div>
          {/* Active-mode footer running text (decorative, aria-hidden). It lives
              inside the active layer so it fades with the board, not pop-in. */}
          <RunningText text={runningText} prominent={false} />
        </div>
        <section
          className={`standby${idle ? '' : ' standby--hidden'}`}
          aria-label="Mode standby"
          data-testid="standby"
        >
          {/* Idle layout (FR-TV-03): the waiting queue takes the left half so a
              customer is never left looking at ads with no queue in sight (the
              "pindahkan iklan ke temppat lain" fix); promo media is demoted to
              the right half. The active WaitingQueue is the single aria-live
              region — the standby instance is `live={false}` (a non-live visual
              duplicate) so two always-mounted live regions don't double-announce
              (mirrors the active layer's "live region mounts fresh / is never
              hidden" rule). */}
          <div className="standby__grid">
            <WaitingQueue
              waiting={state.waiting}
              categories={state.categories}
              live={false}
            />
            <StandbyMedia assets={DEFAULT_STANDBY_CONTENT.media} />
          </div>
          <RunningText text={runningText} prominent />
        </section>
      </main>
    </div>
  );
}
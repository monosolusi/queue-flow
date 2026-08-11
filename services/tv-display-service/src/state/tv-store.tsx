import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type {
  CategoryDto,
  CounterServing,
  QueueLifecycleWireEvent,
  TvPanelLayoutMap,
  TvTicketDto,
} from '../api/types';
import { DEFAULT_TV_PANEL_LAYOUT } from '../api/types';
import type { ITvApi } from '../api/tv-api';
import { type AudioProvider } from '../audio/audio-provider';
import { buildCallFragments } from '../audio/audio-provider';
import { applyBrandColor, applyThemeMode } from '../lib/theme';
import { QueueSocket, type ConnectionStatus, type QueueSocketOptions } from '../realtime/queue-socket';

export interface NowServing {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly counterId: number;
}

/** The slice of a waiting ticket the board renders (id + display fields). */
export interface WaitingTicket {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
}

export interface TvState {
  /** The ticket currently being served (the big board number). */
  readonly nowServing: NowServing | null;
  /** The last (up to 5) previously-called tickets, newest first. */
  readonly history: readonly NowServing[];
  /**
   * The global waiting queue (every WAITING ticket across all categories,
   * oldest first). Sourced from the server's `GET /api/queue/board` read
   * model and refetched after every lifecycle event — the TV does NOT project
   * this from events (SRP — the server owns the queue read model).
   */
  readonly waiting: readonly WaitingTicket[];
  /**
   * The counters-serving panel ("Sedang Melayani"), projected client-side from
   * `GET /api/queue/board`'s `active` array joined with the boot-built
   * `counterNameById` map. The list includes EVERY configured counter (from
   * `routingRules`); a counter with no active ticket right now is shown as
   * idle (em dash, `idle: true`, muted) — a single on-premise store has every
   * configured counter operational, so idle counters stay visible instead of
   * disappearing from the board. Sourced from the server's read model (like
   * `waiting`) and refreshed via the same debounced board refetch — the TV
   * does NOT project this from events (SRP — the server owns the read model).
   */
  readonly countersServing: readonly CounterServing[];
  /** Per-panel layout from `SystemConfiguration.tvPanelLayout` (visible/order/
   * size for each of the five panels). Applied at boot; drives the page's
   * ordered flex-column rendering. Config (not queue state) — preserved
   * across `SYSTEM_RESET`. */
  readonly panelLayout: TvPanelLayoutMap;
  /** Boot-built counter id→name map from `routingRules`. Kept in state so the
   * BOOT_LOADED reducer can re-derive `countersServing` once this map is
   * populated, without a second board fetch (the first board fetch races the
   * config fetch and resolves with the empty initial map → fallback names;
   * BOOT_LOADED re-derives with the populated map). Defensive fallback to
   * `Counter {id}` when a counter appears in the active slice but was absent
   * from the boot config (e.g. a counter added after boot). */
  readonly counterNameById: ReadonlyMap<number, string>;
  /** The raw active slice from the last `BOARD_LOADED`, stashed so BOOT_LOADED
   * can re-derive `countersServing` once the counter-name map is populated.
   * Internal — not consumed by the page. */
  readonly lastActive: readonly TvTicketDto[];
  readonly connection: ConnectionStatus;
  readonly loadStatus: 'loading' | 'loaded' | 'error';
  readonly loadError: string | null;
  readonly storeName: string;
  readonly categories: readonly CategoryDto[];
}

export type TvAction =
  | {
      type: 'BOOT_LOADED';
      storeName: string;
      categories: CategoryDto[];
      panelLayout: TvPanelLayoutMap;
      counterNameById: ReadonlyMap<number, string>;
    }
  | { type: 'BOOT_ERROR'; message: string }
  | {
      type: 'BOARD_LOADED';
      nowServing: NowServing | null;
      waiting: readonly WaitingTicket[];
      active: readonly TvTicketDto[];
    }
  | { type: 'CONNECTION'; status: ConnectionStatus }
  | { type: 'EVENT'; event: QueueLifecycleWireEvent };

const HISTORY_LIMIT = 5;
/** Debounce for refetching the TV board state after a lifecycle event. */
const BOARD_REFETCH_DEBOUNCE_MS = 300;
/** Periodic safety-net refetch interval (covers a dropped broadcast). */
const BOARD_REFETCH_INTERVAL_MS = 30_000;

const initialState: TvState = {
  nowServing: null,
  history: [],
  waiting: [],
  countersServing: [],
  panelLayout: DEFAULT_TV_PANEL_LAYOUT,
  counterNameById: new Map<number, string>(),
  lastActive: [],
  connection: 'closed',
  loadStatus: 'loading',
  loadError: null,
  storeName: '',
  categories: [],
};

/** Maps a wire DTO row into the slim waiting slice the board renders. */
function toWaitingTicket(t: TvTicketDto): WaitingTicket {
  return { ticketId: t.ticketId, ticketNumber: t.ticketNumber, categoryId: t.categoryId };
}

/**
 * Projects the `counters-serving` list from the board state's `active` slice
 * joined with the boot-built counter-name map. The list includes EVERY
 * configured counter (the union of `counterNameById` keys AND any counter id
 * appearing in the `active` slice — the latter preserves the defensive
 * fallback for a counter added after boot that's not in the boot config map).
 * A counter with an active ticket shows its real ticket fields (`idle: false`);
 * a counter with no active ticket shows `ticketNumber: '—'`, `ticketId: ''`,
 * `status: ''`, `idle: true` (visible-but-muted — a single on-premise store
 * has every configured counter operational, so idle counters stay on the
 * board instead of disappearing). The `active` slice is grouped by
 * `counterId` keeping the LAST (most-recently-touched, since `active` is
 * ordered by `updatedAt` asc), then every counter id is sorted ascending for
 * stable display. Falls back to `Counter {id}` when a counter has no
 * boot-config name (defensive against a counter added after boot).
 */
function toCountersServing(
  active: readonly TvTicketDto[],
  counterNameById: ReadonlyMap<number, string>,
): readonly CounterServing[] {
  // Group active rows by counterId; last-in-wins (active is updatedAt asc →
  // last is most-recently-touched).
  const activeByCounter = new Map<number, TvTicketDto>();
  for (const t of active) {
    if (t.counterId === null) continue;
    activeByCounter.set(t.counterId, t);
  }
  // The union of configured counter ids AND any counter appearing in the
  // active slice (defensive against a counter added after boot that's not in
  // the boot config map).
  const ids = new Set<number>(counterNameById.keys());
  for (const id of activeByCounter.keys()) ids.add(id);
  return [...ids]
    .map((counterId) => {
      const t = activeByCounter.get(counterId);
      const counterName = counterNameById.get(counterId) ?? `Counter ${counterId}`;
      if (t) {
        return {
          counterId,
          counterName,
          ticketNumber: t.ticketNumber,
          ticketId: t.ticketId,
          status: t.status,
          idle: false,
        };
      }
      return {
        counterId,
        counterName,
        ticketNumber: '—',
        ticketId: '',
        status: '',
        idle: true,
      };
    })
    .sort((a, b) => a.counterId - b.counterId);
}

/**
 * Maps the most-recently-touched active row into the {@link NowServing} slice.
 * Returns `null` when `counterId` is null — defensive against a degenerate
 * custom machine that produced an active row without a counter; the PRD
 * default machine always sets `counterId` on CALLING/SERVING.
 */
function toNowServing(t: TvTicketDto): NowServing | null {
  if (t.counterId === null) return null;
  return { ticketId: t.ticketId, ticketNumber: t.ticketNumber, counterId: t.counterId };
}

function tvReducer(state: TvState, action: TvAction): TvState {
  switch (action.type) {
    case 'BOOT_LOADED':
      return {
        ...state,
        storeName: action.storeName,
        categories: action.categories,
        panelLayout: action.panelLayout,
        counterNameById: action.counterNameById,
        // Re-derive countersServing from the stashed lastActive joined with
        // the now-populated counterNameById (the first BOARD_LOADED raced the
        // config fetch and used the empty initial map → fallback names; this
        // re-derives with real names with no second board fetch).
        countersServing: toCountersServing(state.lastActive, action.counterNameById),
        loadStatus: 'loaded',
        loadError: null,
      };
    case 'BOOT_ERROR':
      return { ...state, loadStatus: 'error', loadError: action.message };
    case 'BOARD_LOADED': {
      // Dedupe history against the restored nowServing so a ticket never
      // appears in both nowServing and history (a server restore can
      // re-introduce a ticket that was previously pushed into history by a
      // TICKET_CALLED event — e.g. multi-counter where an older active ticket
      // was displaced to history by a newer call, then the newer call
      // completes and the refetch restores the older one as nowServing).
      // BOARD_LOADED must NOT wipe history (history is client-projected from
      // events; the server read carries only active+waiting, not completed
      // history) — it only dedupes against the restored nowServing.
      const history = action.nowServing
        ? state.history.filter((h) => h.ticketId !== action.nowServing!.ticketId)
        : state.history;
      return {
        ...state,
        nowServing: action.nowServing,
        history,
        waiting: action.waiting,
        lastActive: action.active,
        // Derive countersServing from the raw active slice joined with the
        // current counterNameById (empty on the first boot fetch → fallback
        // names; re-derived with real names when BOOT_LOADED dispatches the
        // populated map).
        countersServing: toCountersServing(action.active, state.counterNameById),
      };
    }
    case 'CONNECTION':
      return { ...state, connection: action.status };
    case 'EVENT':
      return projectEvent(state, action.event);
    default:
      return state;
  }
}

/** Projects a single lifecycle event onto the TV board state. */
function projectEvent(state: TvState, e: QueueLifecycleWireEvent): TvState {
  switch (e.type) {
    case 'TICKET_CREATED':
      // The TV board is not a waiting-queue monitor (SRP); ignore new tickets.
      return state;
    case 'TICKET_CALLED': {
      const p = e.payload as Extract<QueueLifecycleWireEvent['payload'], { ticketNumber: string; counterId: number }>;
      const called: NowServing = { ticketId: e.aggregateId, ticketNumber: p.ticketNumber, counterId: p.counterId };
      // Push the previous now-serving into history (newest first, keep 5).
      const history = state.nowServing
        ? [state.nowServing, ...state.history].slice(0, HISTORY_LIMIT)
        : state.history;
      return { ...state, nowServing: called, history };
    }
    case 'STATUS_UPDATED': {
      const p = e.payload as Extract<QueueLifecycleWireEvent['payload'], { from: string; to: string }>;
      if (state.nowServing?.ticketId !== e.aggregateId) return state;
      // A completed ticket conclusively leaves the board, so retain it in the
      // call history (FR-TV-01). Without this, the common single-counter flow
      // (call → serve → complete → call next) never populates history: the
      // completed ticket is null'd here, and the next TICKET_CALLED finds
      // nowServing already null and pushes nothing — "Riwayat Panggilan" stays
      // empty on a quiet store even though tickets were served.
      if (p.to === 'COMPLETED') {
        const history = state.nowServing
          ? [state.nowServing, ...state.history].slice(0, HISTORY_LIMIT)
          : state.history;
        return { ...state, nowServing: null, history };
      }
      // SKIPPED (recallable via "Panggil Ulang") and WAITING (transfer, re-enters
      // the queue as a fresh ticket) leave the board without entering history:
      // neither is a concluded call.
      //
      // Recall-restore: a recalled ticket (SKIPPED -> CALLING) re-shows on the
      // board and re-announces audio via the TICKET_CALLED event the domain now
      // emits on recall (QueueTicket.recall records a TicketCalledEvent, mirroring
      // markCalling) — no TV-side retained state is needed. The STATUS_UPDATED
      // for the recall reaches the TV while nowServing is null (SKIPPED cleared
      // it above), so this `nowServing?.ticketId !== aggregateId` guard returns
      // state unchanged and the follow-on TICKET_CALLED does the restore. The TV
      // needs no recall-specific projection here.
      if (p.to === 'SKIPPED' || p.to === 'WAITING') {
        return { ...state, nowServing: null };
      }
      return state;
    }
    case 'TICKET_TRANSFERRED': {
      const p = e.payload as Extract<
        QueueLifecycleWireEvent['payload'],
        { toTicketNumber: string }
      >;
      // Re-number the ticket wherever it currently appears (FR-CLR-03).
      const renumber = (n: NowServing) =>
        n.ticketId === e.aggregateId ? { ...n, ticketNumber: p.toTicketNumber } : n;
      return {
        ...state,
        nowServing: state.nowServing ? renumber(state.nowServing) : null,
        history: state.history.map(renumber),
      };
    }
    case 'SYSTEM_RESET':
      // Clear now-serving + history immediately; also clear the waiting list,
      // counters-serving, and stashed active slice locally for snappy UX — the
      // debounced refetch in the boot effect reconciles with the server's
      // fresh-day read model. The counters-serving panel is re-derived from the
      // empty active slice joined with `counterNameById`, so EVERY configured
      // counter immediately shows as idle (em dash) — no empty-state flash
      // before the debounced refetch reconciles. `panelLayout` is config (not
      // queue state) so it is preserved via the `...state` spread — a reset
      // never drops the manager's TV layout.
      return {
        ...state,
        nowServing: null,
        history: [],
        waiting: [],
        countersServing: toCountersServing([], state.counterNameById),
        lastActive: [],
      };
    default:
      return state;
  }
}

export interface TvStoreValue {
  readonly state: TvState;
}

const TvStoreContext = createContext<TvStoreValue | null>(null);

export interface TvStoreProviderProps {
  readonly api: ITvApi;
  readonly audio: AudioProvider;
  readonly children: ReactNode;
  /** Test seam: socket options forwarded to the internal {@link QueueSocket}. */
  readonly socketOptions?: QueueSocketOptions;
}

export function TvStoreProvider({ api, audio, children, socketOptions }: TvStoreProviderProps) {
  const [state, dispatch] = useReducer(tvReducer, initialState);

  // Keep a ref to the api so the socket effect (created once with [] deps) and
  // the refetch helpers always read the latest without re-subscribing.
  const apiRef = useRef(api);
  apiRef.current = api;

  // Keep a ref to the audio provider so the socket handler (created once) reads
  // the latest without re-subscribing.
  const audioRef = useRef(audio);
  audioRef.current = audio;

  // Generation guard + in-flight guard for the TV board state fetch. The boot
  // fetch, the debounced event refetch, the reconnect refetch, and the 30s
  // interval refetch all route through `refetchBoardRef.current` so there is
  // ONE resolution policy: a monotonic generation counter decides which
  // resolution wins (last-write-wins among fetches that actually started, not
  // on the slowest), and an in-flight boolean prevents duplicate concurrent
  // GET /api/queue/board work when an event/interval tick lands while a
  // fetch is already pending.
  const boardGenRef = useRef(0);
  const inFlightRef = useRef(false);
  // Mounted guard shared by every refetch trigger (boot + socket + interval).
  // Symmetric to the boot effect's local `cancelled` flag: a fetch resolving
  // after the provider unmounts is dropped instead of dispatching on an
  // unmounted reducer. React 18 no longer warns, but this keeps the refetch
  // path's cancellation discipline consistent with the boot path.
  const mountedRef = useRef(true);

  /**
   * Fetch the TV board state from the server's read model and dispatch
   * `BOARD_LOADED`. Restores `nowServing` from the active slice (the last
   * entry, most-recently-touched) and replaces `waiting`. Stable across the
   * socket effect (closed over `apiRef`). Never throws — a fetch failure
   * degrades gracefully (the board keeps the previous nowServing + waiting
   * list; the next refetch retries). Generation-counted: a resolution is
   * dropped if a newer fetch has started since (last-write-wins on the
   * freshest fetch that started, not on the slowest to resolve). This closes
   * the boot-vs-event race where a slow boot `getBoardState()` would resolve
   * AFTER an event-driven debounced refetch already produced fresher state
   * and overwrite it with stale data. In-flight-guarded: a second call while
   * one is pending returns early — the pending fetch covers it and a later
   * event/interval tick refetches if needed (prevents the interval + debounce
   * from issuing two concurrent fetches when an event lands near a tick).
   */
  const refetchBoardRef = useRef<() => void>(() => {});
  refetchBoardRef.current = () => {
    if (inFlightRef.current) return; // a fetch is pending — it covers this tick
    const gen = ++boardGenRef.current;
    inFlightRef.current = true;
    apiRef.current
      .getBoardState()
      .then((dto) => {
        if (gen !== boardGenRef.current) return; // a newer fetch started — drop stale
        if (!mountedRef.current) return; // provider unmounted — don't dispatch
        // nowServing = most-recently-updated active ticket (findAllActive orders
        // by updatedAt asc, so the last is the most-recently-touched). Restored
        // on boot AND every refetch so a refresh shows the current antrian and
        // the board reconciles to the server's source of truth after every
        // event.
        const nowServing =
          dto.active.length > 0 ? toNowServing(dto.active[dto.active.length - 1]) : null;
        dispatch({
          type: 'BOARD_LOADED',
          nowServing,
          waiting: dto.waiting.map(toWaitingTicket),
          active: dto.active,
        });
      })
      .catch(() => {
        /* graceful degradation: keep the previous nowServing + waiting list on failure */
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  };

  // Boot: load store name (running text) + categories. The TV degrades
  // gracefully if the config read fails — config failure still shows the board
  // (with the static --accent default). The same config read carries the brand
  // color (QUE-37 AC6), applied to the runtime `--accent` here as a side
  // effect (a DOM mutation, not board state). The static `#2563eb` default
  // stays in place on failure (no flash — it IS the default). The TV board
  // state (active + waiting) is fetched separately via the shared
  // generation-counted `refetchBoard` path so its resolution races no other
  // fetch (a slow boot resolution cannot overwrite fresher event-driven
  // state). The counter id→name map built here is carried in state so the
  // BOARD_LOADED reducer re-derives `countersServing` with real names once
  // BOOT_LOADED dispatches (the first board fetch races the config fetch and
  // resolves with the empty initial map → fallback names; BOOT_LOADED's
  // re-derivation fixes that with no second board fetch).
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.getSystemConfig(), api.getCategories()])
      .then(([configRes, categoriesRes]) => {
        if (cancelled) return;
        if (configRes.status === 'fulfilled' && categoriesRes.status === 'fulfilled') {
          applyBrandColor(configRes.value.brandColor);
          applyThemeMode(configRes.value.serviceThemes.tv);
          // Build the counter id→name map from the config's routing rules so
          // the reducer can re-derive countersServing once BOOT_LOADED
          // dispatches (mirrors how getCategories feeds the waiting panel's
          // category name join). A counter appearing in the active slice but
          // absent from this map falls back to `Counter {id}`.
          const counterNameById = new Map<number, string>();
          for (const r of configRes.value.routingRules) {
            counterNameById.set(r.counterId, r.counterName);
          }
          dispatch({
            type: 'BOOT_LOADED',
            storeName: configRes.value.storeName,
            categories: categoriesRes.value,
            panelLayout: configRes.value.tvPanelLayout,
            counterNameById,
          });
        } else {
          dispatch({
            type: 'BOOT_ERROR',
            message: 'Gagal memuat konfigurasi',
          });
        }
      });
    // Fetch the TV board state through the shared generation-counted path. A
    // boot board-fetch failure degrades gracefully (nowServing + waiting stay
    // null/[]); the periodic refetch retries.
    refetchBoardRef.current();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Unmount-only flag flip for the shared `mountedRef`. A dedicated `[]`-deps
  // effect so the cleanup fires only on real unmount — NOT on an `api` identity
  // change (the boot effect above re-runs on `[api]`, but `mountedRef` is shared
  // and must stay true across re-renders/api swaps until the provider actually
  // unmounts). Keeps the refetch dispatch path from firing post-unmount.
  useEffect(() => {
    // Reset on each (re)mount — under <React.StrictMode> an `[]`-deps effect is
    // double-invoked on mount (body -> cleanup -> body); without this reset the
    // cleanup that flips `mountedRef.current = false` would win and every later
    // `refetchBoard` resolution would be dropped, leaving the board empty for
    // the whole dev session.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Realtime subscription (owned by the provider). On each TICKET_CALLED, drive
  // the audio sequencer with the announcement fragments (FR-TV-02). After every
  // lifecycle event, debounce-refetch the TV board state so the server stays
  // the single source of truth (the board does not project waiting from
  // events). The realtime event projection (`projectEvent`) still drives
  // instant nowServing + history updates; the debounced `BOARD_LOADED`
  // refetch reconciles nowServing from the server and dedupes history — both
  // converge to the same correct state.
  const optsRef = useRef(socketOptions);
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let prevStatus: ConnectionStatus = 'closed';

    /** Debounced refetch — clusters of events in one tick produce one fetch. */
    const scheduleRefetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        refetchBoardRef.current();
      }, BOARD_REFETCH_DEBOUNCE_MS);
    };

    const sock = new QueueSocket(
      {
        onEvent: (event) => {
          dispatch({ type: 'EVENT', event });
          if (event.type === 'TICKET_CALLED') {
            const p = event.payload as Extract<QueueLifecycleWireEvent['payload'], { ticketNumber: string; counterId: number }>;
            // Fire-and-forget; the audio provider serializes announcements and
            // never rejects (errors skip a fragment). Don't let a bad
            // announcement crash the board.
            void audioRef.current.playSequence(buildCallFragments(p.ticketNumber, p.counterId));
          }
          if (event.type === 'SYSTEM_RESET') {
            // A reset starts a fresh day; drop any queued announcements for
            // already-called tickets so they don't play after the board clears.
            audioRef.current.stop();
          }
          // Any lifecycle event may affect the waiting list (create adds,
          // call/serve removes, transfer renumbers, reset clears) — the server
          // owns the read model, so refetch on a debounce. SYSTEM_RESET already
          // cleared `waiting` immediately for snappy UX; this confirms.
          scheduleRefetch();
        },
        onStatus: (status) => {
          dispatch({ type: 'CONNECTION', status });
          // On reconnect (open after non-open), refetch immediately so the
          // board resyncs after any missed broadcasts while disconnected.
          if (status === 'open' && prevStatus !== 'open') {
            refetchBoardRef.current();
          }
          prevStatus = status;
        },
      },
      optsRef.current ?? {},
    );
    sock.connect();

    // Periodic safety-net refetch covering any dropped broadcast.
    // Read the latest ref each tick (matches the debounce path's indirection) —
    // capturing `refetchBoardRef.current` directly would pin the function
    // reference from effect-setup time, which is fragile even though the body
    // only closes over refs today.
    const interval = setInterval(() => refetchBoardRef.current(), BOARD_REFETCH_INTERVAL_MS);

    return () => {
      sock.close();
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(interval);
      // Drop queued announcements and stop advancing fragments so a mid-
      // announcement unmount drains the queue. The in-flight fragment is
      // intentionally allowed to finish (the AudioProvider contract — see
      // sequencer-audio-provider.stop()), so this is best-effort silence, not
      // an abrupt cut.
      audioRef.current.stop();
    };
  }, []);

  const value = useMemo<TvStoreValue>(() => ({ state }), [state]);
  return <TvStoreContext.Provider value={value}>{children}</TvStoreContext.Provider>;
}

export function useTvStore(): TvStoreValue {
  const value = useContext(TvStoreContext);
  if (!value) {
    throw new Error('useTvStore must be used within a TvStoreProvider');
  }
  return value;
}
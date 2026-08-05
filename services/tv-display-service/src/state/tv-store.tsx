import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { CategoryDto, QueueLifecycleWireEvent, WaitingTicketDto } from '../api/types';
import type { ITvApi } from '../api/tv-api';
import { type AudioProvider } from '../audio/audio-provider';
import { buildCallFragments } from '../audio/audio-provider';
import { applyBrandColor } from '../lib/theme';
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
   * oldest first). Sourced from the server's `GET /api/queue/waiting` read
   * model and refetched after every lifecycle event — the TV does NOT project
   * this from events (SRP — the server owns the queue read model).
   */
  readonly waiting: readonly WaitingTicket[];
  readonly connection: ConnectionStatus;
  readonly loadStatus: 'loading' | 'loaded' | 'error';
  readonly loadError: string | null;
  readonly storeName: string;
  readonly categories: readonly CategoryDto[];
}

export type TvAction =
  | { type: 'BOOT_LOADED'; storeName: string; categories: CategoryDto[] }
  | { type: 'BOOT_ERROR'; message: string }
  | { type: 'WAITING_LOADED'; waiting: readonly WaitingTicket[] }
  | { type: 'CONNECTION'; status: ConnectionStatus }
  | { type: 'EVENT'; event: QueueLifecycleWireEvent };

const HISTORY_LIMIT = 5;
/** Debounce for refetching the waiting queue after a lifecycle event. */
const WAITING_REFETCH_DEBOUNCE_MS = 300;
/** Periodic safety-net refetch interval (covers a dropped broadcast). */
const WAITING_REFETCH_INTERVAL_MS = 30_000;

const initialState: TvState = {
  nowServing: null,
  history: [],
  waiting: [],
  connection: 'closed',
  loadStatus: 'loading',
  loadError: null,
  storeName: '',
  categories: [],
};

/** Maps the wire DTO into the slim slice the board renders. */
function toWaitingTicket(t: WaitingTicketDto): WaitingTicket {
  return { ticketId: t.ticketId, ticketNumber: t.ticketNumber, categoryId: t.categoryId };
}

function tvReducer(state: TvState, action: TvAction): TvState {
  switch (action.type) {
    case 'BOOT_LOADED':
      return {
        ...state,
        storeName: action.storeName,
        categories: action.categories,
        loadStatus: 'loaded',
        loadError: null,
      };
    case 'BOOT_ERROR':
      return { ...state, loadStatus: 'error', loadError: action.message };
    case 'WAITING_LOADED':
      return { ...state, waiting: action.waiting };
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
      // Clear now-serving + history immediately; also clear the waiting list
      // locally for snappy UX — the debounced refetch in the boot effect
      // reconciles with the server's fresh-day read model.
      return { ...state, nowServing: null, history: [], waiting: [] };
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

  // Generation guard + in-flight guard for the waiting-queue fetch. The boot
  // fetch, the debounced event refetch, the reconnect refetch, and the 30s
  // interval refetch all route through `refetchWaitingRef.current` so there is
  // ONE resolution policy: a monotonic generation counter decides which
  // resolution wins (last-write-wins among fetches that actually started, not
  // on the slowest), and an in-flight boolean prevents duplicate concurrent
  // GET /api/queue/waiting work when an event/interval tick lands while a
  // fetch is already pending.
  const waitingGenRef = useRef(0);
  const inFlightRef = useRef(false);
  // Mounted guard shared by every refetch trigger (boot + socket + interval).
  // Symmetric to the boot effect's local `cancelled` flag: a fetch resolving
  // after the provider unmounts is dropped instead of dispatching on an
  // unmounted reducer. React 18 no longer warns, but this keeps the refetch
  // path's cancellation discipline consistent with the boot path.
  const mountedRef = useRef(true);

  /**
   * Fetch the global waiting queue from the server's read model and dispatch
   * `WAITING_LOADED`. Stable across the socket effect (closed over `apiRef`).
   * Never throws — a fetch failure degrades gracefully (the board keeps the
   * previous waiting list; the next refetch retries). Generation-counted: a
   * resolution is dropped if a newer fetch has started since (last-write-wins
   * on the freshest fetch that started, not on the slowest to resolve). This
   * closes the boot-vs-event race where a slow boot `getWaitingQueue()` would
   * resolve AFTER an event-driven debounced refetch already produced fresher
   * state and overwrite it with stale data. In-flight-guarded: a second call
   * while one is pending returns early — the pending fetch covers it and a
   * later event/interval tick refetches if needed (prevents the interval +
   * debounce from issuing two concurrent fetches when an event lands near a
   * tick).
   */
  const refetchWaitingRef = useRef<() => void>(() => {});
  refetchWaitingRef.current = () => {
    if (inFlightRef.current) return; // a fetch is pending — it covers this tick
    const gen = ++waitingGenRef.current;
    inFlightRef.current = true;
    apiRef.current
      .getWaitingQueue()
      .then((dto) => {
        if (gen !== waitingGenRef.current) return; // a newer fetch started — drop stale
        if (!mountedRef.current) return; // provider unmounted — don't dispatch
        dispatch({ type: 'WAITING_LOADED', waiting: dto.waiting.map(toWaitingTicket) });
      })
      .catch(() => {
        /* graceful degradation: keep the previous waiting list on failure */
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
  // stays in place on failure (no flash — it IS the default). The global
  // waiting queue is fetched separately via the shared generation-counted
  // `refetchWaiting` path so its resolution races no other fetch (a slow boot
  // resolution cannot overwrite fresher event-driven state).
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.getSystemConfig(), api.getCategories()])
      .then(([configRes, categoriesRes]) => {
        if (cancelled) return;
        if (configRes.status === 'fulfilled' && categoriesRes.status === 'fulfilled') {
          applyBrandColor(configRes.value.brandColor);
          dispatch({
            type: 'BOOT_LOADED',
            storeName: configRes.value.storeName,
            categories: categoriesRes.value,
          });
        } else {
          dispatch({
            type: 'BOOT_ERROR',
            message: 'Gagal memuat konfigurasi',
          });
        }
      });
    // Fetch the waiting queue through the shared generation-counted path. A
    // boot waiting-fetch failure degrades gracefully (waiting stays `[]`); the
    // periodic refetch retries.
    refetchWaitingRef.current();
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
    // `refetchWaiting` resolution would be dropped, leaving the waiting queue
    // empty for the whole dev session.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Realtime subscription (owned by the provider). On each TICKET_CALLED, drive
  // the audio sequencer with the announcement fragments (FR-TV-02). After every
  // lifecycle event, debounce-refetch the waiting queue so the server stays the
  // single source of truth (the board does not project waiting from events).
  const optsRef = useRef(socketOptions);
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let prevStatus: ConnectionStatus = 'closed';

    /** Debounced refetch — clusters of events in one tick produce one fetch. */
    const scheduleRefetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        refetchWaitingRef.current();
      }, WAITING_REFETCH_DEBOUNCE_MS);
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
            refetchWaitingRef.current();
          }
          prevStatus = status;
        },
      },
      optsRef.current ?? {},
    );
    sock.connect();

    // Periodic safety-net refetch covering any dropped broadcast.
    // Read the latest ref each tick (matches the debounce path's indirection) —
    // capturing `refetchWaitingRef.current` directly would pin the function
    // reference from effect-setup time, which is fragile even though the body
    // only closes over refs today.
    const interval = setInterval(() => refetchWaitingRef.current(), WAITING_REFETCH_INTERVAL_MS);

    return () => {
      sock.close();
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(interval);
      // No orphaned audio if the provider unmounts mid-announcement.
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
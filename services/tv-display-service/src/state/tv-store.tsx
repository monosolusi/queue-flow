import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { CategoryDto, QueueLifecycleWireEvent } from '../api/types';
import type { ITvApi } from '../api/tv-api';
import { type AudioProvider } from '../audio/audio-provider';
import { buildCallFragments } from '../audio/audio-provider';
import { QueueSocket, type ConnectionStatus, type QueueSocketOptions } from '../realtime/queue-socket';

export interface NowServing {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly counterId: number;
}

export interface TvState {
  /** The ticket currently being served (the big board number). */
  readonly nowServing: NowServing | null;
  /** The last (up to 5) previously-called tickets, newest first. */
  readonly history: readonly NowServing[];
  readonly connection: ConnectionStatus;
  readonly loadStatus: 'loading' | 'loaded' | 'error';
  readonly loadError: string | null;
  readonly storeName: string;
  readonly categories: readonly CategoryDto[];
}

export type TvAction =
  | { type: 'BOOT_LOADED'; storeName: string; categories: CategoryDto[] }
  | { type: 'BOOT_ERROR'; message: string }
  | { type: 'CONNECTION'; status: ConnectionStatus }
  | { type: 'EVENT'; event: QueueLifecycleWireEvent };

const HISTORY_LIMIT = 5;

const initialState: TvState = {
  nowServing: null,
  history: [],
  connection: 'closed',
  loadStatus: 'loading',
  loadError: null,
  storeName: '',
  categories: [],
};

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
      // The ticket leaves the board when it completes, is skipped, or is sent
      // back to WAITING (e.g. by a transfer). CALLING/SERVING keep it shown.
      if (p.to === 'COMPLETED' || p.to === 'SKIPPED' || p.to === 'WAITING') {
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
      return { ...state, nowServing: null, history: [] };
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

  // Keep a ref to the audio provider so the socket handler (created once) reads
  // the latest without re-subscribing.
  const audioRef = useRef(audio);
  audioRef.current = audio;

  // Boot: load store name (running text) + categories. The TV degrades gracefully
  // if the config read fails (store-not-configured) — it still shows the board.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getSystemConfig(), api.getCategories()])
      .then(([config, categories]) => {
        if (cancelled) return;
        dispatch({ type: 'BOOT_LOADED', storeName: config.storeName, categories });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({ type: 'BOOT_ERROR', message: err instanceof Error ? err.message : 'Gagal memuat konfigurasi' });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Realtime subscription (owned by the provider). On each TICKET_CALLED, drive
  // the audio sequencer with the announcement fragments (FR-TV-02).
  const optsRef = useRef(socketOptions);
  useEffect(() => {
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
        },
        onStatus: (status) => dispatch({ type: 'CONNECTION', status }),
      },
      optsRef.current ?? {},
    );
    sock.connect();
    return () => {
      sock.close();
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
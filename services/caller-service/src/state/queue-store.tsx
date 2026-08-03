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
  QueueLifecycleWireEvent,
  QueueSnapshotDto,
  TicketStateDto,
} from '../api/types';
import type { ICallerApi } from '../api/caller-api';
import { QueueSocket, type ConnectionStatus, type QueueSocketOptions } from '../realtime/queue-socket';
import type { BoundCounter } from './counter-binding';

/** Projection context: which counter is mine, and which categories it serves. */
export interface QueueCtx {
  readonly counterId: number;
  readonly categoryIds: ReadonlySet<string>;
}

export interface QueueState {
  readonly counterId: number;
  readonly active: readonly TicketStateDto[];
  readonly waiting: readonly TicketStateDto[];
  readonly waitingCount: number;
  /** Live WS connection state, surfaced in the header. */
  readonly connection: ConnectionStatus;
  /** Snapshot load lifecycle. */
  readonly loadStatus: 'loading' | 'loaded' | 'error';
  readonly loadError: string | null;
  /** When true, the store will refetch the snapshot (set on SYSTEM_RESET). */
  readonly stale: boolean;
}

export type QueueAction =
  | { type: 'SNAPSHOT_LOADED'; snapshot: QueueSnapshotDto }
  | { type: 'SNAPSHOT_ERROR'; message: string }
  | { type: 'CONNECTION'; status: ConnectionStatus }
  | { type: 'EVENT'; event: QueueLifecycleWireEvent }
  | { type: 'MARK_STALE' };

const initialState = (counterId: number): QueueState => ({
  counterId,
  active: [],
  waiting: [],
  waitingCount: 0,
  connection: 'closed',
  loadStatus: 'loading',
  loadError: null,
  stale: false,
});

const byCreatedAt = (a: TicketStateDto, b: TicketStateDto) =>
  a.ticketNumber.localeCompare(b.ticketNumber);

/** Builds a reducer bound to a fixed counter + its assigned categories. */
export function makeQueueReducer(ctx: QueueCtx) {
  return function queueReducer(state: QueueState, action: QueueAction): QueueState {
    switch (action.type) {
      case 'SNAPSHOT_LOADED': {
        const s = action.snapshot;
        return {
          ...state,
          active: [...s.active],
          waiting: [...s.waiting],
          waitingCount: s.waitingCount ?? s.waiting.length,
          loadStatus: 'loaded',
          loadError: null,
          stale: false,
        };
      }
      case 'SNAPSHOT_ERROR':
        return { ...state, loadStatus: 'error', loadError: action.message, stale: false };
      case 'CONNECTION':
        return { ...state, connection: action.status };
      case 'MARK_STALE':
        return { ...state, stale: true };
      case 'EVENT':
        return projectEvent(state, action.event, ctx);
      default:
        return state;
    }
  };
}

/** Projects a single lifecycle event onto the queue state for this counter. */
function projectEvent(state: QueueState, e: QueueLifecycleWireEvent, ctx: QueueCtx): QueueState {
  switch (e.type) {
    case 'TICKET_CREATED': {
      const p = e.payload as Extract<QueueLifecycleWireEvent['payload'], { ticketNumber: string; categoryId: string }>;
      if (!ctx.categoryIds.has(p.categoryId)) {
        return state;
      }
      if (state.waiting.some((t) => t.ticketId === e.aggregateId)) {
        return state;
      }
      const ticket: TicketStateDto = {
        ticketId: e.aggregateId,
        ticketNumber: p.ticketNumber,
        categoryId: p.categoryId,
        status: 'WAITING',
        counterId: null,
      };
      const waiting = [...state.waiting, ticket].sort(byCreatedAt);
      return { ...state, waiting, waitingCount: waiting.length };
    }
    case 'TICKET_CALLED': {
      const p = e.payload as Extract<QueueLifecycleWireEvent['payload'], { ticketNumber: string; counterId: number }>;
      if (p.counterId !== ctx.counterId) {
        // Called at another counter: drop from our waiting if it was in our view.
        const waiting = state.waiting.filter((t) => t.ticketId !== e.aggregateId);
        if (waiting.length === state.waiting.length) {
          return state;
        }
        return { ...state, waiting, waitingCount: waiting.length };
      }
      const called: TicketStateDto = {
        ticketId: e.aggregateId,
        ticketNumber: p.ticketNumber,
        // The TICKET_CALLED payload carries no categoryId. The ticket was in
        // our waiting list with a real categoryId — reuse it so the transfer
        // chooser can exclude the active ticket's own category (FR-CLR-03).
        categoryId: state.waiting.find((t) => t.ticketId === e.aggregateId)?.categoryId ?? '',
        status: 'CALLING',
        counterId: ctx.counterId,
      };
      const waiting = state.waiting.filter((t) => t.ticketId !== e.aggregateId);
      const active = dedupePrepend(called, state.active);
      return { ...state, active, waiting, waitingCount: waiting.length };
    }
    case 'STATUS_UPDATED': {
      const p = e.payload as Extract<QueueLifecycleWireEvent['payload'], { from: string; to: string }>;
      const idx = state.active.findIndex((t) => t.ticketId === e.aggregateId);
      if (idx === -1) {
        return state;
      }
      const to = p.to;
      if (to === 'COMPLETED' || to === 'SKIPPED') {
        const active = state.active.filter((t) => t.ticketId !== e.aggregateId);
        return { ...state, active };
      }
      // Any other target (CALLING, SERVING, or a custom in-progress state like
      // PREPARING reached via the generic apply-transition endpoint, QUE-33)
      // keeps the ticket on the board as the active ticket at the counter — the
      // staff is still serving it, just in a sub-state. Only the PRD-default
      // terminal states (COMPLETED/SKIPPED) leave the counter. The caller only
      // fires the generic endpoint for the active ticket (ActionControls renders
      // edges from `active.status`), so a WAITING-sourced generic transition is
      // out of the UI scope; the `idx === -1` guard above leaves such a ticket in
      // `waiting` untouched (no divergence on the supported flow).
      //
      // The one WAITING target that *does* reach the active ticket is the transfer
      // flow (FR-CLR-03 "Pindah Kategori"): the aggregate records STATUS_UPDATED
      // (CALLING -> WAITING) and then TICKET_TRANSFERRED in sequence. STATUS_UPDATED
      // alone would leave a stale WAITING entry on the board; the immediately
      // following TICKET_TRANSFERRED evicts it from `active` (see below). Do not
      // treat WAITING as terminal here — that would race the two events and could
      // drop the ticket before TICKET_TRANSFERRED re-adds it to `waiting`.
      const active = state.active.map((t) =>
        t.ticketId === e.aggregateId ? { ...t, status: to } : t,
      );
      return { ...state, active };
    }
    case 'TICKET_TRANSFERRED': {
      const p = e.payload as Extract<
        QueueLifecycleWireEvent['payload'],
        { fromCategoryId: string; toCategoryId: string; fromTicketNumber: string; toTicketNumber: string }
      >;
      const mine = ctx.categoryIds.has(p.toCategoryId);
      // A transfer re-enters the queue under a new category + number and clears
      // the counter, so the ticket must leave `active` regardless of destination
      // (FR-CLR-03). Without this, the preceding STATUS_UPDATED (CALLING ->
      // WAITING) leaves a stale WAITING entry on the board for a transfer away,
      // or the ticket appears in both `active` and `waiting` for a transfer into
      // my own categories. Drop it from `active`, then re-add to `waiting` only
      // when the new category is one of mine.
      const active = state.active.filter((t) => t.ticketId !== e.aggregateId);
      let waiting = state.waiting.filter((t) => t.ticketId !== e.aggregateId);
      if (mine) {
        const ticket: TicketStateDto = {
          ticketId: e.aggregateId,
          ticketNumber: p.toTicketNumber,
          categoryId: p.toCategoryId,
          status: 'WAITING',
          counterId: null,
        };
        waiting = [...waiting, ticket].sort(byCreatedAt);
      }
      return { ...state, active, waiting, waitingCount: waiting.length };
    }
    case 'SYSTEM_RESET':
      // The provider refetches the snapshot; mark stale as a signal.
      return { ...state, stale: true };
    default:
      return state;
  }
}

function dedupePrepend(ticket: TicketStateDto, list: readonly TicketStateDto[]): readonly TicketStateDto[] {
  const rest = list.filter((t) => t.ticketId !== ticket.ticketId);
  return [ticket, ...rest];
}

export interface QueueStoreValue {
  readonly state: QueueState;
  /** Force a fresh snapshot fetch (e.g. after SYSTEM_RESET). */
  readonly refetch: () => void;
  /** The caller API (exposed so action controls can issue commands + read the
   *  active state machine without a separate prop drill — FR-CLR-02). */
  readonly api: ICallerApi;
}

const QueueStoreContext = createContext<QueueStoreValue | null>(null);

export interface QueueStoreProviderProps {
  readonly bound: BoundCounter;
  readonly api: ICallerApi;
  readonly children: ReactNode;
  /**
   * Test seam: socket options forwarded to the internal {@link QueueSocket}
   * (e.g. an injected `WebSocketCtor`). The provider always owns the socket and
   * wires its own handlers, so this only changes transport construction.
   */
  readonly socketOptions?: QueueSocketOptions;
}

export function QueueStoreProvider({ bound, api, children, socketOptions }: QueueStoreProviderProps) {
  const ctx = useMemo<QueueCtx>(
    () => ({ counterId: bound.counterId, categoryIds: new Set(bound.assignedCategoryIds) }),
    [bound.counterId, bound.assignedCategoryIds],
  );
  const reducer = useMemo(() => makeQueueReducer(ctx), [ctx]);
  const [state, dispatch] = useReducer(reducer, bound.counterId, initialState);

  const refetch = useMemo(
    () => async () => {
      try {
        const snapshot = await api.getQueueSnapshot(bound.counterId);
        dispatch({ type: 'SNAPSHOT_LOADED', snapshot });
      } catch (err) {
        dispatch({ type: 'SNAPSHOT_ERROR', message: err instanceof Error ? err.message : 'Gagal memuat antrian' });
      }
    },
    [api, bound.counterId],
  );

  // Initial + stale-driven snapshot load.
  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (!state.stale) {
      return;
    }
    void refetch();
  }, [state.stale, refetch]);

  // Realtime subscription (owned by the provider so it lives with the workspace).
  // Options are captured once so the socket isn't re-created on every render.
  const optsRef = useRef(socketOptions);
  useEffect(() => {
    const sock = new QueueSocket(
      {
        onEvent: (event) => dispatch({ type: 'EVENT', event }),
        onStatus: (status) => dispatch({ type: 'CONNECTION', status }),
      },
      optsRef.current ?? {},
    );
    sock.connect();
    return () => {
      sock.close();
    };
  }, []);

  const value = useMemo<QueueStoreValue>(() => ({ state, refetch, api }), [state, refetch, api]);
  return <QueueStoreContext.Provider value={value}>{children}</QueueStoreContext.Provider>;
}

export function useQueueStore(): QueueStoreValue {
  const value = useContext(QueueStoreContext);
  if (!value) {
    throw new Error('useQueueStore must be used within a QueueStoreProvider');
  }
  return value;
}
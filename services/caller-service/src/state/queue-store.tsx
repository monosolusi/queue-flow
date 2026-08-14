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
  /**
   * Tickets this counter skipped ("Lewati / Absen") and has not resolved yet.
   * A third bucket rather than an eviction: SKIPPED is a live status with its
   * own outgoing transition in the PRD §7 flow ("Panggil Ulang", SKIPPED →
   * CALLING), so dropping the ticket from every surface would make that action
   * unreachable — the queue could never re-call an absent customer.
   */
  readonly skipped: readonly TicketStateDto[];
  readonly waitingCount: number;
  /** Live WS connection state, surfaced in the header. */
  readonly connection: ConnectionStatus;
  /** Snapshot load lifecycle. */
  readonly loadStatus: 'loading' | 'loaded' | 'error';
  readonly loadError: string | null;
  /** When true, the store will refetch the snapshot (set on SYSTEM_RESET). */
  readonly stale: boolean;
  /** Monotonic counter bumped on every `SYSTEM_CONFIG_CHANGED` event. The
   *  workspace passes it to {@link ActionControls} so the panel refetches the
   *  active state machine and reflects the admin-designed flow + its
   *  `actionLabel` wording without a reload (FR-CLR-02). Starts at 0 and never
   *  resets — a bump is the signal, not the value. */
  readonly configVersion: number;
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
  skipped: [],
  waitingCount: 0,
  connection: 'closed',
  loadStatus: 'loading',
  loadError: null,
  stale: false,
  configVersion: 0,
});

/**
 * Display-only sort for the `waiting` list. A lexicographic compare on the
 * zero-padded `A-001` format yields a deterministic category-code-major order
 * (`A-*` before `B-*`); within a category the zero-padded sequence matches
 * creation order up to 999 — past 999 (`A-1000` < `A-999` lexicographically)
 * it can invert, and across categories it is not creation order at all. That
 * is fine: this is a stable display projection only — the authoritative
 * next-ticket selection is the backend's `CallNextTicketUseCase`
 * (FIFO_GLOBAL / CATEGORY_PRIORITY), never this sort.
 */
const byTicketNumber = (a: TicketStateDto, b: TicketStateDto) =>
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
          // Tolerated as absent because this is parsed JSON, not a typed
          // literal: a service-worker-cached client can outlive the response
          // shape it was built against. An empty skipped list is exactly the
          // pre-bucket behaviour, so the panel degrades to it rather than
          // crashing. Server order (oldest skip first) is preserved as sent.
          skipped: [...(s.skipped ?? [])],
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
      const waiting = [...state.waiting, ticket].sort(byTicketNumber);
      return { ...state, waiting, waitingCount: waiting.length };
    }
    case 'TICKET_CALLED': {
      const p = e.payload as Extract<QueueLifecycleWireEvent['payload'], { ticketNumber: string; counterId: number }>;
      if (p.counterId !== ctx.counterId) {
        // Called at another counter: drop it from whichever of our lists held it.
        const waiting = state.waiting.filter((t) => t.ticketId !== e.aggregateId);
        const skipped = state.skipped.filter((t) => t.ticketId !== e.aggregateId);
        if (waiting.length === state.waiting.length && skipped.length === state.skipped.length) {
          return state;
        }
        return { ...state, waiting, skipped, waitingCount: waiting.length };
      }
      const called: TicketStateDto = {
        ticketId: e.aggregateId,
        ticketNumber: p.ticketNumber,
        // The TICKET_CALLED payload carries no categoryId. The ticket is already
        // in one of our lists with a real categoryId — reuse it so the transfer
        // chooser can exclude the active ticket's own category (FR-CLR-03).
        // A recall ("Panggil Ulang") reaches here from `skipped`, and its
        // preceding STATUS_UPDATED may already have moved it into `active`, so
        // all three buckets are searched rather than `waiting` alone.
        categoryId: findKnown(state, e.aggregateId)?.categoryId ?? '',
        status: 'CALLING',
        counterId: ctx.counterId,
      };
      const waiting = state.waiting.filter((t) => t.ticketId !== e.aggregateId);
      const skipped = state.skipped.filter((t) => t.ticketId !== e.aggregateId);
      const active = dedupePrepend(called, state.active);
      return { ...state, active, waiting, skipped, waitingCount: waiting.length };
    }
    case 'STATUS_UPDATED': {
      const p = e.payload as Extract<QueueLifecycleWireEvent['payload'], { from: string; to: string }>;
      const at = state.active.find((t) => t.ticketId === e.aggregateId);
      const absent = state.skipped.find((t) => t.ticketId === e.aggregateId);
      const ticket = at ?? absent;
      if (!ticket) {
        return state;
      }
      const to = p.to;
      if (to === 'COMPLETED') {
        // The one truly terminal target: the ticket leaves every counter surface.
        return {
          ...state,
          active: state.active.filter((t) => t.ticketId !== e.aggregateId),
          skipped: state.skipped.filter((t) => t.ticketId !== e.aggregateId),
        };
      }
      if (to === 'SKIPPED') {
        // MOVE, never drop. The customer is absent, not done: SKIPPED has an
        // outgoing transition ("Panggil Ulang", SKIPPED → CALLING) that staff
        // must be able to tap, which needs the ticket on a surface. Dropping it
        // here is what made recall unreachable.
        const skipped = dedupeAppend({ ...ticket, status: to }, state.skipped);
        return {
          ...state,
          active: state.active.filter((t) => t.ticketId !== e.aggregateId),
          skipped,
        };
      }
      if (absent && !at) {
        // Leaving SKIPPED for a non-terminal status: the counter is handling the
        // ticket again, so it returns to the board. The recall path emits
        // STATUS_UPDATED (SKIPPED → CALLING) *before* its TICKET_CALLED, and both
        // must land the ticket in the same place — TICKET_CALLED then dedupes
        // and stamps the counter.
        return {
          ...state,
          active: dedupePrepend({ ...ticket, status: to }, state.active),
          skipped: state.skipped.filter((t) => t.ticketId !== e.aggregateId),
        };
      }
      // Any other target (CALLING, SERVING, or a custom in-progress state like
      // PREPARING reached via the generic apply-transition endpoint, QUE-33)
      // keeps the ticket on the board as the active ticket at the counter — the
      // staff is still serving it, just in a sub-state. Only COMPLETED leaves
      // the counter outright; SKIPPED moves to its own list (above). The caller
      // fires the generic endpoint for the active ticket and for the rows of the
      // waiting/skipped lists, so a WAITING-sourced generic transition leaves a
      // ticket this branch never sees; the `!ticket` guard above leaves such a
      // ticket in `waiting` untouched (no divergence on the supported flow).
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
      // my own categories. Drop it from `active` (and from `skipped`, which a
      // configured `SKIPPED → …` category move leaves it in), then re-add to
      // `waiting` only when the new category is one of mine.
      const active = state.active.filter((t) => t.ticketId !== e.aggregateId);
      const skipped = state.skipped.filter((t) => t.ticketId !== e.aggregateId);
      let waiting = state.waiting.filter((t) => t.ticketId !== e.aggregateId);
      if (mine) {
        const ticket: TicketStateDto = {
          ticketId: e.aggregateId,
          ticketNumber: p.toTicketNumber,
          categoryId: p.toCategoryId,
          status: 'WAITING',
          counterId: null,
        };
        waiting = [...waiting, ticket].sort(byTicketNumber);
      }
      return { ...state, active, skipped, waiting, waitingCount: waiting.length };
    }
    case 'SYSTEM_RESET':
      // The provider refetches the snapshot; mark stale as a signal.
      return { ...state, stale: true };
    case 'SYSTEM_CONFIG_CHANGED':
      // The admin re-saved the system configuration. Bump the config version so
      // the workspace signals ActionControls to refetch the active state
      // machine — the caller must reflect the admin-designed flow + its
      // `actionLabel` wording without a reload (FR-CLR-02). Pure signal: the
      // store does not own the state machine (ActionControls fetches it), so
      // unlike SYSTEM_RESET there is no local projection to invalidate.
      return { ...state, configVersion: state.configVersion + 1 };
    default:
      return state;
  }
}

function dedupePrepend(ticket: TicketStateDto, list: readonly TicketStateDto[]): readonly TicketStateDto[] {
  const rest = list.filter((t) => t.ticketId !== ticket.ticketId);
  return [ticket, ...rest];
}

/**
 * Append to the skipped list, replacing any prior entry for the same ticket and
 * **preserving skip order** — oldest skip first, the order staff work them back
 * through. This deliberately does NOT re-sort by ticket number, because the
 * server hands the same list back in that order (`findSkippedByCounter` reads
 * `updatedAt` ascending), and a client that re-sorted would make the list depend
 * on how you arrived at it: skip B-003 then A-011 and the live list would read
 * `[A-011, B-003]`, but a reload would swap them back. Rows moving under a
 * reaching finger on a touch panel is a mis-tap onto the wrong customer's
 * "Panggil Ulang". Appending keeps live and reloaded order identical.
 *
 * The waiting list keeps its own ticket-number sort (see `byTicketNumber` call
 * sites): its server order is `createdAt` ascending and that pairing predates
 * this bucket — not changed here.
 */
function dedupeAppend(ticket: TicketStateDto, list: readonly TicketStateDto[]): readonly TicketStateDto[] {
  const rest = list.filter((t) => t.ticketId !== ticket.ticketId);
  return [...rest, ticket];
}

/**
 * Looks a ticket up across every bucket this counter projects. Lifecycle payloads
 * are lean (TICKET_CALLED carries no `categoryId`), so a projection recovers the
 * missing fields from what it already knows rather than blanking them — a blank
 * `categoryId` would silently break the transfer chooser (FR-CLR-03).
 */
function findKnown(state: QueueState, ticketId: string): TicketStateDto | undefined {
  return (
    state.waiting.find((t) => t.ticketId === ticketId) ??
    state.skipped.find((t) => t.ticketId === ticketId) ??
    state.active.find((t) => t.ticketId === ticketId)
  );
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

  // Mounted guard so a snapshot fetch resolving after unmount does not dispatch
  // on a dead reducer — mirrors the TV store's discipline.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useMemo(
    () => async () => {
      try {
        const snapshot = await api.getQueueSnapshot(bound.counterId);
        if (!mountedRef.current) return;
        dispatch({ type: 'SNAPSHOT_LOADED', snapshot });
      } catch (err) {
        if (!mountedRef.current) return;
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
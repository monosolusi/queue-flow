import type { CounterDto, QueueSnapshotDto, StateMachineDto } from './types';

/**
 * The slice of core-api the caller panel consumes (ISP — never leaks
 * admin/reporting DTOs into the caller). The read surface (counters + queue
 * snapshot + active state machine) feeds the workspace; the command surface
 * drives queue transitions (FR-CLR-02 / FR-ENG-03). Command results are
 * delivered to the workspace over the WebSocket broadcaster (TICKET_CALLED /
 * STATUS_UPDATED / TICKET_TRANSFERRED), so the command methods return
 * `Promise<void>` — the caller does not need the result DTO, the store updates
 * from the realtime event. Implementations live behind this interface so tests
 * can substitute a fake without touching the network.
 */
export interface ICallerApi {
  // Read surface -----------------------------------------------------------
  listCounters(): Promise<CounterDto[]>;
  getQueueSnapshot(counterId: number): Promise<QueueSnapshotDto>;
  getActiveStateMachine(): Promise<StateMachineDto>;
  // Command surface (FR-CLR-02 / FR-ENG-03) -------------------------------
  callNext(counterId: number): Promise<void>;
  serve(ticketId: string): Promise<void>;
  complete(ticketId: string): Promise<void>;
  skip(ticketId: string): Promise<void>;
  recall(ticketId: string): Promise<void>;
  transfer(ticketId: string, targetCategoryId: string): Promise<void>;
  /** Generic apply-transition (QUE-33): drives a wizard-configurable edge to
   *  an arbitrary target state not covered by the six fixed commands. */
  applyTransition(ticketId: string, targetStatus: string): Promise<void>;
}

const API_BASE = '/api';

/** Generic GET helper that throws on non-2xx so callers can try/catch. */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`GET ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

/** Generic POST helper (empty body) that throws on non-2xx. */
async function postEmpty(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`POST ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

/** Generic POST helper (JSON body) that throws on non-2xx. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`POST ${path} -> ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch-based {@link ICallerApi} using relative `/api` URLs — same-origin behind
 * NGINX in production, proxied to core-api:3000 by Vite in dev. No remote calls
 * (NFR-REL-01). Command endpoints map to the core-api `QueueCommandsController`
 * (`POST /api/queue/call-next`, `…/:id/serve|complete|skip|recall|transfer`).
 */
export class CallerApi implements ICallerApi {
  listCounters(): Promise<CounterDto[]> {
    return getJson<CounterDto[]>('/counters');
  }
  getQueueSnapshot(counterId: number): Promise<QueueSnapshotDto> {
    return getJson<QueueSnapshotDto>(`/queue?counterId=${encodeURIComponent(counterId)}`);
  }
  getActiveStateMachine(): Promise<StateMachineDto> {
    return getJson<StateMachineDto>('/system/state-machine');
  }
  callNext(counterId: number): Promise<void> {
    return postJson(`/queue/call-next`, { counterId }).then(() => undefined);
  }
  serve(ticketId: string): Promise<void> {
    return postEmpty(`/queue/${encodeURIComponent(ticketId)}/serve`);
  }
  complete(ticketId: string): Promise<void> {
    return postEmpty(`/queue/${encodeURIComponent(ticketId)}/complete`);
  }
  skip(ticketId: string): Promise<void> {
    return postEmpty(`/queue/${encodeURIComponent(ticketId)}/skip`);
  }
  recall(ticketId: string): Promise<void> {
    return postEmpty(`/queue/${encodeURIComponent(ticketId)}/recall`);
  }
  transfer(ticketId: string, targetCategoryId: string): Promise<void> {
    return postJson(`/queue/${encodeURIComponent(ticketId)}/transfer`, { targetCategoryId }).then(
      () => undefined,
    );
  }
  applyTransition(ticketId: string, targetStatus: string): Promise<void> {
    return postJson(`/queue/${encodeURIComponent(ticketId)}/transition`, { targetStatus }).then(
      () => undefined,
    );
  }
}

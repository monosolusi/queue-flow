import { describe, expect, it, vi } from 'vitest';
import { invokeWorkflowAction } from './workflow-commands';
import type { WorkflowAction } from './workflow-actions';
import type { ICallerApi } from '../api/caller-api';

function makeApi(): ICallerApi {
  return {
    getWorkflowActions: vi.fn(() => Promise.resolve({ byStatus: {} })),
    callNext: vi.fn(() => Promise.resolve()),
    reannounce: vi.fn(() => Promise.resolve()),
    transfer: vi.fn(() => Promise.resolve()),
    applyTransition: vi.fn(() => Promise.resolve()),
    getBrandColor: vi.fn(() => Promise.resolve({ brandColor: '', themeMode: 'light' as const })),
    listCounters: vi.fn(() => Promise.resolve([])),
    getQueueSnapshot: vi.fn(() => Promise.resolve({} as never)),
    login: vi.fn(() =>
      Promise.resolve({ token: 'tok', user: { id: 'u', username: 's', role: 'caller-staff' as const } }),
    ),
    logout: vi.fn(() => Promise.resolve()),
    getMe: vi.fn(() => Promise.resolve(null)),
  };
}

function action(partial: Partial<WorkflowAction>): WorkflowAction {
  return {
    from: 'CALLING',
    to: 'SERVING',
    actionLabel: 'Mulai Melayani',
    unavailableReason: null,
    ...partial,
  };
}

describe('invokeWorkflowAction', () => {
  it('sends every status change to the one transition endpoint, target and all', async () => {
    // Each of these used to be its own endpoint, chosen by a table upstream. The
    // target state travels in the payload instead, and nothing has to decide
    // which endpoint an edge needs.
    const api = makeApi();
    await invokeWorkflowAction(api, action({ to: 'SERVING' }), 't1', { counterId: 2 });
    await invokeWorkflowAction(api, action({ to: 'COMPLETED' }), 't1', { counterId: 2 });
    await invokeWorkflowAction(api, action({ to: 'SKIPPED' }), 't1', { counterId: 2 });
    await invokeWorkflowAction(api, action({ from: 'SKIPPED', to: 'CALLING' }), 't1', {
      counterId: 2,
    });
    await invokeWorkflowAction(api, action({ to: 'PREPARING' }), 't1', { counterId: 2 });

    expect((api.applyTransition as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['t1', 'SERVING', 2],
      ['t1', 'COMPLETED', 2],
      ['t1', 'SKIPPED', 2],
      ['t1', 'CALLING', 2],
      ['t1', 'PREPARING', 2],
    ]);
  });

  it('sends the re-queue edge as a plain status change, not a category move', async () => {
    // The reported defect, at the one place that used to make the wrong call.
    const api = makeApi();
    await invokeWorkflowAction(
      api,
      action({ from: 'CALLING', to: 'WAITING', actionLabel: 'Kembalikan ke Antrian' }),
      't1',
      { counterId: 2 },
    );
    expect(api.applyTransition).toHaveBeenCalledWith('t1', 'WAITING', 2);
    expect(api.transfer).not.toHaveBeenCalled();
  });

  it('carries the bound counter so a transition into CALLING can be announced', async () => {
    const api = makeApi();
    await invokeWorkflowAction(api, action({ from: 'SKIPPED', to: 'CALLING' }), 't1', {
      counterId: 7,
    });
    expect(api.applyTransition).toHaveBeenCalledWith('t1', 'CALLING', 7);
  });

  it('omits the counter when the panel has none to give', async () => {
    const api = makeApi();
    await invokeWorkflowAction(api, action({ to: 'SERVING' }), 't1');
    expect(api.applyTransition).toHaveBeenCalledWith('t1', 'SERVING', undefined);
  });

  it('never reaches the counter-level call-next (it targets a counter, not a ticket)', async () => {
    // The WAITING → CALLING edge is filtered out of the per-ticket list, so this
    // is defence in depth too: reaching here it is a per-ticket transition,
    // announcing that one ticket — never the counter-level pick.
    const api = makeApi();
    await invokeWorkflowAction(api, action({ from: 'WAITING', to: 'CALLING' }), 't1', {
      counterId: 2,
    });
    expect(api.callNext).not.toHaveBeenCalled();
    expect(api.applyTransition).toHaveBeenCalledWith('t1', 'CALLING', 2);
  });
});
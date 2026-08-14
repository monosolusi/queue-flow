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
    action: 'UPDATE_STATUS',
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

  it('passes the chosen destination category to transfer, and nothing else', async () => {
    // No target status: a transferred ticket always lands back in the queue,
    // because it gets a new per-category number. The edge's `to` adds nothing the
    // endpoint needs.
    const api = makeApi();
    await invokeWorkflowAction(
      api,
      action({ action: 'TRANSFER_CATEGORY', to: 'WAITING', actionLabel: 'Pindah Kategori' }),
      't1',
      { counterId: 2, targetCategoryId: 'cat-b' },
    );
    expect(api.transfer).toHaveBeenCalledWith('t1', 'cat-b');
    expect(api.applyTransition).not.toHaveBeenCalled();
  });

  it('rejects a transfer with no destination rather than calling the endpoint', async () => {
    const api = makeApi();
    await expect(
      invokeWorkflowAction(api, action({ action: 'TRANSFER_CATEGORY', to: 'WAITING' }), 't1', {
        counterId: 2,
      }),
    ).rejects.toThrow(/kategori tujuan/i);
    expect(api.transfer).not.toHaveBeenCalled();
  });

  it('rejects an action this build cannot run instead of guessing an endpoint', async () => {
    // Its button is disabled, so this is defence in depth: a mis-wired caller
    // must fail loudly, never fall through to a command with the wrong semantics.
    const api = makeApi();
    await expect(
      invokeWorkflowAction(api, action({ action: null, from: 'SERVING', to: 'CALLING' }), 't1', {
        counterId: 2,
      }),
    ).rejects.toThrow(/tidak bisa dijalankan/i);
    expect(api.applyTransition).not.toHaveBeenCalled();
    expect(api.transfer).not.toHaveBeenCalled();
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

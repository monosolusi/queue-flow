import { describe, expect, it, vi } from 'vitest';
import { invokeWorkflowAction } from './workflow-commands';
import type { WorkflowAction } from './workflow-actions';
import type { ICallerApi } from '../api/caller-api';

function makeApi(): ICallerApi {
  return {
    getWorkflowActions: vi.fn(() => Promise.resolve({ byStatus: {} })),
    callNext: vi.fn(() => Promise.resolve()),
    serve: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() => Promise.resolve()),
    skip: vi.fn(() => Promise.resolve()),
    recall: vi.fn(() => Promise.resolve()),
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
    command: 'SERVE',
    unavailableReason: null,
    ...partial,
  };
}

describe('invokeWorkflowAction', () => {
  it('maps each ticket-scoped command onto its endpoint', async () => {
    const api = makeApi();
    await invokeWorkflowAction(api, action({ command: 'SERVE' }), 't1');
    await invokeWorkflowAction(api, action({ command: 'COMPLETE', to: 'COMPLETED' }), 't1');
    await invokeWorkflowAction(api, action({ command: 'SKIP', to: 'SKIPPED' }), 't1');
    await invokeWorkflowAction(api, action({ command: 'RECALL', from: 'SKIPPED', to: 'CALLING' }), 't1');
    expect(api.serve).toHaveBeenCalledWith('t1');
    expect(api.complete).toHaveBeenCalledWith('t1');
    expect(api.skip).toHaveBeenCalledWith('t1');
    expect(api.recall).toHaveBeenCalledWith('t1');
  });

  it('maps the CALLING self-loop onto re-announce (no state change)', async () => {
    const api = makeApi();
    await invokeWorkflowAction(
      api,
      action({ command: 'REANNOUNCE', from: 'CALLING', to: 'CALLING' }),
      't1',
    );
    expect(api.reannounce).toHaveBeenCalledWith('t1');
    // It is not confused with recall, which does change the status.
    expect(api.recall).not.toHaveBeenCalled();
  });

  it('passes the target state to the generic transition endpoint', async () => {
    const api = makeApi();
    await invokeWorkflowAction(api, action({ command: 'APPLY_TRANSITION', to: 'PREPARING' }), 't1');
    expect(api.applyTransition).toHaveBeenCalledWith('t1', 'PREPARING');
  });

  it('passes the chosen destination category to transfer', async () => {
    const api = makeApi();
    await invokeWorkflowAction(api, action({ command: 'TRANSFER', to: 'WAITING' }), 't1', 'cat-b');
    expect(api.transfer).toHaveBeenCalledWith('t1', 'cat-b');
  });

  it('rejects a transfer with no destination rather than calling the endpoint', async () => {
    const api = makeApi();
    await expect(
      invokeWorkflowAction(api, action({ command: 'TRANSFER', to: 'WAITING' }), 't1'),
    ).rejects.toThrow(/kategori tujuan/i);
    expect(api.transfer).not.toHaveBeenCalled();
  });

  it('rejects an unroutable action instead of guessing an endpoint', async () => {
    // Its button is disabled, so this is defence in depth: a mis-wired caller
    // must fail loudly, never fall through to a command with the wrong semantics.
    const api = makeApi();
    await expect(
      invokeWorkflowAction(api, action({ command: null, from: 'SERVING', to: 'CALLING' }), 't1'),
    ).rejects.toThrow(/tidak bisa dijalankan/i);
    expect(api.recall).not.toHaveBeenCalled();
  });

  it('rejects the counter-level call-next (it targets a counter, not a ticket)', async () => {
    const api = makeApi();
    await expect(
      invokeWorkflowAction(api, action({ command: 'CALL_NEXT', from: 'WAITING', to: 'CALLING' }), 't1'),
    ).rejects.toThrow(/tidak bisa dijalankan/i);
    expect(api.callNext).not.toHaveBeenCalled();
  });
});

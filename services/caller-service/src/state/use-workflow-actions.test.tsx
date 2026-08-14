import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useWorkflowActions } from './use-workflow-actions';
import type { ICallerApi } from '../api/caller-api';
import type { WorkflowActionsDto } from '../api/types';
import { edge, workflowActions } from '../test/workflow-fixtures';

const defaultWorkflow: WorkflowActionsDto = workflowActions(
  edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'CALL_NEXT'),
  edge('SERVING', 'COMPLETED', 'Selesai Layan', 'COMPLETE'),
);

function makeApi(overrides: Partial<ICallerApi> = {}): ICallerApi {
  return {
    getWorkflowActions: vi.fn(() => Promise.resolve(defaultWorkflow)),
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
    ...overrides,
  };
}

/** Probe rendering the hook's output as text so RTL can assert on it. */
function Probe({ api, configVersion }: { api: ICallerApi; configVersion: number }) {
  const { workflow, error } = useWorkflowActions(api, configVersion);
  const labels = Object.values(workflow?.byStatus ?? {})
    .flat()
    .map((a) => a.actionLabel);
  return (
    <>
      <p data-testid="labels">{labels.join(' | ')}</p>
      <p data-testid="error">{error ?? ''}</p>
    </>
  );
}

describe('useWorkflowActions (FR-CLR-02)', () => {
  it('loads the action surface once on mount', async () => {
    const api = makeApi();
    render(<Probe api={api} configVersion={0} />);
    expect(await screen.findByText(/Selesai Layan/)).toBeInTheDocument();
    expect(api.getWorkflowActions).toHaveBeenCalledTimes(1);
  });

  it('refetches and reflects a relabeled flow when configVersion bumps', async () => {
    // The store bumps `configVersion` on a SYSTEM_CONFIG_CHANGED WS event (the
    // admin re-saved the flow mid-shift). The panel must pick up the new
    // wording without a page reload.
    let surface: WorkflowActionsDto = defaultWorkflow;
    const api = makeApi({ getWorkflowActions: vi.fn(() => Promise.resolve(surface)) });
    const { rerender } = render(<Probe api={api} configVersion={0} />);
    expect(await screen.findByText(/Selesai Layan/)).toBeInTheDocument();
    expect(api.getWorkflowActions).toHaveBeenCalledTimes(1);

    surface = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'CALL_NEXT'),
      edge('SERVING', 'COMPLETED', 'Selesaikan Layanan', 'COMPLETE'),
    );
    rerender(<Probe api={api} configVersion={1} />);

    expect(api.getWorkflowActions).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/Selesaikan Layanan/)).toBeInTheDocument();
  });

  it('reports a friendly error (no HTTP jargon) when the actions cannot be read', async () => {
    const api = makeApi({
      getWorkflowActions: vi.fn(() => Promise.reject(new Error('GET /queue/actions -> 409'))),
    });
    render(<Probe api={api} configVersion={0} />);
    const error = await screen.findByTestId('error');
    expect(error).toHaveTextContent(/Alur status gagal dimuat/i);
    expect(error).not.toHaveTextContent(/409/);
    expect(screen.getByTestId('labels')).toHaveTextContent('');
  });

  it('keeps the last known actions when a refetch fails (a blip must not strip the buttons)', async () => {
    let fail = false;
    const api = makeApi({
      getWorkflowActions: vi.fn(() =>
        fail ? Promise.reject(new Error('offline')) : Promise.resolve(defaultWorkflow),
      ),
    });
    const { rerender } = render(<Probe api={api} configVersion={0} />);
    expect(await screen.findByText(/Selesai Layan/)).toBeInTheDocument();

    fail = true;
    rerender(<Probe api={api} configVersion={1} />);
    expect(await screen.findByText(/Alur status gagal dimuat/i)).toBeInTheDocument();
    // The staff keeps a working panel; the hint says the refresh failed.
    expect(screen.getByTestId('labels')).toHaveTextContent('Selesai Layan');
  });
});

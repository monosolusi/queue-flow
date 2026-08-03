import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionControls } from './ActionControls';
import type { ICallerApi } from '../api/caller-api';
import type { StateMachineDto, TicketStateDto } from '../api/types';
import type { BoundCounter } from '../state/counter-binding';

const defaultStateMachine: StateMachineDto = {
  states: ['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED'],
  transitions: [
    { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
    { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
    { from: 'CALLING', to: 'SKIPPED', actionLabel: 'Lewati / Absen' },
    { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang' },
    { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan' },
  ],
};

const bound: BoundCounter = {
  counterId: 1,
  counterName: 'Loket 1',
  assignedCategoryIds: ['cat-a', 'cat-b'],
  assignedCategories: [
    { id: 'cat-a', code: 'A', name: 'Customer Service' },
    { id: 'cat-b', code: 'B', name: 'Kasir' },
  ],
};

function ticket(status: string, categoryId = 'cat-a'): TicketStateDto {
  return { ticketId: 't1', ticketNumber: 'A-001', categoryId, status, counterId: 1 };
}

function makeApi(overrides: Partial<ICallerApi> = {}): ICallerApi {
  return {
    getActiveStateMachine: vi.fn(() => Promise.resolve(defaultStateMachine)),
    callNext: vi.fn(() => Promise.resolve()),
    serve: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() => Promise.resolve()),
    skip: vi.fn(() => Promise.resolve()),
    recall: vi.fn(() => Promise.resolve()),
    transfer: vi.fn(() => Promise.resolve()),
    applyTransition: vi.fn(() => Promise.resolve()),
    getBrandColor: vi.fn(() => Promise.resolve({ brandColor: '' })),
    listCounters: vi.fn(() => Promise.resolve([])),
    getQueueSnapshot: vi.fn(() => Promise.resolve({} as never)),
    ...overrides,
  };
}

describe('ActionControls (FR-CLR-02 / QUE-20)', () => {
  it('always renders Panggil Berikutnya and per-edge buttons for the active status', async () => {
    const api = makeApi();
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} stateMachine={defaultStateMachine} />,
    );
    // The primary call-next is always present.
    expect(screen.getByRole('button', { name: 'Panggil Berikutnya' })).toBeInTheDocument();
    // Edges from CALLING: → SERVING (serve) + → SKIPPED (skip).
    expect(screen.getByTestId('action-serve')).toHaveTextContent('Mulai Melayani');
    expect(screen.getByTestId('action-skip')).toHaveTextContent('Lewati / Absen');
    // No complete/recall from CALLING.
    expect(screen.queryByTestId('action-complete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-recall')).not.toBeInTheDocument();
  });

  it('renders Selesai Layan when the active ticket is SERVING', () => {
    const api = makeApi();
    render(
      <ActionControls api={api} bound={bound} active={ticket('SERVING')} stateMachine={defaultStateMachine} />,
    );
    expect(screen.getByTestId('action-complete')).toHaveTextContent('Selesai Layan');
    expect(screen.queryByTestId('action-serve')).not.toBeInTheDocument();
  });

  it('renders Panggil Ulang when the active ticket is SKIPPED', () => {
    const api = makeApi();
    render(
      <ActionControls api={api} bound={bound} active={ticket('SKIPPED')} stateMachine={defaultStateMachine} />,
    );
    expect(screen.getByTestId('action-recall')).toHaveTextContent('Panggil Ulang');
  });

  it('shows only Panggil Berikutnya when there is no active ticket', () => {
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={null} stateMachine={defaultStateMachine} />);
    expect(screen.getByRole('button', { name: 'Panggil Berikutnya' })).toBeInTheDocument();
    expect(screen.queryByTestId('action-serve')).not.toBeInTheDocument();
  });

  it('invokes the right command on tap (call-next uses the bound counter id)', async () => {
    const api = makeApi();
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} stateMachine={defaultStateMachine} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Panggil Berikutnya' }));
    expect(api.callNext).toHaveBeenCalledWith(1);

    await userEvent.click(screen.getByTestId('action-serve'));
    expect(api.serve).toHaveBeenCalledWith('t1');

    await userEvent.click(screen.getByTestId('action-skip'));
    expect(api.skip).toHaveBeenCalledWith('t1');
  });

  it('invokes transfer with a target category differing from the active ticket category', async () => {
    const graph: StateMachineDto = {
      states: ['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED'],
      transitions: [
        { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
        { from: 'CALLING', to: 'WAITING', actionLabel: 'Pindah Kategori' },
      ],
    };
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={ticket('CALLING', 'cat-a')} stateMachine={graph} />);
    const transferBtn = screen.getByTestId('action-transfer');
    expect(transferBtn).toHaveTextContent('Pindah Kategori');
    await userEvent.click(transferBtn);
    // The target is the first assigned category that isn't the active one.
    expect(api.transfer).toHaveBeenCalledWith('t1', 'cat-b');
  });

  it('guards against double-fire while a command is pending', async () => {
    let resolveServe: (() => void) | undefined;
    const api = makeApi({ serve: vi.fn(() => new Promise<void>((r) => (resolveServe = r))) });
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} stateMachine={defaultStateMachine} />,
    );
    const serveBtn = screen.getByTestId('action-serve');
    await userEvent.click(serveBtn);
    expect(api.serve).toHaveBeenCalledTimes(1);
    // While pending the button is disabled (double-tap must not fire twice).
    expect(serveBtn).toBeDisabled();
    await userEvent.click(serveBtn);
    expect(api.serve).toHaveBeenCalledTimes(1);
    resolveServe!();
    expect(await screen.findByTestId('action-serve')).not.toBeDisabled();
  });

  it('surfaces an inline error when a command fails', async () => {
    const api = makeApi({ serve: vi.fn(() => Promise.reject(new Error('transisi ilegal'))) });
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} stateMachine={defaultStateMachine} />,
    );
    await userEvent.click(screen.getByTestId('action-serve'));
    expect(await screen.findByText(/transisi ilegal/i)).toBeInTheDocument();
  });

  it('shows a chooser for transfer when ≥2 other categories and fires the chosen one', async () => {
    const multiBound: BoundCounter = {
      counterId: 2,
      counterName: 'Loket 2',
      assignedCategoryIds: ['cat-a', 'cat-b', 'cat-c'],
      assignedCategories: [
        { id: 'cat-a', code: 'A', name: 'Customer Service' },
        { id: 'cat-b', code: 'B', name: 'Kasir' },
        { id: 'cat-c', code: 'C', name: 'Informasi' },
      ],
    };
    const graph: StateMachineDto = {
      states: ['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED'],
      transitions: [{ from: 'CALLING', to: 'WAITING', actionLabel: 'Pindah Kategori' }],
    };
    const api = makeApi();
    render(<ActionControls api={api} bound={multiBound} active={ticket('CALLING', 'cat-a')} stateMachine={graph} />);
    const transferBtn = screen.getByTestId('action-transfer');
    expect(transferBtn).toHaveTextContent('Pindah Kategori');
    // The toggle programmatically points at the chooser it controls (QUE-40 AC4).
    expect(transferBtn).toHaveAttribute('aria-expanded', 'false');
    expect(transferBtn).toHaveAttribute('aria-controls');
    const controlsId = transferBtn.getAttribute('aria-controls')!;
    // No chooser until toggled open.
    expect(screen.queryByTestId('transfer-chooser')).not.toBeInTheDocument();
    await userEvent.click(transferBtn);
    const chooser = await screen.findByTestId('transfer-chooser');
    // The chooser's id matches the toggle's aria-controls, and it is a labelled group.
    expect(chooser).toHaveAttribute('id', controlsId);
    expect(chooser).toHaveAttribute('role', 'group');
    expect(chooser).toHaveAttribute('aria-label', 'Kategori tujuan');
    // Both other categories are listed by name; the active category is excluded.
    expect(chooser).toHaveTextContent('Kasir');
    expect(chooser).toHaveTextContent('Informasi');
    expect(chooser).not.toHaveTextContent('Customer Service');
    await userEvent.click(screen.getByTestId('transfer-target-cat-c'));
    expect(api.transfer).toHaveBeenCalledWith('t1', 'cat-c');
  });

  it('disables transfer and fires nothing when no other category is available', async () => {
    const singleBound: BoundCounter = {
      counterId: 3,
      counterName: 'Loket 3',
      assignedCategoryIds: ['cat-a'],
      assignedCategories: [{ id: 'cat-a', code: 'A', name: 'Customer Service' }],
    };
    const graph: StateMachineDto = {
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'CALLING', to: 'WAITING', actionLabel: 'Pindah Kategori' }],
    };
    const api = makeApi();
    render(<ActionControls api={api} bound={singleBound} active={ticket('CALLING', 'cat-a')} stateMachine={graph} />);
    const transferBtn = screen.getByTestId('action-transfer');
    expect(transferBtn).toBeDisabled();
    await userEvent.click(transferBtn);
    expect(api.transfer).not.toHaveBeenCalled();
  });

  it('fires applyTransition for a custom-target transition (QUE-33)', async () => {
    const graph: StateMachineDto = {
      states: ['WAITING', 'CALLING', 'SERVING', 'PREPARING', 'COMPLETED'],
      transitions: [
        { from: 'SERVING', to: 'PREPARING', actionLabel: 'Siapkan Dokumen' },
        { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan' },
      ],
    };
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={ticket('SERVING')} stateMachine={graph} />);
    // The custom target (PREPARING) is backed by the generic apply-transition
    // endpoint → a functional button labeled with the transition's actionLabel.
    const customBtn = screen.getByTestId('action-apply-transition-PREPARING');
    expect(customBtn).toHaveTextContent('Siapkan Dokumen');
    expect(customBtn).not.toBeDisabled();
    await userEvent.click(customBtn);
    expect(api.applyTransition).toHaveBeenCalledWith('t1', 'PREPARING');
    // The known target (COMPLETED) still routes to its fixed command endpoint.
    expect(screen.getByTestId('action-complete')).not.toBeDisabled();
  });

  it('guards against double-fire on a custom-target transition (QUE-33)', async () => {
    const graph: StateMachineDto = {
      states: ['WAITING', 'CALLING', 'SERVING', 'PREPARING', 'COMPLETED'],
      transitions: [{ from: 'SERVING', to: 'PREPARING', actionLabel: 'Siapkan Dokumen' }],
    };
    let resolveTransition: (() => void) | undefined;
    const api = makeApi({
      applyTransition: vi.fn(() => new Promise<void>((r) => (resolveTransition = r))),
    });
    render(<ActionControls api={api} bound={bound} active={ticket('SERVING')} stateMachine={graph} />);
    const btn = screen.getByTestId('action-apply-transition-PREPARING');
    await userEvent.click(btn);
    expect(api.applyTransition).toHaveBeenCalledTimes(1);
    // While pending the button is disabled (double-tap must not fire twice).
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(api.applyTransition).toHaveBeenCalledTimes(1);
    resolveTransition!();
    expect(await screen.findByTestId('action-apply-transition-PREPARING')).not.toBeDisabled();
  });
});
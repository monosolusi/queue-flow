import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionControls } from './ActionControls';
import type { ICallerApi } from '../api/caller-api';
import type { TicketStateDto } from '../api/types';
import type { BoundCounter } from '../state/counter-binding';
import { PRD_DEFAULT_WORKFLOW, edge, workflowActions } from '../test/workflow-fixtures';

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
    getWorkflowActions: vi.fn(() => Promise.resolve(PRD_DEFAULT_WORKFLOW)),
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
    // Auth surface (QUE-43) — not invoked by action controls; stubs satisfy the type.
    login: vi.fn(() =>
      Promise.resolve({ token: 'tok', user: { id: 'u', username: 's', role: 'caller-staff' as const } }),
    ),
    logout: vi.fn(() => Promise.resolve()),
    getMe: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
}

describe('ActionControls (FR-CLR-02 / QUE-20)', () => {
  it('renders Panggil Berikutnya and per-edge buttons for the active status', async () => {
    const api = makeApi();
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} workflow={PRD_DEFAULT_WORKFLOW} />,
    );
    // The primary call-next is present because the flow has the WAITING →
    // CALLING edge (disabled while an unresolved active ticket occupies the
    // counter — staff must resolve it first).
    const callNextBtn = screen.getByRole('button', { name: 'Panggil Berikutnya' });
    expect(callNextBtn).toBeInTheDocument();
    expect(callNextBtn).toBeDisabled();
    // Edges from CALLING: → SERVING (serve) + → SKIPPED (skip).
    expect(screen.getByTestId('action-serve')).toHaveTextContent('Mulai Melayani');
    expect(screen.getByTestId('action-skip')).toHaveTextContent('Lewati / Absen');
    // "Panggil Lagi" is a fixed affordance shown only while a ticket is CALLING
    // (re-announce — distinct from recall, which is the SKIPPED → CALLING edge).
    expect(screen.getByTestId('action-reannounce')).toHaveTextContent('Panggil Lagi');
    // No complete/recall from CALLING.
    expect(screen.queryByTestId('action-complete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-recall')).not.toBeInTheDocument();
  });

  it('renders Selesai Layan when the active ticket is SERVING', () => {
    const api = makeApi();
    render(
      <ActionControls api={api} bound={bound} active={ticket('SERVING')} workflow={PRD_DEFAULT_WORKFLOW} />,
    );
    expect(screen.getByTestId('action-complete')).toHaveTextContent('Selesai Layan');
    expect(screen.queryByTestId('action-serve')).not.toBeInTheDocument();
    // Panggil Lagi is only for CALLING.
    expect(screen.queryByTestId('action-reannounce')).not.toBeInTheDocument();
  });

  it('offers no buttons for a skipped ticket — that surface is the skipped list', () => {
    // A skipped ticket never occupies the counter: the store moves it to its own
    // list, which renders the SKIPPED edges ("Panggil Ulang"). This panel is for
    // the ticket AT the counter, so it must not also claim them — see
    // SkippedQueueList.test.tsx and WorkspacePage.test.tsx for the real path.
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={null} workflow={PRD_DEFAULT_WORKFLOW} />);
    expect(screen.queryByTestId('action-recall')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-reannounce')).not.toBeInTheDocument();
  });

  it('shows only Panggil Berikutnya when there is no active ticket', () => {
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={null} workflow={PRD_DEFAULT_WORKFLOW} />);
    const callNextBtn = screen.getByRole('button', { name: 'Panggil Berikutnya' });
    expect(callNextBtn).toBeInTheDocument();
    // No active ticket → call-next is enabled (the counter is free to call).
    expect(callNextBtn).not.toBeDisabled();
    expect(screen.queryByTestId('action-serve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-reannounce')).not.toBeInTheDocument();
  });

  it('invokes reannounce on tap when the active ticket is CALLING (Panggil Lagi)', async () => {
    const api = makeApi();
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} workflow={PRD_DEFAULT_WORKFLOW} />,
    );
    await userEvent.click(screen.getByTestId('action-reannounce'));
    expect(api.reannounce).toHaveBeenCalledWith('t1');
  });

  it('invokes the right command on tap (call-next uses the bound counter id)', async () => {
    // call-next is disabled while an unresolved ticket occupies the counter, so
    // verify it on a separate render with no active ticket.
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={null} workflow={PRD_DEFAULT_WORKFLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Panggil Berikutnya' }));
    expect(api.callNext).toHaveBeenCalledWith(1);
    // Unmount the first render so the second `screen` queries don't hit a
    // duplicated "Panggil Berikutnya" button (mirrors the sibling test below).
    cleanup();

    // The per-edge serve / skip buttons stay enabled on the CALLING-state render.
    const api2 = makeApi();
    render(
      <ActionControls api={api2} bound={bound} active={ticket('CALLING')} workflow={PRD_DEFAULT_WORKFLOW} />,
    );
    await userEvent.click(screen.getByTestId('action-serve'));
    expect(api2.serve).toHaveBeenCalledWith('t1');

    await userEvent.click(screen.getByTestId('action-skip'));
    expect(api2.skip).toHaveBeenCalledWith('t1');
  });

  it('disables Panggil Berikutnya while an active ticket is unresolved (CALLING / SERVING)', async () => {
    // CALLING: ticket at the counter, not yet served / skipped.
    const api = makeApi();
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} workflow={PRD_DEFAULT_WORKFLOW} />,
    );
    const callNextCalling = screen.getByRole('button', { name: 'Panggil Berikutnya' });
    expect(callNextCalling).toBeDisabled();
    await userEvent.click(callNextCalling);
    expect(api.callNext).not.toHaveBeenCalled();

    // SERVING: ticket still in-progress; call-next must stay locked until completed.
    cleanup();
    const api2 = makeApi();
    render(
      <ActionControls api={api2} bound={bound} active={ticket('SERVING')} workflow={PRD_DEFAULT_WORKFLOW} />,
    );
    const callNextServing = screen.getByRole('button', { name: 'Panggil Berikutnya' });
    expect(callNextServing).toBeDisabled();
    await userEvent.click(callNextServing);
    expect(api2.callNext).not.toHaveBeenCalled();
  });

  it('invokes transfer with a target category differing from the active ticket category', async () => {
    const workflow = workflowActions(
      edge('CALLING', 'SERVING', 'Mulai Melayani', 'SERVE'),
      edge('CALLING', 'WAITING', 'Pindah Kategori', 'TRANSFER'),
    );
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={ticket('CALLING', 'cat-a')} workflow={workflow} />);
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
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} workflow={PRD_DEFAULT_WORKFLOW} />,
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
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} workflow={PRD_DEFAULT_WORKFLOW} />,
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
    const workflow = workflowActions(edge('CALLING', 'WAITING', 'Pindah Kategori', 'TRANSFER'));
    const api = makeApi();
    render(<ActionControls api={api} bound={multiBound} active={ticket('CALLING', 'cat-a')} workflow={workflow} />);
    const transferBtn = screen.getByTestId('action-transfer');
    expect(transferBtn).toHaveTextContent('Pindah Kategori');
    // The toggle programmatically points at the chooser it controls (QUE-40 AC4).
    expect(transferBtn).toHaveAttribute('aria-expanded', 'false');
    expect(transferBtn).toHaveAttribute('aria-controls');
    const controlsId = transferBtn.getAttribute('aria-controls')!;
    // No chooser until toggled open.
    expect(screen.queryByTestId('action-transfer-chooser')).not.toBeInTheDocument();
    await userEvent.click(transferBtn);
    const chooser = await screen.findByTestId('action-transfer-chooser');
    // The chooser's id matches the toggle's aria-controls, and it is a labelled group.
    expect(chooser).toHaveAttribute('id', controlsId);
    expect(chooser).toHaveAttribute('role', 'group');
    expect(chooser).toHaveAttribute('aria-label', 'Kategori tujuan');
    // Both other categories are listed by name; the active category is excluded.
    expect(chooser).toHaveTextContent('Kasir');
    expect(chooser).toHaveTextContent('Informasi');
    expect(chooser).not.toHaveTextContent('Customer Service');
    await userEvent.click(screen.getByTestId('action-transfer-target-cat-c'));
    expect(api.transfer).toHaveBeenCalledWith('t1', 'cat-c');
  });

  it('disables transfer and fires nothing when no other category is available', async () => {
    const singleBound: BoundCounter = {
      counterId: 3,
      counterName: 'Loket 3',
      assignedCategoryIds: ['cat-a'],
      assignedCategories: [{ id: 'cat-a', code: 'A', name: 'Customer Service' }],
    };
    const workflow = workflowActions(edge('CALLING', 'WAITING', 'Pindah Kategori', 'TRANSFER'));
    const api = makeApi();
    render(<ActionControls api={api} bound={singleBound} active={ticket('CALLING', 'cat-a')} workflow={workflow} />);
    const transferBtn = screen.getByTestId('action-transfer');
    expect(transferBtn).toBeDisabled();
    await userEvent.click(transferBtn);
    expect(api.transfer).not.toHaveBeenCalled();
  });

  it('fires applyTransition for a custom-target transition (QUE-33)', async () => {
    const workflow = workflowActions(
      edge('SERVING', 'PREPARING', 'Siapkan Dokumen', 'APPLY_TRANSITION'),
      edge('SERVING', 'COMPLETED', 'Selesai Layan', 'COMPLETE'),
    );
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={ticket('SERVING')} workflow={workflow} />);
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
    const workflow = workflowActions(
      edge('SERVING', 'PREPARING', 'Siapkan Dokumen', 'APPLY_TRANSITION'),
    );
    let resolveTransition: (() => void) | undefined;
    const api = makeApi({
      applyTransition: vi.fn(() => new Promise<void>((r) => (resolveTransition = r))),
    });
    render(<ActionControls api={api} bound={bound} active={ticket('SERVING')} workflow={workflow} />);
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

  it('labels the call-next button with the admin-configured WAITING→CALLING actionLabel (FR-CLR-02)', () => {
    // The call-next button drives the WAITING → CALLING transition (callNext
    // pulls a WAITING ticket and the aggregate validates that exact edge), so
    // its label is the admin's wording for that edge — not a hardcoded literal.
    const workflow = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Tiket Baru', 'CALL_NEXT'),
      edge('CALLING', 'SERVING', 'Mulai Melayani', 'SERVE'),
    );
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={null} workflow={workflow} />);
    expect(screen.getByRole('button', { name: 'Panggil Tiket Baru' })).toBeInTheDocument();
  });

  it('hides call-next entirely when the flow has no WAITING→CALLING edge', () => {
    // Behavior change (flow-as-source-of-truth): a flow that omits the
    // WAITING → CALLING edge means the manager removed that step. call-next
    // would 409 on the backend anyway, so the button must not be offered —
    // previously it rendered with a hardcoded fallback label.
    const workflow = workflowActions(edge('CALLING', 'SERVING', 'Mulai Melayani', 'SERVE'));
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={null} workflow={workflow} />);
    expect(screen.queryByRole('button', { name: 'Panggil Berikutnya' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Panggil/i })).not.toBeInTheDocument();
  });

  it('falls back to a usable call-next (with the load error) when the flow cannot be read', () => {
    // Degrade safely: an unreadable flow is NOT the same as a flow without the
    // edge. The panel keeps the PRD-default call-next so staff can still work,
    // and says plainly that the flow failed to load.
    const api = makeApi();
    render(
      <ActionControls
        api={api}
        bound={bound}
        active={null}
        workflow={null}
        workflowError="Alur status gagal dimuat — tombol aksi mungkin tidak lengkap. Coba muat ulang halaman."
      />,
    );
    expect(screen.getByRole('button', { name: 'Panggil Berikutnya' })).not.toBeDisabled();
    expect(screen.getByTestId('action-flow-error')).toHaveTextContent(/gagal dimuat/i);
  });

  it('renders an unroutable configured transition disabled with a reason, never silently', async () => {
    // A manager-configured edge back into "memanggil" from a served ticket: the
    // counter panel has no command for it (recall requires a skipped ticket), so
    // the old target-keyed mapping fired recall and got a 409. It must now show
    // as a visible, disabled, explained button — dropping it would reproduce the
    // "configured transitions don't appear" complaint.
    const workflow = workflowActions(
      edge('SERVING', 'CALLING', 'Panggil Ulang Dari Layanan', null, 'NO_COMMAND'),
      edge('SERVING', 'COMPLETED', 'Selesai Layan', 'COMPLETE'),
    );
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={ticket('SERVING')} workflow={workflow} />);
    const unroutable = screen.getByTestId('action-unroutable-CALLING');
    expect(unroutable).toHaveTextContent('Panggil Ulang Dari Layanan');
    expect(unroutable).toBeDisabled();
    // The reason is visible copy, associated with the button for AT.
    const describedBy = unroutable.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)).toHaveTextContent(/tidak bisa dijalankan dari panel loket/i);
    // It is NOT mis-routed to recall (the 409 class of bug this replaces).
    expect(screen.queryByTestId('action-recall')).not.toBeInTheDocument();
    await userEvent.click(unroutable);
    expect(api.recall).not.toHaveBeenCalled();
    // Its sibling edge still works.
    expect(screen.getByTestId('action-complete')).not.toBeDisabled();
  });

  it('runs the command the server named for the edge, not one guessed from the target', async () => {
    // Source-aware routing, on a status the counter can actually hold: the SAME
    // target (CALLING) is unroutable from SERVING in the PRD-default flow
    // (covered above) yet runs recall here, because this flow's server said so.
    // The old client-side target-keyed table could not express that difference.
    const workflow = workflowActions(
      edge('SERVING', 'CALLING', 'Panggil Ulang Dari Layanan', 'RECALL'),
    );
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={ticket('SERVING')} workflow={workflow} />);
    await userEvent.click(screen.getByTestId('action-recall'));
    expect(api.recall).toHaveBeenCalledWith('t1');
  });

  it('disables the other buttons while a command is in flight (no silent taps)', async () => {
    // One runner serves every button in the panel, so a tap on a second button
    // while the first is in flight is turned away by its guard. That must be
    // visible: an ignored tap with no feedback reads as a dead button.
    let resolveServe: (() => void) | undefined;
    const api = makeApi({ serve: vi.fn(() => new Promise<void>((r) => (resolveServe = r))) });
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} workflow={PRD_DEFAULT_WORKFLOW} />,
    );
    await userEvent.click(screen.getByTestId('action-serve'));
    const skipBtn = screen.getByTestId('action-skip');
    expect(skipBtn).toBeDisabled();
    expect(screen.getByTestId('action-reannounce')).toBeDisabled();
    // The blocked button keeps its own label — it is not the one running.
    expect(skipBtn).toHaveTextContent('Lewati / Absen');
    await userEvent.click(skipBtn);
    expect(api.skip).not.toHaveBeenCalled();
    resolveServe!();
    expect(await screen.findByTestId('action-skip')).not.toBeDisabled();
  });

  it('says so when the guard turns a same-tick tap away', async () => {
    // The residual case `disabled` cannot cover: two different buttons tapped
    // within one tick, before the disable renders. The ref guard blocks the
    // second — and the panel explains the wait instead of swallowing it.
    let resolveServe: (() => void) | undefined;
    const api = makeApi({ serve: vi.fn(() => new Promise<void>((r) => (resolveServe = r))) });
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} workflow={PRD_DEFAULT_WORKFLOW} />,
    );
    const serveBtn = screen.getByTestId('action-serve');
    const skipBtn = screen.getByTestId('action-skip');
    // Both taps inside ONE batch: React has not re-rendered in between, so the
    // `disabled` from the test above has not applied yet and the second tap
    // reaches the runner's synchronous ref guard. (Two separate `fireEvent`s
    // each flush, which is why they cannot reproduce this.)
    act(() => {
      serveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      skipBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(api.serve).toHaveBeenCalledTimes(1);
    expect(api.skip).not.toHaveBeenCalled();
    expect(await screen.findByText(/Tunggu perintah sebelumnya selesai/i)).toBeInTheDocument();
    // It is a hint about a wait, so it clears with the command that caused it.
    resolveServe!();
    await waitFor(() =>
      expect(screen.queryByText(/Tunggu perintah sebelumnya selesai/i)).not.toBeInTheDocument(),
    );
  });

  it('takes reannounce from the flow (own wording, inside the flow group) when the self-loop exists', async () => {
    // "Panggil Lagi" IS a CALLING → CALLING self-loop: it repeats the call
    // without changing the status, and the endpoint hard-requires CALLING. When
    // the manager draws that edge it becomes a flow action with their wording.
    const workflow = workflowActions(
      edge('CALLING', 'CALLING', 'Panggil Sekali Lagi', 'REANNOUNCE'),
      edge('CALLING', 'SERVING', 'Mulai Melayani', 'SERVE'),
    );
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={ticket('CALLING')} workflow={workflow} />);
    const btn = screen.getByTestId('action-reannounce');
    expect(btn).toHaveTextContent('Panggil Sekali Lagi');
    expect(screen.getByRole('group', { name: 'Aksi sesuai alur status' })).toContainElement(btn);
    // Exactly one — the built-in utility group stands down rather than
    // duplicating the action under the hardcoded "Panggil Lagi" wording.
    expect(screen.getAllByTestId('action-reannounce')).toHaveLength(1);
    expect(screen.queryByRole('group', { name: /Aksi tambahan/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Panggil Lagi')).not.toBeInTheDocument();

    await userEvent.click(btn);
    expect(api.reannounce).toHaveBeenCalledWith('t1');
  });

  it('disables a no-op self-loop rather than offering a button that changes nothing', async () => {
    // Every self-loop except WAITING → WAITING (category move) and
    // CALLING → CALLING (re-announce) is short-circuited by the aggregate: a 200
    // that changes nothing. Shown disabled, with its own reason.
    const workflow = workflowActions(
      edge('SERVING', 'SERVING', 'Lanjut Melayani', null, 'NO_STATUS_CHANGE'),
      edge('SERVING', 'COMPLETED', 'Selesai Layan', 'COMPLETE'),
    );
    const api = makeApi();
    render(<ActionControls api={api} bound={bound} active={ticket('SERVING')} workflow={workflow} />);
    const selfLoop = screen.getByTestId('action-unroutable-SERVING');
    expect(selfLoop).toHaveTextContent('Lanjut Melayani');
    expect(selfLoop).toBeDisabled();
    const describedBy = selfLoop.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)).toHaveTextContent(/tidak mengubah status tiket/i);
    // It was NOT routed to serve (the old target-keyed mapping's silent no-op).
    await userEvent.click(selfLoop);
    expect(api.serve).not.toHaveBeenCalled();
    expect(screen.getByTestId('action-complete')).not.toBeDisabled();
  });

  it('groups the flow buttons apart from the reannounce utility', () => {
    const api = makeApi();
    render(
      <ActionControls api={api} bound={bound} active={ticket('CALLING')} workflow={PRD_DEFAULT_WORKFLOW} />,
    );
    // The flow cluster holds exactly the outgoing edges of CALLING…
    const flow = screen.getByRole('group', { name: 'Aksi sesuai alur status' });
    expect(flow).toContainElement(screen.getByTestId('action-serve'));
    expect(flow).toContainElement(screen.getByTestId('action-skip'));
    // …and because this flow has no CALLING → CALLING self-loop, the built-in
    // "Panggil Lagi" fallback applies (the PRD §7 default, i.e. every existing
    // install). It changes no status, so it sits in its own utility group and
    // the flow cluster stays a picture of the graph.
    expect(flow).not.toContainElement(screen.getByTestId('action-reannounce'));
    const utilities = screen.getByRole('group', { name: /Aksi tambahan/ });
    expect(utilities).toContainElement(screen.getByTestId('action-reannounce'));
    expect(screen.getByTestId('action-reannounce')).toHaveTextContent('Panggil Lagi');
  });
});
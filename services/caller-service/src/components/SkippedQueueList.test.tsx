import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SkippedQueueList } from './SkippedQueueList';
import { ticketActionsFor } from '../lib/workflow-actions';
import type { TicketStateDto } from '../api/types';
import { PRD_DEFAULT_WORKFLOW, edge, workflowActions } from '../test/workflow-fixtures';

const tickets: readonly TicketStateDto[] = [
  { ticketId: 's1', ticketNumber: 'A-004', categoryId: 'cat-a', status: 'SKIPPED', counterId: 1 },
  { ticketId: 's2', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'SKIPPED', counterId: 1 },
];

describe('SkippedQueueList (FR-CLR-02 — a skipped ticket stays recallable)', () => {
  it('offers the flow\'s SKIPPED transitions on every row', async () => {
    const onAction = vi.fn();
    render(
      <SkippedQueueList
        tickets={tickets}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'SKIPPED')}
        onAction={onAction}
      />,
    );
    // Each row gets its own labelled cluster, like the waiting list.
    const row = screen.getByRole('group', { name: 'Aksi untuk tiket A-004' });
    expect(row).toHaveTextContent('Panggil Ulang');

    await userEvent.click(screen.getByTestId('skipped-action-s2-CALLING'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toMatchObject({ ticketId: 's2' });
    // No special case for recall: the row runs the edge the flow published.
    expect(onAction.mock.calls[0][1]).toMatchObject({ to: 'CALLING' });
  });

  it('renders whatever the flow says, not a hardcoded recall', async () => {
    const onAction = vi.fn();
    const configured = workflowActions(
      edge('SKIPPED', 'CALLING', 'Panggil Lagi Yang Absen'),
      edge('SKIPPED', 'BATAL', 'Batalkan Tiket'),
    );
    render(
      <SkippedQueueList
        tickets={tickets}
        actions={ticketActionsFor(configured, 'SKIPPED')}
        onAction={onAction}
      />,
    );
    const row = screen.getByRole('group', { name: 'Aksi untuk tiket A-004' });
    expect(row).toHaveTextContent('Panggil Lagi Yang Absen');
    expect(row).toHaveTextContent('Batalkan Tiket');
    await userEvent.click(screen.getByTestId('skipped-action-s1-BATAL'));
    expect(onAction.mock.calls[0][1]).toMatchObject({ to: 'BATAL' });
  });

  it('shows the empty state rather than disappearing', () => {
    render(
      <SkippedQueueList
        tickets={[]}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'SKIPPED')}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('Tidak ada tiket yang dilewati.')).toBeInTheDocument();
    expect(screen.getByText('0 tiket')).toBeInTheDocument();
  });

  it('disables every row while a command is in flight, marking the one running', () => {
    render(
      <SkippedQueueList
        tickets={tickets}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'SKIPPED')}
        pending="s1:SKIPPED->CALLING"
        onAction={vi.fn()}
      />,
    );
    const running = screen.getByTestId('skipped-action-s1-CALLING');
    const blocked = screen.getByTestId('skipped-action-s2-CALLING');
    expect(running).toBeDisabled();
    expect(running).toHaveTextContent('…');
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveTextContent('Panggil Ulang');
  });

  it('surfaces a failed command and the wait hint inline', () => {
    render(
      <SkippedQueueList
        tickets={tickets}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'SKIPPED')}
        error="transisi ilegal"
        notice="Tunggu perintah sebelumnya selesai."
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('transisi ilegal')).toBeInTheDocument();
    expect(screen.getByText('Tunggu perintah sebelumnya selesai.')).toBeInTheDocument();
  });

  it('degrades to the plain list when no handler is wired (flow unavailable)', () => {
    render(<SkippedQueueList tickets={tickets} />);
    expect(screen.getByText('A-004')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Aksi untuk tiket/ })).not.toBeInTheDocument();
  });
});

/**
 * Manager feedback: "Tidak bisa memanggil ulang yang sudah dilewati, emang
 * harusnya kayak gitu kan? kenapa ada descriptionnya yang kayak bisa manggil
 * ulang??" — the hint promised a recall unconditionally while the buttons come
 * from the flow, so a flow without a way out of "Dilewati" rendered bare numbers
 * under copy that said staff could call them again. The copy now follows the
 * same source of truth the buttons do.
 */
describe('SkippedQueueList hint follows the flow, never promises a missing action', () => {
  const hint = () => screen.getByTestId('skipped-hint');
  /** The tail of the recall wording. Whatever the flow calls the action, the
   *  sentence must not appear when no recall is on offer — that promise, made
   *  unconditionally, is what the manager read and could not act on. */
  const RECALL_PROMISE = 'kalau orangnya sudah datang.';

  function renderWith(
    actions: ReturnType<typeof ticketActionsFor>,
    workflowError: string | null = null,
  ) {
    render(
      <SkippedQueueList
        tickets={tickets}
        actions={actions}
        workflowError={workflowError}
        onAction={vi.fn()}
      />,
    );
  }

  it('says so plainly when the flow leads nowhere out of "Dilewati"', () => {
    // A flow the designer can really produce: a way INTO skipped, none back out.
    const oneWay = workflowActions(edge('CALLING', 'SKIPPED', 'Lewati / Absen'));
    renderWith(ticketActionsFor(oneWay, 'SKIPPED'));

    // Answers the manager's question — yes, it is meant to be like that here —
    // instead of the promise that provoked it.
    expect(hint()).toHaveTextContent(/tidak punya lanjutan dari status Dilewati/i);
    expect(hint()).toHaveTextContent(/belum bisa dipanggil ulang/i);
    expect(hint()).not.toHaveTextContent(RECALL_PROMISE);
    // Points at where it is configured, in the manager's own words.
    expect(hint()).toHaveTextContent(/Alur Status Tiket/);
    // A configuration fact, not an error — its own visual treatment.
    expect(hint()).toHaveClass('skipped-queue__hint--notice');
    // …and the rows really do have nothing to tap, which is what it describes.
    expect(screen.queryByRole('group', { name: /Aksi untuk tiket/ })).not.toBeInTheDocument();
  });

  it('blames the failed read, not the flow, when the actions could not be loaded', () => {
    // Same empty action list, different cause: telling staff to go and redraw
    // their flow because a fetch failed would send them to fix nothing.
    renderWith([], 'Daftar aksi gagal dimuat.');

    expect(hint()).toHaveTextContent(/belum bisa dibaca/i);
    expect(hint()).toHaveTextContent(/muat ulang halaman/i);
    expect(hint()).not.toHaveTextContent(/Alur Status Tiket/);
    expect(hint()).toHaveClass('skipped-queue__hint--notice');
  });

  it('keeps the recall wording when the flow does publish a recall', () => {
    renderWith(ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'SKIPPED'));

    expect(hint()).toHaveTextContent(
      'Tiket yang tidak hadir saat dipanggil. Tekan "Panggil Ulang" kalau orangnya sudah datang.',
    );
    expect(hint()).not.toHaveClass('skipped-queue__hint--notice');
  });

  it('points at the row buttons when the flow offers actions but no recall', () => {
    const noRecall = workflowActions(edge('SKIPPED', 'BATAL', 'Batalkan Tiket'));
    renderWith(ticketActionsFor(noRecall, 'SKIPPED'));

    expect(hint()).not.toHaveTextContent(RECALL_PROMISE);
    expect(hint()).toHaveTextContent(
      'Tiket yang tidak hadir saat dipanggil. Pilih tindakan yang tersedia di tombol tiap tiket.',
    );
    expect(hint()).not.toHaveClass('skipped-queue__hint--notice');
    expect(screen.getByTestId('skipped-action-s1-BATAL')).toBeEnabled();
  });

  it('does not point at the buttons when every configured action is unrunnable', () => {
    // A self-loop (supported by the designer): configured, visible, but it would
    // change nothing — "pilih tindakan yang tersedia" would be the same lie one
    // step further in.
    const selfLoop = workflowActions(
      edge('SKIPPED', 'SKIPPED', 'Tandai Ulang', 'NO_STATUS_CHANGE'),
    );
    renderWith(ticketActionsFor(selfLoop, 'SKIPPED'));

    expect(hint()).toHaveTextContent(/belum bisa dijalankan dari panel loket/i);
    expect(hint()).toHaveClass('skipped-queue__hint--notice');
    // The button stays visible (a configured edge never silently disappears) and
    // the hint sends staff to the reason printed under it.
    expect(screen.getByTestId('skipped-action-s1-SKIPPED')).toBeDisabled();
    expect(screen.getAllByText(/tidak mengubah status tiket/i)[0]).toBeInTheDocument();
  });

  it('never shows staff a raw status name', () => {
    const oneWay = workflowActions(edge('CALLING', 'SKIPPED', 'Lewati / Absen'));
    renderWith(ticketActionsFor(oneWay, 'SKIPPED'));
    expect(hint().textContent).not.toMatch(/SKIPPED|CALLING|WAITING/);
  });

  it("names the recall in the manager's own wording, not ours", () => {
    // The buttons carry the flow's `actionLabel`, so the sentence describing
    // them must too — hardcoding "Panggil Ulang" over a button that reads
    // "Panggil Lagi Yang Absen" is this very bug in miniature.
    const renamed = workflowActions(
      edge('SKIPPED', 'CALLING', 'Panggil Lagi Yang Absen'),
    );
    renderWith(ticketActionsFor(renamed, 'SKIPPED'));

    expect(hint()).toHaveTextContent('Panggil Lagi Yang Absen');
    // Our default wording must not survive the manager's rename.
    expect(hint()).not.toHaveTextContent('Panggil Ulang');
    expect(screen.getByTestId('skipped-action-s1-CALLING')).toHaveTextContent(
      'Panggil Lagi Yang Absen',
    );
  });
});
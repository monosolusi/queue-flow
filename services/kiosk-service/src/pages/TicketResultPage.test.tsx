import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TicketResultPage } from './TicketResultPage';
import type { IssuedTicket } from './CategorySelectPage';

function renderResult(state: IssuedTicket | null) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/tiket', state }]}>
      <Routes>
        <Route path="/" element={<div>Category Select</div>} />
        <Route path="/tiket" element={<TicketResultPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const issued: IssuedTicket = {
  ticket: {
    ticketId: 't-1',
    ticketNumber: 'A-001',
    categoryId: 'cat-a',
    status: 'WAITING',
    waitingAhead: 0,
  },
  categoryName: 'Customer Service',
};

describe('TicketResultPage (kiosk — FR-KSK-01 / QUE-17)', () => {
  it('shows the issued ticket number and category name', () => {
    renderResult(issued);
    expect(screen.getByText('A-001')).toBeInTheDocument();
    expect(screen.getByText('Customer Service')).toBeInTheDocument();
    expect(screen.getByText('Nomor Antrian Anda')).toBeInTheDocument();
  });

  it('renders the result label as a level-1 page heading (QUE-38 AC4)', () => {
    renderResult(issued);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Nomor Antrian Anda' }),
    ).toBeInTheDocument();
  });

  it('returns to the category screen when Selesai is tapped', async () => {
    renderResult(issued);
    await userEvent.click(screen.getByText('Selesai'));
    expect(await screen.findByText('Category Select')).toBeInTheDocument();
  });

  it('redirects to the category screen when reached with no ticket state', async () => {
    renderResult(null);
    expect(await screen.findByText('Category Select')).toBeInTheDocument();
  });

  it('does not render the Selesai button when there is no ticket', () => {
    renderResult(null);
    // The redirect is synchronous (<Navigate>), so the button never mounts.
    expect(screen.queryByText('Selesai')).not.toBeInTheDocument();
  });

  describe('auto-return to the attract screen (QUE-38 AC1)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-returns to the category screen after 10s', async () => {
      vi.useFakeTimers();
      renderResult(issued);
      expect(screen.getByText('Selesai')).toBeInTheDocument();

      // The auto-return fires at 10s; the navigate triggers a React 18 state
      // update from a fake-timer callback, so it needs an `act`-wrapped async
      // timer advance to flush the router re-render. After the act flush the
      // DOM is updated, so a sync `getByText` reads it (a `findByText` would
      // hang — its waitFor polling uses timers that fake-timers won't advance).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByText('Category Select')).toBeInTheDocument();
    });

    it('does not auto-return before the 10s timeout', async () => {
      vi.useFakeTimers();
      renderResult(issued);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000);
      });
      // Still on the result screen — the Selesai button is still present.
      expect(screen.getByText('Selesai')).toBeInTheDocument();
      expect(screen.queryByText('Category Select')).not.toBeInTheDocument();
    });

    it('clears the auto-return timer when Selesai is tapped (no late redirect)', async () => {
      vi.useFakeTimers();
      renderResult(issued);

      // fireEvent (not userEvent) — userEvent.click awaits internal pointer
      // timers that fake-timers do not auto-advance, which would hang.
      await act(async () => {
        fireEvent.click(screen.getByText('Selesai'));
      });
      expect(screen.getByText('Category Select')).toBeInTheDocument();

      // Advancing well past the timeout must not re-navigate (the timer was
      // cleared on unmount by the effect cleanup).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(screen.getByText('Category Select')).toBeInTheDocument();
    });
  });
});
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  ticket: { ticketId: 't-1', ticketNumber: 'A-001', categoryId: 'cat-a', status: 'WAITING' },
  categoryName: 'Customer Service',
};

describe('TicketResultPage (kiosk — FR-KSK-01 / QUE-17)', () => {
  it('shows the issued ticket number and category name', () => {
    renderResult(issued);
    expect(screen.getByText('A-001')).toBeInTheDocument();
    expect(screen.getByText('Customer Service')).toBeInTheDocument();
    expect(screen.getByText('Nomor Antrian Anda')).toBeInTheDocument();
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
});
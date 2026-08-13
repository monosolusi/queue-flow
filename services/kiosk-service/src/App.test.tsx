import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import type { IKioskApi } from './api/kiosk-api';
import type { CategoryDto, CreatedTicketDto, StoreProfileSlice } from './api/types';
import type { PrintPayload } from './print/print-provider';

const categories: CategoryDto[] = [
  { id: 'cat-a', code: 'A', name: 'Customer Service' },
];

function ticket(): CreatedTicketDto {
  return {
    ticketId: 't-1',
    ticketNumber: 'A-001',
    categoryId: 'cat-a',
    status: 'WAITING',
    waitingAhead: 0,
  };
}

/** Renders App inside a router so its nested `useNavigate` works. */
function renderApp(api: IKioskApi) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <App api={api} />
    </MemoryRouter>,
  );
}

/** A fake API capturing the print-proxy calls (proves the network provider was wired). */
function makeApi(profile: Partial<StoreProfileSlice> = {}): { api: IKioskApi; printTicket: ReturnType<typeof vi.fn> } {
  const printTicket = vi.fn(() => Promise.resolve());
  const fullProfile: StoreProfileSlice = {
    storeName: 'Toko Contoh',
    brandColor: '',
    themeMode: 'light',
    printerMode: 'chrome',
    printerPaperWidth: 80,
    printerCutMode: 'partial',
    printerBaudRate: 9600,
    ...profile,
  };
  const api: IKioskApi = {
    listCategories: () => Promise.resolve(categories),
    createTicket: () => Promise.resolve(ticket()),
    getStoreProfile: () => Promise.resolve(fullProfile),
    printTicket,
  };
  return { api, printTicket };
}

describe('App (config-driven print provider — FR-KSK-02)', () => {
  it('wires a network ESC/POS provider when the profile mode is network-escpos', async () => {
    const { api, printTicket } = makeApi({ printerMode: 'network-escpos' });
    renderApp(api);

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    // The network provider POSTs the ticket via the injected printTicket fn —
    // proving App built a NetworkEscPosPrintProvider from the loaded profile.
    // Print is fire-and-forget; the print fn is invoked synchronously after the
    // createTicket resolves (the result page renders on navigate).
    await vi.waitFor(() => expect(printTicket).toHaveBeenCalledTimes(1));
    const printed = printTicket.mock.calls[0][0] as PrintPayload;
    expect(printed.ticketNumber).toBe('A-001');
    expect(printed.categoryName).toBe('Customer Service');
  });

  it('does not call printTicket when the mode is chrome (browser provider wired)', async () => {
    const { api, printTicket } = makeApi({ printerMode: 'chrome' });
    renderApp(api);

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    // chrome mode wires BrowserPrintProvider, which never calls printTicket.
    expect(printTicket).not.toHaveBeenCalled();
  });

  it('wires a USB Serial provider when the mode is usb-serial (not the network proxy)', async () => {
    const { api, printTicket } = makeApi({ printerMode: 'usb-serial' });
    renderApp(api);

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    // usb-serial composes ESC/POS client-side and writes to the USB printer
    // directly over Web Serial — it does NOT POST to core-api's print proxy
    // (USB is kiosk-local; core-api cannot reach it). Proving printTicket was
    // NOT called rules out the network provider; in jsdom navigator.serial is
    // absent so the provider resolves non-fatal and the flow completes.
    expect(printTicket).not.toHaveBeenCalled();
  });

  it('an injected printProvider is authoritative (never overridden by config)', async () => {
    const { api, printTicket } = makeApi({ printerMode: 'network-escpos' });
    const injected = { print: vi.fn(() => Promise.resolve()) };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App api={api} printProvider={injected} />
      </MemoryRouter>,
    );

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    expect(injected.print).toHaveBeenCalledTimes(1);
    // The config-driven network provider was NOT built (no printTicket call).
    expect(printTicket).not.toHaveBeenCalled();
  });

  it('keeps the default chrome 80mm provider when the profile fetch fails', async () => {
    const printTicket = vi.fn(() => Promise.resolve());
    const api: IKioskApi = {
      listCategories: () => Promise.resolve(categories),
      createTicket: () => Promise.resolve(ticket()),
      getStoreProfile: () => Promise.reject(new Error('config down')),
      printTicket,
    };
    renderApp(api);

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    // Config failure → default BrowserPrintProvider (no printTicket proxy call).
    expect(printTicket).not.toHaveBeenCalled();
  });
});
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CategorySelectPage } from './CategorySelectPage';
import type { CategoryDto, CreatedTicketDto } from '../api/types';
import type { IKioskApi } from '../api/kiosk-api';
import type { IPrintProvider, PrintPayload } from '../print/print-provider';

const categories: CategoryDto[] = [
  { id: 'cat-a', code: 'A', name: 'Customer Service' },
  { id: 'cat-b', code: 'B', name: 'Kasir & Pembayaran' },
];

function ticket(id: string, number = 'A-001', waitingAhead = 0): CreatedTicketDto {
  return {
    ticketId: `ticket-${id}`,
    ticketNumber: number,
    categoryId: id,
    status: 'WAITING',
    waitingAhead,
  };
}

function makeApi(
  list: CategoryDto[] = categories,
  createImpl?: (id: string) => Promise<CreatedTicketDto>,
  storeName = 'Toko Contoh',
  brandColor = '',
): IKioskApi {
  return {
    listCategories: () => Promise.resolve(list),
    createTicket: createImpl ?? ((id: string) => Promise.resolve(ticket(id))),
    getStoreProfile: () => Promise.resolve({ storeName, brandColor }),
  };
}

/** Renders the select page inside a router so `useNavigate` works. */
function renderSelect(api: IKioskApi, printProvider?: IPrintProvider) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={<CategorySelectPage api={api} printProvider={printProvider} />}
        />
        <Route path="/tiket" element={<div>Ticket Result</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CategorySelectPage (kiosk — FR-KSK-01 / QUE-17)', () => {
  it('shows a loading state, then renders the large category buttons', async () => {
    renderSelect(makeApi());
    expect(screen.getByText('Memuat kategori…')).toBeInTheDocument();
    expect(await screen.findByText('Customer Service')).toBeInTheDocument();
    expect(screen.getByText('Kasir & Pembayaran')).toBeInTheDocument();
  });

  it('shows an empty state when no categories are configured', async () => {
    renderSelect(makeApi([]));
    expect(await screen.findByText(/Belum ada kategori/i)).toBeInTheDocument();
  });

  it('shows an error state when the API fails', async () => {
    renderSelect({
      listCategories: () => Promise.reject(new Error('jaringan terputus')),
      createTicket: () => Promise.resolve(ticket('cat-a')),
      getStoreProfile: () => Promise.resolve({ storeName: '', brandColor: '' }),
    });
    expect(await screen.findByText(/jaringan terputus/i)).toBeInTheDocument();
  });

  it('creates a ticket on tap and navigates to the result page', async () => {
    const createTicket = vi.fn((id: string) => Promise.resolve(ticket(id, 'B-001')));
    renderSelect(makeApi(categories, createTicket));

    await screen.findByText('Kasir & Pembayaran');
    await userEvent.click(screen.getByText('Kasir & Pembayaran'));

    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket).toHaveBeenCalledWith('cat-b');
    expect(await screen.findByText('Ticket Result')).toBeInTheDocument();
  });

  it('disables all buttons while a ticket is being issued (double-tap guard)', async () => {
    let resolveCreate: ((v: CreatedTicketDto) => void) | undefined;
    const createTicket = vi.fn(
      () => new Promise<CreatedTicketDto>((resolve) => (resolveCreate = resolve)),
    );
    renderSelect(makeApi(categories, createTicket));

    await screen.findByText('Customer Service');
    const firstButton = screen.getByText('Customer Service').closest('button')!;
    await userEvent.click(firstButton);
    expect(createTicket).toHaveBeenCalledTimes(1);

    // While the first request is pending, a second tap must not issue another.
    expect(firstButton).toBeDisabled();
    await userEvent.click(firstButton);
    expect(createTicket).toHaveBeenCalledTimes(1);

    // Releasing the request navigates away to the result page.
    resolveCreate!(ticket('cat-a'));
    expect(await screen.findByText('Ticket Result')).toBeInTheDocument();
  });

  it('shows an error and re-enables buttons when ticket creation fails', async () => {
    const createTicket = vi.fn(() => Promise.reject(new Error('gagal membuat tiket')));
    renderSelect(makeApi(categories, createTicket));

    await screen.findByText('Customer Service');
    const button = screen.getByText('Customer Service').closest('button')!;
    await userEvent.click(button);

    expect(await screen.findByText(/gagal membuat tiket/i)).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it('fires the thermal print within 1.5s of ticket creation (FR-KSK-02/03, NFR-PERF-03)', async () => {
    let createResolvedAt = 0;
    const createTicket = vi.fn(
      (id: string) =>
        new Promise<CreatedTicketDto>((resolve) => {
          // Resolve on a microtask so we can stamp the moment the POST resolves.
          Promise.resolve().then(() => {
            createResolvedAt = performance.now();
            resolve(ticket(id, 'A-001'));
          });
        }),
    );
    let printed: PrintPayload | undefined;
    let printCalledAt = 0;
    const printProvider: IPrintProvider = {
      print: vi.fn((p: PrintPayload) => {
        printed = p;
        printCalledAt = performance.now();
        return Promise.resolve();
      }),
    };

    renderSelect(makeApi(categories, createTicket), printProvider);

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    // Navigating to the result page only happens after the print has fired
    // (fire-and-forget, but synchronous in the post-resolve continuation).
    expect(await screen.findByText('Ticket Result')).toBeInTheDocument();
    expect(printProvider.print).toHaveBeenCalledTimes(1);
    expect(printed!.ticketNumber).toBe('A-001');
    expect(printed!.categoryName).toBe('Customer Service');
    // FR-KSK-03: the receipt carries the store name + queue position.
    expect(printed!.storeName).toBe('Toko Contoh');
    expect(printed!.waitingAhead).toBe(0);
    // NFR-PERF-03: physical print triggers within 1.5 s of the POST resolving.
    expect(printCalledAt - createResolvedAt).toBeLessThan(1500);
  });

  it('threads the store name and queue position into the print payload (FR-KSK-03)', async () => {
    const createTicket = vi.fn((id: string) => Promise.resolve(ticket(id, 'A-007', 6)));
    let printed: PrintPayload | undefined;
    const printProvider: IPrintProvider = {
      print: vi.fn((p: PrintPayload) => {
        printed = p;
        return Promise.resolve();
      }),
    };
    renderSelect(makeApi(categories, createTicket, 'Toko Utama Surabaya'), printProvider);

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    expect(await screen.findByText('Ticket Result')).toBeInTheDocument();
    expect(printProvider.print).toHaveBeenCalledTimes(1);
    expect(printed!.storeName).toBe('Toko Utama Surabaya');
    expect(printed!.waitingAhead).toBe(6);
    expect(printed!.ticketNumber).toBe('A-007');
  });

  it('applies the manager-configured brand color to the runtime --accent (QUE-37 AC6)', async () => {
    // The static `#2563eb` default is in place before the profile settles; the
    // manager-picked brandColor overrides `--accent` on the document root once
    // the store-profile fetch resolves.
    document.documentElement.style.setProperty('--accent', '#2563eb');
    renderSelect(makeApi(categories, undefined, 'Toko Contoh', '#abcdef'));

    await screen.findByText('Customer Service');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#abcdef');
  });

  it('keeps the static --accent default when the brand color is empty (no flash)', async () => {
    document.documentElement.style.setProperty('--accent', '#2563eb');
    renderSelect(makeApi(categories, undefined, 'Toko Contoh', ''));

    await screen.findByText('Customer Service');
    // Empty brandColor is ignored so the CSS default `#2563eb` stays.
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb');
  });

  it('omits the store name when the store-name fetch is empty (optional header)', async () => {
    const createTicket = vi.fn((id: string) => Promise.resolve(ticket(id, 'A-001')));
    let printed: PrintPayload | undefined;
    const printProvider: IPrintProvider = {
      print: vi.fn((p: PrintPayload) => {
        printed = p;
        return Promise.resolve();
      }),
    };
    renderSelect(makeApi(categories, createTicket, ''), printProvider);

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    expect(await screen.findByText('Ticket Result')).toBeInTheDocument();
    // An empty store name yields an undefined `storeName` in the payload — the
    // receipt omits the header line (it is optional in PrintPayload).
    expect(printed!.storeName).toBeUndefined();
  });

  it('waits for the store-name fetch before enabling a tap (no race on the receipt)', async () => {
    // Store name resolves *after* categories; the category buttons stay
    // loading until both settle so a fast tap can never print a headerless
    // receipt. Categories resolve immediately, the store name on a later tick.
    let resolveName: ((v: { storeName: string; brandColor: string }) => void) | undefined;
    const api: IKioskApi = {
      listCategories: () => Promise.resolve(categories),
      createTicket: (id: string) => Promise.resolve(ticket(id, 'A-001')),
      getStoreProfile: () =>
        new Promise<{ storeName: string; brandColor: string }>((resolve) => {
          resolveName = resolve;
        }),
    };
    let printed: PrintPayload | undefined;
    const printProvider: IPrintProvider = {
      print: vi.fn((p: PrintPayload) => {
        printed = p;
        return Promise.resolve();
      }),
    };
    renderSelect(api, printProvider);

    // Categories are ready, but the buttons are NOT interactive yet because
    // the store-name fetch is still pending — the loading hint persists.
    expect(await screen.findByText('Memuat kategori…')).toBeInTheDocument();

    // Releasing the store-profile fetch lets the load state flip to `loaded`.
    resolveName!({ storeName: 'Toko Lambat', brandColor: '' });
    expect(await screen.findByText('Customer Service')).toBeInTheDocument();

    await userEvent.click(screen.getByText('Customer Service'));
    expect(await screen.findByText('Ticket Result')).toBeInTheDocument();
    expect(printed!.storeName).toBe('Toko Lambat');
  });

  it('still navigates when the print provider rejects (print failure is non-fatal)', async () => {
    const createTicket = vi.fn((id: string) => Promise.resolve(ticket(id, 'A-001')));
    const printProvider: IPrintProvider = {
      print: vi.fn(() => Promise.reject(new Error('printer offline'))),
    };

    renderSelect(makeApi(categories, createTicket), printProvider);

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    expect(await screen.findByText('Ticket Result')).toBeInTheDocument();
    expect(printProvider.print).toHaveBeenCalledTimes(1);
  });

  it('does not print when no print provider is wired (printing optional)', async () => {
    const createTicket = vi.fn((id: string) => Promise.resolve(ticket(id, 'A-001')));
    // No printProvider passed — existing flows without a printer are unbroken.
    renderSelect(makeApi(categories, createTicket));

    await screen.findByText('Customer Service');
    await userEvent.click(screen.getByText('Customer Service'));

    expect(await screen.findByText('Ticket Result')).toBeInTheDocument();
  });
});
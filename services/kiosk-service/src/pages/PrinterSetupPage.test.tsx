import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PrinterSetupPage } from './PrinterSetupPage';

/** The shape PrinterSetupPage reads off `navigator.serial`. */
interface PortInfo {
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}
interface FakeSerial {
  getPorts(): Promise<PortInfo[]>;
  requestPort(): Promise<PortInfo>;
}

function makePort(vendor = 0x04b8, product = 0x0202): PortInfo {
  return { getInfo: () => ({ usbVendorId: vendor, usbProductId: product }) };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/sambung-printer']}>
      <PrinterSetupPage />
    </MemoryRouter>,
  );
}

describe('PrinterSetupPage (USB pairing overlay)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the unsupported message when Web Serial is unavailable', async () => {
    // navigator.serial absent (jsdom default) → unsupported message, no button.
    renderPage();
    expect(await screen.findByText(/tidak mendukung Web Serial/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sambungkan Printer USB/ })).toBeNull();
  });

  it('shows the pair button + zero paired ports when Web Serial is available', async () => {
    const serial: FakeSerial = {
      getPorts: vi.fn(async () => []),
      requestPort: vi.fn(),
    };
    vi.stubGlobal('navigator', { ...navigator, serial });

    renderPage();
    const button = await screen.findByRole('button', { name: /Sambungkan Printer USB/ });
    expect(button).not.toBeDisabled();
    expect(await screen.findByText(/Belum ada printer USB/)).toBeInTheDocument();
    expect(screen.getByText(/Printer aktif: 0/)).toBeInTheDocument();
  });

  it('calls requestPort on click and reports the granted port', async () => {
    const port = makePort();
    const serial: FakeSerial = {
      getPorts: vi.fn(async () => [port]),
      requestPort: vi.fn(async () => port),
    };
    vi.stubGlobal('navigator', { ...navigator, serial });

    renderPage();
    const button = await screen.findByRole('button', { name: /Sambungkan Printer USB/ });
    await userEvent.click(button);

    // requestPort was invoked under the user gesture.
    expect(serial.requestPort).toHaveBeenCalledTimes(1);
    // The success message + the granted port info render.
    expect(await screen.findByText(/Printer USB berhasil disambungkan/)).toBeInTheDocument();
    expect(screen.getByText(/Printer aktif: 1/)).toBeInTheDocument();
    expect(screen.getByText(/vendor 0x04b8/)).toBeInTheDocument();
  });

  it('reports a cancelled pairing as a non-blocking status (no throw)', async () => {
    const serial: FakeSerial = {
      getPorts: vi.fn(async () => []),
      requestPort: vi.fn(async () => {
        throw new Error('cancelled');
      }),
    };
    vi.stubGlobal('navigator', { ...navigator, serial });

    renderPage();
    const button = await screen.findByRole('button', { name: /Sambungkan Printer USB/ });
    await userEvent.click(button);

    expect(await screen.findByText(/Gagal menyambungkan/)).toBeInTheDocument();
    // The button is re-enabled (not stuck busy).
    expect(screen.getByRole('button', { name: /Sambungkan Printer USB/ })).not.toBeDisabled();
  });

  it('has a back-to-kiosk link', async () => {
    const serial: FakeSerial = {
      getPorts: vi.fn(async () => []),
      requestPort: vi.fn(),
    };
    vi.stubGlobal('navigator', { ...navigator, serial });

    renderPage();
    expect(await screen.findByRole('button', { name: /Kembali ke Kiosk/ })).toBeInTheDocument();
  });
});
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AktivasiPage } from './AktivasiPage';
import { LicenseRejectedError, type ILicenseApi } from '../api/admin-api';
import type { LicenseStatusDto } from '../api/types';
import { SystemConfigProvider } from '../config/system-config-context';
import { ToastProvider } from '../toast/toast-context';

const INSTALLATION_ID = '11111111-2222-4333-8444-555555555555';

/**
 * Builds a key with a correct check symbol, independently of the module under
 * test — a fixture produced by calling the implementation could not detect a
 * broken implementation.
 */
function mintKey(payload = 'M4RS7QRSTVWXYZ0123A'): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) sum += alphabet.indexOf(payload[i]) * (2 * i + 1);
  const full = payload + alphabet[sum % 32];
  return `${full.slice(0, 5)}-${full.slice(5, 10)}-${full.slice(10, 15)}-${full.slice(15)}`;
}

const KEY = mintKey();
const MISTYPED = KEY.slice(0, -1) + (KEY.endsWith('0') ? '1' : '0');

function statusOf(overrides: Partial<LicenseStatusDto> = {}): LicenseStatusDto {
  return {
    state: 'RESTRICTED',
    issue: 'ABSENT',
    detail: 'No license is installed.',
    expiresAt: null,
    graceEndsAt: null,
    restrictsNewTickets: true,
    installationId: INSTALLATION_ID,
    type: null,
    customerName: null,
    supportUntil: null,
    daysUntilExpiry: null,
    supportActive: false,
    versionCovered: false,
    entitlements: { maxCounters: 1, maxCategories: 1, features: [] },
    host: null,
    ...overrides,
  };
}

function makeApi(overrides: Partial<ILicenseApi> = {}): ILicenseApi {
  return {
    getLicense: vi.fn(() => Promise.resolve(statusOf())),
    activateWithKey: vi.fn(() => Promise.resolve(statusOf({ state: 'VALID', issue: 'NONE' }))),
    getLicenseHistory: vi.fn(() => Promise.resolve([])),
    ...overrides,
  };
}

function renderPage(api: ILicenseApi) {
  return render(
    <SystemConfigProvider api={{ getSystemConfig: vi.fn(() => Promise.reject(new Error('n/a'))) }}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/aktivasi']}>
          <Routes>
            <Route path="/aktivasi" element={<AktivasiPage api={api} />} />
            <Route path="/" element={<p>dashboard</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </SystemConfigProvider>,
  );
}

async function typeKey(value: string) {
  fireEvent.change(await screen.findByLabelText('Kunci Aktivasi'), { target: { value } });
}

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
});

describe('AktivasiPage', () => {
  it('warns that internet is needed BEFORE anyone tries, not after a timeout', async () => {
    // The single most important line on the page. A technician in a basement
    // unit needs to know to go and tether a phone while they are still holding
    // it — not after a fifteen-second failure they have to interpret.
    renderPage(makeApi());
    expect(await screen.findByText(/memerlukan koneksi internet/i)).toBeInTheDocument();
    expect(screen.getByText(/sepenuhnya tanpa internet/i)).toBeInTheDocument();
  });

  it('explains what to do, in Indonesian, without leaking the English diagnostic', async () => {
    // `detail` is a support string aimed at whoever installed the system.
    // Showing it to a shop manager is the friendly-label rule being broken.
    renderPage(makeApi());
    expect(await screen.findByText(/belum diaktivasi/i)).toBeInTheDocument();
    expect(screen.queryByText('No license is installed.')).not.toBeInTheDocument();
  });

  it('activates with a typed key and lands on the dashboard', async () => {
    const api = makeApi();
    renderPage(api);

    await typeKey(KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));

    await waitFor(() => expect(api.activateWithKey).toHaveBeenCalledWith(KEY));
    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });

  it('reformats as you type, so a pasted key in any shape becomes the one form', async () => {
    // Lower case from an email, no hyphens, stray spaces, and the O/0 and I/1
    // look-alikes a person produces when reading a key down a phone.
    const api = makeApi();
    renderPage(api);

    const spoken = KEY.replace(/-/g, '').toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l');
    await typeKey(`  ${spoken}  `);

    expect(await screen.findByLabelText('Kunci Aktivasi')).toHaveValue(KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));
    await waitFor(() => expect(api.activateWithKey).toHaveBeenCalledWith(KEY));
  });

  it('rejects a mistyped key locally, without calling the server', async () => {
    // Saves a round trip on a connection that may be a tethered phone, and
    // keeps a slipped finger from reaching the activation server as a failed
    // redemption against a key that was correct.
    const api = makeApi();
    renderPage(api);

    await typeKey(MISTYPED);
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));

    // Queried by text, not by role: ToastProvider's viewport is also an alert
    // region, so `getByRole('alert')` is ambiguous on this page.
    expect(await screen.findByText(/salah ketik/i)).toBeInTheDocument();
    expect(api.activateWithKey).not.toHaveBeenCalled();
  });

  it.each([
    ['OFFLINE' as const, /Tidak ada koneksi internet/i],
    ['TIMEOUT' as const, /tidak menjawab tepat waktu/i],
    ['KEY_UNKNOWN' as const, /tidak dikenali/i],
    ['KEY_ALREADY_USED' as const, /sudah dipakai di perangkat lain/i],
    ['KEY_REVOKED' as const, /sudah dinonaktifkan/i],
    ['KEY_EXPIRED' as const, /Masa pakai.*sudah lewat/i],
    ['SERVER_ERROR' as const, /sedang bermasalah/i],
    ['UNTRUSTED' as const, /tidak diterbitkan oleh penyedia sistem ini/i],
    ['WRONG_INSTALLATION' as const, /untuk perangkat lain/i],
    ['WRONG_PRODUCT' as const, /untuk produk lain/i],
  ])('renders the remediation specific to a %s rejection', async (reason, expected) => {
    // Ten refusals with different fixes. A single generic "aktivasi gagal"
    // would send a technician hunting a dead network when the real answer is
    // "that key is running another branch" — this is the whole reason the
    // server sends a code instead of a sentence.
    const api = makeApi({
      activateWithKey: vi.fn(() => Promise.reject(new LicenseRejectedError(reason, 'nope'))),
    });
    renderPage(api);

    await typeKey(KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('tells someone with no internet what to physically go and do', async () => {
    // The most likely failure of the whole feature. "Aktivasi gagal" would be
    // useless here; the copy has to name the action.
    const api = makeApi({
      activateWithKey: vi.fn(() => Promise.reject(new LicenseRejectedError('OFFLINE', 'no route'))),
    });
    renderPage(api);

    await typeKey(KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));

    expect(await screen.findByText(/hotspot HP|kabel LAN/i)).toBeInTheDocument();
  });

  it('falls back to a generic message when the call fails in no known way', async () => {
    const api = makeApi({ activateWithKey: vi.fn(() => Promise.reject(new Error('network'))) });
    renderPage(api);

    await typeKey(KEY);
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));

    expect(await screen.findByText(/Aktivasi gagal.*Pastikan server aktif/i)).toBeInTheDocument();
  });

  it('keeps Aktifkan disabled until a whole key has been entered', async () => {
    renderPage(makeApi());
    expect(await screen.findByRole('button', { name: 'Aktifkan' })).toBeDisabled();

    await typeKey(KEY.slice(0, 10));
    expect(screen.getByRole('button', { name: 'Aktifkan' })).toBeDisabled();

    await typeKey(KEY);
    expect(screen.getByRole('button', { name: 'Aktifkan' })).toBeEnabled();
  });

  it('still enables Aktifkan for a complete-but-mistyped key', async () => {
    // So the manager gets the specific reason on submit, rather than a button
    // that silently refuses and explains nothing.
    renderPage(makeApi());
    await typeKey(MISTYPED);
    expect(screen.getByRole('button', { name: 'Aktifkan' })).toBeEnabled();
  });

  it('shows the device id for support calls, and copies it', async () => {
    renderPage(makeApi());
    expect(await screen.findByText(INSTALLATION_ID)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Salin' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(INSTALLATION_ID));
    expect(await screen.findByRole('button', { name: 'Tersalin ✓' })).toBeInTheDocument();
  });

  it('surfaces an outage rather than an empty form when status cannot be loaded', async () => {
    const api = makeApi({ getLicense: vi.fn(() => Promise.reject(new Error('core-api down'))) });
    renderPage(api);

    expect(await screen.findByText(/Tidak dapat memuat data aktivasi/i)).toBeInTheDocument();
  });
});

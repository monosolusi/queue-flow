import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AktivasiPage } from './AktivasiPage';
import { LicenseRejectedError, type ILicenseApi } from '../api/admin-api';
import type { LicenseStatusDto } from '../api/types';
import { SystemConfigProvider } from '../config/system-config-context';
import { ToastProvider } from '../toast/toast-context';

const INSTALLATION_ID = '11111111-2222-4333-8444-555555555555';
const BLOB = `QMSREQ1-${'e'.repeat(200)}`;
const VALID_TOKEN = [
  '-----BEGIN QMS LICENSE-----',
  'aGVhZGVy.cGF5bG9hZA.c2ln',
  '-----END QMS LICENSE-----',
].join('\n');

function statusOf(overrides: Partial<LicenseStatusDto> = {}): LicenseStatusDto {
  return {
    state: 'RESTRICTED',
    issue: 'ABSENT',
    detail: 'No license is installed.',
    expiresAt: null,
    graceEndsAt: null,
    restrictsNewTickets: true,
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
    getActivationRequest: vi.fn(() =>
      Promise.resolve({ installationId: INSTALLATION_ID, claims: {}, majorVersion: 1, blob: BLOB }),
    ),
    activateLicense: vi.fn(() => Promise.resolve(statusOf({ state: 'VALID', issue: 'NONE' }))),
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

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
});

describe('AktivasiPage', () => {
  it('shows the activation request as one copyable string', async () => {
    renderPage(makeApi());
    const blob = await screen.findByLabelText('Kode Permintaan Aktivasi');
    expect(blob).toHaveValue(BLOB);
  });

  it('explains what to do, in Indonesian, without leaking the English diagnostic', async () => {
    // `detail` is a support string aimed at whoever installed the system.
    // Showing it to a shop manager is the friendly-label rule being broken.
    renderPage(makeApi());
    expect(await screen.findByText(/belum diaktivasi/i)).toBeInTheDocument();
    expect(screen.queryByText('No license is installed.')).not.toBeInTheDocument();
  });

  it('copies the request to the clipboard and confirms in place', async () => {
    renderPage(makeApi());
    fireEvent.click(await screen.findByRole('button', { name: 'Salin Kode' }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(BLOB));
    expect(await screen.findByRole('button', { name: 'Tersalin ✓' })).toBeInTheDocument();
  });

  it('activates a pasted license and lands on the dashboard', async () => {
    const api = makeApi();
    renderPage(api);

    fireEvent.change(await screen.findByLabelText(/tempel isi lisensinya/i), {
      target: { value: VALID_TOKEN },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));

    await waitFor(() => expect(api.activateLicense).toHaveBeenCalledWith(VALID_TOKEN));
    expect(await screen.findByText('dashboard')).toBeInTheDocument();
  });

  it('rejects an obvious non-license locally, without calling the server', async () => {
    // Saves a round trip, and keeps an accidental empty paste out of the audit
    // log — repeated server-side rejections are supposed to mean tampering.
    const api = makeApi();
    renderPage(api);

    fireEvent.change(await screen.findByLabelText(/tempel isi lisensinya/i), {
      target: { value: 'foto struk.jpg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));

    // Queried by text, not by role: ToastProvider's viewport is also an alert
    // region, so `getByRole('alert')` is ambiguous on this page.
    expect(await screen.findByText(/bukan file lisensi yang valid/i)).toBeInTheDocument();
    expect(api.activateLicense).not.toHaveBeenCalled();
  });

  it.each([
    ['WRONG_INSTALLATION' as const, /untuk perangkat lain/i],
    ['UNTRUSTED' as const, /tidak diterbitkan oleh penyedia sistem/i],
    ['WRONG_PRODUCT' as const, /untuk produk lain/i],
  ])('renders the remediation specific to a %s rejection', async (reason, expected) => {
    // Three refusals with three different fixes — a single generic "invalid
    // license" message would send the manager down the wrong path.
    const api = makeApi({
      activateLicense: vi.fn(() => Promise.reject(new LicenseRejectedError(reason, 'nope'))),
    });
    renderPage(api);

    fireEvent.change(await screen.findByLabelText(/tempel isi lisensinya/i), {
      target: { value: VALID_TOKEN },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('falls back to a generic message when the server is simply unreachable', async () => {
    const api = makeApi({ activateLicense: vi.fn(() => Promise.reject(new Error('network'))) });
    renderPage(api);

    fireEvent.change(await screen.findByLabelText(/tempel isi lisensinya/i), {
      target: { value: VALID_TOKEN },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan' }));

    expect(await screen.findByText(/Aktivasi gagal.*Pastikan server aktif/i)).toBeInTheDocument();
  });

  it('keeps Aktifkan disabled until something has been entered', async () => {
    renderPage(makeApi());
    expect(await screen.findByRole('button', { name: 'Aktifkan' })).toBeDisabled();
  });

  it('surfaces an outage rather than an empty form when the request cannot be loaded', async () => {
    const api = makeApi({
      getActivationRequest: vi.fn(() => Promise.reject(new Error('core-api down'))),
    });
    renderPage(api);

    expect(await screen.findByText(/Tidak dapat memuat data aktivasi/i)).toBeInTheDocument();
  });
});

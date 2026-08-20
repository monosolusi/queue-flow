import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LicenseGuard } from './LicenseGuard';
import { SystemConfigProvider } from '../config/system-config-context';
import type { ISystemConfigApi } from '../api/admin-api';
import type { LicenseStateName, LicenseSummaryDto, SystemConfigurationDto } from '../api/types';
import {
  DEFAULT_PRINTER_CONFIGURATION,
  DEFAULT_SERVICE_THEMES,
  DEFAULT_TTS_CONFIGURATION,
  DEFAULT_TV_GRID_LAYOUT,
} from '../api/types';

function storeWith(license: LicenseSummaryDto | null | undefined): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: true,
    license,
    storeName: 'Apotek Sehat',
    stateMachine: { states: [], transitions: [], descriptions: {} },
    dailyResetPolicy: {
      mode: 'MANUAL',
      cronExpression: null,
      resetTicketNumberTo: 1,
      archivePreviousDayData: true,
      timezone: 'Asia/Jakarta',
    },
    categories: [],
    routingRules: [],
    brandColor: '#2563eb',
    serviceThemes: { ...DEFAULT_SERVICE_THEMES },
    tvPanelLayout: DEFAULT_TV_GRID_LAYOUT,
    edgeRoutingLayout: {},
    nodePositions: {},
    nodeActions: {},
    endSources: [],
    startSources: [],
    terminalNodes: { start: 'auto', end: 'auto' } as const,
    printerConfiguration: { ...DEFAULT_PRINTER_CONFIGURATION },
    ttsConfiguration: { ...DEFAULT_TTS_CONFIGURATION },
  };
}

const license = (state: LicenseStateName): LicenseSummaryDto => ({
  state,
  issue: 'NONE',
  detail: '',
  expiresAt: null,
  graceEndsAt: null,
  restrictsNewTickets: state === 'RESTRICTED',
});

/** Same ISP-narrow fake the SetupGuard suite uses: one method, not eleven. */
function makeApi(config: SystemConfigurationDto): ISystemConfigApi {
  return { getSystemConfig: vi.fn(() => Promise.resolve(config)) };
}

function renderGuard(api: ISystemConfigApi) {
  return render(
    <SystemConfigProvider api={api}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <LicenseGuard>
                <p>halaman operasional</p>
              </LicenseGuard>
            }
          />
          <Route path="/aktivasi" element={<p>halaman aktivasi</p>} />
        </Routes>
      </MemoryRouter>
    </SystemConfigProvider>,
  );
}

describe('LicenseGuard', () => {
  it('renders the page on a valid license', async () => {
    renderGuard(makeApi(storeWith(license('VALID'))));
    expect(await screen.findByText('halaman operasional')).toBeInTheDocument();
  });

  it('redirects to the activation page when restricted', async () => {
    renderGuard(makeApi(storeWith(license('RESTRICTED'))));
    expect(await screen.findByText('halaman aktivasi')).toBeInTheDocument();
  });

  it.each<LicenseStateName>(['EXPIRING_SOON', 'GRACE', 'MISMATCH_GRACE'])(
    'keeps the store fully usable in %s',
    async (state) => {
      // The point of a graded ladder: only RESTRICTED withholds anything. If
      // one of these ever redirects, a paying store loses its admin panel over
      // a warning.
      renderGuard(makeApi(storeWith(license(state))));
      expect(await screen.findByText('halaman operasional')).toBeInTheDocument();
    },
  );

  it('renders the page when the license slice is null (core-api still booting)', async () => {
    // "Unknown" must never read as "unlicensed" — blocking here would take a
    // working store offline while its backend was merely starting up.
    renderGuard(makeApi(storeWith(null)));
    expect(await screen.findByText('halaman operasional')).toBeInTheDocument();
  });

  it('renders the page when the license slice is absent entirely', async () => {
    // A core-api predating this feature omits the field. Same rule.
    renderGuard(makeApi(storeWith(undefined)));
    expect(await screen.findByText('halaman operasional')).toBeInTheDocument();
  });

  it('shows the loading state while the config is still resolving', () => {
    // A promise that never settles is the honest model of "still in flight".
    renderGuard({ getSystemConfig: vi.fn(() => new Promise<SystemConfigurationDto>(() => {})) });
    expect(screen.getByText('Memuat konfigurasi sistem…')).toBeInTheDocument();
  });

  it('surfaces an outage instead of redirecting when the config fetch fails', async () => {
    // A failed fetch says nothing about the license. Redirecting to /aktivasi
    // would tell a licensed store it is unlicensed because the network blipped.
    renderGuard({ getSystemConfig: vi.fn(() => Promise.reject(new Error('core-api down'))) });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Tidak dapat memuat konfigurasi sistem'),
    );
    expect(screen.queryByText('halaman aktivasi')).not.toBeInTheDocument();
  });
});

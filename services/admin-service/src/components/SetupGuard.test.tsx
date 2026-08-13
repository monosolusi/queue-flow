import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SetupGuard } from './SetupGuard';
import { SystemConfigProvider } from '../config/system-config-context';
import type { ISystemConfigApi } from '../api/admin-api';
import type { SystemConfigurationDto } from '../api/types';
import { DEFAULT_PRINTER_CONFIGURATION, DEFAULT_SERVICE_THEMES, DEFAULT_TV_GRID_LAYOUT } from '../api/types';

function cleanStore(): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: false,
    storeName: '',
    stateMachine: { states: [], transitions: [] },
    dailyResetPolicy: { mode: 'MANUAL', cronExpression: null, resetTicketNumberTo: 1, archivePreviousDayData: true, timezone: 'Asia/Jakarta' },
    categories: [],
    routingRules: [],
    brandColor: '#2563eb',
    serviceThemes: { ...DEFAULT_SERVICE_THEMES },
    tvPanelLayout: DEFAULT_TV_GRID_LAYOUT,
    edgeRoutingLayout: {},
    nodePositions: {}, nodeActions: {},
    printerConfiguration: { ...DEFAULT_PRINTER_CONFIGURATION },
  };
}

function configuredStore(): SystemConfigurationDto {
  return { ...cleanStore(), isInitialSetupCompleted: true, storeName: 'Apotek Sehat' };
}

/**
 * The guard no longer fetches — it reads the shared `SystemConfigProvider`
 * snapshot — so its dependency is the one-method config read slice (ISP). The
 * fake is a single function, not the 11-method `IAdminApi` every guard test used
 * to have to construct.
 */
function makeApi(config: SystemConfigurationDto): ISystemConfigApi {
  return { getSystemConfig: vi.fn(() => Promise.resolve(config)) };
}

function rejectingApi(): ISystemConfigApi {
  return { getSystemConfig: vi.fn(() => Promise.reject(new Error('core-api down'))) };
}

/** Renders the guard inside a router + provider so `<Navigate to="/wizard">` resolves. */
function renderGuard(api: ISystemConfigApi) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SystemConfigProvider api={api}>
        <Routes>
          <Route
            path="/"
            element={
              <SetupGuard>
                <div>Admin Panel Content</div>
              </SetupGuard>
            }
          />
          <Route path="/wizard" element={<div>Wizard Page</div>} />
        </Routes>
      </SystemConfigProvider>
    </MemoryRouter>,
  );
}

describe('SetupGuard (FR-WZD-01)', () => {
  it('redirects to /wizard when the store is not yet configured', async () => {
    renderGuard(makeApi(cleanStore()));
    // A clean browser is redirected to the wizard (FR-WZD-01).
    expect(await screen.findByText('Wizard Page')).toBeInTheDocument();
    expect(screen.queryByText('Admin Panel Content')).not.toBeInTheDocument();
  });

  it('renders children when setup is complete', async () => {
    renderGuard(makeApi(configuredStore()));
    expect(await screen.findByText('Admin Panel Content')).toBeInTheDocument();
    expect(screen.queryByText('Wizard Page')).not.toBeInTheDocument();
  });

  it('shows an error state (not a redirect) when the config read fails', async () => {
    renderGuard(rejectingApi());
    // A fetch failure is a real outage (the read returns a default DTO on a
    // clean store, never throws), so the guard surfaces an error state with a
    // retry button — NOT a redirect to /wizard (which would loop with
    // WizardGuard post-setup). See the SetupGuard docstring.
    expect(await screen.findByText(/Tidak dapat memuat konfigurasi sistem/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Coba Lagi' })).toBeInTheDocument();
    expect(screen.queryByText('Wizard Page')).not.toBeInTheDocument();
    expect(screen.queryByText('Admin Panel Content')).not.toBeInTheDocument();
  });

  it('re-runs the fetch when the Coba Lagi button is clicked', async () => {
    let calls = 0;
    const api: ISystemConfigApi = {
      getSystemConfig: vi.fn(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('core-api down'))
          : Promise.resolve(configuredStore());
      }),
    };
    renderGuard(api);
    expect(await screen.findByText(/Tidak dapat memuat konfigurasi sistem/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Coba Lagi' }));
    // The retry resolves the configured store → children render.
    expect(await screen.findByText('Admin Panel Content')).toBeInTheDocument();
  });

  it('does not multiply config probes when nested (one shared snapshot)', async () => {
    // Every operational route wraps this guard, so a per-guard fetch would fire
    // `GET /api/system/config` once per guarded render. Reading the shared
    // provider snapshot keeps it at exactly one probe per page load — the same
    // property RequireAuth documents for `/me`.
    const api = makeApi(configuredStore());
    render(
      <MemoryRouter initialEntries={['/']}>
        <SystemConfigProvider api={api}>
          <Routes>
            <Route
              path="/"
              element={
                <SetupGuard>
                  <SetupGuard>
                    <div>Admin Panel Content</div>
                  </SetupGuard>
                </SetupGuard>
              }
            />
          </Routes>
        </SystemConfigProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Admin Panel Content')).toBeInTheDocument();
    expect(api.getSystemConfig).toHaveBeenCalledTimes(1);
  });
});

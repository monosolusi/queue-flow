import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WizardGuard } from './WizardGuard';
import { SystemConfigProvider } from '../config/system-config-context';
import type { ISystemConfigApi } from '../api/admin-api';
import type { SystemConfigurationDto } from '../api/types';
import { DEFAULT_SERVICE_THEMES, DEFAULT_TV_GRID_LAYOUT } from '../api/types';

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
    nodePositions: {},
  };
}

function configuredStore(): SystemConfigurationDto {
  return { ...cleanStore(), isInitialSetupCompleted: true, storeName: 'Apotek Sehat' };
}

/** The guard reads the shared snapshot, so its dependency is the one-method
 *  config read slice (ISP) — see the SetupGuard spec's note. */
function makeApi(config: SystemConfigurationDto): ISystemConfigApi {
  return { getSystemConfig: vi.fn(() => Promise.resolve(config)) };
}

/** Renders the guard at /wizard with a / route so `<Navigate to="/">` resolves. */
function renderGuard(api: ISystemConfigApi) {
  return render(
    <MemoryRouter initialEntries={['/wizard']}>
      <SystemConfigProvider api={api}>
        <Routes>
          <Route path="/" element={<div>Home Page</div>} />
          <Route
            path="/wizard"
            element={
              <WizardGuard>
                <div>Wizard Page</div>
              </WizardGuard>
            }
          />
        </Routes>
      </SystemConfigProvider>
    </MemoryRouter>,
  );
}

describe('WizardGuard (FR-WZD-01 — wizard first-run only)', () => {
  it('renders wizard children when setup is incomplete (first-run path)', async () => {
    renderGuard(makeApi(cleanStore()));
    expect(await screen.findByText('Wizard Page')).toBeInTheDocument();
    expect(screen.queryByText('Home Page')).not.toBeInTheDocument();
  });

  it('redirects to / when setup is complete (wizard blocked post-setup)', async () => {
    renderGuard(makeApi(configuredStore()));
    // A configured store → the wizard is closed; the guard bounces to /.
    expect(await screen.findByText('Home Page')).toBeInTheDocument();
    expect(screen.queryByText('Wizard Page')).not.toBeInTheDocument();
  });

  it('shows an error state (not a redirect) when the config read fails', async () => {
    const api: ISystemConfigApi = {
      getSystemConfig: vi.fn(() => Promise.reject(new Error('core-api down'))),
    };
    renderGuard(api);
    // A fetch failure is a real outage — do NOT redirect (avoids a redirect
    // loop with SetupGuard, which also errors on fetch failure). The wizard
    // only renders when setup is CONFIRMED incomplete.
    expect(await screen.findByText(/Tidak dapat memuat konfigurasi sistem/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Coba Lagi' })).toBeInTheDocument();
    expect(screen.queryByText('Wizard Page')).not.toBeInTheDocument();
    expect(screen.queryByText('Home Page')).not.toBeInTheDocument();
  });

  it('re-runs the fetch when the Coba Lagi button is clicked', async () => {
    let calls = 0;
    const api: ISystemConfigApi = {
      getSystemConfig: vi.fn(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('core-api down'))
          : Promise.resolve(cleanStore());
      }),
    };
    renderGuard(api);
    expect(await screen.findByText(/Tidak dapat memuat konfigurasi sistem/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Coba Lagi' }));
    // The retry resolves the clean store → wizard children render.
    expect(await screen.findByText('Wizard Page')).toBeInTheDocument();
  });
});

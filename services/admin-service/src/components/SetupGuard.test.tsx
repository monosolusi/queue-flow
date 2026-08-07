import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SetupGuard } from './SetupGuard';
import type { IAdminApi } from '../api/admin-api';
import type { SystemConfigurationDto } from '../api/types';
import { DEFAULT_SERVICE_THEMES } from '../api/types';

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
  };
}

function configuredStore(): SystemConfigurationDto {
  return { ...cleanStore(), isInitialSetupCompleted: true, storeName: 'Apotek Sehat' };
}

function makeApi(config: SystemConfigurationDto): IAdminApi {
  return {
    getSystemConfig: vi.fn(() => Promise.resolve(config)),
    saveSystemConfig: vi.fn(() => Promise.resolve({ isInitialSetupCompleted: true, storeName: config.storeName, brandColor: config.brandColor, serviceThemes: config.serviceThemes })),
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
    getDailyReport: vi.fn(),
    getCounterPerformance: vi.fn(),
    getRangeReport: vi.fn(),
    getQueueBoard: vi.fn(),
    getCounters: vi.fn(),
    getAuditLog: vi.fn(),
    triggerManualReset: vi.fn(),
    cleanupTransactionLogs: vi.fn(),
  };
}

/** Renders the guard inside a router so `<Navigate to="/wizard">` resolves. */
function renderGuard(api: IAdminApi) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <SetupGuard api={api}>
              <div>Admin Panel Content</div>
            </SetupGuard>
          }
        />
        <Route path="/wizard" element={<div>Wizard Page</div>} />
      </Routes>
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

  it('redirects to /wizard when the config read fails (defensive)', async () => {
    const api: IAdminApi = {
      getSystemConfig: vi.fn(() => Promise.reject(new Error('core-api down'))),
      saveSystemConfig: vi.fn(),
      getActiveStateMachine: vi.fn(),
      getDailyReport: vi.fn(),
      getCounterPerformance: vi.fn(),
      getRangeReport: vi.fn(),
      getQueueBoard: vi.fn(),
      getCounters: vi.fn(),
      getAuditLog: vi.fn(),
      triggerManualReset: vi.fn(),
      cleanupTransactionLogs: vi.fn(),
    };
    renderGuard(api);
    expect(await screen.findByText('Wizard Page')).toBeInTheDocument();
  });
});
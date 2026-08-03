import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import type { IAdminApi } from './api/admin-api';
import type { SystemConfigurationDto } from './api/types';

function makeConfig(brandColor = '#2563eb'): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: true,
    storeName: 'Apotek Sehat',
    stateMachine: { states: [], transitions: [] },
    dailyResetPolicy: {
      mode: 'MANUAL',
      cronExpression: null,
      resetTicketNumberTo: 1,
      archivePreviousDayData: true,
    },
    categories: [],
    routingRules: [],
    brandColor,
  };
}

function makeApi(config: SystemConfigurationDto, reject?: Error): IAdminApi {
  return {
    getSystemConfig: reject ? vi.fn(() => Promise.reject(reject)) : vi.fn(() => Promise.resolve(config)),
    saveSystemConfig: vi.fn(() =>
      Promise.resolve({ isInitialSetupCompleted: true, storeName: config.storeName, brandColor: config.brandColor }),
    ),
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
    getDailyReport: vi.fn(),
    getCounterPerformance: vi.fn(),
    getAuditLog: vi.fn(),
    triggerManualReset: vi.fn(),
    cleanupTransactionLogs: vi.fn(),
  };
}

function renderApp(api: IAdminApi) {
  return render(
    <MemoryRouter>
      <App api={api} />
    </MemoryRouter>,
  );
}

describe('App (admin — runtime brand color, QUE-37 AC6)', () => {
  it('applies the manager-configured brand color to --accent on mount', async () => {
    document.documentElement.style.setProperty('--accent', '#2563eb');
    renderApp(makeApi(makeConfig('#abcdef')));
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#abcdef'),
    );
  });

  it('keeps the static --accent default when the config fetch fails (no flash)', async () => {
    document.documentElement.style.setProperty('--accent', '#2563eb');
    renderApp(makeApi(makeConfig('#abcdef'), new Error('offline')));
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb'),
    );
  });

  it('keeps the static --accent default when the brand color is empty', async () => {
    document.documentElement.style.setProperty('--accent', '#2563eb');
    renderApp(makeApi(makeConfig('')));
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb'),
    );
  });
});
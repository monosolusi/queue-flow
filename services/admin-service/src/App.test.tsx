import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import type { IAdminAppApi } from './api/admin-api';
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
      timezone: 'Asia/Jakarta',
    },
    categories: [],
    routingRules: [],
    brandColor,
  };
}

function makeApi(config: SystemConfigurationDto, reject?: Error): IAdminAppApi {
  return {
    getSystemConfig: reject ? vi.fn(() => Promise.reject(reject)) : vi.fn(() => Promise.resolve(config)),
    saveSystemConfig: vi.fn(() =>
      Promise.resolve({ isInitialSetupCompleted: true, storeName: config.storeName, brandColor: config.brandColor }),
    ),
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
    getDailyReport: vi.fn(),
    getCounterPerformance: vi.fn(),
    getRangeReport: vi.fn(),
    getQueueBoard: vi.fn(),
    getCounters: vi.fn(),
    getAuditLog: vi.fn(),
    triggerManualReset: vi.fn(),
    cleanupTransactionLogs: vi.fn(),
    // IAuthApi (QUE-43) — App wires an AuthProvider; with no token in jsdom it
    // never probes /me, so these stay unused here but satisfy the interface.
    login: vi.fn(),
    logout: vi.fn(),
    getMe: vi.fn(),
    setupInitialAdmin: vi.fn(),
    // IUsersApi (QUE-43) — unused by the App-level smoke tests; present for types.
    listUsers: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
  };
}

function renderApp(api: IAdminAppApi) {
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

describe('App (admin — landmark + skip link, QUE-41 AC8)', () => {
  it('renders a single <main> landmark with id="main-content"', () => {
    renderApp(makeApi(makeConfig()));
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });

  it('renders a skip link pointing at #main-content', () => {
    renderApp(makeApi(makeConfig()));
    const skip = screen.getByRole('link', { name: /Lewati ke konten/i });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(skip).toHaveClass('skip-link');
  });
});
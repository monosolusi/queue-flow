import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import type { IAdminAppApi } from './api/admin-api';
import type { AuthUserDto, SystemConfigurationDto } from './api/types';
import { DEFAULT_BRAND_COLOR, DEFAULT_PRINTER_CONFIGURATION,
  DEFAULT_TTS_CONFIGURATION, DEFAULT_SERVICE_THEMES, DEFAULT_STATE_MACHINE, DEFAULT_TV_GRID_LAYOUT } from './api/types';
import { clearToken, writeToken } from './auth/token-store';

const ADMIN: AuthUserDto = { id: 'u-1', username: 'manajer', role: 'admin' };

function makeConfig(brandColor = '#2563eb'): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: true,
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
    brandColor,
    serviceThemes: { ...DEFAULT_SERVICE_THEMES },
    tvPanelLayout: DEFAULT_TV_GRID_LAYOUT,
    edgeRoutingLayout: {},
    nodePositions: {}, nodeActions: {}, endSources: [], startSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    printerConfiguration: { ...DEFAULT_PRINTER_CONFIGURATION },
    ttsConfiguration: { ...DEFAULT_TTS_CONFIGURATION },
  };
}

/**
 * A clean store that is already walkable end-to-end: it carries a store name,
 * one category and one assigned counter, so the wizard's step-1 and step-2
 * guards pass on the prefill and the finalize path (the arm under test) is
 * reachable in a handful of clicks.
 */
const INSTALLATION_ID = '11111111-2222-4333-8444-555555555555';
/** A healthy license, so these suites test routing/wizard rather than licensing. */
const VALID_LICENSE = {
  state: 'VALID',
  issue: 'NONE',
  detail: 'The license is valid.',
  expiresAt: null,
  graceEndsAt: null,
  restrictsNewTickets: false,
  type: 'perpetual',
  customerName: 'Toko Contoh',
  supportUntil: null,
  daysUntilExpiry: null,
  supportActive: true,
  versionCovered: true,
  entitlements: { maxCounters: null, maxCategories: null, features: [] },
  host: null,
} as const;

const CAT_ID = '11111111-1111-4111-8111-111111111111';
function cleanWalkableConfig(): SystemConfigurationDto {
  return {
    ...makeConfig(DEFAULT_BRAND_COLOR),
    isInitialSetupCompleted: false,
    storeName: 'Toko Contoh',
    stateMachine: DEFAULT_STATE_MACHINE,
    categories: [{ id: CAT_ID, code: 'A', name: 'Customer Service' }],
    routingRules: [
      { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: [CAT_ID], priorityPolicy: 'FIFO_GLOBAL' },
    ],
  };
}

function makeApi(
  config: SystemConfigurationDto,
  reject?: Error,
  overrides: Partial<IAdminAppApi> = {},
): IAdminAppApi {
  return {
    getSystemConfig: reject ? vi.fn(() => Promise.reject(reject)) : vi.fn(() => Promise.resolve(config)),
    saveSystemConfig: vi.fn(() =>
      Promise.resolve({ isInitialSetupCompleted: true, storeName: config.storeName, brandColor: config.brandColor, serviceThemes: config.serviceThemes, tvPanelLayout: config.tvPanelLayout, edgeRoutingLayout: {}, nodePositions: {}, nodeActions: {}, endSources: [], startSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const, printerConfiguration: config.printerConfiguration, ttsConfiguration: config.ttsConfiguration }),
    ),
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
    getDailyReport: vi.fn(),
    getCounterPerformance: vi.fn(),
    getRangeReport: vi.fn(),
    // The dashboard polls these two; resolve them empty so the landing view
    // renders instead of erroring.
    getQueueBoard: vi.fn(() => Promise.resolve({ active: [], waiting: [], waitingCount: 0 })),
    getCounters: vi.fn(() => Promise.resolve([])),
    getAuditLog: vi.fn(),
    // Licensing (ILicenseApi). A VALID verdict by default so these tests keep
    // exercising what they are about; the license screens have their own suite.
    getLicense: vi.fn(() => Promise.resolve(VALID_LICENSE)),
    getActivationRequest: vi.fn(() =>
      Promise.resolve({ installationId: INSTALLATION_ID, claims: {}, majorVersion: 1, blob: 'QMSREQ1-x' }),
    ),
    activateLicense: vi.fn(() => Promise.resolve(VALID_LICENSE)),
    getLicenseHistory: vi.fn(() => Promise.resolve([])),
    triggerManualReset: vi.fn(),
    cleanupTransactionLogs: vi.fn(),
    // IAuthApi (QUE-43) — App wires an AuthProvider; with no token in jsdom it
    // never probes /me, so these stay unused unless a test writes a token.
    login: vi.fn(() => Promise.resolve({ token: 'test-token', user: ADMIN })),
    logout: vi.fn(() => Promise.resolve()),
    getMe: vi.fn(() => Promise.resolve(ADMIN)),
    setupInitialAdmin: vi.fn(() =>
      Promise.resolve({ id: 'u-1', username: 'manajer', role: 'admin' as const, createdAt: 0 }),
    ),
    // IUsersApi (QUE-43) — unused by the App-level smoke tests; present for types.
    listUsers: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    ...overrides,
  };
}

function renderApp(api: IAdminAppApi, initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
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
  // These two assert the initial render only, so the mount config probe is
  // stubbed to a promise that never resolves — otherwise it settles after the
  // synchronous test body and leaks an "update not wrapped in act" warning.
  // The landmark + skip link are chrome: they render regardless of guard state.
  function pendingApi(): IAdminAppApi {
    return makeApi(makeConfig(), undefined, {
      getSystemConfig: vi.fn(() => new Promise<SystemConfigurationDto>(() => {})),
    });
  }

  it('renders a single <main> landmark with id="main-content"', () => {
    renderApp(pendingApi());
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });

  it('renders a skip link pointing at #main-content', () => {
    renderApp(pendingApi());
    const skip = screen.getByRole('link', { name: /Lewati ke konten/i });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(skip).toHaveClass('skip-link');
  });
});

/**
 * The full route-guard matrix. The reported bug — a first-run visitor bounced to
 * `/login` for an account that does not exist yet — has one arm per axis (setup
 * complete?, token?, which route?), so the whole matrix is asserted here rather
 * than only the arm that regressed.
 */
describe('App (admin — first-run guard matrix)', () => {
  beforeEach(() => clearToken());
  afterEach(() => clearToken());

  it('redirects a clean store (no setup, no token) to /wizard, NOT /login', async () => {
    // The reported bug: a first-run visitor with no account hit /admin and was
    // bounced to /login with no way to create an account. Fix: SetupGuard is
    // the OUTER guard (setup first), so a clean store redirects to /wizard
    // regardless of token state. This test is the regression detector.
    const cleanConfig: SystemConfigurationDto = { ...makeConfig(), isInitialSetupCompleted: false };
    renderApp(makeApi(cleanConfig));
    // The wizard renders (SetupGuard → /wizard → WizardGuard → ready → WizardPage).
    expect(await screen.findByText(/Setup Awal Sistem/i)).toBeInTheDocument();
    // The login page must NOT render — the first-run path goes to the wizard,
    // not the login page.
    expect(screen.queryByRole('heading', { name: /Masuk Admin/i })).not.toBeInTheDocument();
  });

  it('redirects a clean store landing on /login to /wizard (the bug on another route)', async () => {
    // `/admin/login` is reachable by bookmark / browser autocomplete, and the
    // gateway `auth_request` exempts `/admin/`, so nothing but SetupGuard stops
    // a clean store from rendering a sign-in form for a nonexistent account.
    const cleanConfig: SystemConfigurationDto = { ...makeConfig(), isInitialSetupCompleted: false };
    renderApp(makeApi(cleanConfig), ['/login']);
    expect(await screen.findByText(/Setup Awal Sistem/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Masuk Admin/i })).not.toBeInTheDocument();
  });

  it('redirects a configured store with no token to /login', async () => {
    renderApp(makeApi(makeConfig()));
    expect(await screen.findByRole('heading', { name: /Masuk Admin/i })).toBeInTheDocument();
    expect(screen.queryByText(/Setup Awal Sistem/i)).not.toBeInTheDocument();
  });

  it('renders the operational page for a configured store with an authenticated principal', async () => {
    writeToken('abc123');
    renderApp(makeApi(makeConfig()));
    expect(await screen.findByTestId('app-shell-page-title')).toHaveTextContent('Status Antrian');
    expect(screen.queryByRole('heading', { name: /Masuk Admin/i })).not.toBeInTheDocument();
  });

  it('bounces an authenticated manual navigation to /wizard back to /', async () => {
    writeToken('abc123');
    renderApp(makeApi(makeConfig()), ['/wizard']);
    // The wizard is first-run only — WizardGuard sends a configured store home.
    expect(await screen.findByTestId('app-shell-page-title')).toHaveTextContent('Status Antrian');
    expect(screen.queryByText(/Setup Awal Sistem/i)).not.toBeInTheDocument();
  });

  it('lands the manager on the dashboard after completing the wizard, NOT on /login', async () => {
    // The first-run dead-end: the wizard wrote the bearer token but nothing
    // re-resolved the principal, so `navigate('/')` handed RequireAuth a null
    // user and dumped the manager who had just created the account onto the
    // login form. The finalize now re-resolves BOTH the principal and the store
    // configuration before navigating.
    let current = cleanWalkableConfig();
    const completed: SystemConfigurationDto = { ...current, isInitialSetupCompleted: true };
    const api = makeApi(current, undefined, {
      getSystemConfig: vi.fn(() => Promise.resolve(current)),
      saveSystemConfig: vi.fn(() => {
        current = completed;
        return Promise.resolve({
          isInitialSetupCompleted: true,
          storeName: completed.storeName,
          brandColor: completed.brandColor,
          serviceThemes: completed.serviceThemes,
          tvPanelLayout: completed.tvPanelLayout,
          edgeRoutingLayout: {},
          nodePositions: {}, nodeActions: {}, endSources: [], startSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
          printerConfiguration: completed.printerConfiguration, ttsConfiguration: completed.ttsConfiguration,
        });
      }),
    });
    renderApp(api);

    // Steps 1–4 are valid straight off the prefill; walk them.
    await screen.findByTestId('step-1');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-4');
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Step 5 — the initial administrator (first-run only).
    await screen.findByTestId('step-5');
    await userEvent.type(screen.getByTestId('admin-username'), 'manajer');
    await userEvent.type(screen.getByTestId('admin-password'), 'rahasia123');
    await userEvent.type(screen.getByTestId('admin-password-confirm'), 'rahasia123');
    await userEvent.click(screen.getByTestId('wizard-next'));

    await screen.findByTestId('step-6');
    await userEvent.click(screen.getByTestId('wizard-finalize'));

    // The manager lands on the operational dashboard, authenticated.
    expect(await screen.findByTestId('app-shell-page-title')).toHaveTextContent('Status Antrian');
    expect(screen.queryByRole('heading', { name: /Masuk Admin/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Setup Awal Sistem/i)).not.toBeInTheDocument();
    expect(api.getMe).toHaveBeenCalled();
  });

  it('refreshes the shared config after the wizard so the shell shows the new store name', async () => {
    // Previously each holder kept its own snapshot, so `App`'s copy stayed the
    // pre-setup DTO after finalize and the chrome/dashboard rendered stale data
    // until a manual reload.
    let current: SystemConfigurationDto = { ...cleanWalkableConfig(), storeName: 'Toko Contoh' };
    const api = makeApi(current, undefined, {
      getSystemConfig: vi.fn(() => Promise.resolve(current)),
      saveSystemConfig: vi.fn(() => {
        current = { ...current, isInitialSetupCompleted: true, storeName: 'Apotek Sehat Sentosa' };
        return Promise.resolve({
          isInitialSetupCompleted: true,
          storeName: current.storeName,
          brandColor: current.brandColor,
          serviceThemes: current.serviceThemes,
          tvPanelLayout: current.tvPanelLayout,
          edgeRoutingLayout: {},
          nodePositions: {}, nodeActions: {}, endSources: [], startSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
          printerConfiguration: current.printerConfiguration, ttsConfiguration: current.ttsConfiguration,
        });
      }),
    });
    renderApp(api);

    await screen.findByTestId('step-1');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-4');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-5');
    await userEvent.type(screen.getByTestId('admin-username'), 'manajer');
    await userEvent.type(screen.getByTestId('admin-password'), 'rahasia123');
    await userEvent.type(screen.getByTestId('admin-password-confirm'), 'rahasia123');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-6');
    await userEvent.click(screen.getByTestId('wizard-finalize'));

    // The shell's sidebar brand reads the refreshed snapshot, not the prefill.
    expect(await screen.findByText('Apotek Sehat Sentosa')).toBeInTheDocument();
  });
});

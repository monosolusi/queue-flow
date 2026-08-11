import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TvLayoutPage } from './TvLayoutPage';
import { SystemConfigProvider } from '../config/system-config-context';
import { ToastProvider } from '../toast/toast-context';
import type { IAdminApi, ISystemConfigApi } from '../api/admin-api';
import {
  DEFAULT_BRAND_COLOR,
  DEFAULT_SERVICE_THEMES,
  DEFAULT_STATE_MACHINE,
  DEFAULT_TV_PANEL_LAYOUT,
  type SaveSystemConfigurationPayload,
  type SaveSystemConfigurationResult,
  type SystemConfigurationDto,
} from '../api/types';

/**
 * A configured store — `isInitialSetupCompleted: true`, with two categories
 * (carrying ids) and one routing rule assigned to the first category. Mirrors
 * the AdminPanel test fixture so the full-payload passthrough on save maps
 * cleanly (categories with ids, routing id->code).
 */
function configuredStore(): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: true,
    storeName: 'Apotek Sehat',
    stateMachine: DEFAULT_STATE_MACHINE,
    dailyResetPolicy: {
      mode: 'AUTOMATIC_CRON',
      cronExpression: '0 0 * * *',
      resetTicketNumberTo: 1,
      archivePreviousDayData: true,
      timezone: 'Asia/Jakarta',
    },
    categories: [
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Farmasi' },
    ],
    routingRules: [
      { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: ['cat-a'], priorityPolicy: 'FIFO_GLOBAL' },
    ],
    brandColor: DEFAULT_BRAND_COLOR,
    serviceThemes: { ...DEFAULT_SERVICE_THEMES },
    tvPanelLayout: { ...DEFAULT_TV_PANEL_LAYOUT },
  };
}

function makeApi(
  config: SystemConfigurationDto = configuredStore(),
  saveImpl?: (payload: SaveSystemConfigurationPayload) => Promise<SaveSystemConfigurationResult>,
) {
  const save = vi.fn(
    saveImpl ??
      ((payload: SaveSystemConfigurationPayload) =>
        Promise.resolve({
          isInitialSetupCompleted: true,
          storeName: payload.storeName,
          brandColor: payload.brandColor,
          serviceThemes: payload.serviceThemes,
          tvPanelLayout: payload.tvPanelLayout,
        })),
  );
  const getConfig = vi.fn(() => Promise.resolve(config));
  const api: IAdminApi = {
    getSystemConfig: getConfig,
    saveSystemConfig: save,
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
  // The provider shares the same getSystemConfig so the post-save refresh sees
  // the same config (with ids preserved).
  const providerApi: ISystemConfigApi = { getSystemConfig: getConfig };
  return { api, save, getConfig, providerApi };
}

function renderPage(
  api: IAdminApi,
  providerApi: ISystemConfigApi,
  initialEntries: string[] = ['/tv-layout'],
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SystemConfigProvider api={providerApi}>
        <ToastProvider>
          <TvLayoutPage api={api} />
        </ToastProvider>
      </SystemConfigProvider>
    </MemoryRouter>,
  );
}

/** The content panels in their DEFAULT order (used to build row testids). */
const CONTENT_IN_DEFAULT_ORDER = [
  'nowServing',
  'waitingQueue',
  'callHistory',
  'countersServing',
] as const;

describe('TvLayoutPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the 4 content panels in DEFAULT order + the runningText footer row', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    // The page heading.
    expect(await screen.findByRole('heading', { level: 1, name: 'Tampilan TV' })).toBeInTheDocument();
    // Each content panel row is present, in order.
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.dataset.testid)).toEqual(
      CONTENT_IN_DEFAULT_ORDER.map((k) => `tv-layout-row-${k}`),
    );
    // The runningText footer row (visibility checkbox only).
    expect(screen.getByTestId('tv-layout-vis-runningText')).toBeInTheDocument();
    // The runningText row carries the helper text.
    expect(screen.getByText('Teks berjalan selalu di bagian bawah.')).toBeInTheDocument();
  });

  it('the Up button on the second row moves it up (reorder via the accessible backbone)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-waitingQueue');
    // Click "Naik" on waitingQueue (index 1) -> moves to index 0.
    fireEvent.click(screen.getByTestId('tv-layout-up-waitingQueue'));
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'tv-layout-row-waitingQueue',
      'tv-layout-row-nowServing',
      'tv-layout-row-callHistory',
      'tv-layout-row-countersServing',
    ]);
  });

  it('the Down button on the first row moves it down', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-nowServing');
    fireEvent.click(screen.getByTestId('tv-layout-down-nowServing'));
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'tv-layout-row-waitingQueue',
      'tv-layout-row-nowServing',
      'tv-layout-row-callHistory',
      'tv-layout-row-countersServing',
    ]);
  });

  it('the Up button on the first row is disabled (no wraparound)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-nowServing');
    expect(screen.getByTestId('tv-layout-up-nowServing')).toBeDisabled();
    // The Down button on the last row is disabled too.
    expect(screen.getByTestId('tv-layout-down-countersServing')).toBeDisabled();
  });

  it('the size segmented control changes a panel size', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-nowServing');
    // The nowServing default size is 4 (Penuh). Click "Sedang" (2).
    const sedang = screen.getByTestId('tv-layout-size-nowServing-2');
    fireEvent.click(sedang);
    // The nowServing radio for 2 is now checked.
    expect(sedang).toBeChecked();
    expect(screen.getByTestId('tv-layout-size-nowServing-4')).not.toBeChecked();
  });

  it('the visibility checkbox toggles a panel off', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-callHistory');
    const vis = screen.getByTestId('tv-layout-vis-callHistory') as HTMLInputElement;
    expect(vis.checked).toBe(true);
    fireEvent.click(vis);
    expect(vis.checked).toBe(false);
  });

  it('the preview reflects the current order + the size via flex', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-preview');
    // 4 visible content bars in DEFAULT order.
    const bars = [
      screen.getByTestId('tv-layout-preview-bar-nowServing'),
      screen.getByTestId('tv-layout-preview-bar-waitingQueue'),
      screen.getByTestId('tv-layout-preview-bar-callHistory'),
      screen.getByTestId('tv-layout-preview-bar-countersServing'),
    ];
    expect(bars).toHaveLength(4);
    // The nowServing bar carries flex: 4 1 0 (the DEFAULT hero size). jsdom
    // appends `px` to the 0 basis, so match via regex.
    expect(bars[0].style.flex).toMatch(/^4 1 0(px)?$/);
    // The waitingQueue bar carries flex: 2 1 0 (the DEFAULT side-column size).
    expect(bars[1].style.flex).toMatch(/^2 1 0(px)?$/);
    // The footer bar is present.
    expect(screen.getByTestId('tv-layout-preview-footer')).toBeInTheDocument();
  });

  it('the preview re-orders when a panel is moved up', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-preview-bar-nowServing');
    // Move callHistory (index 2) up to index 1.
    fireEvent.click(screen.getByTestId('tv-layout-up-callHistory'));
    // The preview DOM order now starts with nowServing, callHistory, ...
    const preview = screen.getByTestId('tv-layout-preview');
    const bars = within(preview).getAllByTestId(/tv-layout-preview-bar-/);
    expect(bars.map((b) => b.dataset.testid)).toEqual([
      'tv-layout-preview-bar-nowServing',
      'tv-layout-preview-bar-callHistory',
      'tv-layout-preview-bar-waitingQueue',
      'tv-layout-preview-bar-countersServing',
    ]);
  });

  it('hiding runningText removes the footer from the preview', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-preview-footer');
    fireEvent.click(screen.getByTestId('tv-layout-vis-runningText'));
    expect(screen.queryByTestId('tv-layout-preview-footer')).toBeNull();
  });

  it('save sends tvPanelLayout with the edited layout + passthrough of other fields', async () => {
    const { api, save, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-callHistory');
    // Edit: move callHistory up (index 2 -> 1) + change nowServing size to 2.
    fireEvent.click(screen.getByTestId('tv-layout-up-callHistory'));
    fireEvent.click(screen.getByTestId('tv-layout-size-nowServing-2'));
    fireEvent.click(screen.getByTestId('tv-layout-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    // tvPanelLayout reflects the edits: callHistory moved up one position
    // (order 2 -> 1), and nowServing size changed 4 -> 2.
    expect(payload.tvPanelLayout.callHistory.order).toBe(1);
    expect(payload.tvPanelLayout.nowServing.size).toBe(2);
    // waitingQueue shifted down to fill callHistory's old slot (order 1 -> 2).
    expect(payload.tvPanelLayout.waitingQueue.order).toBe(2);
    // Passthrough fields are unchanged from the config.
    expect(payload.storeName).toBe('Apotek Sehat');
    expect(payload.brandColor).toBe(DEFAULT_BRAND_COLOR);
    expect(payload.serviceThemes).toEqual({ ...DEFAULT_SERVICE_THEMES });
    expect(payload.stateMachine).toEqual(DEFAULT_STATE_MACHINE);
    // Categories preserve ids.
    expect(payload.categories).toEqual([
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Farmasi' },
    ]);
    // Routing rules carry codes (id -> code mapped).
    expect(payload.routingRules).toEqual([
      { counterId: 1, counterName: 'Counter 1', assignedCategoryCodes: ['A'], priorityPolicy: 'FIFO_GLOBAL' },
    ]);
  });

  it('announces "Tampilan TV disimpan" via the polite toast region', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-nowServing');
    fireEvent.click(screen.getByTestId('tv-layout-save'));
    // The polite live region carries the success toast.
    await waitFor(() =>
      expect(screen.getByText('Tampilan TV disimpan.')).toBeInTheDocument(),
    );
  });

  it('a save failure is announced via the error toast and does not throw', async () => {
    const { api, save, providerApi } = makeApi(
      configuredStore(),
      () => Promise.reject(new Error('backend down')),
    );
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-nowServing');
    fireEvent.click(screen.getByTestId('tv-layout-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Gagal menyimpan: backend down/)).toBeInTheDocument();
  });

  it('a11y: the size control is a radiogroup with an aria-label naming the panel', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-nowServing');
    const rg = screen.getByRole('radiogroup', { name: 'Ukuran panel Sedang Dilayani' });
    expect(rg).toBeInTheDocument();
    // 4 radios inside.
    const radios = within(rg).getAllByRole('radio');
    expect(radios).toHaveLength(4);
  });

  it('a11y: the drag handle has an aria-label naming the panel', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-nowServing');
    const handle = screen.getByTestId('tv-layout-handle-nowServing');
    expect(handle).toHaveAttribute('aria-label', 'Seret Sedang Dilayani untuk mengatur urutan');
  });

  it('a11y: the up/down buttons have accessible names naming the panel', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-nowServing');
    expect(screen.getByLabelText('Naikkan Sedang Dilayani')).toBeInTheDocument();
    expect(screen.getByLabelText('Turunkan Sedang Dilayani')).toBeInTheDocument();
  });

  it('Save is disabled when the layout is invalid (defense-in-depth for a corrupt prefill)', async () => {
    // A config with a corrupt size (out of range). coerceTvPanelLayout drops
    // the invalid value and falls back to the DEFAULT, so the page is valid —
    // this test asserts the Save button is ENABLED after coercion, i.e. the
    // corrupt prefill never disables the page.
    const corrupt = {
      ...configuredStore(),
      tvPanelLayout: {
        ...DEFAULT_TV_PANEL_LAYOUT,
        nowServing: { visible: true, order: 0, size: 99 },
      },
    };
    const { api, providerApi } = makeApi(corrupt);
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout-row-nowServing');
    // The nowServing size was coerced back to the DEFAULT (4) — Penuh is checked.
    expect(screen.getByTestId('tv-layout-size-nowServing-4')).toBeChecked();
    expect(screen.getByTestId('tv-layout-save')).not.toBeDisabled();
  });
});
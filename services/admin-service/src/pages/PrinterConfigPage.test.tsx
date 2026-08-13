import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PrinterConfigPage } from './PrinterConfigPage';
import { SystemConfigProvider } from '../config/system-config-context';
import { ToastProvider } from '../toast/toast-context';
import type { IAdminApi, ISystemConfigApi } from '../api/admin-api';
import {
  DEFAULT_BRAND_COLOR,
  DEFAULT_PRINTER_CONFIGURATION,
  DEFAULT_SERVICE_THEMES,
  DEFAULT_STATE_MACHINE,
  DEFAULT_TV_GRID_LAYOUT,
  type SaveSystemConfigurationPayload,
  type SaveSystemConfigurationResult,
  type SystemConfigurationDto,
} from '../api/types';

/**
 * A configured store — `isInitialSetupCompleted: true`, with two categories
 * (carrying ids) and one routing rule. Mirrors the AdminPanel / TvLayoutPage
 * fixtures so the full-payload passthrough on save maps cleanly (categories
 * with ids, routing id→code).
 */
function configuredStore(
  overrides: Partial<SystemConfigurationDto> = {},
): SystemConfigurationDto {
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
    tvPanelLayout: DEFAULT_TV_GRID_LAYOUT.map((w) => ({ ...w })),
    edgeRoutingLayout: {},
    nodePositions: {},
    printerConfiguration: { ...DEFAULT_PRINTER_CONFIGURATION },
    ...overrides,
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
          edgeRoutingLayout: {},
          nodePositions: {},
          printerConfiguration: payload.printerConfiguration,
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
  const providerApi: ISystemConfigApi = { getSystemConfig: getConfig };
  return { api, save, getConfig, providerApi };
}

function renderPage(
  api: IAdminApi,
  providerApi: ISystemConfigApi,
  initialEntries: string[] = ['/printer-config'],
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SystemConfigProvider api={providerApi}>
        <ToastProvider>
          <PrinterConfigPage api={api} />
        </ToastProvider>
      </SystemConfigProvider>
    </MemoryRouter>,
  );
}

describe('PrinterConfigPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the chrome default mode + 80mm paper on load (no network fields)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    expect(await screen.findByRole('heading', { level: 1, name: 'Konfigurasi Printer' })).toBeInTheDocument();
    // Chrome is the selected mode (default).
    const chromeRadio = screen.getByTestId('printer-mode--chrome') as HTMLInputElement;
    expect(chromeRadio.checked).toBe(true);
    // 80mm (standar) is the selected paper width.
    const paper80 = screen.getByTestId('printer-paper-width--80') as HTMLInputElement;
    expect(paper80.checked).toBe(true);
    // Chrome mode hides the network ESC/POS section entirely (real conditional
    // render — the fields are absent, not just hidden).
    expect(screen.queryByTestId('printer-network-section')).toBeNull();
    expect(screen.queryByTestId('printer-host')).toBeNull();
    // Save is enabled (chrome is always valid).
    expect(screen.getByTestId('printer-save')).not.toBeDisabled();
  });

  it('toggling to network-escpos reveals the host/port/cut fields', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('printer-mode--chrome');
    fireEvent.click(screen.getByTestId('printer-mode--network-escpos'));
    // The network section renders.
    expect(screen.getByTestId('printer-network-section')).toBeInTheDocument();
    expect(screen.getByTestId('printer-host')).toBeInTheDocument();
    expect(screen.getByTestId('printer-port')).toBeInTheDocument();
    expect(screen.getByTestId('printer-cut-mode')).toBeInTheDocument();
    // The network note (help text) renders.
    expect(screen.getByTestId('printer-network-note')).toBeInTheDocument();
  });

  it('validation blocks save when network mode + empty host, then enables after typing', async () => {
    const { api, save, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('printer-mode--chrome');
    fireEvent.click(screen.getByTestId('printer-mode--network-escpos'));
    // Default host is '' → save is disabled + the host error shows.
    expect(screen.getByTestId('printer-save')).toBeDisabled();
    expect(screen.getByTestId('printer-host-error')).toHaveTextContent(/Host/);
    // No save fired while invalid.
    expect(save).not.toHaveBeenCalled();
    // Type a host → save enables and the error clears.
    fireEvent.change(screen.getByTestId('printer-host'), { target: { value: '192.168.1.50' } });
    expect(screen.queryByTestId('printer-host-error')).toBeNull();
    expect(screen.getByTestId('printer-save')).not.toBeDisabled();
  });

  it('save sends the full payload with the edited printerConfiguration + passthrough of every other field', async () => {
    const { api, save, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('printer-mode--chrome');
    // Switch to network + 58mm + set host/port/cut.
    fireEvent.click(screen.getByTestId('printer-mode--network-escpos'));
    fireEvent.click(screen.getByTestId('printer-paper-width--58'));
    fireEvent.change(screen.getByTestId('printer-host'), { target: { value: '10.0.0.20' } });
    fireEvent.change(screen.getByTestId('printer-port'), { target: { value: '9200' } });
    fireEvent.click(screen.getByTestId('printer-cut-mode--full'));
    fireEvent.click(screen.getByTestId('printer-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    // The one field this page edits.
    expect(payload.printerConfiguration).toEqual({
      mode: 'network-escpos',
      paperWidth: 58,
      host: '10.0.0.20',
      port: 9200,
      cutMode: 'full',
      baudRate: 9600,
    });
    // Passthrough fields unchanged from the config.
    expect(payload.storeName).toBe('Apotek Sehat');
    expect(payload.brandColor).toBe(DEFAULT_BRAND_COLOR);
    expect(payload.serviceThemes).toEqual({ ...DEFAULT_SERVICE_THEMES });
    expect(payload.stateMachine).toEqual(DEFAULT_STATE_MACHINE);
    expect(payload.tvPanelLayout).toEqual(DEFAULT_TV_GRID_LAYOUT.map((w) => ({ ...w })));
    // Categories preserve ids; routing rules carry codes.
    expect(payload.categories).toEqual([
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Farmasi' },
    ]);
    expect(payload.routingRules).toEqual([
      { counterId: 1, counterName: 'Counter 1', assignedCategoryCodes: ['A'], priorityPolicy: 'FIFO_GLOBAL' },
    ]);
  });

  it('save success announces the toast and refreshes the shared config', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('printer-mode--chrome');
    fireEvent.click(screen.getByTestId('printer-save'));
    await waitFor(() => expect(screen.getByText('Konfigurasi Printer disimpan.')).toBeInTheDocument());
  });

  it('a save failure is announced via the error toast with the Gagal menyimpan prefix', async () => {
    const { api, save, providerApi } = makeApi(
      configuredStore(),
      () => Promise.reject(new Error('port tidak valid')),
    );
    renderPage(api, providerApi);
    await screen.findByTestId('printer-mode--chrome');
    fireEvent.click(screen.getByTestId('printer-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Gagal menyimpan: port tidak valid/)).toBeInTheDocument();
  });

  it('paper width applies to both modes (chrome keeps it editable)', async () => {
    const { api, save, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('printer-mode--chrome');
    // Chrome mode shows the paper-width radio (it drives the @page size).
    expect(screen.getByTestId('printer-paper-section')).toBeInTheDocument();
    // Pick 58mm in chrome mode + save → payload carries paperWidth 58.
    fireEvent.click(screen.getByTestId('printer-paper-width--58'));
    fireEvent.click(screen.getByTestId('printer-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.printerConfiguration.paperWidth).toBe(58);
    expect(payload.printerConfiguration.mode).toBe('chrome');
  });

  it('switching back to chrome hides the network fields and is always valid', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('printer-mode--chrome');
    fireEvent.click(screen.getByTestId('printer-mode--network-escpos'));
    expect(screen.getByTestId('printer-network-section')).toBeInTheDocument();
    // Switch back to chrome — the network section unmounts.
    fireEvent.click(screen.getByTestId('printer-mode--chrome'));
    expect(screen.queryByTestId('printer-network-section')).toBeNull();
    // Chrome is always valid → save enabled even though host is still ''.
    expect(screen.getByTestId('printer-save')).not.toBeDisabled();
  });

  it('coerces a corrupt GET projection to the chrome default (defense-in-depth)', async () => {
    // A store whose printerConfiguration is missing/degraded — coerce falls back
    // to the chrome default so the editor never breaks on a corrupt prefill.
    const corrupt = configuredStore({ printerConfiguration: undefined as unknown as SystemConfigurationDto['printerConfiguration'] });
    const { api, providerApi } = makeApi(corrupt);
    renderPage(api, providerApi);
    const chromeRadio = await screen.findByTestId('printer-mode--chrome') as HTMLInputElement;
    expect(chromeRadio.checked).toBe(true);
    const paper80 = screen.getByTestId('printer-paper-width--80') as HTMLInputElement;
    expect(paper80.checked).toBe(true);
    expect(screen.getByTestId('printer-save')).not.toBeDisabled();
  });

  it('toggling to usb-serial reveals the baud-rate field + cut mode (no host required)', async () => {
    const { api, save, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('printer-mode--chrome');
    fireEvent.click(screen.getByTestId('printer-mode--usb-serial'));
    // The USB section renders; the network section does NOT (no host/port).
    expect(screen.getByTestId('printer-usb-section')).toBeInTheDocument();
    expect(screen.getByTestId('printer-baud-rate')).toBeInTheDocument();
    expect(screen.getByTestId('printer-usb-note')).toBeInTheDocument();
    expect(screen.queryByTestId('printer-network-section')).toBeNull();
    expect(screen.queryByTestId('printer-host')).toBeNull();
    // Cut mode renders for usb-serial too (it is an ESC/POS mode).
    expect(screen.getByTestId('printer-cut-mode')).toBeInTheDocument();
    // usb-serial needs no host → save is enabled immediately.
    expect(screen.getByTestId('printer-save')).not.toBeDisabled();
    // Change baud rate to 19200 + cut to full + save.
    fireEvent.change(screen.getByTestId('printer-baud-rate'), { target: { value: '19200' } });
    fireEvent.click(screen.getByTestId('printer-cut-mode--full'));
    fireEvent.click(screen.getByTestId('printer-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.printerConfiguration).toEqual({
      mode: 'usb-serial',
      paperWidth: 80,
      host: '',
      port: 9100,
      cutMode: 'full',
      baudRate: 19200,
    });
  });

  it('prefills an existing network-escpos config into the fields', async () => {
    const networkStore = configuredStore({
      printerConfiguration: {
        mode: 'network-escpos',
        paperWidth: 58,
        host: '192.168.10.5',
        port: 9100,
        cutMode: 'full',
        baudRate: 9600,
      },
    });
    const { api, providerApi } = makeApi(networkStore);
    renderPage(api, providerApi);
    // Network mode is selected + the host/port prefilled.
    expect(await screen.findByTestId('printer-mode--network-escpos')).toBeInTheDocument();
    const networkRadio = screen.getByTestId('printer-mode--network-escpos') as HTMLInputElement;
    expect(networkRadio.checked).toBe(true);
    expect((screen.getByTestId('printer-host') as HTMLInputElement).value).toBe('192.168.10.5');
    expect((screen.getByTestId('printer-port') as HTMLInputElement).value).toBe('9100');
    const cutFull = screen.getByTestId('printer-cut-mode--full') as HTMLInputElement;
    expect(cutFull.checked).toBe(true);
    // The prefilled network config is valid → save enabled.
    expect(screen.getByTestId('printer-save')).not.toBeDisabled();
  });
});
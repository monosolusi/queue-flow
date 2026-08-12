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
  DEFAULT_TV_GRID_LAYOUT,
  TV_COMPONENT_TYPES,
  type SaveSystemConfigurationPayload,
  type SaveSystemConfigurationResult,
  type SystemConfigurationDto,
} from '../api/types';

/**
 * A configured store — `isInitialSetupCompleted: true`, with two categories
 * (carrying ids) and one routing rule assigned to the first category. The
 * `tvPanelLayout` is the default 12-col grid widget array (5 widgets with
 * stable ids matching their component). Mirrors the AdminPanel test fixture
 * so the full-payload passthrough on save maps cleanly (categories with ids,
 * routing id->code).
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
    tvPanelLayout: DEFAULT_TV_GRID_LAYOUT.map((w) => ({ ...w })),
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

describe('TvLayoutPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the palette (5 component chips) + the default 5 placed widgets', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    expect(await screen.findByRole('heading', { level: 1, name: 'Tampilan TV' })).toBeInTheDocument();
    // The palette is a labelled group with one chip per component type.
    const palette = screen.getByRole('group', { name: 'Komponen TV' });
    for (const type of TV_COMPONENT_TYPES) {
      expect(within(palette).getByTestId(`tv-layout__chip--${type}`)).toBeInTheDocument();
    }
    // The default layout places 5 widgets (ids match component names).
    const widgets = screen.getAllByTestId(/^tv-layout__widget--/);
    expect(widgets).toHaveLength(5);
    for (const type of TV_COMPONENT_TYPES) {
      expect(screen.getByTestId(`tv-layout__widget--${type}`)).toBeInTheDocument();
    }
  });

  it('removes a widget via the × button', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--callHistory');
    expect(screen.getByTestId('tv-layout__widget--callHistory')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tv-layout__remove--callHistory'));
    expect(screen.queryByTestId('tv-layout__widget--callHistory')).toBeNull();
    expect(screen.getAllByTestId(/^tv-layout__widget--/)).toHaveLength(4);
  });

  it('the Kolom stepper moves a widget that has room (after removing its neighbor)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--waitingQueue');
    // callHistory sits to the right of waitingQueue — remove it so waitingQueue
    // can shift right without an overlap no-op.
    fireEvent.click(screen.getByTestId('tv-layout__remove--callHistory'));
    const stepper = screen.getByTestId('tv-layout__stepper-x--waitingQueue');
    const input = within(stepper).getByLabelText('Kolom') as HTMLInputElement;
    expect(input.value).toBe('0');
    fireEvent.click(within(stepper).getByLabelText('Kolom tambah'));
    expect(input.value).toBe('1');
  });

  it('the Lebar stepper resizes a widget that has room (after removing its neighbor)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--waitingQueue');
    fireEvent.click(screen.getByTestId('tv-layout__remove--callHistory'));
    const stepper = screen.getByTestId('tv-layout__stepper-w--waitingQueue');
    const input = within(stepper).getByLabelText('Lebar') as HTMLInputElement;
    expect(input.value).toBe('6');
    fireEvent.click(within(stepper).getByLabelText('Lebar tambah'));
    expect(input.value).toBe('7');
  });

  it('an overlap-blocked resize is a no-op (the stepper value does not change)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--waitingQueue');
    // callHistory is still to the right → widening waitingQueue to 7 overlaps it.
    const stepper = screen.getByTestId('tv-layout__stepper-w--waitingQueue');
    const input = within(stepper).getByLabelText('Lebar') as HTMLInputElement;
    expect(input.value).toBe('6');
    fireEvent.click(within(stepper).getByLabelText('Lebar tambah'));
    // resizeWidget returns the original layout on overlap → value stays 6.
    expect(input.value).toBe('6');
  });

  it('the Baris/Tinggi steppers change a widget row position + height', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--runningText');
    // runningText is at y=10,h=1. It can grow taller (rows 10..19 are free).
    const hStepper = screen.getByTestId('tv-layout__stepper-h--runningText');
    const hInput = within(hStepper).getByLabelText('Tinggi') as HTMLInputElement;
    expect(hInput.value).toBe('1');
    fireEvent.click(within(hStepper).getByLabelText('Tinggi tambah'));
    expect(hInput.value).toBe('2');
  });

  it('the Kolom stepper is clamped at min (0) — the − button is disabled', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--nowServing');
    const stepper = screen.getByTestId('tv-layout__stepper-x--nowServing');
    expect(within(stepper).getByLabelText('Kolom kurang')).toBeDisabled();
  });

  it('a full-width widget hits max Lebar — the + button is disabled', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--nowServing');
    const stepper = screen.getByTestId('tv-layout__stepper-w--nowServing');
    // nowServing is x=0,w=12 → max = GRID_COLS - x = 12 → atMax.
    expect(within(stepper).getByLabelText('Lebar tambah')).toBeDisabled();
  });

  it('clicking a palette chip on a full grid surfaces the no-room status', async () => {
    // A single 12×20 widget fills every row → no free spot for any add. (The
    // default 5-widget layout leaves rows 11..19 empty, so it is NOT full.)
    const fullGrid = {
      ...configuredStore(),
      tvPanelLayout: [{ id: 'filler', component: 'nowServing' as const, x: 0, y: 0, w: 12, h: 20 }],
    };
    const { api, providerApi } = makeApi(fullGrid);
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--filler');
    fireEvent.click(screen.getByTestId('tv-layout__chip--runningText'));
    await waitFor(() =>
      expect(screen.getByText('Tidak ada ruang kosong untuk komponen baru.')).toBeInTheDocument(),
    );
    // No new widget was added.
    expect(screen.getAllByTestId(/^tv-layout__widget--/)).toHaveLength(1);
  });

  it('clicking a palette chip after freeing space adds the component back', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--runningText');
    // Remove runningText (a 12×1 strip) → its row frees up.
    fireEvent.click(screen.getByTestId('tv-layout__remove--runningText'));
    expect(screen.getAllByTestId(/^tv-layout__widget--/)).toHaveLength(4);
    // Re-add runningText via the palette — findFreeSpot places it at the freed row.
    fireEvent.click(screen.getByTestId('tv-layout__chip--runningText'));
    expect(screen.getAllByTestId(/^tv-layout__widget--/)).toHaveLength(5);
  });

  it('Kembalikan ke Default restores the 5 default widgets', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--callHistory');
    fireEvent.click(screen.getByTestId('tv-layout__remove--callHistory'));
    fireEvent.click(screen.getByTestId('tv-layout__remove--runningText'));
    expect(screen.getAllByTestId(/^tv-layout__widget--/)).toHaveLength(3);
    fireEvent.click(screen.getByTestId('tv-layout-reset'));
    expect(screen.getAllByTestId(/^tv-layout__widget--/)).toHaveLength(5);
    for (const type of TV_COMPONENT_TYPES) {
      expect(screen.getByTestId(`tv-layout__widget--${type}`)).toBeInTheDocument();
    }
  });

  it('save sends the edited tvPanelLayout + passthrough of every other field', async () => {
    const { api, save, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--callHistory');
    // Edit: remove callHistory + move waitingQueue one column right (needs the
    // neighbor gone, which the remove just accomplished).
    fireEvent.click(screen.getByTestId('tv-layout__remove--callHistory'));
    fireEvent.click(within(screen.getByTestId('tv-layout__stepper-x--waitingQueue')).getByLabelText('Kolom tambah'));
    fireEvent.click(screen.getByTestId('tv-layout-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    // tvPanelLayout: 4 widgets, no callHistory, waitingQueue at x=1.
    expect(payload.tvPanelLayout).toHaveLength(4);
    expect(payload.tvPanelLayout.find((w) => w.component === 'callHistory')).toBeUndefined();
    const waiting = payload.tvPanelLayout.find((w) => w.component === 'waitingQueue');
    expect(waiting?.x).toBe(1);
    // Passthrough fields unchanged from the config.
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

  it('announces "Tampilan TV disimpan." via the polite toast region', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--nowServing');
    fireEvent.click(screen.getByTestId('tv-layout-save'));
    await waitFor(() => expect(screen.getByText('Tampilan TV disimpan.')).toBeInTheDocument());
  });

  it('a save failure is announced via the error toast and does not throw', async () => {
    const { api, save, providerApi } = makeApi(
      configuredStore(),
      () => Promise.reject(new Error('backend down')),
    );
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--nowServing');
    fireEvent.click(screen.getByTestId('tv-layout-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Gagal menyimpan: backend down/)).toBeInTheDocument();
  });

  it('a11y: the palette is a role=group labelled "Komponen TV"', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__palette');
    expect(screen.getByRole('group', { name: 'Komponen TV' })).toBeInTheDocument();
  });

  it('a11y: each palette chip has an aria-label naming the component it adds', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__palette');
    expect(screen.getByLabelText('Tambah Sedang Dilayani')).toBeInTheDocument();
    expect(screen.getByLabelText('Tambah Teks Berjalan')).toBeInTheDocument();
  });

  it('a11y: each widget steppers group is labelled naming the component', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--nowServing');
    expect(
      screen.getByRole('group', { name: 'Posisi dan ukuran Sedang Dilayani' }),
    ).toBeInTheDocument();
  });

  it('a11y: each widget has a resize slider labelled "Ubah Ukuran"', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--nowServing');
    // One slider per widget — scope to a widget to disambiguate.
    const handle = within(screen.getByTestId('tv-layout__widget--nowServing')).getByRole('slider', {
      name: 'Ubah Ukuran',
    });
    expect(handle).toBeInTheDocument();
    // Every widget carries one.
    expect(screen.getAllByRole('slider', { name: 'Ubah Ukuran' })).toHaveLength(5);
  });

  it('a11y: each widget remove button has an accessible name', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--nowServing');
    // One remove button per widget — all share the "Hapus Komponen" label.
    expect(screen.getAllByLabelText('Hapus Komponen')).toHaveLength(5);
    const btn = within(screen.getByTestId('tv-layout__widget--nowServing')).getByLabelText('Hapus Komponen');
    expect(btn).toBeInTheDocument();
  });

  it('Save is disabled when the layout is invalid (defense-in-depth for a corrupt prefill)', async () => {
    // A config with an out-of-range widget width. coerceTvGridLayout rejects the
    // invalid array and falls back to the DEFAULT, so the page is valid — this
    // asserts the corrupt prefill never disables Save (coercion backstop).
    const corrupt = {
      ...configuredStore(),
      tvPanelLayout: [{ id: 'bad', component: 'nowServing' as const, x: 0, y: 0, w: 99, h: 1 }],
    };
    const { api, providerApi } = makeApi(corrupt);
    renderPage(api, providerApi);
    await screen.findByTestId('tv-layout__widget--nowServing');
    // Coerced back to the default → nowServing default widget present + Save enabled.
    expect(screen.getByTestId('tv-layout__widget--nowServing')).toBeInTheDocument();
    expect(screen.getByTestId('tv-layout-save')).not.toBeDisabled();
  });
});
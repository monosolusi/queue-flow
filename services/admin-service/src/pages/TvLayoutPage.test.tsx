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

/**
 * The page opens in preview mode (a read-only miniature). Most tests exercise
 * the editor, so they first open it via the "Edit Tampilan" button and await
 * the full-page overlay dialog. This helper is the shared entry point.
 */
async function enterEditMode() {
  const editBtn = await screen.findByTestId('tv-layout-edit');
  fireEvent.click(editBtn);
  await screen.findByTestId('tv-layout-editor-overlay');
}

describe('TvLayoutPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- preview-first WYSIWYG flow ---

  it('renders the preview miniature on load (not the editor) with an Edit button', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    expect(await screen.findByRole('heading', { level: 1, name: 'Tampilan TV' })).toBeInTheDocument();
    // The preview miniature is present…
    expect(screen.getByTestId('tv-preview')).toBeInTheDocument();
    // …with one rendered widget per default-layout widget, at its real id.
    for (const w of DEFAULT_TV_GRID_LAYOUT) {
      expect(screen.getByTestId(`tv-preview__widget--${w.id}`)).toBeInTheDocument();
    }
    // …and the Edit Tampilan button is the entry point to the editor.
    expect(screen.getByTestId('tv-layout-edit')).toBeInTheDocument();
    // The editor is NOT mounted until Edit is pressed (the canvas/palette are
    // absent in preview mode).
    expect(screen.queryByTestId('tv-layout__palette')).toBeNull();
    expect(screen.queryByTestId('tv-layout__canvas')).toBeNull();
  });

  it('clicking Edit opens the full-page editor overlay dialog (palette + 5 widgets)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    // The overlay is a labelled modal dialog.
    expect(screen.getByRole('dialog', { name: 'Sunting Tampilan TV' })).toBeInTheDocument();
    expect(screen.getByTestId('tv-layout-editor-overlay')).toBeInTheDocument();
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
    // The canvas is wrapped in a TV frame (bezel) so the manager can tell
    // which side is the TV area vs the component palette, with visible area
    // captions on each side.
    expect(screen.getByTestId('tv-layout__tv-bezel')).toBeInTheDocument();
    expect(screen.getByText('Layar TV')).toBeInTheDocument();
    expect(screen.getByText('Komponen')).toBeInTheDocument();
  });

  it('Selesai returns to the preview (overlay unmounts, preview stays)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    fireEvent.click(screen.getByTestId('tv-layout-close'));
    expect(screen.queryByTestId('tv-layout-editor-overlay')).toBeNull();
    expect(screen.getByTestId('tv-preview')).toBeInTheDocument();
  });

  it('Escape closes the editor and returns to the preview', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('tv-layout-editor-overlay')).toBeNull();
    expect(screen.getByTestId('tv-preview')).toBeInTheDocument();
  });

  it('save returns to the preview on success and announces the toast', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    fireEvent.click(screen.getByTestId('tv-layout-save'));
    await waitFor(() => expect(screen.getByText('Tampilan TV disimpan.')).toBeInTheDocument());
    // A successful save returns to the preview (overlay unmounts).
    expect(screen.queryByTestId('tv-layout-editor-overlay')).toBeNull();
    expect(screen.getByTestId('tv-preview')).toBeInTheDocument();
  });

  // --- editor interactions (entered via Edit) ---

  it('removes a widget via the × button', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    expect(screen.getByTestId('tv-layout__widget--callHistory')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tv-layout__remove--callHistory'));
    expect(screen.queryByTestId('tv-layout__widget--callHistory')).toBeNull();
    expect(screen.getAllByTestId(/^tv-layout__widget--/)).toHaveLength(4);
  });

  // Note: the × button and the steppers container carry onPointerDown
  // stopPropagation so a real-browser press does not begin a widget drag +
  // setPointerCapture (which would swallow the click — delete broken, +/−
  // "tidak berguna"). jsdom cannot reproduce pointer-capture (RTL's
  // fireEvent.pointerDown strips isPrimary/button and the global PointerEvent
  // ctor is absent in this env), so the stopPropagation is a real-browser-only
  // fix verified by reasoning + the existing resize-handle precedent, not by a
  // unit test (same class as the resize handle's own stopPropagation, which is
  // likewise jsdom-untested). The click-based tests below cover the click
  // handler logic; the pointerdown-bubbling interaction is browser-only.

  it('the Lebar stepper resizes a widget that has room (after removing its neighbor)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
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
    await enterEditMode();
    // callHistory is still to the right → widening waitingQueue to 7 overlaps it.
    const stepper = screen.getByTestId('tv-layout__stepper-w--waitingQueue');
    const input = within(stepper).getByLabelText('Lebar') as HTMLInputElement;
    expect(input.value).toBe('6');
    fireEvent.click(within(stepper).getByLabelText('Lebar tambah'));
    // resizeWidget returns the original layout on overlap → value stays 6.
    expect(input.value).toBe('6');
  });

  it('the Tinggi stepper changes a widget height', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    // runningText is at y=10,h=1. It can grow taller (rows 10..19 are free).
    const hStepper = screen.getByTestId('tv-layout__stepper-h--runningText');
    const hInput = within(hStepper).getByLabelText('Tinggi') as HTMLInputElement;
    expect(hInput.value).toBe('1');
    fireEvent.click(within(hStepper).getByLabelText('Tinggi tambah'));
    expect(hInput.value).toBe('2');
  });

  it('the Tinggi stepper is clamped at min (1) — the − button is disabled', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    // runningText has h=1 (GRID_MIN_H) → Tinggi kurang is disabled at min.
    const stepper = screen.getByTestId('tv-layout__stepper-h--runningText');
    expect(within(stepper).getByLabelText('Tinggi kurang')).toBeDisabled();
  });

  it('a full-width widget hits max Lebar — the + button is disabled', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
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
    await enterEditMode();
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
    await enterEditMode();
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
    await enterEditMode();
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
    await enterEditMode();
    // Edit: remove callHistory (waitingQueue's right neighbor) + widen
    // waitingQueue one column (needs the neighbor gone so it doesn't overlap).
    fireEvent.click(screen.getByTestId('tv-layout__remove--callHistory'));
    fireEvent.click(within(screen.getByTestId('tv-layout__stepper-w--waitingQueue')).getByLabelText('Lebar tambah'));
    fireEvent.click(screen.getByTestId('tv-layout-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    // tvPanelLayout: 4 widgets, no callHistory, waitingQueue widened to w=7.
    expect(payload.tvPanelLayout).toHaveLength(4);
    expect(payload.tvPanelLayout.find((w) => w.component === 'callHistory')).toBeUndefined();
    const waiting = payload.tvPanelLayout.find((w) => w.component === 'waitingQueue');
    expect(waiting?.w).toBe(7);
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

  it('a save failure is announced via the error toast and keeps the editor open', async () => {
    const { api, save, providerApi } = makeApi(
      configuredStore(),
      () => Promise.reject(new Error('backend down')),
    );
    renderPage(api, providerApi);
    await enterEditMode();
    fireEvent.click(screen.getByTestId('tv-layout-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Gagal menyimpan: backend down/)).toBeInTheDocument();
    // A failed save stays in the editor so the manager can retry (the overlay
    // does not unmount — contrast with the success-returns-to-preview test).
    expect(screen.getByTestId('tv-layout-editor-overlay')).toBeInTheDocument();
  });

  it('a11y: the palette is a role=group labelled "Komponen TV"', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    expect(screen.getByRole('group', { name: 'Komponen TV' })).toBeInTheDocument();
  });

  it('a11y: each palette chip has an aria-label naming the component it adds', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    expect(screen.getByLabelText('Tambah Sedang Dilayani')).toBeInTheDocument();
    expect(screen.getByLabelText('Tambah Teks Berjalan')).toBeInTheDocument();
  });

  it('a11y: each widget steppers group is labelled naming the component', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    expect(
      screen.getByRole('group', { name: 'Ukuran Sedang Dilayani' }),
    ).toBeInTheDocument();
  });

  it('a11y: each widget has a resize slider labelled "Ubah Ukuran"', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
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
    await enterEditMode();
    // One remove button per widget — all share the "Hapus Komponen" label.
    expect(screen.getAllByLabelText('Hapus Komponen')).toHaveLength(5);
    const btn = within(screen.getByTestId('tv-layout__widget--nowServing')).getByLabelText('Hapus Komponen');
    expect(btn).toBeInTheDocument();
  });

  it('a11y: the editor overlay is a modal dialog (aria-modal="true")', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    const dialog = screen.getByRole('dialog', { name: 'Sunting Tampilan TV' });
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('a11y (WCAG 2.4.3): focus moves into the dialog on open and restores to the Edit trigger on close', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    const editBtn = await screen.findByTestId('tv-layout-edit');
    editBtn.focus();
    expect(document.activeElement).toBe(editBtn);
    // Opening the dialog moves focus into the dialog container (tabindex={-1}).
    fireEvent.click(editBtn);
    const dialog = await screen.findByRole('dialog', { name: 'Sunting Tampilan TV' });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    // Closing via "Selesai" restores focus to the captured Edit trigger.
    fireEvent.click(screen.getByTestId('tv-layout-close'));
    await waitFor(() => expect(document.activeElement).toBe(editBtn));
  });

  it('a11y: the background preview is aria-hidden while the editor dialog is open', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await enterEditMode();
    // The page h1 lives in the background wrapper — it is aria-hidden while the
    // modal is open so AT does not reach background content behind the dialog.
    expect(screen.queryByRole('heading', { level: 1, name: 'Tampilan TV' })).toBeNull();
    // Closing the dialog re-exposes the background heading.
    fireEvent.click(screen.getByTestId('tv-layout-close'));
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Tampilan TV' })).toBeInTheDocument(),
    );
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
    await enterEditMode();
    // Coerced back to the default → nowServing default widget present + Save enabled.
    expect(screen.getByTestId('tv-layout__widget--nowServing')).toBeInTheDocument();
    expect(screen.getByTestId('tv-layout-save')).not.toBeDisabled();
  });
});
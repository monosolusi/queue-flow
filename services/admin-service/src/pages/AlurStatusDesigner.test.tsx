import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AlurStatusDesigner } from './AlurStatusDesigner';
import { AdminPanel } from './AdminPanel';
import { ConfigDraftProvider } from './admin-config/config-draft-context';
import { SystemConfigProvider } from '../config/system-config-context';
import { ToastProvider } from '../toast/toast-context';
import type { IAdminApi } from '../api/admin-api';
import {
  DEFAULT_STATE_MACHINE,
  DEFAULT_BRAND_COLOR,
  DEFAULT_SERVICE_THEMES,
  DEFAULT_TV_GRID_LAYOUT,
  type SaveSystemConfigurationPayload,
  type SystemConfigurationDto,
} from '../api/types';

/**
 * A configured store — `isInitialSetupCompleted: true`, two categories (with
 * ids), one routing rule. Mirrors `AdminPanel.test.tsx`'s fixture (duplicated
 * rather than cross-imported — the repo has no shared test-helpers package and
 * the two suites are independent; matches the localized-duplication precedent).
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

function makeApi(config: SystemConfigurationDto = configuredStore()) {
  const save = vi.fn((payload: SaveSystemConfigurationPayload) =>
    Promise.resolve({
      isInitialSetupCompleted: true,
      storeName: payload.storeName,
      brandColor: payload.brandColor,
      serviceThemes: payload.serviceThemes,
      tvPanelLayout: payload.tvPanelLayout,
    }),
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
  return { api, save, getConfig };
}

/**
 * Renders the real `/config` nested route tree starting at `/config/alur-status`
 * (the designer). `SystemConfigProvider` wraps it (the provider calls
 * `useSystemConfigContext().refresh()` after a save). The `ConfigDraftProvider`
 * is the `/config` route element, so the designer + the panel share ONE draft —
 * navigating `/config/alur-status → /config` keeps it mounted. Mirrors the
 * `renderConfigRoute` helper in `AdminPanel.test.tsx`.
 */
function renderDesignerRoute(api: IAdminApi, initialEntry = '/config/alur-status') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SystemConfigProvider api={api}>
        <ToastProvider>
          <Routes>
            <Route path="/config" element={<ConfigDraftProvider api={api} />}>
              <Route index element={<AdminPanel />} />
              <Route path="alur-status" element={<AlurStatusDesigner />} />
            </Route>
          </Routes>
        </ToastProvider>
      </SystemConfigProvider>
    </MemoryRouter>,
  );
}

describe('AlurStatusDesigner (dedicated /config/alur-status page)', () => {
  it('renders the Diagram view by default with the workflow editor', async () => {
    const { api } = makeApi();
    renderDesignerRoute(api);
    // The Diagram view renders the StateMachineWorkflow (sm-mode + canvas).
    expect(await screen.findByTestId('sm-mode')).toBeInTheDocument();
    expect(screen.getByTestId('sm-canvas')).toBeInTheDocument();
    // The Diagram toggle is the active (aria-pressed) affordance.
    expect(screen.getByTestId('sm-view-diagram')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('sm-view-source')).toHaveAttribute('aria-pressed', 'false');
    // The source textarea is NOT mounted in Diagram view.
    expect(screen.queryByTestId('sm-source')).not.toBeInTheDocument();
  });

  it('toggles to the Source view showing the serialized JSON graph', async () => {
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    await userEvent.click(screen.getByTestId('sm-view-source'));
    expect(screen.getByTestId('sm-view-source')).toHaveAttribute('aria-pressed', 'true');
    // The source textarea mounts with the default graph serialized as JSON.
    const source = screen.getByTestId('sm-source') as HTMLTextAreaElement;
    expect(source.value).toContain('"states"');
    expect(source.value).toContain('"transitions"');
    // The first transition's action label is present in the source text.
    expect(source.value).toContain('Panggil Berikutnya');
    // The diagram canvas is unmounted in Source view.
    expect(screen.queryByTestId('sm-canvas')).not.toBeInTheDocument();
  });

  it('a valid source edit lifts into the shared draft (round-trips into the diagram)', async () => {
    const { api, save } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('sm-view-source'));
    const source = screen.getByTestId('sm-source') as HTMLTextAreaElement;

    // Edit the first action label via the JSON source, then save.
    fireEvent.change(source, { target: { value: source.value.replace('Panggil Berikutnya', 'Panggil Cepat') } });
    // No parse error — the save button is enabled.
    expect(screen.queryByTestId('sm-source-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.stateMachine.transitions[0].actionLabel).toBe('Panggil Cepat');
    // The client-only `mode` preset is stripped on the wire (source edits force
    // custom mode, but it never reaches core-api).
    expect((payload.stateMachine as unknown as Record<string, unknown>).mode).toBeUndefined();
  });

  it('invalid JSON shows an error, blocks save, and keeps the draft at the last valid graph', async () => {
    const { api, save } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('sm-view-source'));

    fireEvent.change(screen.getByTestId('sm-source'), { target: { value: '{ not valid json' } });
    expect(await screen.findByTestId('sm-source-error')).toBeInTheDocument();
    // Save is disabled while the source holds an invalid parse.
    expect(screen.getByTestId('admin-save')).toBeDisabled();
    await userEvent.click(screen.getByTestId('admin-save'));
    expect(save).not.toHaveBeenCalled();

    // The diagram (draft) stays at the last valid graph — switch back to
    // Diagram view and the workflow still shows the standard flow.
    await userEvent.click(screen.getByTestId('sm-view-diagram'));
    expect(screen.queryByTestId('sm-source-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('sm-mode')).toBeInTheDocument();
  });

  it('save navigates back to /config after a successful save', async () => {
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    // The designer's savedAt effect navigates to /config → the panel renders
    // (its store-name heading) and the designer-only canvas is gone.
    expect(await screen.findByTestId('admin-store-name')).toBeInTheDocument();
    expect(screen.queryByTestId('sm-canvas')).not.toBeInTheDocument();
  });

  it('stays mounted when a save happened on /config before opening the designer', async () => {
    const { api } = makeApi();
    renderDesignerRoute(api, '/config');
    await screen.findByTestId('admin-store-name');
    // Save on /config — bumps the shared `savedAt` to 1. AdminPanel does not
    // navigate on save, so we stay on /config.
    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    // Open the designer via the state-machine section's "Lihat Diagram" link.
    await userEvent.click(screen.getByRole('tab', { name: /^Alur Status Tiket( belum valid)?$/ }));
    await userEvent.click(screen.getByTestId('sm-open-designer'));
    // The designer MUST stay mounted — a prior save must NOT bounce it back to
    // /config before the manager can touch the diagram. (Regression guard for
    // the `mountedSavedAt` capture: `savedAt` is monotonic in the shared
    // provider, so a naive `if (savedAt > 0)` mount-tick would bounce instantly.)
    expect(await screen.findByTestId('sm-mode')).toBeInTheDocument();
    expect(screen.getByTestId('sm-canvas')).toBeInTheDocument();
    // Still on the designer route — the panel's store-name heading is gone.
    expect(screen.queryByTestId('admin-store-name')).not.toBeInTheDocument();
  });

  it('a store-name edit on /config + a transition-label edit here ride ONE save (shared draft)', async () => {
    const { api, save } = makeApi();
    // Start on /config, edit the store name, then navigate to the designer.
    renderDesignerRoute(api, '/config');
    await screen.findByText('Apotek Sehat');
    const storeNameInput = screen.getByTestId('admin-store-name');
    await userEvent.clear(storeNameInput);
    await userEvent.type(storeNameInput, 'Toko Baru');

    // The panel opens on the profile section — switch to the state-machine
    // section to reach the "Lihat Diagram" link into the designer. The provider
    // stays mounted across the navigation → the store-name edit persists.
    await userEvent.click(screen.getByRole('tab', { name: /^Alur Status Tiket( belum valid)?$/ }));
    await userEvent.click(screen.getByTestId('sm-open-designer'));
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));
    fireEvent.change(screen.getAllByLabelText('Label aksi')[0], { target: { value: 'Panggil Cepat' } });

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.storeName).toBe('Toko Baru');
    expect(payload.stateMachine.transitions[0].actionLabel).toBe('Panggil Cepat');
  });

  it('warns without blocking save when a custom flow drops a standard status', async () => {
    const trimmedFlow: SystemConfigurationDto = {
      ...configuredStore(),
      stateMachine: {
        states: ['WAITING', 'CALLING'],
        transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
      },
    };
    const { api, save } = makeApi(trimmedFlow);
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    const warning = screen.getByTestId('sm-standard-warning');
    expect(warning).toHaveTextContent('SERVING');
    expect(warning).toHaveTextContent('COMPLETED');
    expect(screen.queryByTestId('sm-errors')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('the back button returns to /config without saving', async () => {
    const { api, save } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    await userEvent.click(screen.getByTestId('designer-back'));
    // The panel renders (store-name heading); no save was sent.
    expect(await screen.findByTestId('admin-store-name')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('shows a "fix elsewhere" hint when the state-machine is valid but another section is not', async () => {
    // An all-unassigned routing matrix makes the WHOLE form invalid while the
    // state-machine section itself is valid — the designer tells the manager
    // where the blocking error is.
    const unassigned: SystemConfigurationDto = {
      ...configuredStore(),
      routingRules: [
        { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: [], priorityPolicy: 'FIFO_GLOBAL' },
      ],
    };
    const { api, save } = makeApi(unassigned);
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    expect(screen.getByTestId('designer-fix-elsewhere')).toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).toBeDisabled();
    // No state-machine errors — the block is elsewhere.
    expect(screen.queryByTestId('sm-errors')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('admin-save'));
    expect(save).not.toHaveBeenCalled();
  });

  it('offers a Coba Lagi retry when the config load fails', async () => {
    let calls = 0;
    const { api } = makeApi();
    (api.getSystemConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls += 1;
      // The SystemConfigProvider probe (child-first → runs after the draft's
      // mount probe) resolves; the draft's mount probe rejects; the draft's
      // retry probe resolves. So: draft-reject (1), shared-resolve (2),
      // draft-retry-resolve (3).
      return calls === 1
        ? Promise.reject(new Error('core-api down'))
        : Promise.resolve(configuredStore());
    });
    renderDesignerRoute(api);
    expect(await screen.findByText(/Gagal memuat konfigurasi/i)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('designer-retry'));
    expect(await screen.findByTestId('sm-mode')).toBeInTheDocument();
  });
});

/** The toast viewport live regions (mirrors AdminPanel.test.tsx). */
function toastViewport() {
  return within(screen.getByRole('region', { name: 'Notifikasi' }));
}

describe('AlurStatusDesigner save outcomes', () => {
  it('announces a save through the polite toast region', async () => {
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('admin-save'));
    expect(await toastViewport().findByText('Konfigurasi tersimpan.')).toBeInTheDocument();
  });

  it('surfaces a save error through the assertive toast region and re-enables save', async () => {
    const { api, save } = makeApi(configuredStore());
    (save as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.reject(new Error('kode kategori tidak valid')),
    );
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('admin-save'));
    expect(await toastViewport().findByText(/kode kategori tidak valid/i)).toBeInTheDocument();
    // The save navigates-back effect only fires on a successful save (savedAt),
    // so the designer stays mounted and the save button re-enables.
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();
    expect(screen.getByTestId('sm-mode')).toBeInTheDocument();
  });
});
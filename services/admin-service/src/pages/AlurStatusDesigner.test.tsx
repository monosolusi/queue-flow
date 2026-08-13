import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { AlurStatusDesigner } from './AlurStatusDesigner';
import { AdminPanel } from './AdminPanel';
import { ConfigDraftProvider } from './admin-config/config-draft-context';
import { SystemConfigProvider } from '../config/system-config-context';
import { ToastProvider } from '../toast/toast-context';
import type { IAdminApi } from '../api/admin-api';
import {
  DEFAULT_STATE_MACHINE,
  DEFAULT_BRAND_COLOR,
  DEFAULT_PRINTER_CONFIGURATION,
  DEFAULT_SERVICE_THEMES,
  DEFAULT_TV_GRID_LAYOUT,
  type SaveSystemConfigurationPayload,
  type SystemConfigurationDto,
} from '../api/types';

/**
 * Captures the router's `navigate` so tests can switch `/config/*` routes
 * (the in-content tablist is gone — section switches are navigations now).
 * Mirrors the probe in `AdminPanel.test.tsx`.
 */
const navigateRef: { current: ((to: string) => void) | null } = { current: null };
function NavigateProbe() {
  const navigate = useNavigate();
  navigateRef.current = navigate;
  return null;
}

/** Navigates to a `/config/*` route, wrapped in `act` so React flushes. */
async function navigateTo(to: string): Promise<void> {
  await act(async () => {
    navigateRef.current?.(to);
  });
}

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
    edgeRoutingLayout: {},
    nodePositions: {}, nodeActions: {},
    printerConfiguration: { ...DEFAULT_PRINTER_CONFIGURATION },
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
      edgeRoutingLayout: {},
      nodePositions: {}, nodeActions: {},
      printerConfiguration: payload.printerConfiguration,
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
  navigateRef.current = null;
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SystemConfigProvider api={api}>
        <ToastProvider>
          <NavigateProbe />
          <Routes>
            <Route path="/config" element={<ConfigDraftProvider api={api} />}>
              <Route index element={<AdminPanel section="profile" />} />
              <Route path="profil" element={<AdminPanel section="profile" />} />
              <Route path="kategori" element={<AdminPanel section="categories" />} />
              <Route path="counter-routing" element={<AdminPanel section="routing" />} />
              <Route path="reset-harian" element={<AdminPanel section="daily-reset" />} />
              <Route path="operasi-manual" element={<AdminPanel section="manual" />} />
              <Route path="alur-status" element={<AlurStatusDesigner />} />
            </Route>
          </Routes>
        </ToastProvider>
      </SystemConfigProvider>
    </MemoryRouter>,
  );
}

describe('AlurStatusDesigner (dedicated /config/alur-status page)', () => {
  it('surfaces the live-ticket strand caution (re-surfaced from the removed AdminPanel section)', async () => {
    // The live-ticket strand warning used to live on the AdminPanel
    // state-machine section; that section was removed when the in-content
    // tablist was consolidated into the sidebar. The designer is now the
    // decision point where the manager edits the state machine, so the caution
    // moved here. It is always visible (both Diagram + Source views) — the
    // active alur status is resolved per operation, so a ticket sitting in a
    // status this save removes has no legal next step (caller buttons vanish).
    // The dropped-standard-status caution was removed from the designer (the
    // standar/bawaan distinction is no longer surfaced in the UI), so this
    // live-ticket strand caution is the only warning the designer renders.
    // Uses the existing `.admin-panel__warning` class (the
    // warning-at-decision-point invariant).
    const { api } = makeApi();
    renderDesignerRoute(api);
    const warning = await screen.findByTestId('state-machine-warning');
    expect(warning).toHaveTextContent(/tiket aktif/);
    expect(warning).toHaveTextContent(/tidak bisa dilanjutkan/i);
    expect(warning).toHaveTextContent(/panel caller/i);
    expect(warning).toHaveClass('admin-panel__warning');
  });

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

  it('toggles to the Source view showing the serialized XML graph', async () => {
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    await userEvent.click(screen.getByTestId('sm-view-source'));
    expect(screen.getByTestId('sm-view-source')).toHaveAttribute('aria-pressed', 'true');
    // The source textarea mounts with the default graph serialized as XML.
    const source = screen.getByTestId('sm-source') as HTMLTextAreaElement;
    expect(source.value).toContain('<stateMachine');
    expect(source.value).toContain('<state ');
    expect(source.value).toContain('<transition ');
    // The first transition's action label is present in the source text.
    expect(source.value).toContain('Panggil Berikutnya');
    // The diagram canvas is unmounted in Source view.
    expect(screen.queryByTestId('sm-canvas')).not.toBeInTheDocument();
  });

  it('shows a connector legend (from → to · actionLabel) in the Source view', async () => {
    // Manager feedback: the raw JSON source did not explain which point
    // connects to which (ruwet). The Source view now renders a read-only
    // connector legend derived from the last-valid draft — one chip per
    // transition, `from → to · actionLabel` — so the connector direction is
    // visible, not buried in the flat JSON list.
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('sm-view-source'));

    const legend = screen.getByTestId('sm-source-connectors');
    expect(legend).toBeInTheDocument();
    // The default PRD §7 graph has 5 transitions → 5 connector chips.
    const chips = within(legend).getAllByTestId('sm-source-connector');
    expect(chips).toHaveLength(5);
    // The first connector reads WAITING → CALLING · Panggil Berikutnya.
    expect(chips[0]).toHaveTextContent('WAITING');
    expect(chips[0]).toHaveTextContent('CALLING');
    expect(chips[0]).toHaveTextContent('Panggil Berikutnya');
    // The SKIPPED → CALLING back-connector is present too (the cycle edge the
    // manager specifically found confusing without an arrow indicator).
    const recallChip = chips.find((c) => c.textContent?.includes('SKIPPED') && c.textContent?.includes('Panggil Ulang'));
    expect(recallChip).toBeDefined();
  });

  it('keeps the connector legend at the last-valid graph while the source holds invalid XML', async () => {
    // The legend mirrors the draft (last-valid), NOT the live textarea — so a
    // broken parse does NOT blank the indicator; the error region explains the
    // divergence instead. Mirrors the Diagram view's last-valid behavior.
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('sm-view-source'));

    fireEvent.change(screen.getByTestId('sm-source'), { target: { value: '<not-xml' } });
    expect(await screen.findByTestId('sm-source-error')).toBeInTheDocument();
    // The legend still shows the last-valid default graph's connectors.
    const chips = screen.getAllByTestId('sm-source-connector');
    expect(chips).toHaveLength(5);
    expect(chips[0]).toHaveTextContent('Panggil Berikutnya');
  });

  it('a valid source edit lifts into the shared draft (round-trips into the diagram)', async () => {
    const { api, save } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('sm-view-source'));
    const source = screen.getByTestId('sm-source') as HTMLTextAreaElement;

    // Edit the first action label via the XML source, then save.
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

  it('invalid XML shows an error, blocks save, and keeps the draft at the last valid graph', async () => {
    const { api, save } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('sm-view-source'));

    fireEvent.change(screen.getByTestId('sm-source'), { target: { value: '<not-xml' } });
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

  it('stays on the designer after a successful save (matches other config sections)', async () => {
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    // Like every other /config/* section, the designer stays put after a
    // successful save (no navigate()): the canvas is still mounted and the
    // panel's profile heading is NOT rendered.
    expect(screen.getByTestId('sm-canvas')).toBeInTheDocument();
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

    // The panel opens on the profile section — navigate to the designer route
    // (the state-machine section is a route now). The provider stays mounted
    // across the navigation → the store-name edit persists.
    await navigateTo('/config/alur-status');
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));
    // The inline edge input moved to the right-side properties panel (redesign):
    // select the first edge on the canvas, then edit the action label in the
    // panel. Drives the real React Flow selection path.
    fireEvent.click(screen.getByTestId('rf__edge-WAITING->CALLING#0'));
    fireEvent.change(screen.getByTestId('panel-action-label'), { target: { value: 'Panggil Cepat' } });

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.storeName).toBe('Toko Baru');
    expect(payload.stateMachine.transitions[0].actionLabel).toBe('Panggil Cepat');
  });

  it('does not block save when a custom flow drops a standard status (the dropped-status warning is removed)', async () => {
    // Manager feedback: the dropped-standard-status caution was removed from the
    // designer (the standar/bawaan distinction is no longer surfaced in the UI).
    // A custom flow that drops standard statuses is still accepted by the
    // backend — save is not blocked, and no sm-standard-warning is rendered.
    const trimmedFlow: SystemConfigurationDto = {
      ...configuredStore(),
      stateMachine: {
        states: ['WAITING', 'CALLING'],
        transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
        descriptions: {},
      },
    };
    const { api, save } = makeApi(trimmedFlow);
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    expect(screen.queryByTestId('sm-standard-warning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sm-errors')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('renders no redundant back button (the sidebar already covers section nav)', async () => {
    // Manager feedback: the designer's header "Kembali" button was useless — the
    // always-visible AppShell sidebar already lists every config section as a
    // NavLink, so a page-level back-to-/config affordance is redundant (and
    // misleading: /config redirects to /config/profil regardless of origin). The
    // only remaining "kembali ke Konfigurasi" link is the contextual one in the
    // `otherSectionInvalid` hint, which points at a specific blocking error —
    // not present here because the default flow is valid.
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    expect(screen.queryByTestId('designer-back')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Kembali' })).not.toBeInTheDocument();
  });

  it('navigating back to /config via the route keeps the shared draft (no save)', async () => {
    // The back button is gone, so a return to /config is a route navigation
    // (as the sidebar would drive it). The shared draft persists across the
    // navigation — no save is sent — and the panel renders.
    const { api, save } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    await navigateTo('/config/profil');
    expect(await screen.findByTestId('admin-store-name')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('save round-trip preserves a vertical edge (edgeRoutingLayout in the payload + re-GET)', async () => {
    // THE persistence round-trip — the whole point of the feature: a vertical
    // edge survives a save + re-GET. The GET returns the sparse
    // `edgeRoutingLayout` map; `toForm` merges it back into the form
    // transitions; the PUT payload carries it back. The proof that the diagram
    // "redraws according to the source" is the round-trip: select the vertical
    // edge (seeded from the merged sides), edit its label — `commit` →
    // `flowToGraph` captures the sides back from the canvas edges → the emitted
    // form still carries `sourceSide:'bottom'` → the save payload's
    // `edgeRoutingLayout` carries it. If `toForm` had not merged the sides, the
    // seeded edge would use the default right/left handles and the payload's
    // `edgeRoutingLayout` would be `{}`.
    const verticalStore: SystemConfigurationDto = {
      ...configuredStore(),
      edgeRoutingLayout: { 'WAITING->CALLING': { sourceSide: 'bottom', targetSide: 'top' } },
      nodePositions: { WAITING: { x: 10, y: 20 }, CALLING: { x: 30, y: 40 } },
    };
    const { api, save } = makeApi(verticalStore);
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    // The store has a custom-routed default-structure graph → `toForm` infers
    // `mode: 'custom'` (isDefaultGraph now considers sides), so the canvas is
    // already editable.
    expect(screen.getByLabelText(/Susun alur status sendiri/)).toBeChecked();
    // Select the vertical edge and edit its label — the round-trip captures the
    // merged sides back into the form, proving the diagram was seeded from them.
    fireEvent.click(screen.getByTestId('rf__edge-WAITING->CALLING#0'));
    fireEvent.change(screen.getByTestId('panel-action-label'), { target: { value: 'Panggil Cepat' } });

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    // The PUT payload carries the sparse edgeRoutingLayout map (the vertical
    // routing survived the round-trip through the canvas).
    expect(payload.edgeRoutingLayout).toEqual({
      'WAITING->CALLING': { sourceSide: 'bottom', targetSide: 'top' },
    });
    // The edited label reached the wire.
    expect(payload.stateMachine.transitions[0].actionLabel).toBe('Panggil Cepat');
    // The wire transitions stay side-free (sides travel only in edgeRoutingLayout).
    expect(
      (payload.stateMachine.transitions[0] as unknown as Record<string, unknown>).sourceSide,
    ).toBeUndefined();
    // The seeded node positions survived the round-trip through the canvas —
    // `toForm` merged them into `form.positions`, `formToFlow` seeded the node
    // positions, `flowToGraph` captured them back, and the PUT payload carries
    // them in `nodePositions`. The autoLayout'd nodes (SERVING/SKIPPED/
    // COMPLETED) also carry positions (autoLayout coordinates), so we assert
    // the two explicitly-seeded positions survived, not exact equality.
    expect(payload.nodePositions.WAITING).toEqual({ x: 10, y: 20 });
    expect(payload.nodePositions.CALLING).toEqual({ x: 30, y: 40 });
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
    // A save error does not navigate (the designer never navigates on save; it
    // stays put like every other config section), so the save button re-enables
    // and the designer remains mounted.
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();
    expect(screen.getByTestId('sm-mode')).toBeInTheDocument();
  });
});
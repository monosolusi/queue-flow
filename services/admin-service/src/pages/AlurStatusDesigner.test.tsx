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
  type SaveSystemConfigurationResult,
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
    nodePositions: {}, nodeActions: {}, endSources: [], startSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
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
      nodePositions: {}, nodeActions: {}, endSources: [], startSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
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
    expect(warning).toHaveTextContent(/layar petugas/i);
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

  it('toggles to the Sumber view showing the graph as read-only JSON', async () => {
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    await userEvent.click(screen.getByTestId('sm-view-source'));
    expect(screen.getByTestId('sm-view-source')).toHaveAttribute('aria-pressed', 'true');
    // The Sumber textarea mounts with the draft's state machine serialized as
    // pretty-printed JSON. It is the editable FORM (minus the client-only
    // `mode`), a superset of the persisted `state_machine` object: the graph is
    // saved inside `state_machine`, while positions/nodeActions/terminalNodes/
    // endSources travel as sibling top-level wire fields.
    const source = screen.getByTestId('sm-source') as HTMLTextAreaElement;
    const parsed = JSON.parse(source.value);
    expect(parsed.states).toEqual(DEFAULT_STATE_MACHINE.states);
    // The client-only `mode` preset is stripped — the manager never sees an
    // internal enum, and the text never implies the flow carries a field the
    // wire drops (`toStateMachineDto`).
    expect(parsed.mode).toBeUndefined();
    expect(parsed.transitions[0]).toMatchObject({
      from: 'WAITING',
      to: 'CALLING',
      actionLabel: 'Panggil Berikutnya',
    });
    // It is a projection, not an editing surface.
    expect(source).toHaveAttribute('readonly');
    // The diagram canvas is unmounted in Sumber view.
    expect(screen.queryByTestId('sm-canvas')).not.toBeInTheDocument();
  });

  it('shows a connector legend (from → to · actionLabel) in the Sumber view', async () => {
    // Manager feedback: the raw source did not explain which point connects to
    // which (ruwet) — nested JSON spreads a connector's direction across two
    // levels. The Sumber view renders a read-only connector legend derived from
    // the draft — one chip per transition, `from → to · actionLabel` — so the
    // direction stays visible.
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

  it('the Sumber view is a projection: a diagram edit shows up in the JSON', async () => {
    // THE single-source-of-truth property. The text is DERIVED from the draft on
    // render (no mirror state, no sync effect), so the two views cannot diverge:
    // edit a label on the canvas, switch to Sumber, and the JSON already says so.
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));
    fireEvent.click(screen.getByTestId('rf__edge-WAITING->CALLING#0'));
    fireEvent.change(screen.getByTestId('panel-action-label'), { target: { value: 'Panggil Cepat' } });

    await userEvent.click(screen.getByTestId('sm-view-source'));
    const parsed = JSON.parse((screen.getByTestId('sm-source') as HTMLTextAreaElement).value);
    expect(parsed.transitions[0].actionLabel).toBe('Panggil Cepat');
  });

  it('the Sumber view cannot edit the flow (no second editing path, save unaffected)', async () => {
    // Regression guard for the rule this view exists under: the canvas is the
    // ONLY editing surface. A change event on the read-only textarea moves
    // nothing — not the text, not the draft, not the save payload — and the
    // Sumber view never gates the save (there is no parse that could fail).
    const { api, save } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('sm-view-source'));
    const before = (screen.getByTestId('sm-source') as HTMLTextAreaElement).value;

    // `userEvent.type` is the real keyboard path — it honours `readOnly` and
    // fires no input events, so this fails if the attribute is ever dropped (a
    // `fireEvent.change` would pass either way; it assigns the value directly).
    await userEvent.type(screen.getByTestId('sm-source'), 'x');
    expect((screen.getByTestId('sm-source') as HTMLTextAreaElement).value).toBe(before);
    expect(screen.queryByTestId('sm-source-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.stateMachine.states).toEqual(DEFAULT_STATE_MACHINE.states);
    // The client-only `mode` preset is still stripped on the wire.
    expect((payload.stateMachine as unknown as Record<string, unknown>).mode).toBeUndefined();
  });

  it('follows an EXTERNAL draft change while sitting in the Sumber view (post-save re-seed)', async () => {
    // The property the deleted machinery used to manage by hand. The old mirror
    // state + `lastEmittedSig` guard existed to decide when an incoming draft
    // change should overwrite the textarea; a derived projection just tracks it.
    // The case that mattered is an EXTERNAL change landing while the manager is
    // IN the Sumber view — the provider's post-save re-GET re-seeds the draft.
    // Here the re-GET returns a flow whose label differs from what was saved, so
    // the assertion can only pass if the text re-rendered from the new draft.
    const reseeded: SystemConfigurationDto = {
      ...configuredStore(),
      stateMachine: {
        states: ['WAITING', 'CALLING'],
        transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Dipanggil Server' }],
        descriptions: {},
      },
    };
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('sm-view-source'));
    expect((screen.getByTestId('sm-source') as HTMLTextAreaElement).value).toContain(
      'Panggil Berikutnya',
    );

    // The post-save re-GET returns the re-seeded flow.
    (api.getSystemConfig as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve(reseeded),
    );
    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    // Still in the Sumber view, and the text tracked the external change.
    expect(screen.getByTestId('sm-view-source')).toHaveAttribute('aria-pressed', 'true');
    const parsed = JSON.parse((screen.getByTestId('sm-source') as HTMLTextAreaElement).value);
    expect(parsed.transitions[0].actionLabel).toBe('Dipanggil Server');
    expect(parsed.states).toEqual(['WAITING', 'CALLING']);
    // The connector legend is derived from the same form, so it moved too.
    expect(screen.getAllByTestId('sm-source-connector')).toHaveLength(1);
  });

  it('toggling Diagram↔Sumber leaves the flow untouched', async () => {
    // A bare view switch is now a plain `setView` — no parse, no serialize, no
    // draft write. The JSON is identical across a round-trip through Diagram.
    const { api, save } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    await userEvent.click(screen.getByTestId('sm-view-source'));
    const before = (screen.getByTestId('sm-source') as HTMLTextAreaElement).value;

    await userEvent.click(screen.getByTestId('sm-view-diagram'));
    await userEvent.click(screen.getByTestId('sm-view-source'));
    expect((screen.getByTestId('sm-source') as HTMLTextAreaElement).value).toBe(before);
    expect(save).not.toHaveBeenCalled();
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

  it('offers a Layar Penuh toggle that overlays the editor full-screen (modal a11y + Esc exits)', async () => {
    // Manager feedback: "add option to make it full screen." The toggle adds a
    // `--fullscreen` modifier to the designer root (a CSS position:fixed overlay
    // — see styles.test.ts) and flips its label to the exit action. The overlay
    // is a modal dialog (mirrors `TvLayoutEditOverlay`): role="dialog" +
    // aria-modal="true" + tabindex=-1, focus moves into it on open, and restores
    // to the trigger on close. Esc exits (guarded while saving). The Simpan
    // button + Diagram/Sumber toggle stay available while full-screen.
    const { api } = makeApi();
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');

    const root = document.querySelector('.alur-status-designer') as HTMLElement;
    // Not full-screen: no dialog semantics, no modifier.
    expect(root).not.toHaveClass('alur-status-designer--fullscreen');
    expect(root).not.toHaveAttribute('role');
    expect(root).not.toHaveAttribute('aria-modal');
    expect(root).not.toHaveAttribute('tabindex');
    const toggle = screen.getByTestId('designer-toggle-fullscreen');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveTextContent('Layar Penuh');

    await userEvent.click(toggle);
    // Dialog semantics apply only while full-screen.
    expect(root).toHaveClass('alur-status-designer--fullscreen');
    expect(root).toHaveAttribute('role', 'dialog');
    expect(root).toHaveAttribute('aria-modal', 'true');
    expect(root).toHaveAttribute('aria-label', 'Editor Alur Status Tiket — Layar Penuh');
    expect(root).toHaveAttribute('tabindex', '-1');
    // Focus moved into the dialog container (WCAG 2.4.3).
    expect(root).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveTextContent('Keluar dari Layar Penuh');
    // The save button stays available while full-screen.
    expect(screen.getByTestId('admin-save')).toBeInTheDocument();

    // Esc exits the overlay + restores focus to the trigger.
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(root).not.toHaveClass('alur-status-designer--fullscreen');
    expect(root).not.toHaveAttribute('role');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveTextContent('Layar Penuh');
    expect(toggle).toHaveFocus();
  });

  it('Esc does not exit full-screen while a save is in flight (no mid-save yank)', async () => {
    // Parity with `TvLayoutEditOverlay`: the Esc close is guarded while
    // submitting so a mid-save Escape does not yank the manager out of the
    // full-screen overlay before the toast lands. The save is non-destructive
    // (the draft persists), so once it resolves Esc exits again.
    const { api, save } = makeApi();
    let resolveSave!: (value: SaveSystemConfigurationResult) => void;
    const pending = new Promise<SaveSystemConfigurationResult>((resolve) => {
      resolveSave = resolve;
    });
    (save as ReturnType<typeof vi.fn>).mockImplementation(() => pending);
    renderDesignerRoute(api);
    await screen.findByTestId('sm-mode');
    const root = document.querySelector('.alur-status-designer') as HTMLElement;
    await userEvent.click(screen.getByTestId('designer-toggle-fullscreen'));
    expect(root).toHaveClass('alur-status-designer--fullscreen');

    // Start a save → submitting=true → the Simpan button enters its "Menyimpan…"
    // state. Esc must NOT exit while the save is pending.
    await userEvent.click(screen.getByTestId('admin-save'));
    expect(screen.getByTestId('admin-save')).toHaveTextContent('Menyimpan…');
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(root).toHaveClass('alur-status-designer--fullscreen');

    // Once the save resolves (submitting=false), Esc exits again.
    await act(async () => {
      resolveSave({ ...configuredStore() });
    });
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(root).not.toHaveClass('alur-status-designer--fullscreen');
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
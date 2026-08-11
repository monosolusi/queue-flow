import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminPanel } from './AdminPanel';
import { SystemConfigProvider, useSystemConfigContext } from '../config/system-config-context';
import { ToastProvider } from '../toast/toast-context';
import type { IAdminApi, ISystemConfigApi } from '../api/admin-api';
import {
  DEFAULT_STATE_MACHINE,
  DEFAULT_BRAND_COLOR,
  DEFAULT_SERVICE_THEMES,
  type CleanupTransactionLogResultDto,
  type ManualResetResultDto,
  type SaveSystemConfigurationPayload,
  type ServiceThemesMap,
  type SystemConfigurationDto,
} from '../api/types';

/**
 * A configured store — `isInitialSetupCompleted: true`, with two categories
 * (carrying ids) and one routing rule assigned to the first category. Mirrors
 * what `GET /api/system/config` returns after the wizard has run.
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
  };
}

/** A configured store whose routing matrix assigns nothing to any counter. */
function unassignedRoutingStore(): SystemConfigurationDto {
  return {
    ...configuredStore(),
    routingRules: [
      { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: [], priorityPolicy: 'FIFO_GLOBAL' },
    ],
  };
}

function makeApi(
  config: SystemConfigurationDto = configuredStore(),
  saveImpl?: (payload: SaveSystemConfigurationPayload) => Promise<{ isInitialSetupCompleted: boolean; storeName: string; brandColor: string; serviceThemes: ServiceThemesMap }>,
  overrides?: {
    manualReset?: () => Promise<ManualResetResultDto>;
    cleanup?: (retentionDays: number) => Promise<CleanupTransactionLogResultDto>;
  },
) {
  const save = vi.fn(
    saveImpl ??
      ((payload: SaveSystemConfigurationPayload) =>
        Promise.resolve({ isInitialSetupCompleted: true, storeName: payload.storeName, brandColor: payload.brandColor, serviceThemes: payload.serviceThemes })),
  );
  // The panel reloads the config after a successful save; default to returning
  // the same config (with ids preserved) so the post-save repopulate succeeds.
  const getConfig = vi.fn(() => Promise.resolve(config));
  const triggerManualReset = vi.fn(
    overrides?.manualReset ??
      (() =>
        Promise.resolve<ManualResetResultDto>({
          status: 'reset',
          date: '2026-01-15',
          resetTo: 1,
          archivedCount: 0,
        })),
  );
  const cleanupTransactionLogs = vi.fn(
    overrides?.cleanup ??
      ((_retentionDays: number) =>
        Promise.resolve<CleanupTransactionLogResultDto>({
          status: 'cleaned',
          retentionDays: 90,
          deletedCount: 5,
        })),
  );
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
    triggerManualReset,
    cleanupTransactionLogs,
  };
  return { api, save, getConfig, triggerManualReset, cleanupTransactionLogs };
}

/**
 * The panel is wrapped in a real {@link ToastProvider} because save / reset /
 * cleanup outcomes are announced through the toast stack now — the provider
 * also renders the viewport, so the two live regions the assertions scope into
 * (`role="status"` polite, `role="alert"` assertive) exist here.
 */
function renderPanel(api: IAdminApi) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AdminPanel api={api} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * The toast viewport landmark. Scoping through it keeps these helpers
 * unambiguous even though the page owns its own inline `role="alert"` (the
 * config-load error, `AdminPanel.tsx:204`) — that node is not rendered in the
 * states these tests drive, but an unscoped `getByRole('alert')` would start
 * throwing the day a ready-state alert lands.
 */
function toastViewport() {
  return within(screen.getByRole('region', { name: 'Notifikasi' }));
}
/** The polite live region — success/info toasts land here. */
function politeRegion() {
  return within(toastViewport().getByRole('status'));
}
/** The assertive live region — error toasts land here. */
function alertRegion() {
  return within(toastViewport().getByRole('alert'));
}

/**
 * Switches the active in-content section by clicking its nav tab. The `<h1>`
 * header (`form.storeName || 'QMS Admin'`) is always visible regardless of
 * section, so `findByText('Apotek Sehat')` remains the ready-signal and does
 * NOT imply a section — call this to reach a section's inputs. Uses userEvent
 * (real timers throughout these tests). The matcher tolerates the "belum
 * valid" sr-only label an invalid section's tab appends to its accessible
 * name, so navigating to an invalid section (e.g. unassigned routing) still
 * resolves.
 */
async function goToSection(label: string): Promise<void> {
  await userEvent.click(screen.getByRole('tab', { name: new RegExp(`^${label}( belum valid)?$`) }));
}

/** The `<li>` row that owns the labelled input. */
function rowOf(label: string): HTMLElement {
  const el = screen.getByLabelText(label);
  return el.closest('li') as HTMLElement;
}

describe('AdminPanel (QUE-24 / FR-ADM-01)', () => {
  it('prefills editable sections and maps routing assignedCategoryIds -> codes', async () => {
    const { api } = makeApi();
    renderPanel(api);

    expect(await screen.findByText('Apotek Sehat')).toBeInTheDocument();
    // Store name prefilled on the default profile section.
    expect(screen.getByTestId('admin-store-name')).toHaveValue('Apotek Sehat');

    // Categories prefilled with existing names.
    await goToSection('Kategori');
    expect(screen.getByLabelText('Kategori 1 kode')).toHaveValue('A');
    expect(screen.getByLabelText('Kategori 1 nama')).toHaveValue('Customer Service');

    // Routing assignment mapped from id 'cat-a' -> code 'A' is reflected in the
    // shared routing table's Kategori Dilayani cell (the table replaces the old
    // inline checkbox group; opening the Edit modal would show the selection in
    // SearchableCategorySelect).
    await goToSection('Counter & Routing');
    expect(screen.getByTestId('routing-categories-0')).toHaveTextContent('Customer Service');

    // State machine is editable now (migrated from the wizard; the wizard is
    // first-run only). The heading text is now a tab label (always visible → a
    // tab-label assertion would false-pass), so assert via the editor's sm-mode
    // testid instead.
    await goToSection('Alur Status Tiket');
    expect(screen.getByTestId('sm-mode')).toBeInTheDocument();
  });

  it('announces a save through the polite toast region, with no inline success paragraph left behind', async () => {
    // The ~15 sibling assertions in this file only do `findByText('Konfigurasi
    // tersimpan.')`, which would pass just as happily against a stray inline
    // <p class="admin-panel__success"> that never clears — the exact bug this
    // change removes. This test pins the message to the live region AND asserts
    // the inline element is gone, so a regression cannot hide behind them. (The
    // `.admin-panel__success` CSS rule was deleted along with the markup; this
    // is the DOM-level guard against it being reintroduced.)
    const { api } = makeApi();
    const { container } = renderPanel(api);
    await screen.findByText('Apotek Sehat');

    await userEvent.click(screen.getByTestId('admin-save'));

    expect(await politeRegion().findByText('Konfigurasi tersimpan.')).toBeInTheDocument();
    expect(container.querySelector('.admin-panel__success')).toBeNull();
    // Dismissible, and dismissing removes it (the live region itself stays).
    await userEvent.click(screen.getByRole('button', { name: 'Tutup notifikasi' }));
    expect(screen.queryByText('Konfigurasi tersimpan.')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('preserves existing category ids and omits id for newly added ones on save', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Kategori');

    // Edit the existing 'A' category name (ubah).
    await userEvent.clear(screen.getByLabelText('Kategori 1 nama'));
    await userEvent.type(screen.getByLabelText('Kategori 1 nama'), 'Loket 1');

    // Add a new category and fill it.
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Kategori' }));
    await userEvent.type(screen.getByLabelText('Kategori 3 kode'), 'C');
    await userEvent.type(screen.getByLabelText('Kategori 3 nama'), 'Obat');

    // Remove the second category (cat-b).
    await userEvent.click(within(rowOf('Kategori 2 kode')).getByRole('button', { name: 'Hapus' }));

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    expect(save).toHaveBeenCalledTimes(1);
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    // cat-a keeps its id with the edited name; the new 'C' row has no id;
    // cat-b was removed.
    expect(payload.categories).toEqual([
      { id: 'cat-a', code: 'A', name: 'Loket 1' },
      { code: 'C', name: 'Obat' },
    ]);
  });

  it('sends routing rules by code and the chosen priority policy', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Counter & Routing');

    // Open the Edit modal for Counter 1, assign category B, switch policy to
    // CATEGORY_PRIORITY, then Simpan (mirrors the wizard Step 2 flow).
    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const search = screen.getByRole('combobox', { name: /Kategori dilayani/ });
    await userEvent.type(search, 'Farmasi');
    await userEvent.click(screen.getByRole('option', { name: /Farmasi/ }));
    await userEvent.selectOptions(
      screen.getByLabelText('Counter 1 kebijakan prioritas'),
      'CATEGORY_PRIORITY',
    );
    await userEvent.click(screen.getByTestId('routing-modal-save'));

    // Add a second counter (auto-assigns counterId = max+1 = 2).
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Counter' }));

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.routingRules).toHaveLength(2);
    expect(payload.routingRules[0].assignedCategoryCodes).toEqual(['A', 'B']);
    expect(payload.routingRules[0].priorityPolicy).toBe('CATEGORY_PRIORITY');
    expect(payload.routingRules[1].counterId).toBe(2);
    expect(payload.routingRules[1].assignedCategoryCodes).toEqual([]);
  });

  it('nulls the cron expression when daily-reset mode is MANUAL', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Reset Harian');

    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'MANUAL');
    // The label now carries a decorative ` *` (required marker), so match by
    // regex rather than the exact pre-QUE-41 label string.
    await userEvent.clear(screen.getByLabelText(/Reset nomor antrian ke/));
    await userEvent.type(screen.getByLabelText(/Reset nomor antrian ke/), '10');
    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.dailyReset.mode).toBe('MANUAL');
    expect(payload.dailyReset.cronExpression).toBeNull();
    expect(payload.dailyReset.resetTicketNumberTo).toBe(10);
  });

  it('sends storeName + stateMachine on the wire with the client-only mode stripped', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.storeName).toBe('Apotek Sehat');
    expect(payload.stateMachine.transitions).toHaveLength(5);
    expect(payload.stateMachine.transitions[0].actionLabel).toBe('Panggil Berikutnya');
    // The client-only `mode` preset must never reach the wire (mirrors the
    // wizard's finalize — mode is a UI-only affordance, stripped at save).
    expect((payload.stateMachine as unknown as Record<string, unknown>).mode).toBeUndefined();
    // brandColor is editable (AC3) and prefilled from the loaded config.
    expect(payload.brandColor).toBe(DEFAULT_BRAND_COLOR);
  });

  it('edits storeName + a custom state-machine transition and sends them on the PUT payload', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    // Edit the store name on the default profile section.
    const storeNameInput = screen.getByTestId('admin-store-name');
    await userEvent.clear(storeNameInput);
    await userEvent.type(storeNameInput, 'Toko Baru');

    // Switch to the state-machine section and edit the first transition's
    // label. The draft persists across the switch, so both edits ride ONE save
    // (a per-section save still sends the full payload — do NOT split into two).
    await goToSection('Alur Status Tiket');
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));
    const labelInputs = screen.getAllByLabelText(/Transisi 1 label aksi/);
    fireEvent.change(labelInputs[0], { target: { value: 'Panggil Cepat' } });

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.storeName).toBe('Toko Baru');
    expect(payload.stateMachine.transitions[0].actionLabel).toBe('Panggil Cepat');
    // The `mode` preset is stripped — never on the wire.
    expect((payload.stateMachine as unknown as Record<string, unknown>).mode).toBeUndefined();
  });

  it('edits the brand color and the new color reaches the save payload (QUE-36)', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    const hexInput = screen.getByLabelText('Kode hex warna brand');
    await userEvent.clear(hexInput);
    fireEvent.change(hexInput, { target: { value: '#abcdef' } });

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.brandColor).toBe('#abcdef');
  });

  it('re-applies the runtime --accent after a save so a brand-color change is visible without a reload (QUE-35)', async () => {
    const brandConfig = { ...configuredStore(), brandColor: '#abcdef' };
    const { api } = makeApi(brandConfig);
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    // AdminPanel does not touch the runtime accent on mount (App applies it
    // once on mount); the panel re-applies it only after a successful save.
    document.documentElement.style.removeProperty('--accent');

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    // The post-save config reload re-applies the brand color to --accent, so a
    // manager who changed the brand color sees it immediately (no full reload).
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#abcdef');

    // Cleanup so the inline style does not leak into sibling tests.
    document.documentElement.style.removeProperty('--accent');
  });

  it('renders the per-service theme section prefilled from the loaded config (QUE-47)', async () => {
    const { api } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    // One constrained <select> per surface, all prefilled to the default light.
    expect(screen.getByTestId('service-themes-section')).toBeTruthy();
    for (const surface of ['kiosk', 'tv', 'caller', 'admin'] as const) {
      expect((screen.getByTestId(`theme-select-${surface}`) as HTMLSelectElement).value).toBe('light');
    }
  });

  it('edits a per-service theme and the new value reaches the save payload (QUE-47)', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    // Switch the TV surface to dark via its constrained select.
    fireEvent.change(screen.getByTestId('theme-select-tv'), { target: { value: 'dark' } });

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.serviceThemes.tv).toBe('dark');
    // The untouched surfaces stay light (passthrough preserves the rest).
    expect(payload.serviceThemes.kiosk).toBe('light');
    expect(payload.serviceThemes.caller).toBe('light');
    expect(payload.serviceThemes.admin).toBe('light');
  });

  it('disables save and shows an error for a malformed brand color (QUE-36)', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    const hexInput = screen.getByLabelText('Kode hex warna brand');
    await userEvent.clear(hexInput);
    fireEvent.change(hexInput, { target: { value: 'not-a-color' } });

    // The save button is disabled and an inline error appears.
    expect(screen.getByTestId('admin-save')).toBeDisabled();
    expect(screen.getByTestId('brand-color-errors')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('wires the brand-color error to its input via aria-invalid + aria-describedby (QUE-41 AC6)', async () => {
    const { api } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    const hexInput = screen.getByLabelText('Kode hex warna brand');
    // Happy path — no error attributes.
    expect(hexInput).not.toHaveAttribute('aria-invalid');
    expect(hexInput).not.toHaveAttribute('aria-describedby');

    fireEvent.change(hexInput, { target: { value: 'not-a-color' } });
    expect(hexInput).toHaveAttribute('aria-invalid', 'true');
    expect(hexInput).toHaveAttribute('aria-describedby', 'brand-color-errors');
    expect(screen.getByTestId('brand-color-errors')).toHaveAttribute('id', 'brand-color-errors');
  });

  it('marks the category + counter row inputs with aria-required (QUE-41 AC6)', async () => {
    const { api } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    await goToSection('Kategori');
    expect(screen.getByLabelText('Kategori 1 kode')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Kategori 1 nama')).toHaveAttribute('aria-required', 'true');
    // Counter name + priority live inside the shared Edit modal now (counterId
    // is no longer hand-editable). Open the modal to assert their aria-required.
    await goToSection('Counter & Routing');
    await userEvent.click(screen.getByTestId('routing-edit-0'));
    expect(screen.getByLabelText('Counter 1 nama')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Counter 1 kebijakan prioritas')).toHaveAttribute('aria-required', 'true');
  });

  it('fires exactly one save on a rapid double click (double-tap guard)', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    const saveBtn = screen.getByTestId('admin-save');
    // Two synchronous clicks before any await resolves.
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn);
    await screen.findByText('Konfigurasi tersimpan.');

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not mint a duplicate counterId after a remove-then-add', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Counter & Routing');

    // Build [1, 2, 3] via two "+ Tambah Counter" clicks (configuredStore
    // starts with one counter, counterId 1).
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Counter' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Counter' }));
    // Remove the middle counter (Counter 2, id=2) -> survivors [1, 3]. The
    // Hapus buttons in the Aksi column live inside the `data-table` (unique to
    // the routing section — categories use `entry-list`); scope to it so the
    // categories-section Hapus buttons don't pollute the index. After the two
    // adds the routing table has 3 rows → Hapus indices [0, 1, 2]; index 1 is
    // the middle row.
    const routingTable = document.querySelector('table.data-table') as HTMLElement;
    await userEvent.click(within(routingTable).getAllByRole('button', { name: 'Hapus' })[1]);
    // Add again — must mint 4 (max+1), not 3, or the backend rejects a dup id.
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Counter' }));

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.routingRules.map((r) => r.counterId).sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });

  it('surfaces an error and re-enables save when the save fails', async () => {
    const { api, save } = makeApi(configuredStore(), () =>
      Promise.reject(new Error('kode kategori tidak valid')),
    );
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    await userEvent.click(screen.getByTestId('admin-save'));
    // Sticky error toast in the assertive region; the `Gagal menyimpan: ` prefix
    // is part of the contract (it wraps the backend's validation message).
    expect(await alertRegion().findByText(/kode kategori tidak valid/i)).toBeInTheDocument();
    expect(alertRegion().getByText(/^Gagal menyimpan: /)).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();
  });

  it('derives the cron expression from the daily-reset time picker (FR-WZD-05 / QUE-34)', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Reset Harian');

    // The default cron '0 0 * * *' maps to 00:00 → save enabled, no error.
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();
    expect(screen.queryByTestId('cron-error')).not.toBeInTheDocument();

    // Pick 08:30 → the form derives the cron client-side (MM HH * * * → 30 8 * * *).
    // The time picker constrains input so no malformed cron can be produced.
    fireEvent.change(screen.getByLabelText('Waktu reset harian'), { target: { value: '08:30' } });
    expect(screen.queryByTestId('cron-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.dailyReset.mode).toBe('AUTOMATIC_CRON');
    expect(payload.dailyReset.cronExpression).toBe('30 8 * * *');
  });

  it('shows a timezone selector defaulting to the loaded config zone (QUE-42)', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Reset Harian');

    // The tz selector renders in the AUTOMATIC_CRON block and defaults to the
    // loaded config's timezone (configuredStore → 'Asia/Jakarta').
    const tzSelect = screen.getByTestId('tz-select') as HTMLSelectElement;
    expect(tzSelect.value).toBe('Asia/Jakarta');

    // Pick a different zone and save — the new zone reaches the PUT payload.
    await userEvent.selectOptions(tzSelect, 'America/New_York');
    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.dailyReset.timezone).toBe('America/New_York');
  });

  it('keeps a persisted non-curated timezone selectable (QUE-42 arch-review fix)', async () => {
    // A direct API call can persist a valid IANA zone that is neither the
    // browser's nor in TIMEZONE_OPTIONS (e.g. Asia/Kolkata). The <select> must
    // still offer it as an <option> so the displayed value equals the wire
    // value — a save that doesn't touch the select sends what the manager sees.
    const nonCurated = 'Asia/Kolkata';
    const config: SystemConfigurationDto = {
      ...configuredStore(),
      dailyResetPolicy: { ...configuredStore().dailyResetPolicy, timezone: nonCurated },
    };
    const { api } = makeApi(config);
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Reset Harian');

    const tzSelect = screen.getByTestId('tz-select') as HTMLSelectElement;
    // The prefilled non-curated zone is the current value...
    expect(tzSelect.value).toBe(nonCurated);
    // ...and is present as an <option> (the constrained-<select> contract holds
    // for persisted values, not just curated/browser ones).
    expect(
      Array.from(tzSelect.options).some((o) => o.value === nonCurated),
    ).toBe(true);
  });

  // --- New: section-navigation ARIA + one-section-at-a-time + per-section save ---

  it('renders an ARIA tablist with 6 tabs, roving tabindex, and tabpanel labelled by the active tab', async () => {
    const { api } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-label', 'Bagian konfigurasi');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);

    // Default active = profile: its tab is selected + in the tab order; the
    // rest rove (tabindex -1, aria-selected false).
    const profileTab = screen.getByRole('tab', { name: /^Profil & Tampilan( belum valid)?$/ });
    expect(profileTab).toHaveAttribute('aria-selected', 'true');
    expect(profileTab).toHaveAttribute('tabindex', '0');
    tabs
      .filter((t) => t !== profileTab)
      .forEach((t) => {
        expect(t).toHaveAttribute('aria-selected', 'false');
        expect(t).toHaveAttribute('tabindex', '-1');
      });

    // The single tabpanel is labelled by the active tab and the active tab's
    // aria-controls resolves to its id (the panel re-identifies per section).
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', profileTab.getAttribute('id'));
    expect(profileTab).toHaveAttribute('aria-controls', panel.getAttribute('id'));
  });

  it('renders only the active section — profile on load, Kategori after navigating to it', async () => {
    const { api } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    // Default = profile: store-name input present, categories absent.
    expect(screen.getByTestId('admin-store-name')).toBeInTheDocument();
    expect(screen.queryByLabelText('Kategori 1 kode')).not.toBeInTheDocument();

    await goToSection('Kategori');
    // After the switch, profile's store-name input is gone and categories show.
    expect(screen.queryByTestId('admin-store-name')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Kategori 1 kode')).toBeInTheDocument();
  });

  it('a per-section save on daily-reset sends the FULL payload, not just the daily-reset slice', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Reset Harian');

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    // The daily-reset slice is present...
    expect(payload.dailyReset.mode).toBe('AUTOMATIC_CRON');
    // ...but so is the rest of the full config (passthrough) — a per-section
    // save is still a full PUT.
    expect(payload.storeName).toBe('Apotek Sehat');
    expect(payload.categories).toHaveLength(2);
    expect(payload.routingRules).toHaveLength(1);
    expect(payload.stateMachine.transitions).toHaveLength(5);
    expect(payload.brandColor).toBe(DEFAULT_BRAND_COLOR);
  });
});

/**
 * The safety rails the panel inherited when the wizard became first-run only:
 * it is now the ONLY post-setup editor, so guards that used to live in the
 * wizard's step flow have to exist here or they exist nowhere.
 */
describe('AdminPanel (post-wizard safety rails)', () => {
  it('blocks save on a fully-unassigned routing matrix and explains why', async () => {
    // Mirrors the wizard's step-2 gate: with no counter serving any category
    // every counter is dead and no ticket can ever be routed. The backend has
    // no such invariant, so without this the panel could PUT it.
    const { api, save } = makeApi(unassignedRoutingStore());
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Counter & Routing');

    expect(screen.getByTestId('admin-save')).toBeDisabled();
    expect(screen.getByTestId('routing-empty-hint')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('admin-save'));
    expect(save).not.toHaveBeenCalled();
  });

  it('lifts the routing guard once a counter is assigned a category', async () => {
    const { api, save } = makeApi(unassignedRoutingStore());
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Counter & Routing');

    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const search = screen.getByRole('combobox', { name: /Kategori dilayani/ });
    await userEvent.type(search, 'Customer');
    await userEvent.click(screen.getByRole('option', { name: /Customer Service/ }));
    await userEvent.click(screen.getByTestId('routing-modal-save'));

    expect(screen.queryByTestId('routing-empty-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.routingRules[0].assignedCategoryCodes).toEqual(['A']);
  });

  it('blocks save on an empty store name and explains why', async () => {
    // Mirrors the wizard's step-1 gate: the backend 400s on a blank storeName,
    // and the panel is the only post-setup editor of it, so the guard has to
    // live here or it lives nowhere.
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    await userEvent.clear(screen.getByTestId('admin-store-name'));

    expect(screen.getByTestId('admin-save')).toBeDisabled();
    expect(screen.getByTestId('store-name-errors')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('admin-save'));
    expect(save).not.toHaveBeenCalled();

    // ...and lifts as soon as a name is typed back in.
    await userEvent.type(screen.getByTestId('admin-store-name'), 'Apotek Baru');
    expect(screen.queryByTestId('store-name-errors')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();
  });

  it('blocks save on an invalid custom ticket flow and explains why', async () => {
    // Mirrors the wizard's step-3 gate via the same shared
    // `validateCustomStateMachine`: an empty action label is a graph the backend
    // rejects, and the panel is now the only post-setup editor of the flow.
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Alur Status Tiket');

    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));
    // Controlled input bound to derived state — set via fireEvent.change.
    fireEvent.change(screen.getAllByLabelText(/Transisi 1 label aksi/)[0], { target: { value: '' } });

    expect(screen.getByTestId('admin-save')).toBeDisabled();
    expect(screen.getByTestId('sm-errors')).toHaveTextContent('Label aksi tidak boleh kosong.');
    await userEvent.click(screen.getByTestId('admin-save'));
    expect(save).not.toHaveBeenCalled();

    // ...and lifts once the label is restored.
    fireEvent.change(screen.getAllByLabelText(/Transisi 1 label aksi/)[0], {
      target: { value: 'Panggil Berikutnya' },
    });
    expect(screen.queryByTestId('sm-errors')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();
  });

  it('warns — without blocking save — when the ticket flow drops a standard status', async () => {
    // The bigger hazard than a live ticket: core-api's queue engine transitions
    // to the standard status names as literals, but `StateSchema` carries no
    // invariant that they survive a custom graph. Dropping COMPLETED breaks
    // "Selesai Layan" for every FUTURE ticket and stops stamping completed_at
    // (the analytics average). The manager is warned; the save still goes
    // through, because a custom flow may legitimately skip a status.
    const trimmedFlow: SystemConfigurationDto = {
      ...configuredStore(),
      stateMachine: {
        states: ['WAITING', 'CALLING'],
        transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
      },
    };
    const { api, save } = makeApi(trimmedFlow);
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Alur Status Tiket');

    const warning = screen.getByTestId('sm-standard-warning');
    expect(warning).toHaveTextContent('SERVING');
    expect(warning).toHaveTextContent('SKIPPED');
    expect(warning).toHaveTextContent('COMPLETED');
    expect(warning).toHaveTextContent(/Selesai Layan/);
    // Not an error list, and not a save gate.
    expect(screen.queryByTestId('sm-errors')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('warns that editing the ticket flow can strand a live ticket', async () => {
    // The alur status is resolved per operation, so a ticket sitting in a status
    // this save removes has no legal next step — its caller action buttons
    // vanish. The wizard framed this as one-time guided setup; the panel is a
    // daily surface, so the consequence has to be stated.
    const { api } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');
    await goToSection('Alur Status Tiket');

    const warning = screen.getByTestId('state-machine-warning');
    expect(warning).toHaveTextContent(/tidak bisa dilanjutkan/i);
    expect(warning).toHaveTextContent(/panel caller/i);
  });

  it('shows a nav error badge on an invalid section and clears it once fixed', async () => {
    // The nav surfaces cross-section invalidity: a manager on profile can see
    // that routing is broken via the badge on its tab. Never color alone — the
    // dot is aria-hidden and an .sr-only "belum valid" label carries the AT
    // text (CLAUDE.md a11y rule).
    const { api } = makeApi(unassignedRoutingStore());
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    // Routing is invalid (all-unassigned): the routing tab carries the badge.
    const routingTab = screen.getByRole('tab', { name: /Counter & Routing belum valid/ });
    expect(routingTab.querySelector('.admin-config__nav-badge')).toHaveAttribute('aria-hidden', 'true');
    expect(routingTab).toHaveTextContent('belum valid');

    // Fix: assign a category to a counter on the routing section.
    await goToSection('Counter & Routing');
    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const search = screen.getByRole('combobox', { name: /Kategori dilayani/ });
    await userEvent.type(search, 'Customer');
    await userEvent.click(screen.getByRole('option', { name: /Customer Service/ }));
    await userEvent.click(screen.getByTestId('routing-modal-save'));

    // The badge clears once routing is valid again.
    const fixedTab = screen.getByRole('tab', { name: /^Counter & Routing$/ });
    expect(fixedTab.querySelector('.admin-config__nav-badge')).toBeNull();
    expect(fixedTab).not.toHaveTextContent('belum valid');
  });
});

describe('AdminPanel config load failure (retry)', () => {
  it('offers a Coba Lagi retry that re-runs the config load', async () => {
    // The two config guards gained a retry; the panel's own load-failure state
    // had none, so the manager's only recourse was a full page reload.
    let calls = 0;
    const { api } = makeApi();
    (api.getSystemConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('core-api down'))
        : Promise.resolve(configuredStore());
    });
    renderPanel(api);

    expect(await screen.findByText(/Gagal memuat konfigurasi/i)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('config-retry'));
    expect(await screen.findByText('Apotek Sehat')).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});

describe('AdminPanel shared-config coherence', () => {
  /** Projects the shared snapshot so the post-save refresh is observable. */
  function SharedStoreName() {
    const { config } = useSystemConfigContext();
    return <span data-testid="shared-store-name">{config?.storeName ?? '—'}</span>;
  }

  it('refreshes the shared config after a save so the app chrome shows the new store name', async () => {
    // The shell's sidebar brand reads the shared snapshot. Before this, a
    // rename saved fine but the chrome kept the OLD name until a full reload,
    // because App held its own independent copy of the config.
    let shared: SystemConfigurationDto = { ...configuredStore(), storeName: 'Toko Lama' };
    const { api } = makeApi();
    (api.saveSystemConfig as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: SaveSystemConfigurationPayload) => {
        shared = { ...shared, storeName: payload.storeName };
        return Promise.resolve({
          isInitialSetupCompleted: true,
          storeName: payload.storeName,
          brandColor: payload.brandColor,
          serviceThemes: payload.serviceThemes,
        });
      },
    );
    const providerApi: ISystemConfigApi = { getSystemConfig: vi.fn(() => Promise.resolve(shared)) };

    render(
      <MemoryRouter>
        <SystemConfigProvider api={providerApi}>
          <ToastProvider>
            <SharedStoreName />
            <AdminPanel api={api} />
          </ToastProvider>
        </SystemConfigProvider>
      </MemoryRouter>,
    );
    await screen.findByText('Apotek Sehat');
    expect(await screen.findByTestId('shared-store-name')).toHaveTextContent('Toko Lama');

    const storeNameInput = screen.getByTestId('admin-store-name');
    await userEvent.clear(storeNameInput);
    await userEvent.type(storeNameInput, 'Toko Baru');
    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    await waitFor(() =>
      expect(screen.getByTestId('shared-store-name')).toHaveTextContent('Toko Baru'),
    );
    // Exactly two shared probes: the mount resolution + the post-save refresh
    // (the panel's own reload uses its own api, not the shared one).
    expect(providerApi.getSystemConfig).toHaveBeenCalledTimes(2);
  });
});

describe('AdminPanel manual override operations (QUE-25 / FR-ADM-02)', () => {
  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderOverridePanel() {
    const made = makeApi();
    renderPanel(made.api);
    return made;
  }

  /** Navigates to the manual-operations section (the manual-ops tests all
   *  operate there). The panel opens on profile by default. */
  async function openManual(): Promise<void> {
    await screen.findByText('Apotek Sehat');
    await goToSection('Operasi Manual');
  }

  it('manual-reset button triggers triggerManualReset and shows the result', async () => {
    const { triggerManualReset } = renderOverridePanel();
    await openManual();

    await userEvent.click(screen.getByTestId('manual-reset'));

    expect(triggerManualReset).toHaveBeenCalledTimes(1);
    // The outcome is a toast in the polite live region, not an inline paragraph.
    expect(await politeRegion().findByText(/kembali ke 1/)).toBeInTheDocument();
  });

  it('two rapid manual-reset taps produce exactly one call (synchronous double-tap guard)', async () => {
    const { triggerManualReset } = renderOverridePanel();
    await openManual();

    // Two clicks land in the same tick — the in-flight ref guard drops the
    // second so only one reset is sent (mirrors the kiosk double-tap guard).
    fireEvent.click(screen.getByTestId('manual-reset'));
    fireEvent.click(screen.getByTestId('manual-reset'));

    await politeRegion().findByText(/kembali ke 1/);
    expect(triggerManualReset).toHaveBeenCalledTimes(1);
  });

  it('manual-reset does not fire when the confirm dialog is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { triggerManualReset } = renderOverridePanel();
    await openManual();

    await userEvent.click(screen.getByTestId('manual-reset'));

    expect(triggerManualReset).not.toHaveBeenCalled();
  });

  it('manual-reset surfaces an error when the call rejects', async () => {
    const { api, triggerManualReset } = makeApi(configuredStore(), undefined, {
      manualReset: () => Promise.reject(new Error('core-api down')),
    });
    renderPanel(api);
    await openManual();

    await userEvent.click(screen.getByTestId('manual-reset'));

    // Failures are assertive (sticky) toasts, so they land in role="alert".
    expect(await alertRegion().findByText(/core-api down/)).toBeInTheDocument();
    expect(triggerManualReset).toHaveBeenCalledTimes(1);
  });

  it('cleanup button calls cleanupTransactionLogs with the retention value and shows the result', async () => {
    const { cleanupTransactionLogs } = renderOverridePanel();
    await openManual();

    await userEvent.click(screen.getByTestId('cleanup-run'));

    expect(cleanupTransactionLogs).toHaveBeenCalledWith(90);
    expect(await politeRegion().findByText(/5 transaksi/)).toBeInTheDocument();
  });

  it('cleanup button is disabled and shows an error when retentionDays is below the 7-day floor', async () => {
    const { cleanupTransactionLogs } = renderOverridePanel();
    await openManual();

    // Controlled numeric input bound to state — set via fireEvent.change per
    // the CLAUDE.md controlled-numeric-input gotcha.
    fireEvent.change(screen.getByTestId('retention-days'), { target: { value: '1' } });

    expect(screen.getByTestId('retention-error')).toBeInTheDocument();
    expect(screen.getByTestId('cleanup-run')).toBeDisabled();

    await userEvent.click(screen.getByTestId('cleanup-run'));
    expect(cleanupTransactionLogs).not.toHaveBeenCalled();
  });

  it('wires the retention error to its input via aria-invalid + aria-describedby (QUE-41 AC6)', async () => {
    renderOverridePanel();
    await openManual();

    const retentionInput = screen.getByTestId('retention-days');
    // Default 90 is valid — no error attributes.
    expect(retentionInput).not.toHaveAttribute('aria-invalid');
    expect(retentionInput).not.toHaveAttribute('aria-describedby');

    // Below the 7-day floor → the error <p> renders and the input is wired to it.
    fireEvent.change(retentionInput, { target: { value: '1' } });
    expect(retentionInput).toHaveAttribute('aria-invalid', 'true');
    expect(retentionInput).toHaveAttribute('aria-describedby', 'retention-error');
    expect(screen.getByTestId('retention-error')).toHaveAttribute('id', 'retention-error');
  });

  it('cleanup does not fire when the confirm dialog is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { cleanupTransactionLogs } = renderOverridePanel();
    await openManual();

    await userEvent.click(screen.getByTestId('cleanup-run'));

    expect(cleanupTransactionLogs).not.toHaveBeenCalled();
  });
});
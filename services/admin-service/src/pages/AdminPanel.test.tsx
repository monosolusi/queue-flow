import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminPanel } from './AdminPanel';
import type { IAdminApi } from '../api/admin-api';
import {
  DEFAULT_STATE_MACHINE,
  DEFAULT_BRAND_COLOR,
  type CleanupTransactionLogResultDto,
  type ManualResetResultDto,
  type SaveSystemConfigurationPayload,
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
    },
    categories: [
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Farmasi' },
    ],
    routingRules: [
      { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: ['cat-a'], priorityPolicy: 'FIFO_GLOBAL' },
    ],
    brandColor: DEFAULT_BRAND_COLOR,
  };
}

function makeApi(
  config: SystemConfigurationDto = configuredStore(),
  saveImpl?: (payload: SaveSystemConfigurationPayload) => Promise<{ isInitialSetupCompleted: boolean; storeName: string; brandColor: string }>,
  overrides?: {
    manualReset?: () => Promise<ManualResetResultDto>;
    cleanup?: (retentionDays: number) => Promise<CleanupTransactionLogResultDto>;
  },
) {
  const save = vi.fn(
    saveImpl ??
      ((payload: SaveSystemConfigurationPayload) =>
        Promise.resolve({ isInitialSetupCompleted: true, storeName: payload.storeName, brandColor: payload.brandColor })),
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
    getAuditLog: vi.fn(),
    triggerManualReset,
    cleanupTransactionLogs,
  };
  return { api, save, getConfig, triggerManualReset, cleanupTransactionLogs };
}

function renderPanel(api: IAdminApi) {
  return render(
    <MemoryRouter>
      <AdminPanel api={api} />
    </MemoryRouter>,
  );
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
    // Categories prefilled with existing names.
    expect(screen.getByLabelText('Kategori 1 kode')).toHaveValue('A');
    expect(screen.getByLabelText('Kategori 1 nama')).toHaveValue('Customer Service');
    // Routing assignment mapped from id 'cat-a' -> code 'A' (checkbox checked).
    expect(screen.getByRole('checkbox', { name: 'A' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'B' })).not.toBeChecked();
    // State machine is read-only (no editable transition inputs).
    expect(screen.getByText('Alur Status Tiket (hanya lihat)')).toBeInTheDocument();
  });

  it('preserves existing category ids and omits id for newly added ones on save', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

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

    // Assign category B to Counter 1, and switch policy to CATEGORY_PRIORITY.
    await userEvent.click(screen.getByRole('checkbox', { name: 'B' }));
    await userEvent.selectOptions(screen.getByLabelText('Counter 1 kebijakan prioritas'), 'CATEGORY_PRIORITY');

    // Add a second counter.
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

    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'MANUAL');
    await userEvent.clear(screen.getByLabelText('Reset nomor antrian ke'));
    await userEvent.type(screen.getByLabelText('Reset nomor antrian ke'), '10');
    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.dailyReset.mode).toBe('MANUAL');
    expect(payload.dailyReset.cronExpression).toBeNull();
    expect(payload.dailyReset.resetTicketNumberTo).toBe(10);
  });

  it('passes storeName and stateMachine through unchanged', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    await userEvent.click(screen.getByTestId('admin-save'));
    await screen.findByText('Konfigurasi tersimpan.');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.storeName).toBe('Apotek Sehat');
    expect(payload.stateMachine.transitions).toHaveLength(5);
    expect(payload.stateMachine.transitions[0].actionLabel).toBe('Panggil Berikutnya');
    // brandColor is editable (AC3) and prefilled from the loaded config.
    expect(payload.brandColor).toBe(DEFAULT_BRAND_COLOR);
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

    // Build [1, 2, 3].
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Counter' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Counter' }));
    // Remove the middle counter (Counter 2, id=2) -> survivors [1, 3].
    await userEvent.click(within(rowOf('Counter 2 id')).getByRole('button', { name: 'Hapus' }));
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
    expect(await screen.findByText(/kode kategori tidak valid/i)).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();
  });

  it('derives the cron expression from the daily-reset time picker (FR-WZD-05 / QUE-34)', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

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

  it('manual-reset button triggers triggerManualReset and shows the result', async () => {
    const { triggerManualReset } = renderOverridePanel();
    await screen.findByText('Apotek Sehat');

    await userEvent.click(screen.getByTestId('manual-reset'));

    expect(triggerManualReset).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('reset-result')).toBeInTheDocument();
    expect(screen.getByTestId('reset-result').textContent).toContain('kembali ke 1');
  });

  it('two rapid manual-reset taps produce exactly one call (synchronous double-tap guard)', async () => {
    const { triggerManualReset } = renderOverridePanel();
    await screen.findByText('Apotek Sehat');

    // Two clicks land in the same tick — the in-flight ref guard drops the
    // second so only one reset is sent (mirrors the kiosk double-tap guard).
    fireEvent.click(screen.getByTestId('manual-reset'));
    fireEvent.click(screen.getByTestId('manual-reset'));

    await screen.findByTestId('reset-result');
    expect(triggerManualReset).toHaveBeenCalledTimes(1);
  });

  it('manual-reset does not fire when the confirm dialog is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { triggerManualReset } = renderOverridePanel();
    await screen.findByText('Apotek Sehat');

    await userEvent.click(screen.getByTestId('manual-reset'));

    expect(triggerManualReset).not.toHaveBeenCalled();
  });

  it('manual-reset surfaces an error when the call rejects', async () => {
    const { api, triggerManualReset } = makeApi(configuredStore(), undefined, {
      manualReset: () => Promise.reject(new Error('core-api down')),
    });
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    await userEvent.click(screen.getByTestId('manual-reset'));

    expect(await screen.findByTestId('reset-error')).toBeInTheDocument();
    expect(screen.getByTestId('reset-error').textContent).toContain('core-api down');
    expect(triggerManualReset).toHaveBeenCalledTimes(1);
  });

  it('cleanup button calls cleanupTransactionLogs with the retention value and shows the result', async () => {
    const { cleanupTransactionLogs } = renderOverridePanel();
    await screen.findByText('Apotek Sehat');

    await userEvent.click(screen.getByTestId('cleanup-run'));

    expect(cleanupTransactionLogs).toHaveBeenCalledWith(90);
    expect(await screen.findByTestId('cleanup-result')).toBeInTheDocument();
    expect(screen.getByTestId('cleanup-result').textContent).toContain('5 transaksi');
  });

  it('cleanup button is disabled and shows an error when retentionDays is below the 7-day floor', async () => {
    const { cleanupTransactionLogs } = renderOverridePanel();
    await screen.findByText('Apotek Sehat');

    // Controlled numeric input bound to state — set via fireEvent.change per
    // the CLAUDE.md controlled-numeric-input gotcha.
    fireEvent.change(screen.getByTestId('retention-days'), { target: { value: '1' } });

    expect(screen.getByTestId('retention-error')).toBeInTheDocument();
    expect(screen.getByTestId('cleanup-run')).toBeDisabled();

    await userEvent.click(screen.getByTestId('cleanup-run'));
    expect(cleanupTransactionLogs).not.toHaveBeenCalled();
  });

  it('cleanup does not fire when the confirm dialog is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { cleanupTransactionLogs } = renderOverridePanel();
    await screen.findByText('Apotek Sehat');

    await userEvent.click(screen.getByTestId('cleanup-run'));

    expect(cleanupTransactionLogs).not.toHaveBeenCalled();
  });
});
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminPanel } from './AdminPanel';
import type { IAdminApi } from '../api/admin-api';
import {
  DEFAULT_STATE_MACHINE,
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
  };
}

function makeApi(
  config: SystemConfigurationDto = configuredStore(),
  saveImpl?: (payload: SaveSystemConfigurationPayload) => Promise<{ isInitialSetupCompleted: boolean; storeName: string }>,
) {
  const save = vi.fn(
    saveImpl ??
      ((payload: SaveSystemConfigurationPayload) =>
        Promise.resolve({ isInitialSetupCompleted: true, storeName: payload.storeName })),
  );
  // The panel reloads the config after a successful save; default to returning
  // the same config (with ids preserved) so the post-save repopulate succeeds.
  const getConfig = vi.fn(() => Promise.resolve(config));
  const api: IAdminApi = {
    getSystemConfig: getConfig,
    saveSystemConfig: save,
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
  };
  return { api, save, getConfig };
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
    expect(screen.getByText('State Machine (read-only)')).toBeInTheDocument();
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
    await userEvent.selectOptions(screen.getByLabelText('Counter 1 priority policy'), 'CATEGORY_PRIORITY');

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

  it('disables save and shows an error when the cron expression is malformed (FR-WZD-05 / QUE-16)', async () => {
    const { api, save } = makeApi();
    renderPanel(api);
    await screen.findByText('Apotek Sehat');

    // The default cron '0 0 * * *' is valid → save enabled, no error.
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();
    expect(screen.queryByTestId('cron-error')).not.toBeInTheDocument();

    // Enter a malformed cron (out-of-range hour field) → save disabled, error shown.
    await userEvent.clear(screen.getByLabelText('Cron expression'));
    await userEvent.type(screen.getByLabelText('Cron expression'), '0 99 * * *');
    expect(screen.getByTestId('cron-error')).toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).toBeDisabled();

    // A save click is blocked — nothing is sent with a malformed cron.
    await userEvent.click(screen.getByTestId('admin-save'));
    expect(save).not.toHaveBeenCalled();

    // Fix it → error clears and save re-enables.
    await userEvent.clear(screen.getByLabelText('Cron expression'));
    await userEvent.type(screen.getByLabelText('Cron expression'), '0 0 * * *');
    expect(screen.queryByTestId('cron-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-save')).not.toBeDisabled();
  });
});
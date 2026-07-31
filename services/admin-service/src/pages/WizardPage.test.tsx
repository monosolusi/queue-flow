import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WizardPage } from './WizardPage';
import type { IAdminApi } from '../api/admin-api';
import { DEFAULT_STATE_MACHINE, type SaveSystemConfigurationPayload, type SystemConfigurationDto } from '../api/types';

/** A clean store mirrors core-api's `GetSystemConfigurationUseCase`: the default
 *  state machine is returned even before setup (so the wizard is prefilled). */
function cleanStore(): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: false,
    storeName: '',
    stateMachine: DEFAULT_STATE_MACHINE,
    dailyResetPolicy: { mode: 'AUTOMATIC_CRON', cronExpression: '0 0 * * *', resetTicketNumberTo: 1, archivePreviousDayData: true },
    categories: [],
    routingRules: [],
  };
}

function makeApi(
  config: SystemConfigurationDto = cleanStore(),
  saveImpl?: (payload: SaveSystemConfigurationPayload) => Promise<{ isInitialSetupCompleted: boolean; storeName: string }>,
) {
  const save = vi.fn(
    saveImpl ??
      ((payload: SaveSystemConfigurationPayload) =>
        Promise.resolve({ isInitialSetupCompleted: true, storeName: payload.storeName })),
  );
  const api: IAdminApi = {
    getSystemConfig: vi.fn(() => Promise.resolve(config)),
    saveSystemConfig: save,
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
  };
  return { api, save };
}

function renderWizard(api: IAdminApi) {
  return render(
    <MemoryRouter initialEntries={['/wizard']}>
      <Routes>
        <Route path="/wizard" element={<WizardPage api={api} />} />
        <Route path="/" element={<div>Admin Panel Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WizardPage (FR-WZD-02..06)', () => {
  it('walks all four steps and saves the configuration on finalize', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    // Step 1 — store name (FR-WZD-02).
    expect(await screen.findByTestId('step-1')).toBeInTheDocument();
    const nameInput = screen.getByPlaceholderText('mis. Apotek Sehat Sentosa');
    await userEvent.type(nameInput, 'Apotek Sehat Sentosa');
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Step 2 — categories + counters + routing (FR-WZD-03).
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    // The fallback category 'A' has an empty name; fill it.
    const categoryNameInput = screen.getByLabelText('Kategori 1 nama');
    await userEvent.type(categoryNameInput, 'Customer Service');
    // Assign category A to Counter 1.
    await userEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Step 3 — state machine designer with the PRD §7 default prefilled (FR-WZD-04).
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();
    // The five default transitions are prefilled (Panggil Berikutnya etc.).
    expect(screen.getByDisplayValue('Panggil Berikutnya')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Selesai Layan')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Step 4 — daily reset policy (FR-WZD-05).
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-finalize'));

    // Navigation to the admin home (FR-WZD-06 — operational access after setup).
    expect(await screen.findByText('Admin Panel Home')).toBeInTheDocument();

    // The PUT payload carries the entered store name, the category, the
    // routing assignment, the default state machine, and the daily-reset
    // policy with actor 'admin' (NFR-SEC-02).
    expect(save).toHaveBeenCalledTimes(1);
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.storeName).toBe('Apotek Sehat Sentosa');
    expect(payload.categories).toEqual([{ code: 'A', name: 'Customer Service' }]);
    expect(payload.routingRules).toHaveLength(1);
    expect(payload.routingRules[0].assignedCategoryCodes).toEqual(['A']);
    expect(payload.routingRules[0].priorityPolicy).toBe('FIFO_GLOBAL');
    expect(payload.stateMachine.transitions).toHaveLength(5);
    expect(payload.stateMachine.transitions[0].actionLabel).toBe('Panggil Berikutnya');
    expect(payload.dailyReset.mode).toBe('AUTOMATIC_CRON');
    expect(payload.dailyReset.cronExpression).toBe('0 0 * * *');
    expect(payload.dailyReset.resetTicketNumberTo).toBe(1);
    expect(payload.actor).toBe('admin');
  });

  it('lets the manager move back between steps', async () => {
    const { api } = makeApi();
    renderWizard(api);

    expect(await screen.findByTestId('step-1')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Kembali'));
    expect(await screen.findByTestId('step-1')).toBeInTheDocument();
  });

  it('nulls the cron expression when daily-reset mode is MANUAL', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    // Skip to step 4 via three "Lanjut" clicks.
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();

    // Switch mode to MANUAL.
    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'MANUAL');
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.dailyReset.mode).toBe('MANUAL');
    expect(payload.dailyReset.cronExpression).toBeNull();
  });

  it('surfaces an error and re-enables finalize when the save fails', async () => {
    const { api, save } = makeApi(cleanStore(), () =>
      Promise.reject(new Error('state machine tidak valid')),
    );
    renderWizard(api);

    // Walk to step 4 and finalize.
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-finalize'));

    expect(await screen.findByText(/state machine tidak valid/i)).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    // Finalize is re-enabled (not stuck in "Menyimpan…").
    expect(screen.getByTestId('wizard-finalize')).not.toBeDisabled();
  });
});
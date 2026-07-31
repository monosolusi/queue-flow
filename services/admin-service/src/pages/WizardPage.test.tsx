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
  it('walks all five steps, renders the review, and saves the configuration on finalize', async () => {
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
    // Default mode renders the five default transitions read-only (no inputs).
    expect(screen.getByTestId('sm-readonly')).toBeInTheDocument();
    expect(screen.getByText('Panggil Berikutnya')).toBeInTheDocument();
    expect(screen.getByText('Selesai Layan')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Step 4 — daily reset policy (FR-WZD-05).
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Step 5 — review & activate (FR-WZD-06).
    expect(await screen.findByTestId('step-5')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-review')).toBeInTheDocument();
    expect(screen.getByTestId('review-store-name')).toHaveTextContent('Apotek Sehat Sentosa');
    expect(screen.getByTestId('review-categories')).toHaveTextContent(/Customer Service/);
    expect(screen.getByTestId('review-daily-reset')).toHaveTextContent(/Otomatis/);
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
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-5')).toBeInTheDocument();
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

    // Walk to step 5 (the review step) and finalize.
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-5')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-finalize'));

    expect(await screen.findByText(/state machine tidak valid/i)).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    // Finalize is re-enabled (not stuck in "Menyimpan…").
    expect(screen.getByTestId('wizard-finalize')).not.toBeDisabled();
  });

  it('infers custom mode when the prefilled graph differs from the PRD default', async () => {
    const customConfig: SystemConfigurationDto = {
      ...cleanStore(),
      stateMachine: {
        states: ['WAITING', 'CALLING', 'SERVING', 'PREPARING', 'COMPLETED'],
        transitions: [
          { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
          { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
          { from: 'SERVING', to: 'PREPARING', actionLabel: 'Siapkan' },
          { from: 'PREPARING', to: 'COMPLETED', actionLabel: 'Selesai Layan' },
        ],
      },
    };
    const { api } = makeApi(customConfig);
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();
    // A non-default graph opens in custom mode with the editor (not read-only).
    expect(screen.getByTestId('sm-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('sm-readonly')).not.toBeInTheDocument();
  });

  it('adds a custom state and transition and sends them (without mode) in the PUT payload', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    // Step 1 → 2 → 3.
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();

    // Switch to custom mode.
    await userEvent.click(screen.getByLabelText(/Susun state machine sendiri/));
    expect(screen.getByTestId('sm-editor')).toBeInTheDocument();

    // Add a PREPARING state, then a transition SERVING → PREPARING ("Siapkan").
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah State' }));
    const stateInputs = screen.getAllByLabelText(/^State \d+$/);
    await userEvent.type(stateInputs[stateInputs.length - 1], 'PREPARING');

    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Transisi' }));
    const fromSelects = screen.getAllByLabelText(/Transisi \d+ from/);
    const toSelects = screen.getAllByLabelText(/Transisi \d+ to/);
    const lastFrom = fromSelects[fromSelects.length - 1];
    const lastTo = toSelects[toSelects.length - 1];
    await userEvent.selectOptions(lastFrom, 'SERVING');
    await userEvent.selectOptions(lastTo, 'PREPARING');
    const labelInputs = screen.getAllByLabelText(/Transisi \d+ label aksi/);
    await userEvent.type(labelInputs[labelInputs.length - 1], 'Siapkan');

    // Advance to finalize — step 3 must be valid (Lanjut enabled).
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-5')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.stateMachine.states).toContain('PREPARING');
    expect(payload.stateMachine.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'SERVING', to: 'PREPARING', actionLabel: 'Siapkan' }),
      ]),
    );
    // `mode` is a UI-only preset and must never reach the wire payload.
    expect((payload.stateMachine as unknown as Record<string, unknown>).mode).toBeUndefined();
  });

  it('reverts to the default graph when switching back to default after editing custom', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');

    // Custom → add a stray state → back to default → finalize sends the PRD default.
    await userEvent.click(screen.getByLabelText(/Susun state machine sendiri/));
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah State' }));
    await userEvent.click(screen.getByLabelText(/Gunakan state machine default/));
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-5')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.stateMachine.states).toEqual([...DEFAULT_STATE_MACHINE.states]);
    expect(payload.stateMachine.transitions).toHaveLength(5);
  });

  it('blocks removal of a state that is referenced by a transition', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByLabelText(/Susun state machine sendiri/));

    // WAITING is referenced by the default `WAITING -> CALLING` edge, so its
    // remove button must be disabled.
    const waitRemove = screen.getAllByRole('button', { name: 'Hapus' }).find((b) =>
      b.closest('.entry-row--state')?.querySelector('input')?.value === 'WAITING',
    );
    expect(waitRemove).toBeDefined();
    expect(waitRemove).toBeDisabled();
  });

  it('blocks advancing past step 3 when the custom graph is invalid (duplicate edge)', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByLabelText(/Susun state machine sendiri/));

    // Add a duplicate of the existing WAITING -> CALLING edge with an empty
    // label (two violations: duplicate edge + empty action label).
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Transisi' }));
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Still on step 3; Lanjut is disabled and no save happened.
    expect(screen.getByTestId('step-3')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-next')).toBeDisabled();
    expect(screen.getByTestId('sm-errors')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('renders a read-only review of the full configuration on step 5 (FR-WZD-06)', async () => {
    const { api } = makeApi();
    renderWizard(api);

    // Step 1 — store name.
    await (await screen.findByTestId('step-1'));
    await userEvent.type(screen.getByPlaceholderText('mis. Apotek Sehat Sentosa'), 'Apotek Sehat');
    await userEvent.click(screen.getByTestId('wizard-next'));
    // Step 2 — category A -> Customer Service, assign A to Counter 1.
    await screen.findByTestId('step-2');
    await userEvent.type(screen.getByLabelText('Kategori 1 nama'), 'Customer Service');
    await userEvent.click(screen.getByRole('checkbox', { name: 'A' }));
    await userEvent.click(screen.getByTestId('wizard-next'));
    // Step 3 — default state machine.
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    // Step 4 — daily reset (default automatic, valid cron).
    await screen.findByTestId('step-4');
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Step 5 — the review renders a summary of every assembled section.
    expect(await screen.findByTestId('step-5')).toBeInTheDocument();
    expect(screen.getByTestId('review-store-name')).toHaveTextContent('Apotek Sehat');
    expect(screen.getByTestId('review-categories')).toHaveTextContent(/Customer Service/);
    expect(screen.getByTestId('review-routing')).toHaveTextContent(/Counter 1/);
    expect(screen.getByTestId('review-state-machine')).toHaveTextContent(/Default/);
    expect(screen.getByTestId('review-daily-reset')).toHaveTextContent(/Otomatis/);
    expect(screen.getByTestId('review-daily-reset')).toHaveTextContent(/aktif/);
  });

  it('blocks advancing past step 4 when the cron expression is malformed (FR-WZD-05 / QUE-16)', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    // Walk to step 4.
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();

    // The default cron '0 0 * * *' is valid → Lanjut enabled, no error shown.
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    expect(screen.queryByTestId('cron-error')).not.toBeInTheDocument();

    // Enter a malformed cron (only 3 fields) → Lanjut disabled, error shown.
    await userEvent.clear(screen.getByLabelText('Cron expression'));
    await userEvent.type(screen.getByLabelText('Cron expression'), '0 0 *');
    expect(screen.getByTestId('cron-error')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-next')).toBeDisabled();

    // A click attempts to advance but the guard holds — still on step 4.
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('step-4')).toBeInTheDocument();

    // Fix the cron → error clears and Lanjut re-enables.
    await userEvent.clear(screen.getByLabelText('Cron expression'));
    await userEvent.type(screen.getByLabelText('Cron expression'), '0 0 * * *');
    expect(screen.queryByTestId('cron-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();

    expect(save).not.toHaveBeenCalled();
  });
});
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WizardPage } from './WizardPage';
import type { IAdminApi, IAuthApi } from '../api/admin-api';
import { DEFAULT_CATEGORIES, DEFAULT_STATE_MACHINE, DEFAULT_BRAND_COLOR, DEFAULT_SERVICE_THEMES, DEFAULT_TV_GRID_LAYOUT, type EdgeRoutingLayoutDto, type NodePositionsDto, type SaveSystemConfigurationPayload, type ServiceThemesMap, type SystemConfigurationDto, type TvGridLayout } from '../api/types';
import { BROWSER_TIMEZONE } from '../lib/timezone';

/** A clean store mirrors core-api's `GetSystemConfigurationUseCase`: the default
 *  state machine is returned even before setup (so the wizard is prefilled),
 *  and the default daily-reset policy carries the server's local IANA timezone
 *  (which equals the browser's zone on the single on-premise box — NFR-SEC-01). */
function cleanStore(): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: false,
    storeName: '',
    stateMachine: DEFAULT_STATE_MACHINE,
    dailyResetPolicy: { mode: 'AUTOMATIC_CRON', cronExpression: '0 0 * * *', resetTicketNumberTo: 1, archivePreviousDayData: true, timezone: BROWSER_TIMEZONE },
    categories: [],
    routingRules: [],
    brandColor: DEFAULT_BRAND_COLOR,
    serviceThemes: { ...DEFAULT_SERVICE_THEMES },
    tvPanelLayout: DEFAULT_TV_GRID_LAYOUT,
    edgeRoutingLayout: {},
    nodePositions: {},
  };
}

/** A clean store with a prefilled `storeName` so tests that only need to walk
 *  past step 1 don't have to type a name each time (the step-1 guard blocks
 *  advance while the name is empty). Tests that exercise the name field itself
 *  (typing flow, empty-name guard) use {@link cleanStore} instead. */
function prefilledStore(): SystemConfigurationDto {
  return { ...cleanStore(), storeName: 'Toko Contoh' };
}

function makeApi(
  config: SystemConfigurationDto = prefilledStore(),
  saveImpl?: (payload: SaveSystemConfigurationPayload) => Promise<{ isInitialSetupCompleted: boolean; storeName: string; brandColor: string; serviceThemes: ServiceThemesMap; tvPanelLayout: TvGridLayout; edgeRoutingLayout: EdgeRoutingLayoutDto; nodePositions: NodePositionsDto }>,
) {
  const save = vi.fn(
    saveImpl ??
      ((payload: SaveSystemConfigurationPayload) =>
        Promise.resolve({ isInitialSetupCompleted: true, storeName: payload.storeName, brandColor: payload.brandColor, serviceThemes: payload.serviceThemes, tvPanelLayout: payload.tvPanelLayout, edgeRoutingLayout: {}, nodePositions: {} })),
  );
  // Auth spies (QUE-43). First-run finalize calls setupInitialAdmin then login;
  // re-edit finalize calls neither. Defaults resolve so the happy-path walk
  // completes; tests override via the returned spies when they assert ordering.
  const setupInitialAdmin = vi.fn(
    (username: string) => Promise.resolve({ id: 'admin-id', username, role: 'admin' as const, createdAt: 0 }),
  );
  const login = vi.fn(
    (username: string) =>
      Promise.resolve({ token: 'test-token', user: { id: 'admin-id', username, role: 'admin' as const } }),
  );
  const api: IAdminApi & IAuthApi = {
    getSystemConfig: vi.fn(() => Promise.resolve(config)),
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
    login,
    logout: vi.fn(() => Promise.resolve()),
    getMe: vi.fn(),
    setupInitialAdmin,
  };
  return { api, save, setupInitialAdmin, login };
}

function renderWizard(api: IAdminApi & IAuthApi) {
  return render(
    <MemoryRouter initialEntries={['/wizard']}>
      <Routes>
        <Route path="/wizard" element={<WizardPage api={api} />} />
        <Route path="/" element={<div>Admin Panel Home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Step-2 guard helper. The wizard now blocks advancing past step 2 until at
 *  least one counter serves a category (FR-WZD-03 feedback: "jika belum ada
 *  kategori dilayani, tidak bisa next"). Assigns "Customer Service" (code A)
 *  to Counter 1 via the edit modal so a test that only needs to walk past step
 *  2 can do so without re-asserting the combobox flow each time. Call after the
 *  step-1 → step-2 `wizard-next` click. */
async function assignCategoryOnStep2() {
  await screen.findByTestId('step-2');
  await userEvent.click(screen.getByTestId('routing-edit-0'));
  const search = screen.getByRole('combobox', { name: /Kategori dilayani/ });
  await userEvent.type(search, 'Customer');
  await userEvent.click(screen.getByRole('option', { name: /Customer Service/ }));
  await userEvent.click(screen.getByTestId('routing-modal-save'));
}

/**
 * Step-5 admin-credentials helper (QUE-43, first-run only). The new step 5
 * requires a valid username + password + confirm before the Lanjut guard lets
 * the manager reach the review (now step 6). Tests that only need to walk past
 * the credentials step fill the defaults and advance. Call after the step-4 →
 * step-5 `wizard-next` click. On re-edit (setup already complete) the step is a
 * read-only notice and the Lanjut is already enabled — those tests click
 * `wizard-next` directly without this helper.
 */
async function fillAdminCredentialsOnStep5(username = 'admin', password = 'password123') {
  await screen.findByTestId('step-5');
  await userEvent.type(screen.getByTestId('admin-username'), username);
  await userEvent.type(screen.getByTestId('admin-password'), password);
  await userEvent.type(screen.getByTestId('admin-password-confirm'), password);
  await userEvent.click(screen.getByTestId('wizard-next'));
}

describe('WizardPage (FR-WZD-02..06)', () => {
  it('walks all six steps, renders the review, and saves the configuration on finalize', async () => {
    const { api, save, setupInitialAdmin, login } = makeApi(cleanStore());
    renderWizard(api);

    // Step 1 — store profile + counter count + categories (FR-WZD-02).
    expect(await screen.findByTestId('step-1')).toBeInTheDocument();
    const nameInput = screen.getByPlaceholderText('mis. Apotek Sehat Sentosa');
    await userEvent.type(nameInput, 'Apotek Sehat Sentosa');
    // Default category template (PRD §7) is prefilled and read-only, so no
    // category typing is needed; the counter count defaults to 1.
    expect(screen.getByTestId('cat-readonly')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Step 2 — routing matrix (FR-WZD-03). Assign category A to Counter 1 via
    // the edit modal + searchable category combobox (selected by name).
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const search = screen.getByRole('combobox', { name: /Kategori dilayani/ });
    await userEvent.type(search, 'Customer');
    await userEvent.click(screen.getByRole('option', { name: /Customer Service/ }));
    await userEvent.click(screen.getByTestId('routing-modal-save'));
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

    // Step 5 — admin credentials (QUE-43, first-run). Fill + advance to step 6.
    await fillAdminCredentialsOnStep5('manajer', 'rahasia123');

    // Step 6 — review & activate (FR-WZD-06).
    expect(await screen.findByTestId('step-6')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-review')).toBeInTheDocument();
    expect(screen.getByTestId('review-store-name')).toHaveTextContent('Apotek Sehat Sentosa');
    expect(screen.getByTestId('review-categories')).toHaveTextContent(/Customer Service/);
    expect(screen.getByTestId('review-daily-reset')).toHaveTextContent(/Otomatis/);
    expect(screen.getByTestId('review-brand-color')).toHaveTextContent(DEFAULT_BRAND_COLOR);
    expect(screen.getByTestId('review-admin-username')).toHaveTextContent('manajer');
    await userEvent.click(screen.getByTestId('wizard-finalize'));

    // Navigation to the admin home (FR-WZD-06 — operational access after setup).
    expect(await screen.findByText('Admin Panel Home')).toBeInTheDocument();

    // First-run finalize creates the initial admin BEFORE the config save
    // (setup-admin only works while setup is incomplete; the config save flips
    // it complete), then logs in with the just-created credentials.
    expect(setupInitialAdmin).toHaveBeenCalledTimes(1);
    expect(setupInitialAdmin).toHaveBeenCalledWith('manajer', 'rahasia123');
    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith('manajer', 'rahasia123');

    // The PUT payload carries the entered store name, the PRD §7 default
    // categories (no ids — backend mints them on first save), the routing
    // assignment, the default state machine, and the daily-reset policy. The
    // `actor` field is no longer sent (the server derives the audit actor from
    // the bearer token — QUE-43). `categoriesMode` is a UI-only preset and must
    // never reach the wire (mirrors `stateMachine.mode`).
    expect(save).toHaveBeenCalledTimes(1);
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.storeName).toBe('Apotek Sehat Sentosa');
    expect(payload.categories).toEqual(DEFAULT_CATEGORIES.map((c) => ({ ...c })));
    expect(payload.routingRules).toHaveLength(1);
    expect(payload.routingRules[0].assignedCategoryCodes).toEqual(['A']);
    expect(payload.routingRules[0].priorityPolicy).toBe('FIFO_GLOBAL');
    expect(payload.stateMachine.transitions).toHaveLength(5);
    expect(payload.stateMachine.transitions[0].actionLabel).toBe('Panggil Berikutnya');
    expect(payload.dailyReset.mode).toBe('AUTOMATIC_CRON');
    expect(payload.dailyReset.cronExpression).toBe('0 0 * * *');
    expect(payload.dailyReset.resetTicketNumberTo).toBe(1);
    expect(payload.brandColor).toBe(DEFAULT_BRAND_COLOR);
    expect((payload as unknown as Record<string, unknown>).actor).toBeUndefined();
    expect((payload as unknown as Record<string, unknown>).categoriesMode).toBeUndefined();
  });

  it('step-1 brand color defaults to the shared accent and the picker change reaches the payload', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    // Step 1 — the color picker prefills the shared --accent default.
    expect(await screen.findByTestId('step-1')).toBeInTheDocument();
    const picker = screen.getByLabelText('Pilih warna brand') as HTMLInputElement;
    expect(picker.value).toBe(DEFAULT_BRAND_COLOR);
    // Change the brand color via the hex text input.
    const hexInput = screen.getByPlaceholderText('#2563eb');
    await userEvent.clear(hexInput);
    fireEvent.change(hexInput, { target: { value: '#abcdef' } });

    // Walk to the review and finalize.
    await userEvent.click(screen.getByTestId('wizard-next'));
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await (await screen.findByTestId('step-3'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await (await screen.findByTestId('step-4'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await fillAdminCredentialsOnStep5();
    expect(await screen.findByTestId('step-6')).toBeInTheDocument();
    expect(screen.getByTestId('review-brand-color')).toHaveTextContent('#abcdef');
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.brandColor).toBe('#abcdef');
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

    // Skip to step 4 via three "Lanjut" clicks (assigning a category on step 2
    // so the step-2 guard lets the manager advance).
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();

    // Switch mode to MANUAL.
    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'MANUAL');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await fillAdminCredentialsOnStep5();
    expect(await screen.findByTestId('step-6')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.dailyReset.mode).toBe('MANUAL');
    expect(payload.dailyReset.cronExpression).toBeNull();
  });

  it('surfaces an error and re-enables finalize when the save fails', async () => {
    const { api, save } = makeApi(prefilledStore(), () =>
      Promise.reject(new Error('state machine tidak valid')),
    );
    renderWizard(api);

    // Walk to step 6 (the review step) and finalize.
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await fillAdminCredentialsOnStep5();
    expect(await screen.findByTestId('step-6')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-finalize'));

    expect(await screen.findByText(/state machine tidak valid/i)).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    // Finalize is re-enabled (not stuck in "Menyimpan…").
    expect(screen.getByTestId('wizard-finalize')).not.toBeDisabled();
  });

  it('infers custom mode when the prefilled graph differs from the PRD default', async () => {
    const customConfig: SystemConfigurationDto = {
      ...prefilledStore(),
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
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();
    // A non-default graph opens in custom mode with the editor (not read-only).
    expect(screen.getByTestId('sm-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('sm-readonly')).not.toBeInTheDocument();
  });

  it('adds a custom state and transition and sends them (without mode) in the PUT payload', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    // Step 1 → 2 → 3 (assign a category on step 2 so the guard lets it advance).
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();

    // Switch to custom mode.
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));
    expect(screen.getByTestId('sm-editor')).toBeInTheDocument();

    // Add a PREPARING state, then a transition SERVING → PREPARING ("Siapkan").
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Status' }));
    const stateInputs = screen.getAllByLabelText(/^Status \d+$/);
    await userEvent.type(stateInputs[stateInputs.length - 1], 'PREPARING');

    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Transisi' }));
    const fromSelects = screen.getAllByLabelText(/Transisi \d+ dari/);
    const toSelects = screen.getAllByLabelText(/Transisi \d+ ke/);
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
    await fillAdminCredentialsOnStep5();
    expect(await screen.findByTestId('step-6')).toBeInTheDocument();
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
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');

    // Custom → add a stray state → back to default → finalize sends the PRD default.
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Status' }));
    await userEvent.click(screen.getByLabelText(/Gunakan alur status standar/));
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await fillAdminCredentialsOnStep5();
    expect(await screen.findByTestId('step-6')).toBeInTheDocument();
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
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));

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
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));

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

  it('renders a read-only review of the full configuration on step 6 (FR-WZD-06)', async () => {
    const { api } = makeApi(cleanStore());
    renderWizard(api);

    // Step 1 — store name (default category template prefilled, read-only).
    await (await screen.findByTestId('step-1'));
    await userEvent.type(screen.getByPlaceholderText('mis. Apotek Sehat Sentosa'), 'Apotek Sehat');
    await userEvent.click(screen.getByTestId('wizard-next'));
    // Step 2 — assign category A to Counter 1 via the edit modal.
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const search = screen.getByRole('combobox', { name: /Kategori dilayani/ });
    await userEvent.type(search, 'Customer');
    await userEvent.click(screen.getByRole('option', { name: /Customer Service/ }));
    await userEvent.click(screen.getByTestId('routing-modal-save'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    // Step 3 — default state machine.
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    // Step 4 — daily reset (default automatic, valid cron).
    await screen.findByTestId('step-4');
    await userEvent.click(screen.getByTestId('wizard-next'));
    // Step 5 — admin credentials (first-run). Fill + advance to step 6.
    await fillAdminCredentialsOnStep5();

    // Step 6 — the review renders a summary of every assembled section.
    expect(await screen.findByTestId('step-6')).toBeInTheDocument();
    expect(screen.getByTestId('review-store-name')).toHaveTextContent('Apotek Sehat');
    expect(screen.getByTestId('review-categories')).toHaveTextContent(/Customer Service/);
    // The routing review is now an auto-generated SVG graph (jsdom doesn't
    // traverse SVG <text> via toHaveTextContent reliably), so assert the
    // summary aria-label carries the counter/category counts instead.
    expect(screen.getByRole('img', { name: /Grafik routing: 1 counter, 1 kategori/ })).toBeInTheDocument();
    expect(screen.getByTestId('review-state-machine')).toHaveTextContent(/Standar/);
    expect(screen.getByTestId('review-daily-reset')).toHaveTextContent(/Otomatis/);
    expect(screen.getByTestId('review-daily-reset')).toHaveTextContent(/aktif/);
  });

  it('derives the cron expression from the daily-reset time picker (FR-WZD-05 / QUE-34)', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    // Walk to step 4.
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();

    // The default cron '0 0 * * *' maps to 00:00 → Lanjut enabled, no error.
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    expect(screen.queryByTestId('cron-error')).not.toBeInTheDocument();

    // Pick 08:30 → the form derives the cron client-side (MM HH * * * → 30 8 * * *).
    // The time picker constrains input so no malformed cron can be produced.
    fireEvent.change(screen.getByLabelText('Waktu reset harian'), { target: { value: '08:30' } });
    expect(screen.queryByTestId('cron-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();

    await userEvent.click(screen.getByTestId('wizard-next'));
    await fillAdminCredentialsOnStep5();
    expect(await screen.findByTestId('step-6')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.dailyReset.mode).toBe('AUTOMATIC_CRON');
    expect(payload.dailyReset.cronExpression).toBe('30 8 * * *');
  });

  it('switches to custom categories, adds a category, and sends the custom list (without mode) in the PUT payload', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    // Step 1 — switch to custom categories and add a third category C / Farmasi.
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByLabelText(/Susun kategori sendiri/));
    expect(screen.getByTestId('cat-editor')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Kategori' }));
    const codeInputs = screen.getAllByLabelText(/^Kategori \d+ kode$/);
    const nameInputs = screen.getAllByLabelText(/^Kategori \d+ nama$/);
    await userEvent.type(codeInputs[codeInputs.length - 1], 'C');
    await userEvent.type(nameInputs[nameInputs.length - 1], 'Farmasi');
    // Custom list is valid (A, B, C — all uppercase, non-empty, unique) → Lanjut enabled.
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Walk the remaining steps to finalize.
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-4');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await fillAdminCredentialsOnStep5();
    await screen.findByTestId('step-6');
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'C', name: 'Farmasi' }),
        expect.objectContaining({ code: 'A', name: 'Customer Service' }),
      ]),
    );
    expect(payload.categories).toHaveLength(3);
    // `categoriesMode` is a UI-only preset and must never reach the wire.
    expect((payload as unknown as Record<string, unknown>).categoriesMode).toBeUndefined();
  });

  it('blocks advancing past step 1 when a custom category has a duplicate code', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByLabelText(/Susun kategori sendiri/));
    // Add a second category and set its code to A (collides with the prefilled A).
    await userEvent.click(screen.getByRole('button', { name: '+ Tambah Kategori' }));
    const codeInputs = screen.getAllByLabelText(/^Kategori \d+ kode$/);
    await userEvent.type(codeInputs[codeInputs.length - 1], 'A');

    expect(screen.getByTestId('cat-errors')).toBeInTheDocument();
    expect(screen.getByTestId('wizard-next')).toBeDisabled();

    // A click attempts to advance but the guard holds — still on step 1, no save.
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('step-1')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('syncs routing rule rows to the counter count input (add/remove)', async () => {
    const { api } = makeApi();
    renderWizard(api);

    // Step 1 — set the counter count to 3. The count input is a free-text
    // field (digits only, empty allowed) bound to `form.counterCount`, so
    // fireEvent.change works cleanly (the handler strips non-digits).
    await (await screen.findByTestId('step-1'));
    const countInput = screen.getByLabelText('Jumlah counter aktif');
    fireEvent.change(countInput, { target: { value: '3' } });
    await userEvent.click(screen.getByTestId('wizard-next'));

    // Step 2 — three counter rows are present (one Edit button per row).
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Edit counter \d+$/ })).toHaveLength(3);

    // Back to step 1, reduce to 1 → step 2 shows a single row. Re-query the
    // count input: the {step === N && ...} block unmounts step 1 on navigation,
    // so the previously-captured node is detached and its events would no-op.
    await userEvent.click(screen.getByText('Kembali'));
    await screen.findByTestId('step-1');
    fireEvent.change(screen.getByLabelText('Jumlah counter aktif'), { target: { value: '1' } });
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Edit counter \d+$/ })).toHaveLength(1);
  });

  it('clearing the counter count input blocks advance and shows the inline error', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    const countInput = screen.getByLabelText('Jumlah counter aktif');
    // Default is '1' → Lanjut enabled, no error.
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    expect(screen.queryByTestId('counter-count-errors')).not.toBeInTheDocument();

    // Clear the field → Lanjut disabled and the inline error list shows.
    fireEvent.change(countInput, { target: { value: '' } });
    expect(screen.getByTestId('wizard-next')).toBeDisabled();
    expect(screen.getByTestId('counter-count-errors')).toBeInTheDocument();
    // The routingRules are left at their last valid state (1 row) — the field
    // is empty but the routing-rule source of truth is not emptied.
    expect(screen.getByLabelText('Jumlah counter aktif')).toHaveValue('');

    // Type '2' → guard lifts, the error is gone, and advancing works.
    fireEvent.change(countInput, { target: { value: '2' } });
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    expect(screen.queryByTestId('counter-count-errors')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Edit counter \d+$/ })).toHaveLength(2);
  });

  it('strips non-digit characters from the counter count input', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    const countInput = screen.getByLabelText('Jumlah counter aktif');
    // Typing '3a' strips to '3' (digits only) and stays valid.
    fireEvent.change(countInput, { target: { value: '3a' } });
    expect(countInput).toHaveValue('3');
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    expect(screen.queryByTestId('counter-count-errors')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Edit counter \d+$/ })).toHaveLength(3);
  });

  it('prefills the counter count text from the loaded routing rules', async () => {
    // A configured store with two routing rules prefills the counter count as
    // '2' (text), matching the routingRules array length.
    const idA = '11111111-1111-4111-8111-111111111111';
    const configuredStore: SystemConfigurationDto = {
      ...cleanStore(),
      isInitialSetupCompleted: true,
      storeName: 'Toko Lama',
      categories: [{ id: idA, code: 'A', name: 'Customer Service' }],
      routingRules: [
        { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: [idA], priorityPolicy: 'FIFO_GLOBAL' },
        { counterId: 2, counterName: 'Counter 2', assignedCategoryIds: [], priorityPolicy: 'FIFO_GLOBAL' },
      ],
    };
    const { api } = makeApi(configuredStore);
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    expect(screen.getByLabelText('Jumlah counter aktif')).toHaveValue('2');
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
  });

  it('infers custom category mode when the prefilled categories differ from the PRD default', async () => {
    const customConfig: SystemConfigurationDto = {
      ...cleanStore(),
      categories: [{ id: '11111111-1111-4111-8111-111111111111', code: 'A', name: 'Farmasi' }],
    };
    const { api } = makeApi(customConfig);
    renderWizard(api);

    // A non-default category list opens step 1 in custom mode with the editor.
    await (await screen.findByTestId('step-1'));
    expect(screen.getByTestId('cat-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('cat-readonly')).not.toBeInTheDocument();
  });

  it('preserves existing category ids when re-editing a default-category store', async () => {
    // A store that saved the default preset carries ids on A/B. Keeping the
    // default mode and re-saving MUST reuse those ids (not mint new ones) so
    // existing QueueTicket.categoryId references stay valid.
    const idA = '11111111-1111-4111-8111-111111111111';
    const idB = '22222222-2222-4222-8222-222222222222';
    const configuredStore: SystemConfigurationDto = {
      ...cleanStore(),
      isInitialSetupCompleted: true,
      storeName: 'Toko Lama',
      categories: [
        { id: idA, code: 'A', name: 'Customer Service' },
        { id: idB, code: 'B', name: 'Kasir & Pembayaran' },
      ],
      routingRules: [
        { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: [idA], priorityPolicy: 'FIFO_GLOBAL' },
      ],
    };
    const { api, save } = makeApi(configuredStore);
    renderWizard(api);

    // Step 1 opens in default mode (inferred by code+name, ignoring id) and is
    // read-only. Walk to finalize without touching categories — Counter 1 is
    // already assigned category A by the prefill, so the step-2 guard passes.
    await (await screen.findByTestId('step-1'));
    expect(screen.getByTestId('cat-readonly')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-4');
    await userEvent.click(screen.getByTestId('wizard-next'));
    // Re-edit (setup already complete) — step 5 is a read-only notice (no
    // credentials form); advance to the review.
    await screen.findByTestId('step-5');
    expect(screen.getByTestId('admin-readonly')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-6');
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.categories).toEqual([
      { id: idA, code: 'A', name: 'Customer Service' },
      { id: idB, code: 'B', name: 'Kasir & Pembayaran' },
    ]);
  });

  it('preserves original category ids across a custom detour that removes a row', async () => {
    // The default-mode force-reset draws its id pool from the prefill, not the
    // live editable list — so a custom detour that removes category A, then
    // switches back to default, MUST still reuse A's original id (not mint a
    // fresh one and orphan every QueueTicket.categoryId that referenced it).
    const idA = '11111111-1111-4111-8111-111111111111';
    const idB = '22222222-2222-4222-8222-222222222222';
    const configuredStore: SystemConfigurationDto = {
      ...cleanStore(),
      isInitialSetupCompleted: true,
      storeName: 'Toko Lama',
      categories: [
        { id: idA, code: 'A', name: 'Customer Service' },
        { id: idB, code: 'B', name: 'Kasir & Pembayaran' },
      ],
      routingRules: [
        { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: [idA], priorityPolicy: 'FIFO_GLOBAL' },
      ],
    };
    const { api, save } = makeApi(configuredStore);
    renderWizard(api);

    // Step 1 opens in default mode; switch to custom, remove category A, switch back.
    await (await screen.findByTestId('step-1'));
    expect(screen.getByTestId('cat-readonly')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Susun kategori sendiri/));
    // Remove the first category row (A).
    await userEvent.click(screen.getAllByRole('button', { name: 'Hapus' })[0]);
    expect(screen.getAllByLabelText(/^Kategori \d+ kode$/)).toHaveLength(1);
    // Switch back to default — A reappears with its ORIGINAL id from the prefill.
    await userEvent.click(screen.getByLabelText(/Gunakan kategori standar/));
    expect(screen.getByTestId('cat-readonly')).toBeInTheDocument();

    // Walk to finalize — Counter 1 is already assigned category A by the
    // prefill, so the step-2 guard passes without re-touching the routing.
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-4');
    await userEvent.click(screen.getByTestId('wizard-next'));
    // Re-edit — step 5 read-only notice; advance to the review.
    await screen.findByTestId('step-5');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-6');
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.categories).toEqual([
      { id: idA, code: 'A', name: 'Customer Service' },
      { id: idB, code: 'B', name: 'Kasir & Pembayaran' },
    ]);
  });

  it('marks the active step dot with aria-current="step" and clears it on advance (QUE-41 AC14)', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await screen.findByTestId('step-1');
    // Scope to the step bar so category-list <li>s don't pollute the query.
    const stepsBar = screen.getByRole('list', { name: 'Langkah wizard' });
    const dots = within(stepsBar).getAllByRole('listitem');
    // The step bar carries exactly 6 dots.
    expect(dots).toHaveLength(6);
    // Exactly one dot carries aria-current="step", and it is the first (step 1).
    const current = dots.filter((d) => d.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('1');

    // Advance to step 2 → aria-current moves to the second dot.
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');
    const dots2 = within(screen.getByRole('list', { name: 'Langkah wizard' })).getAllByRole('listitem');
    const current2 = dots2.filter((d) => d.getAttribute('aria-current') === 'step');
    expect(current2).toHaveLength(1);
    expect(current2[0]).toHaveTextContent('2');
  });

  it('wires the brand-color hex error to its input via aria-invalid + aria-describedby (QUE-41 AC6)', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await screen.findByTestId('step-1');
    const hexInput = screen.getByLabelText('Kode hex warna brand');
    // Happy path — no error attributes.
    expect(hexInput).not.toHaveAttribute('aria-invalid');
    expect(hexInput).not.toHaveAttribute('aria-describedby');

    // Type a malformed hex → the error list renders and the input is wired to it.
    fireEvent.change(hexInput, { target: { value: 'not-a-color' } });
    expect(hexInput).toHaveAttribute('aria-invalid', 'true');
    expect(hexInput).toHaveAttribute('aria-describedby', 'brand-color-errors');
    expect(screen.getByTestId('brand-color-errors')).toHaveAttribute('id', 'brand-color-errors');
  });

  it('marks the step-1 store-name input as required (QUE-41 AC6)', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await screen.findByTestId('step-1');
    const storeNameInput = screen.getByPlaceholderText('mis. Apotek Sehat Sentosa');
    expect(storeNameInput).toHaveAttribute('required');
  });

  it('blocks step-1 advance while the store name is empty and shows an inline error (client-side presence guard)', async () => {
    // The `required` attribute only fires on native form submit, not on the
    // Lanjut onClick — so step1Valid gates the button. With an empty name the
    // button is disabled and an inline error appears; typing a name enables it.
    const { api } = makeApi(cleanStore());
    renderWizard(api);

    await screen.findByTestId('step-1');
    expect(screen.getByTestId('wizard-next')).toBeDisabled();
    expect(screen.getByTestId('store-name-errors')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('mis. Apotek Sehat Sentosa'), 'Toko Sehat');
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    expect(screen.queryByTestId('store-name-errors')).not.toBeInTheDocument();
  });

  it('marks custom-mode category inputs with aria-required (QUE-41 AC6)', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await screen.findByTestId('step-1');
    await userEvent.click(screen.getByLabelText(/Susun kategori sendiri/));
    expect(screen.getByTestId('cat-editor')).toBeInTheDocument();
    // The category editor group exposes a labelled region for AT.
    expect(screen.getByRole('group', { name: 'Daftar kategori' })).toBeInTheDocument();

    const codeInputs = screen.getAllByLabelText(/^Kategori \d+ kode$/);
    expect(codeInputs[0]).toHaveAttribute('aria-required', 'true');
    const nameInputs = screen.getAllByLabelText(/^Kategori \d+ nama$/);
    expect(nameInputs[0]).toHaveAttribute('aria-required', 'true');
  });

  it('Step 2 modal Simpan persists counter name, priority, and category names', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();

    // Open the edit modal for Counter 1, change its name, priority, and assign
    // a category by name.
    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const nameInput = screen.getByLabelText('Counter 1 nama');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Loket Penerimaan');
    await userEvent.selectOptions(screen.getByLabelText('Counter 1 kebijakan prioritas'), 'CATEGORY_PRIORITY');
    const search = screen.getByRole('combobox', { name: /Kategori dilayani/ });
    await userEvent.type(search, 'Kasir');
    await userEvent.click(screen.getByRole('option', { name: /Kasir & Pembayaran/ }));
    await userEvent.click(screen.getByTestId('routing-modal-save'));

    // The table cell now shows the friendly priority label + category name.
    expect(screen.getByTestId('routing-counter-name-0')).toHaveTextContent('Loket Penerimaan');
    expect(screen.getByTestId('routing-categories-0')).toHaveTextContent('Kasir & Pembayaran');
    expect(screen.getByTestId('routing-categories-0')).not.toHaveTextContent(/\bB\b/);

    // Walk to finalize and assert the wire payload carries the codes.
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-4');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await fillAdminCredentialsOnStep5();
    await screen.findByTestId('step-6');
    await userEvent.click(screen.getByTestId('wizard-finalize'));
    await screen.findByText('Admin Panel Home');

    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.routingRules[0].counterName).toBe('Loket Penerimaan');
    expect(payload.routingRules[0].priorityPolicy).toBe('CATEGORY_PRIORITY');
    expect(payload.routingRules[0].assignedCategoryCodes).toEqual(['B']);
  });

  it('Step 2 modal Batal discards edits', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('routing-edit-0'));
    await userEvent.type(screen.getByLabelText('Counter 1 nama'), 'Sementara');
    await userEvent.click(screen.getByText('Batal'));

    // The table cell still shows the original default name.
    expect(screen.getByTestId('routing-counter-name-0')).toHaveTextContent('Counter 1');
    expect(screen.getByTestId('routing-counter-name-0')).not.toHaveTextContent('Sementara');
  });

  it('Step 4 shows a timezone selector defaulting to the browser zone and a hint next to the time picker (QUE-42)', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-4')).toBeInTheDocument();

    // AUTOMATIC_CRON is the default → the time picker + tz selector render.
    const tzSelect = screen.getByTestId('tz-select') as HTMLSelectElement;
    // The selector defaults to the browser's IANA zone.
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(tzSelect.value).toBe(browserTz);
    // The selector is changeable — pick a different curated zone and assert it
    // reaches the form. Use a curated option that's guaranteed present and
    // different from the browser zone (Asia/Jakarta vs America/New_York).
    const targetTz =
      browserTz === 'America/New_York' ? 'Asia/Jakarta' : 'America/New_York';
    await userEvent.selectOptions(tzSelect, targetTz);
    expect(tzSelect.value).toBe(targetTz);

    // The hint still renders and reflects the selected zone's offset, matching
    // the existing CI-machine tz-agnostic regex ("Waktu setempat: <zone> (UTC±HH:MM)").
    const tzHint = screen.getByTestId('tz-hint');
    expect(tzHint).toHaveTextContent(/Waktu setempat: .+ \(UTC[+-]\d{2}:\d{2}\)/);
  });

  it('Step 6 daily-reset review includes the timezone label', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await assignCategoryOnStep2();
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-3');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-4');
    await userEvent.click(screen.getByTestId('wizard-next'));
    await fillAdminCredentialsOnStep5();
    expect(await screen.findByTestId('step-6')).toBeInTheDocument();

    const review = screen.getByTestId('review-daily-reset');
    expect(review).toHaveTextContent(/Otomatis/);
    expect(review).toHaveTextContent(/Waktu setempat/);
  });

  it('blocks advancing past step 2 until a category is assigned (feedback)', async () => {
    const { api, save } = makeApi();
    renderWizard(api);

    // Step 1 → 2 (no categories assigned yet on a clean store).
    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();

    // The guard: Lanjut is disabled and the empty-matrix hint shows.
    expect(screen.getByTestId('wizard-next')).toBeDisabled();
    expect(screen.getByTestId('routing-empty-hint')).toBeInTheDocument();

    // A click attempts to advance but the guard holds — still on step 2, no save.
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('step-2')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();

    // Assigning a category to Counter 1 lifts the guard and hides the hint.
    await assignCategoryOnStep2();
    expect(screen.queryByTestId('routing-empty-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('wizard-next')).not.toBeDisabled();
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-3')).toBeInTheDocument();
  });

  it('shows the short priority label + tooltip in the step-2 table (feedback)', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('step-2')).toBeInTheDocument();

    // The table cell carries the short label (no parenthetical), and the info
    // glyph carries the full explanation as its title tooltip + aria-label.
    const fifoInfo = screen.getByRole('img', { name: /Keterangan: .* urutan masuk/i });
    expect(fifoInfo).toBeInTheDocument();
    expect(fifoInfo).toHaveAttribute('title');
    expect(fifoInfo.getAttribute('title')).toMatch(/lebih dulu/i);
    // The short label is present; the long parenthetical is not inlined.
    expect(screen.getByText('Urutan masuk')).toBeInTheDocument();
    expect(screen.queryByText(/yang lebih dulu dilayani lebih dulu/i)).not.toBeInTheDocument();
  });

  it('shows the priority description hint under the modal select and updates on change', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');

    await userEvent.click(screen.getByTestId('routing-edit-0'));
    const desc = await screen.findByTestId('routing-priority-desc');
    // Default FIFO_GLOBAL → its description.
    expect(desc).toHaveTextContent(/urutan masuk/i);

    // Switch to CATEGORY_PRIORITY → the description hint follows the pick.
    await userEvent.selectOptions(screen.getByLabelText('Counter 1 kebijakan prioritas'), 'CATEGORY_PRIORITY');
    expect(desc).toHaveTextContent(/prioritas lebih tinggi/i);
  });

  it('returns focus to the Edit button when the routing modal closes (a11y 2.4.3)', async () => {
    const { api } = makeApi();
    renderWizard(api);

    await (await screen.findByTestId('step-1'));
    await userEvent.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('step-2');

    const editBtn = screen.getByTestId('routing-edit-0');
    await userEvent.click(editBtn);
    // Modal open — the name input is autofocused.
    expect(screen.getByLabelText('Counter 1 nama')).toHaveFocus();
    // Batal closes the modal → focus returns to the Edit trigger, not body.
    await userEvent.click(screen.getByText('Batal'));
    await waitFor(() => expect(editBtn).toHaveFocus());
  });
});
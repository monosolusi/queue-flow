import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StateMachineEditor } from './StateMachineEditor';
import { defaultStateMachineForm, validateCustomStateMachine } from '../lib/state-machine';
import { DEFAULT_STATE_MACHINE } from '../api/types';

function renderEditor(
  value = defaultStateMachineForm(),
  errors: string[] = [],
  onChange: (next: ReturnType<typeof defaultStateMachineForm>) => void = vi.fn(),
) {
  return render(<StateMachineEditor value={value} onChange={onChange} errors={errors} />);
}

describe('StateMachineEditor (shared editor — wizard + AdminPanel)', () => {
  it('renders the mode fieldset + read-only transition list in default mode', () => {
    renderEditor();
    expect(screen.getByTestId('sm-mode')).toBeInTheDocument();
    expect(screen.getByTestId('sm-readonly')).toBeInTheDocument();
    // The PRD §7 default transitions render as read-only rows.
    expect(screen.getByText('Panggil Berikutnya')).toBeInTheDocument();
    expect(screen.getByText('Selesai Layan')).toBeInTheDocument();
    // No editor in default mode.
    expect(screen.queryByTestId('sm-editor')).not.toBeInTheDocument();
  });

  it('switches to custom mode and shows the states + transitions editor', async () => {
    const onChange = vi.fn();
    renderEditor(defaultStateMachineForm(), [], onChange);
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));
    // The first onChange call flips mode to 'custom' (carries the existing graph).
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.mode).toBe('custom');
    expect(next.states).toEqual([...DEFAULT_STATE_MACHINE.states]);
  });

  it('adds a state via the + Tambah Status button', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderEditor(customForm, [], onChange);
    fireEvent.click(screen.getByRole('button', { name: '+ Tambah Status' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.states).toHaveLength(DEFAULT_STATE_MACHINE.states.length + 1);
    // The new state is seeded empty.
    expect(next.states[next.states.length - 1]).toBe('');
  });

  it('removes a state that is not referenced by any transition', () => {
    const onChange = vi.fn();
    // SKIPPED is referenced (CALLING→SKIPPED + SKIPPED→CALLING). Build a form
    // with an extra unreferenced state so its remove button is enabled.
    const customForm = {
      mode: 'custom' as const,
      states: [...DEFAULT_STATE_MACHINE.states, 'EXTRA'],
      transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    };
    renderEditor(customForm, [], onChange);
    // The EXTRA state's remove button is enabled (not referenced).
    const extraRow = screen.getAllByLabelText(/^Status \d+$/).find(
      (input): input is HTMLInputElement => (input as HTMLInputElement).value === 'EXTRA',
    );
    expect(extraRow).toBeDefined();
    const removeBtn = extraRow!.closest('li')!.querySelector('button')!;
    expect(removeBtn).not.toBeDisabled();
    fireEvent.click(removeBtn);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.states).not.toContain('EXTRA');
  });

  it('blocks removal of a state referenced by a transition (disabled button)', () => {
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderEditor(customForm);
    // WAITING is referenced by the WAITING→CALLING edge, so its remove button
    // is disabled.
    const waitingRow = screen.getAllByLabelText(/^Status \d+$/).find(
      (input): input is HTMLInputElement => (input as HTMLInputElement).value === 'WAITING',
    );
    expect(waitingRow).toBeDefined();
    const removeBtn = waitingRow!.closest('li')!.querySelector('button')!;
    expect(removeBtn).toBeDisabled();
  });

  it('edits a transition via the from/to dropdowns + label input', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderEditor(customForm, [], onChange);
    // Change the first transition's label.
    const labelInputs = screen.getAllByLabelText(/Transisi 1 label aksi/);
    fireEvent.change(labelInputs[0], { target: { value: 'Panggil Cepat' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.transitions[0].actionLabel).toBe('Panggil Cepat');
  });

  it('renders validation errors when the errors prop is non-empty', () => {
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    const errors = validateCustomStateMachine({
      ...customForm,
      transitions: [...customForm.transitions, { from: 'WAITING', to: 'CALLING', actionLabel: '' }],
    });
    expect(errors.length).toBeGreaterThan(0);
    renderEditor(customForm, errors);
    expect(screen.getByTestId('sm-errors')).toBeInTheDocument();
    // The editor group is wired to the error list via aria-describedby.
    expect(screen.getByTestId('sm-editor')).toHaveAttribute('aria-describedby', 'sm-errors');
  });

  it('renders no error list when the errors prop is empty', () => {
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderEditor(customForm, []);
    expect(screen.queryByTestId('sm-errors')).not.toBeInTheDocument();
    // No aria-describedby wiring when there are no errors.
    expect(screen.getByTestId('sm-editor')).not.toHaveAttribute('aria-describedby');
  });

  it('uses Indonesian copy with no internal terms on the custom editor', () => {
    // The editor is no longer wizard-only: it sits on /config, which a
    // non-technical store manager opens daily, so "States" / "Transisi N from|to"
    // (developer vocabulary) must not reach the UI.
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderEditor(customForm);

    expect(screen.getByRole('heading', { name: 'Status' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'States' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Tambah Status' })).toBeInTheDocument();

    expect(screen.getByLabelText('Transisi 1 dari')).toBeInTheDocument();
    expect(screen.getByLabelText('Transisi 1 ke')).toBeInTheDocument();
    expect(screen.queryByLabelText('Transisi 1 from')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Transisi 1 to')).not.toBeInTheDocument();
  });

  it('warns when a custom graph drops a standard status, wired to the editor group', () => {
    // Non-blocking caution: it names the dropped statuses and what stops working
    // but renders OUTSIDE the red error list, and the editor exposes no gate for
    // it (the parent's save/Lanjut guard reads `errors` only).
    renderEditor({
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
    });

    const warning = screen.getByTestId('sm-standard-warning');
    expect(warning).toHaveTextContent('COMPLETED');
    expect(warning).toHaveTextContent(/Selesai Layan/);
    expect(screen.queryByTestId('sm-errors')).not.toBeInTheDocument();
    // Described by the warning alone while there are no errors.
    expect(screen.getByTestId('sm-editor')).toHaveAttribute('aria-describedby', 'sm-standard-warning');
    expect(warning).toHaveAttribute('id', 'sm-standard-warning');
  });

  it('describes the editor by BOTH the error list and the warning when both are present', () => {
    const value = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: '' }],
    };
    renderEditor(value, validateCustomStateMachine(value));
    expect(screen.getByTestId('sm-editor')).toHaveAttribute(
      'aria-describedby',
      'sm-errors sm-standard-warning',
    );
  });

  it('shows no dropped-status warning in default mode or on a complete custom graph', () => {
    const { unmount } = renderEditor();
    expect(screen.queryByTestId('sm-standard-warning')).not.toBeInTheDocument();
    unmount();

    renderEditor({ ...defaultStateMachineForm(), mode: 'custom' });
    expect(screen.queryByTestId('sm-standard-warning')).not.toBeInTheDocument();
  });

  it('reverts to the default graph when switching back to default from custom', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderEditor(customForm, [], onChange);
    fireEvent.click(screen.getByLabelText(/Gunakan alur status standar/));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.mode).toBe('default');
    expect(next.states).toEqual([...DEFAULT_STATE_MACHINE.states]);
    expect(next.transitions).toHaveLength(DEFAULT_STATE_MACHINE.transitions.length);
  });
});
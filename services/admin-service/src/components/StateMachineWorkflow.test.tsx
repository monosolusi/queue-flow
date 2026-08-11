import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StateMachineWorkflow } from './StateMachineWorkflow';
import { type Transition, defaultStateMachineForm, validateCustomStateMachine } from '../lib/state-machine';
import { DEFAULT_STATE_MACHINE } from '../api/types';

function renderWorkflow(
  value = defaultStateMachineForm(),
  errors: string[] = [],
  onChange: (next: ReturnType<typeof defaultStateMachineForm>) => void = vi.fn(),
) {
  return render(<StateMachineWorkflow value={value} onChange={onChange} errors={errors} />);
}

describe('StateMachineWorkflow (visual React Flow builder)', () => {
  it('renders the mode fieldset + read-only canvas in default mode', () => {
    renderWorkflow();
    expect(screen.getByTestId('sm-mode')).toBeInTheDocument();
    // The canvas mounts in both modes (read-only in default).
    expect(screen.getByTestId('sm-canvas')).toBeInTheDocument();
    // No palette / add buttons in default mode.
    expect(screen.queryByTestId('sm-palette')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sm-add-state')).not.toBeInTheDocument();
    // No dropped-status warning in default mode (the standard graph is intact).
    expect(screen.queryByTestId('sm-standard-warning')).not.toBeInTheDocument();
  });

  it('switches to custom mode and shows the palette + editable canvas', async () => {
    const onChange = vi.fn();
    renderWorkflow(defaultStateMachineForm(), [], onChange);
    await userEvent.click(screen.getByLabelText(/Susun alur status sendiri/));
    // The first onChange flips mode to 'custom' (carries the existing graph).
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.mode).toBe('custom');
    expect(next.states).toEqual([...DEFAULT_STATE_MACHINE.states]);
  });

  it('adds a state via the "Tambah Status" button', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    fireEvent.click(screen.getByTestId('sm-add-state'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.states).toHaveLength(DEFAULT_STATE_MACHINE.states.length + 1);
    // The new state is a non-colliding generated name (STATUS_N), not empty.
    const added = next.states[next.states.length - 1];
    expect(/^STATUS_\d+$/.test(added)).toBe(true);
  });

  it('adds a transition via the "Tambah Transisi" button', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    fireEvent.click(screen.getByTestId('sm-add-transition'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.transitions).toHaveLength(DEFAULT_STATE_MACHINE.transitions.length + 1);
    // The new transition is a self-edge on the first state with an empty label.
    const added = next.transitions[next.transitions.length - 1];
    expect(added.from).toBe(DEFAULT_STATE_MACHINE.states[0]);
    expect(added.to).toBe(DEFAULT_STATE_MACHINE.states[0]);
    expect(added.actionLabel).toBe('');
  });

  it('edits a transition label via the edge input', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    const labelInputs = screen.getAllByLabelText('Label aksi');
    expect(labelInputs.length).toBeGreaterThan(0);
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
    renderWorkflow(customForm, errors);
    expect(screen.getByTestId('sm-errors')).toBeInTheDocument();
    expect(screen.getByTestId('sm-errors')).toHaveTextContent('Label aksi tidak boleh kosong.');
  });

  it('renders no error list when the errors prop is empty', () => {
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, []);
    expect(screen.queryByTestId('sm-errors')).not.toBeInTheDocument();
  });

  it('warns when a custom graph drops a standard status', () => {
    renderWorkflow({
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
    });
    const warning = screen.getByTestId('sm-standard-warning');
    expect(warning).toHaveTextContent('COMPLETED');
    expect(warning).toHaveTextContent(/Selesai Layan/);
    // Not an error list.
    expect(screen.queryByTestId('sm-errors')).not.toBeInTheDocument();
    expect(warning).toHaveAttribute('id', 'sm-standard-warning');
  });

  it('shows no dropped-status warning on a complete custom graph', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' });
    expect(screen.queryByTestId('sm-standard-warning')).not.toBeInTheDocument();
  });

  it('reverts to the default graph when switching back to default from custom', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    fireEvent.click(screen.getByLabelText(/Gunakan alur status standar/));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.mode).toBe('default');
    expect(next.states).toEqual([...DEFAULT_STATE_MACHINE.states]);
    expect(next.transitions).toHaveLength(DEFAULT_STATE_MACHINE.transitions.length);
  });

  it('uppercases a state name on rename', () => {
    const onChange = vi.fn();
    const customForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'EXTRA'],
      transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    };
    renderWorkflow(customForm, [], onChange);
    // The EXTRA node's name input — rename it to lowercase, expect uppercased lift.
    const extraInput = screen.getAllByLabelText(/^Status /).find(
      (el): el is HTMLInputElement => (el as HTMLInputElement).value === 'EXTRA',
    );
    expect(extraInput).toBeDefined();
    fireEvent.change(extraInput!, { target: { value: 'onhold' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.states).toContain('ONHOLD');
    // The rename propagates to no referencing transition (EXTRA was unreferenced).
  });

  it('cascades transition removal when a state node is deleted', () => {
    const onChange = vi.fn();
    // CALLING is referenced by several transitions — deleting it must cascade.
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    const callingDelete = screen.getAllByLabelText(/^Hapus status /).find((b) =>
      (b as HTMLButtonElement).getAttribute('aria-label') === 'Hapus status CALLING',
    );
    expect(callingDelete).toBeDefined();
    fireEvent.click(callingDelete!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.states).not.toContain('CALLING');
    // Every transition referencing CALLING is gone (no dangling edges).
    expect(next.transitions.every((t: Transition) => t.from !== 'CALLING' && t.to !== 'CALLING')).toBe(true);
  });

  // --- Regression tests pinning the arch-reviewer's applied fixes ---

  it('absorbs a same-tick double-tap on "+ Tambah Status" (m3: exactly one add)', () => {
    // `disabled` only takes effect after a re-render, so two clicks landing in
    // the same tick both pass a state-only guard. The ref guard must flip BEFORE
    // the first commit and stay set until the value-sync effect resets it after
    // the parent re-renders — here the vi.fn() parent never feeds back, so the
    // ref stays set and the second tap is absorbed.
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    const btn = screen.getByTestId('sm-add-state');
    fireEvent.click(btn);
    fireEvent.click(btn); // same-tick second tap
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.states).toHaveLength(DEFAULT_STATE_MACHINE.states.length + 1);
  });

  it('no-ops "+ Tambah Transisi" when a self-edge on the first state already exists (m1)', () => {
    // The default graph has no self-edges, so seed one on WAITING (the first
    // state). The button must mirror onConnect's duplicate-edge guard and skip
    // instead of minting a second self-edge (which the M1 length-based id bug
    // would have collided on the wire-irrelevant React key).
    const onChange = vi.fn();
    const firstState = DEFAULT_STATE_MACHINE.states[0];
    const customForm = {
      mode: 'custom' as const,
      states: [...DEFAULT_STATE_MACHINE.states],
      transitions: [
        ...DEFAULT_STATE_MACHINE.transitions,
        { from: firstState, to: firstState, actionLabel: 'ulang' },
      ],
    };
    renderWorkflow(customForm, [], onChange);
    fireEvent.click(screen.getByTestId('sm-add-transition'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('no-ops a rename onto an existing state name (M2: no duplicate node id)', () => {
    // The node id IS the state name. Renaming EXTRA → WAITING would mint a
    // second { id: 'WAITING' } node (duplicate React key + duplicate state in
    // the form). The guard must no-op; the controlled input reverts on the next
    // re-render, so the form never accepts the invalid rename.
    const onChange = vi.fn();
    const customForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'EXTRA'],
      transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    };
    renderWorkflow(customForm, [], onChange);
    const extraInput = screen.getAllByLabelText(/^Status /).find(
      (el): el is HTMLInputElement => (el as HTMLInputElement).value === 'EXTRA',
    );
    expect(extraInput).toBeDefined();
    fireEvent.change(extraInput!, { target: { value: 'WAITING' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('mints opaque `sm-edge-N` ids for newly added edges (M1: disjoint id space)', () => {
    // Newly minted edges (onConnect / "+ Tambah Transisi") use an opaque
    // `sm-edge-N` id from a per-instance monotonic counter — a DISTINCT prefix
    // from `formToFlow`'s index-based `${from}->${to}#${i}` ids — so a delete
    // (which leaves gaps in the index space) can never collide with a re-add.
    // React Flow stamps each edge's id as `data-id` on its rendered `<g>`, so
    // the prefix is observable in the DOM. A regression to the old
    // length-based `${from}->${to}#${length}` form would NOT match `^sm-edge-\d+$`.
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    fireEvent.click(screen.getByTestId('sm-add-transition'));
    const renderedEdges = document.querySelectorAll('.react-flow__edge');
    expect(renderedEdges.length).toBeGreaterThan(0);
    const newEdge = Array.from(renderedEdges).find((e) =>
      /^sm-edge-\d+$/.test(e.getAttribute('data-id') ?? ''),
    );
    expect(newEdge).toBeDefined();
  });
});
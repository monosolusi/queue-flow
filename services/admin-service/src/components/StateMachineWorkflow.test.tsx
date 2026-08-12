import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StateMachineWorkflow } from './StateMachineWorkflow';
import { type StateMachineForm, type Transition, defaultStateMachineForm, validateCustomStateMachine } from '../lib/state-machine';
import { DEFAULT_STATE_MACHINE } from '../api/types';

function renderWorkflow(
  value = defaultStateMachineForm(),
  errors: string[] = [],
  onChange: (next: ReturnType<typeof defaultStateMachineForm>) => void = vi.fn(),
) {
  return render(<StateMachineWorkflow value={value} onChange={onChange} errors={errors} />);
}

/**
 * Select a state node on the canvas by clicking its SVG card. Drives the real
 * React Flow selection path: the NodeWrapper's onClick fires the parent's
 * `onNodeClick` prop (always fires, regardless of `selectNodesOnDrag`), which
 * marks the node selected in local state; the store syncs via `StoreUpdater`;
 * `onSelectionChange` fires; `selectedNodeId` is set; the panel renders.
 */
function selectStateNode(name: string): void {
  fireEvent.click(screen.getByTestId(`sm-node-card-${name}`));
}

/**
 * Select a transition edge on the canvas by clicking its React Flow wrapper.
 * The edge's `data-testid` is `rf__edge-${id}` (React Flow stamps it). For a
 * seed edge the id is `${from}->${to}#${i}`; for a manager-added edge it is
 * `sm-edge-N`. Drives the real React Flow selection path.
 */
function selectEdge(edgeId: string): void {
  fireEvent.click(screen.getByTestId(`rf__edge-${edgeId}`));
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
    // No properties panel in default mode (canvas is read-only).
    expect(screen.queryByTestId('sm-properties')).not.toBeInTheDocument();
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

  it('edits a transition label via the properties panel (select edge → edit action label)', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    // Select the first edge (WAITING->CALLING#0) on the canvas — drives the
    // real React Flow selection path (onEdgeClick → onSelectionChange → panel).
    selectEdge('WAITING->CALLING#0');
    // The properties panel renders the edge editor.
    const panel = screen.getByTestId('sm-properties');
    const actionLabelInput = within(panel).getByTestId('panel-action-label');
    fireEvent.change(actionLabelInput, { target: { value: 'Panggil Cepat' } });
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

  it('uppercases a state name on rename via the properties panel', () => {
    const onChange = vi.fn();
    const customForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'EXTRA'],
      transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
    };
    renderWorkflow(customForm, [], onChange);
    // Select the EXTRA node on the canvas → panel renders the node editor.
    selectStateNode('EXTRA');
    const panel = screen.getByTestId('sm-properties');
    const nameInput = within(panel).getByTestId('panel-state-name') as HTMLInputElement;
    expect(nameInput.value).toBe('EXTRA');
    fireEvent.change(nameInput, { target: { value: 'onhold' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.states).toContain('ONHOLD');
    // The rename propagates to no referencing transition (EXTRA was unreferenced).
  });

  it('cascades transition removal when a state node is deleted from the panel', () => {
    const onChange = vi.fn();
    // CALLING is referenced by several transitions — deleting it must cascade.
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    // Select the CALLING node on the canvas → panel renders the node editor.
    selectStateNode('CALLING');
    const panel = screen.getByTestId('sm-properties');
    const deleteBtn = within(panel).getByTestId('panel-delete-state');
    fireEvent.click(deleteBtn);
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
    // Select the EXTRA node on the canvas → panel renders the node editor.
    selectStateNode('EXTRA');
    const panel = screen.getByTestId('sm-properties');
    const nameInput = within(panel).getByTestId('panel-state-name');
    fireEvent.change(nameInput, { target: { value: 'WAITING' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders vertical (top + bottom) connection handles on every node', () => {
    // Feedback fix: the manager can draw a transition edge down/up only if each
    // node has top + bottom connection handles (source + target), not just the
    // left-right pair. Pin their presence + per-node count so a regression to
    // the two-handle (left/right only) node is caught. React Flow stamps each
    // handle with `data-handlepos` (top/right/bottom/left); one source + one
    // target per side ⇒ 2 per side per node. The handles are CSS-hidden until
    // hover/selection but stay in the DOM (regression test queries the DOM).
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    const stateCount = DEFAULT_STATE_MACHINE.states.length;
    const top = document.querySelectorAll('.react-flow__handle[data-handlepos="top"]');
    const bottom = document.querySelectorAll('.react-flow__handle[data-handlepos="bottom"]');
    const left = document.querySelectorAll('.react-flow__handle[data-handlepos="left"]');
    const right = document.querySelectorAll('.react-flow__handle[data-handlepos="right"]');
    expect(top.length).toBe(stateCount * 2);
    expect(bottom.length).toBe(stateCount * 2);
    expect(left.length).toBe(stateCount * 2);
    expect(right.length).toBe(stateCount * 2);
  });

  it('stamps the vertical handle ids matching HANDLE_IDS', () => {
    // The edge's sourceHandle/targetHandle reference these ids; they MUST
    // match the ids `formToFlow` seeds (DEFAULT_SOURCE_HANDLE etc.) exactly, or
    // a seed edge would attach to no handle and render at the node center.
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    const handleIds = new Set(
      Array.from(document.querySelectorAll('.react-flow__handle')).map(
        (h) => h.getAttribute('data-handleid') ?? '',
      ),
    );
    expect(handleIds.has('top-source')).toBe(true);
    expect(handleIds.has('top-target')).toBe(true);
    expect(handleIds.has('bottom-source')).toBe(true);
    expect(handleIds.has('bottom-target')).toBe(true);
    expect(handleIds.has('right-source')).toBe(true);
    expect(handleIds.has('right-target')).toBe(true);
    expect(handleIds.has('left-source')).toBe(true);
    expect(handleIds.has('left-target')).toBe(true);
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

  // --- Panel selection tests (redesign: select on canvas → edit in panel) ---

  it('shows the empty hint in the properties panel when nothing is selected', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    const panel = screen.getByTestId('sm-properties');
    expect(panel).toHaveTextContent('Pilih status atau transisi untuk mengedit.');
    // No node/edge editor inputs in the empty-hint state.
    expect(screen.queryByTestId('panel-state-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-action-label')).not.toBeInTheDocument();
  });

  it('selecting a node shows its panel (name input + description + delete button)', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('CALLING');
    const panel = screen.getByTestId('sm-properties');
    expect(within(panel).getByTestId('panel-state-name')).toBeInTheDocument();
    // The derived description for a canonical state is the canonical copy.
    expect(panel).toHaveTextContent('Sedang dipanggil ke counter');
    expect(within(panel).getByTestId('panel-delete-state')).toBeInTheDocument();
  });

  it('selecting an edge shows its panel (action label input + delete button)', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectEdge('WAITING->CALLING#0');
    const panel = screen.getByTestId('sm-properties');
    expect(within(panel).getByTestId('panel-action-label')).toBeInTheDocument();
    expect(within(panel).getByTestId('panel-delete-transition')).toBeInTheDocument();
    // The from→to route is shown.
    expect(panel).toHaveTextContent('WAITING');
    expect(panel).toHaveTextContent('CALLING');
  });

  it('disables the panel delete-transition button when only one transition remains', () => {
    // The ≥1-transition invariant: the button is disabled (the handler also
    // guards, but the disabled state is the visible affordance).
    renderWorkflow({
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' }],
    });
    selectEdge('WAITING->CALLING#0');
    const panel = screen.getByTestId('sm-properties');
    expect(within(panel).getByTestId('panel-delete-transition')).toBeDisabled();
  });

  it('clears the panel when the mode flips to default', () => {
    // Use a stateful parent so the mode flip feeds back into the component
    // (a vi.fn() parent never updates `value`, so `isCustom` would stay true
    // and the panel would never unmount). The panel only renders in custom
    // mode; switching to default hides it (read-only canvas only).
    let form: StateMachineForm = { ...defaultStateMachineForm(), mode: 'custom' };
    const { rerender } = render(
      <StateMachineWorkflow
        value={form}
        onChange={(next) => {
          form = next;
        }}
        errors={[]}
      />,
    );
    selectStateNode('CALLING');
    expect(screen.getByTestId('panel-state-name')).toBeInTheDocument();
    // Switch to default mode — the parent feeds back, the panel unmounts.
    fireEvent.click(screen.getByLabelText(/Gunakan alur status standar/));
    rerender(
      <StateMachineWorkflow
        value={form}
        onChange={(next) => {
          form = next;
        }}
        errors={[]}
      />,
    );
    expect(screen.queryByTestId('sm-properties')).not.toBeInTheDocument();
  });

  it('refreshes a node card description after a mutation changes its outgoing-transition count', () => {
    // The description lives on `data.description` (computed by `formToFlow`/
    // `withDescriptions`), NOT derived from the form prop at render. So a
    // mutation that changes a state's outgoing count (here: adding a self-edge
    // on the first state via "+ Tambah Transisi") must refresh the node card's
    // description via `commit`'s `withDescriptions` call — even though the
    // vi.fn() parent never feeds the new form back.
    const onChange = vi.fn();
    // ONHOLD is a custom state with 0 outgoing → "Status kustom" initially.
    // After a self-edge is added, it has 1 outgoing → "1 transisi keluar".
    renderWorkflow(
      {
        mode: 'custom',
        states: ['ONHOLD', 'CALLING'],
        transitions: [{ from: 'ONHOLD', to: 'CALLING', actionLabel: 'Lanjut' }],
      },
      [],
      onChange,
    );
    // ONHOLD already has 1 outgoing (to CALLING) → "1 transisi keluar".
    const card = screen.getByTestId('sm-node-card-ONHOLD');
    expect(card).toHaveTextContent('1 transisi keluar');
    // Add a self-edge on ONHOLD (the first state) via the button → 2 outgoing.
    fireEvent.click(screen.getByTestId('sm-add-transition'));
    expect(onChange).toHaveBeenCalledTimes(1);
    // The node card description refreshes via `withDescriptions` in `commit`.
    const refreshedCard = screen.getByTestId('sm-node-card-ONHOLD');
    expect(refreshedCard).toHaveTextContent('2 transisi keluar');
  });
});
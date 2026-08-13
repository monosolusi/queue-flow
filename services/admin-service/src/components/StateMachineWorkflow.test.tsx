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
    // No palette in default mode.
    expect(screen.queryByTestId('sm-palette')).not.toBeInTheDocument();
    // No properties panel in default mode (canvas is read-only).
    expect(screen.queryByTestId('sm-properties')).not.toBeInTheDocument();
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

  it('adds a transition via the inline "Tambah aksi" button in the node panel', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    // Select the WAITING node → the panel renders the inline Aksi editor.
    selectStateNode('WAITING');
    fireEvent.click(screen.getByTestId('panel-add-action'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.transitions).toHaveLength(DEFAULT_STATE_MACHINE.transitions.length + 1);
    // The new transition is an outgoing edge from WAITING (the selected node)
    // to the first non-duplicate target. WAITING→CALLING already exists, and
    // WAITING→WAITING (self-edge) does not, so the self-edge is the first
    // non-duplicate target.
    const added = next.transitions[next.transitions.length - 1];
    expect(added.from).toBe('WAITING');
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
      positions: {},
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
      positions: {},
    };
    renderWorkflow(customForm, [], onChange);
    // Select the EXTRA node on the canvas → panel renders the node editor.
    selectStateNode('EXTRA');
    const panel = screen.getByTestId('sm-properties');
    const nameInput = within(panel).getByTestId('panel-state-name');
    fireEvent.change(nameInput, { target: { value: 'WAITING' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('no-ops a rename to an empty/blank name (manager feedback: "ketika nama status node dihapus, error")', () => {
    // Clearing the name input used to commit a node with an empty id (`''`),
    // which then tripped `validateCustomStateMachine` → "Nama status tidak boleh
    // kosong" and blocked the save. The empty/whitespace guard must no-op; the
    // controlled input reverts to the prior name on re-render, so the name can
    // never be blank and no degenerate empty node is ever committed.
    const onChange = vi.fn();
    const customForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'EXTRA'],
      transitions: DEFAULT_STATE_MACHINE.transitions.map((t) => ({ ...t })),
      positions: {},
    };
    renderWorkflow(customForm, [], onChange);
    selectStateNode('EXTRA');
    const panel = screen.getByTestId('sm-properties');
    const nameInput = within(panel).getByTestId('panel-state-name') as HTMLInputElement;
    // Empty string.
    fireEvent.change(nameInput, { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
    // Whitespace-only (the rename input uppercases; whitespace survives).
    fireEvent.change(nameInput, { target: { value: '   ' } });
    expect(onChange).not.toHaveBeenCalled();
    // The controlled value reverts to the prior name — no blank commit.
    expect(nameInput.value).toBe('EXTRA');
  });

  it('renders one typeless connection handle on every side of every node', () => {
    // Feedback fix: the manager can draw a transition edge from any point to any
    // point only if each node has one TYPELESS handle per side — a single
    // `source`-typed handle that, under ConnectionMode.Loose, both STARTS and
    // RECEIVES a connection. Pin their presence + per-node count so a regression
    // to the eight-handle (source + target per side) or two-handle (left/right
    // only) node is caught. React Flow stamps each handle with `data-handlepos`
    // (top/right/bottom/left); one typeless handle per side ⇒ 1 per side per
    // node. The handles are CSS-hidden until hover/selection but stay in the DOM
    // (regression test queries the DOM).
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    const stateCount = DEFAULT_STATE_MACHINE.states.length;
    const top = document.querySelectorAll('.react-flow__handle[data-handlepos="top"]');
    const bottom = document.querySelectorAll('.react-flow__handle[data-handlepos="bottom"]');
    const left = document.querySelectorAll('.react-flow__handle[data-handlepos="left"]');
    const right = document.querySelectorAll('.react-flow__handle[data-handlepos="right"]');
    expect(top.length).toBe(stateCount * 1);
    expect(bottom.length).toBe(stateCount * 1);
    expect(left.length).toBe(stateCount * 1);
    expect(right.length).toBe(stateCount * 1);
  });

  it('stamps the four typeless side handle ids matching HANDLE_IDS', () => {
    // The edge's sourceHandle/targetHandle reference these ids; they MUST
    // match the ids `formToFlow` seeds (DEFAULT_SOURCE_HANDLE etc.) exactly, or
    // a seed edge would attach to no handle and render at the node center. The
    // ids are now the bare side strings (one typeless handle per side).
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    const handleIds = new Set(
      Array.from(document.querySelectorAll('.react-flow__handle')).map(
        (h) => h.getAttribute('data-handleid') ?? '',
      ),
    );
    expect(handleIds.has('top')).toBe(true);
    expect(handleIds.has('right')).toBe(true);
    expect(handleIds.has('bottom')).toBe(true);
    expect(handleIds.has('left')).toBe(true);
  });

  it('makes every handle a bidirectional typeless connection point (connectablestart + connectableend)', () => {
    // Manager feedback: "tidak bisa ditarik dari semua titik" — only the source
    // handles could start a drag (the target handles were drop-only via
    // isConnectableStart={false}). Fix: every handle is now a TYPELESS point — a
    // single `source`-typed handle per side that, under ConnectionMode.Loose,
    // both STARTS and RECEIVES a connection. Because every drag starts at a
    // `source`-typed handle, the START-handle-TYPE arrow-reversal can never fire
    // (React Flow keys an edge's source/target on the START handle's TYPE), so
    // the arrow always points where the manager dropped. React Flow stamps
    // `connectablestart: isConnectableStart` and `connectableend: isConnectableEnd`
    // as CSS classes (verified in @xyflow/react source) — the only jsdom-
    // observable regression surface for this (jsdom cannot simulate a real
    // pointer-geometry drag — see CLAUDE.md frontend-RTL gotchas). Pin it:
    // every handle carries BOTH classes now (no drop-only handles remain).
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    const handles = document.querySelectorAll('.react-flow__handle.connectable');
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      expect(handle).toHaveClass('connectablestart');
      expect(handle).toHaveClass('connectableend');
    }
  });

  it('mints opaque `sm-edge-N` ids for newly added edges (M1: disjoint id space)', () => {
    // Newly minted edges (onConnect / inline "Tambah aksi") use an opaque
    // `sm-edge-N` id from a per-instance monotonic counter — a DISTINCT prefix
    // from `formToFlow`'s index-based `${from}->${to}#${i}` ids — so a delete
    // (which leaves gaps in the index space) can never collide with a re-add.
    // React Flow stamps each edge's id as `data-id` on its rendered `<g>`, so
    // the prefix is observable in the DOM. A regression to the old
    // length-based `${from}->${to}#${length}` form would NOT match `^sm-edge-\d+$`.
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    // Select the WAITING node → panel renders the inline Aksi editor → add an
    // outgoing edge via the "Tambah aksi" button (replaces the old palette
    // "Tambah Transisi" button which was removed in the palette de-dup).
    selectStateNode('WAITING');
    fireEvent.click(screen.getByTestId('panel-add-action'));
    const renderedEdges = document.querySelectorAll('.react-flow__edge');
    expect(renderedEdges.length).toBeGreaterThan(0);
    const newEdge = Array.from(renderedEdges).find((e) =>
      /^sm-edge-\d+$/.test(e.getAttribute('data-id') ?? ''),
    );
    expect(newEdge).toBeDefined();
  });

  // --- Panel selection tests (redesign: select on canvas → edit in panel) ---

  it('shows the node picker (palette) in the right panel when nothing is selected', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    // Nothing selected → the right panel is the node picker (palette), not the editor.
    expect(screen.getByTestId('sm-palette')).toBeInTheDocument();
    expect(screen.queryByTestId('sm-properties')).not.toBeInTheDocument();
    // No node/edge editor inputs in the palette state.
    expect(screen.queryByTestId('panel-state-name')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-action-label')).not.toBeInTheDocument();
  });

  it('the panel back button clears selection and returns to the node picker', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    // Select a node → the right panel switches to the properties editor.
    selectStateNode('CALLING');
    expect(screen.getByTestId('sm-properties')).toBeInTheDocument();
    expect(screen.queryByTestId('sm-palette')).not.toBeInTheDocument();
    // The back button returns to the node picker (palette) by clearing selection.
    fireEvent.click(screen.getByTestId('sm-panel-back'));
    expect(screen.queryByTestId('sm-properties')).not.toBeInTheDocument();
    expect(screen.getByTestId('sm-palette')).toBeInTheDocument();
  });

  it('selecting a node shows its panel (name input + Deskripsi + inline Aksi + delete button)', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('CALLING');
    const panel = screen.getByTestId('sm-properties');
    expect(within(panel).getByTestId('panel-state-name')).toBeInTheDocument();
    // The read-only "Deskripsi" field shows the canonical description.
    expect(within(panel).getByTestId('panel-state-description')).toHaveTextContent(
      'Sedang dipanggil ke counter',
    );
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
      positions: {},
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
    // via the inline "Tambah aksi" button) must refresh the node card's
    // description via `commit`'s `withDescriptions` call — even though the
    // vi.fn() parent never feeds the new form back.
    const onChange = vi.fn();
    // ONHOLD is a custom state with 1 outgoing → "1 transisi keluar" initially.
    // After a self-edge is added, it has 2 outgoing → "2 transisi keluar".
    renderWorkflow(
      {
        mode: 'custom',
        states: ['ONHOLD', 'CALLING'],
        transitions: [{ from: 'ONHOLD', to: 'CALLING', actionLabel: 'Lanjut' }],
        positions: {},
      },
      [],
      onChange,
    );
    // ONHOLD already has 1 outgoing (to CALLING) → "1 transisi keluar".
    const card = screen.getByTestId('sm-node-card-ONHOLD');
    expect(card).toHaveTextContent('1 transisi keluar');
    // Select ONHOLD → panel renders the inline Aksi editor → add a self-edge
    // (ONHOLD→ONHOLD is the first non-duplicate target since ONHOLD→CALLING
    // already exists). The node now has 2 outgoing → "2 transisi keluar".
    selectStateNode('ONHOLD');
    fireEvent.click(screen.getByTestId('panel-add-action'));
    expect(onChange).toHaveBeenCalledTimes(1);
    // The node card description refreshes via `withDescriptions` in `commit`.
    const refreshedCard = screen.getByTestId('sm-node-card-ONHOLD');
    expect(refreshedCard).toHaveTextContent('2 transisi keluar');
  });

  it('renders an arrowhead marker on transition edges so direction is unambiguous', () => {
    // Manager feedback: "garis tidak ada panah, jadi membingungkan". Every
    // transition edge carries a closed-arrow `markerEnd` at the target end so
    // the edge reads "from → to" — including the default graph's bottom-up
    // SKIPPED → CALLING back-edge, which was the confusing case.
    //
    // NOTE: jsdom cannot simulate a real React Flow connection drag (no real
    // pointer geometry / `PointerEvent` ctor — see CLAUDE.md frontend-RTL
    // gotchas), so the duplicate-toast (`onConnectEnd`) behavior is covered by
    // the pure `rejectionMessageForConnection` lib test, NOT a component drag
    // test. This test pins only the ARROW rendering, which is the load-bearing
    // visual fix and IS observable in jsdom.
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    // At least one edge path carries the resolved `marker-end` url attribute —
    // this proves the component forwarded the resolved marker to `BaseEdge`
    // (the `<marker>` def itself is React Flow's `MarkerDefinitions`, which may
    // or may not render under jsdom; the edge-path attribute is the primary
    // guard and is load-bearing).
    const paths = document.querySelectorAll('.react-flow__edge-path');
    expect(paths.length).toBeGreaterThan(0);
    const withMarker = Array.from(paths).some((p) => p.getAttribute('marker-end'));
    expect(withMarker).toBe(true);
    // React Flow's `MarkerDefinitions` (the `<marker>` defs) is not guaranteed
    // to render under jsdom, so it is NOT asserted here — the edge-path
    // `marker-end` attribute above is the authoritative guard (it proves the
    // component forwarded the resolved marker url to `BaseEdge`).
  });

  it('redraw respects the source sides — a vertical edge round-trips through the canvas', () => {
    // THE core fix: the form transition carries sourceSide/targetSide, and the
    // diagram redraws according to those sides (not the unclear default). The
    // proof is a full round-trip: form sides → `formToFlow` seeds the canvas
    // edges with the bottom/top handles → a canvas edit calls `commit` →
    // `flowToGraph` captures the sides back from the handles → the emitted form
    // STILL carries `sourceSide:'bottom'`/`targetSide:'top'`. If `formToFlow`
    // ignored the form sides (the old behavior), the seeded edge would use the
    // default right/left handles and the round-tripped form would carry
    // `sourceSide:'right'` instead of `'bottom'`.
    const onChange = vi.fn();
    const form: StateMachineForm = {
      mode: 'custom' as const,
      states: [...DEFAULT_STATE_MACHINE.states],
      transitions: DEFAULT_STATE_MACHINE.transitions.map((t, i) =>
        i === 0
          ? { ...t, sourceSide: 'bottom' as const, targetSide: 'top' as const }
          : { ...t },
      ),
      positions: {},
    };
    renderWorkflow(form, [], onChange);
    // Select the vertical edge and edit its label — `commit` lifts the
    // `flowToGraph`-captured form (with the sides) to the parent.
    selectEdge('WAITING->CALLING#0');
    fireEvent.change(screen.getByTestId('panel-action-label'), { target: { value: 'Panggil Cepat' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // The round-tripped transition keeps its vertical routing — the canvas
    // edges were seeded from the form sides and `flowToGraph` captured them
    // back. (The old default-routing seed would have produced 'right'/'left'.)
    const vertical = next.transitions.find((t: Transition) => t.from === 'WAITING' && t.to === 'CALLING');
    expect(vertical?.sourceSide).toBe('bottom');
    expect(vertical?.targetSide).toBe('top');
    expect(vertical?.actionLabel).toBe('Panggil Cepat');
  });

  it('rename a state preserves the sides on affected transitions (regression)', () => {
    // Before the fix, `updateState` rebuilt each transition as
    // `{ from, to, actionLabel }`, dropping sourceSide/targetSide and snapping
    // a vertical edge back to L→R on rename. The spread form preserves them.
    const onChange = vi.fn();
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'EXTRA'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya', sourceSide: 'bottom', targetSide: 'top' },
        ...DEFAULT_STATE_MACHINE.transitions.slice(1).map((t) => ({ ...t })),
      ],
      positions: {},
    };
    renderWorkflow(customForm, [], onChange);
    // Select the WAITING node and rename it to PENDING.
    selectStateNode('WAITING');
    const panel = screen.getByTestId('sm-properties');
    const nameInput = within(panel).getByTestId('panel-state-name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'PENDING' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // The renamed transition keeps its vertical routing.
    const renamed = next.transitions.find((t: Transition) => t.from === 'PENDING' && t.to === 'CALLING');
    expect(renamed?.sourceSide).toBe('bottom');
    expect(renamed?.targetSide).toBe('top');
  });

  // --- State-panel inline "Aksi" editor + edge reroute (manager feedback) ---
  //
  // Manager feedback: "update status → update to" — a state node's properties
  // should surface its outgoing actions inline and editable. Each outgoing
  // transition is a row with a "Update to" <select> (re-point the target), a
  // "Label aksi" <input>, and a "Hapus" button. The read-only "Status" badge +
  // consequence block is gone; a read-only "Deskripsi" field replaces it. The
  // standalone edge editor (Dari / Ke / Label aksi / Hapus transisi) is kept
  // unchanged — two edit paths (inline node actions + click-an-edge).

  it('the state panel shows the inline Aksi editor with outgoing transitions only', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('SERVING');
    const panel = screen.getByTestId('sm-properties');
    // SERVING has one outgoing: SERVING → COMPLETED (index 4 in the default
    // graph). The inline editor renders a "Update to" select showing COMPLETED
    // and a "Label aksi" input with the action label "Selesai Layan".
    const toSelect = within(panel).getByTestId('panel-action-to-SERVING->COMPLETED#4') as HTMLSelectElement;
    expect(toSelect).toBeInTheDocument();
    expect(toSelect.value).toBe('COMPLETED');
    const labelInput = within(panel).getByTestId('panel-action-label-SERVING->COMPLETED#4') as HTMLInputElement;
    expect(labelInput.value).toBe('Selesai Layan');
    // The incoming transition (CALLING → SERVING, index 1) is NOT listed
    // (outgoing only).
    expect(within(panel).queryByTestId('panel-action-to-CALLING->SERVING#1')).not.toBeInTheDocument();
  });

  it('the state panel shows the read-only Deskripsi field (derived description)', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('SERVING');
    const panel = screen.getByTestId('sm-properties');
    // The "Deskripsi" field shows the canonical description for SERVING.
    expect(within(panel).getByTestId('panel-state-description')).toHaveTextContent('Sedang dilayani');
    // The old "Status" badge / sub-description / consequence blocks are gone.
    expect(within(panel).queryByTestId('panel-state-status')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('panel-state-badge')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('panel-state-subdescription')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('panel-state-consequence')).not.toBeInTheDocument();
  });

  it('the state panel Deskripsi shows the derived summary for a custom node', () => {
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'ONHOLD'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' },
        { from: 'ONHOLD', to: 'CALLING', actionLabel: 'Lanjut' },
      ],
      positions: {},
    };
    renderWorkflow(customForm);
    selectStateNode('ONHOLD');
    const panel = screen.getByTestId('sm-properties');
    // ONHOLD has 1 outgoing transition → derived "1 transisi keluar".
    expect(within(panel).getByTestId('panel-state-description')).toHaveTextContent('1 transisi keluar');
    // No old badge block.
    expect(within(panel).queryByTestId('panel-state-badge')).not.toBeInTheDocument();
  });

  it('the inline "Tambah aksi" button adds a new outgoing edge from the selected node', () => {
    const onChange = vi.fn();
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' }],
      positions: {},
    };
    renderWorkflow(customForm, [], onChange);
    selectStateNode('WAITING');
    fireEvent.click(screen.getByTestId('panel-add-action'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // The new edge is WAITING → WAITING (the first non-duplicate target: CALLING
    // is already a target, so WAITING itself is the next candidate).
    expect(next.transitions).toHaveLength(2);
    const added = next.transitions[next.transitions.length - 1];
    expect(added.from).toBe('WAITING');
    expect(added.actionLabel).toBe('');
  });

  it('the inline "Tambah aksi" button is disabled when every status is already a target', () => {
    // A 2-state graph where WAITING has outgoing edges to both WAITING and
    // CALLING → no non-duplicate target left → the button is disabled.
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING'],
      transitions: [
        { from: 'WAITING', to: 'WAITING', actionLabel: 'ulang' },
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' },
      ],
      positions: {},
    };
    renderWorkflow(customForm);
    selectStateNode('WAITING');
    expect(screen.getByTestId('panel-add-action')).toBeDisabled();
  });

  it('the inline "Update to" select re-routes the edge (source stays the selected node)', () => {
    const onChange = vi.fn();
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const }, [], onChange);
    selectStateNode('SERVING');
    // SERVING → COMPLETED (index 4) is the outgoing edge. Change "Update to" to
    // SKIPPED.
    const toSelect = screen.getByTestId('panel-action-to-SERVING->COMPLETED#4') as HTMLSelectElement;
    fireEvent.change(toSelect, { target: { value: 'SKIPPED' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // The edge is re-routed: source stays SERVING, target becomes SKIPPED.
    const routed = next.transitions.find((t: Transition) => t.from === 'SERVING');
    expect(routed?.to).toBe('SKIPPED');
  });

  it('the inline "Label aksi" input edits the edge action label', () => {
    const onChange = vi.fn();
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const }, [], onChange);
    selectStateNode('SERVING');
    const labelInput = screen.getByTestId('panel-action-label-SERVING->COMPLETED#4') as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: 'Selesai' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    const edited = next.transitions.find((t: Transition) => t.from === 'SERVING' && t.to === 'COMPLETED');
    expect(edited?.actionLabel).toBe('Selesai');
  });

  it('the inline "Hapus" button deletes the outgoing action (disabled when only one transition remains)', () => {
    // 2-state / 1-transition graph → the Hapus button on the sole outgoing
    // edge is disabled (the ≥1-transition invariant).
    const oneTransitionForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' }],
      positions: {},
    };
    renderWorkflow(oneTransitionForm);
    selectStateNode('WAITING');
    const deleteBtn = screen.getByTestId('panel-action-delete-WAITING->CALLING#0');
    expect(deleteBtn).toBeDisabled();
  });

  it('the inline "Hapus" button deletes the outgoing action when more than one transition exists', () => {
    const onChange = vi.fn();
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const }, [], onChange);
    selectStateNode('SERVING');
    const deleteBtn = screen.getByTestId('panel-action-delete-SERVING->COMPLETED#4');
    expect(deleteBtn).not.toBeDisabled();
    fireEvent.click(deleteBtn);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // The SERVING → COMPLETED transition is gone.
    expect(next.transitions.every((t: Transition) => !(t.from === 'SERVING' && t.to === 'COMPLETED'))).toBe(true);
  });

  it('the state panel shows the empty-state hint when the node has no outgoing transitions', () => {
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'LONELY'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' }],
      positions: {},
    };
    renderWorkflow(customForm);
    selectStateNode('LONELY');
    const panel = screen.getByTestId('sm-properties');
    expect(within(panel).getByTestId('panel-state-actions-empty')).toHaveTextContent(
      'Belum ada aksi keluar. Tambah aksi untuk mengubah status ini ke status lain.',
    );
  });

  // --- Edge editor (unchanged): reroute + duplicate revert via the standalone
  //     edge editor's Dari/Ke selects --------------------------------------------

  it('re-routes an edge via the panel "Ke" select (CALLING stays, target becomes COMPLETED)', () => {
    // The standalone edge editor's "Dari"/"Ke" selects lift a reroute via
    // `onRerouteTransition`. Changing the "Ke" select on WAITING->CALLING to
    // COMPLETED re-points the edge to WAITING->COMPLETED (a non-duplicate pair).
    const onChange = vi.fn();
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const }, [], onChange);
    selectEdge('WAITING->CALLING#0');
    const toSelect = screen.getByTestId('panel-transition-to') as HTMLSelectElement;
    fireEvent.change(toSelect, { target: { value: 'COMPLETED' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.transitions[0].from).toBe('WAITING');
    expect(next.transitions[0].to).toBe('COMPLETED');
  });

  it('a duplicate reroute reverts (controlled `<select>` keeps the live edge value, onChange NOT called)', () => {
    // The controlled-component revert: a reroute that would duplicate an
    // existing edge is rejected with a toast and `commit`/`onChange` is NOT
    // called, so the controlled `<select>` snaps back to the live edge value
    // on the next re-render (no state change leaks). Setup: a graph that
    // already has WAITING→COMPLETED; selecting WAITING→CALLING and changing
    // "Ke" to COMPLETED would duplicate it.
    const onChange = vi.fn();
    const form: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'COMPLETED'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
        { from: 'WAITING', to: 'COMPLETED', actionLabel: 'Skip' },
      ],
      positions: {},
    };
    renderWorkflow(form, [], onChange);
    selectEdge('WAITING->CALLING#0');
    const toSelect = screen.getByTestId('panel-transition-to') as HTMLSelectElement;
    fireEvent.change(toSelect, { target: { value: 'COMPLETED' } });
    // The duplicate guard rejects the reroute — `onChange` is NOT called.
    expect(onChange).not.toHaveBeenCalled();
    // The controlled `<select>` reverts to the live edge value (CALLING) —
    // the DOM reflects the controlled value, not the rejected pick.
    expect(toSelect.value).toBe('CALLING');
  });
});

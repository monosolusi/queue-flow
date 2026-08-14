import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StateMachineWorkflow } from './StateMachineWorkflow';
import { type StateMachineForm, type Transition, defaultStateMachineForm, validateCustomStateMachine } from '../lib/state-machine';
import { DEFAULT_STATE_MACHINE } from '../api/types';
import { SELF_LOOP_RADIUS } from '../lib/state-machine-flow';

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

  it('adds a transition via the inline "Tambah transisi" button in the node panel', () => {
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    // Select the WAITING node → the panel renders the inline "Transisi keluar"
    // editor (the node's outgoing transitions — the independent button-label
    // surface, decoupled from the node-level "Aksi" section).
    selectStateNode('WAITING');
    // Navigate to the "Transisi keluar" sub-view (panel redesign: the node
    // editor splits into overview + transitions/actions sub-views).
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    fireEvent.click(screen.getByTestId('panel-add-transition'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.transitions).toHaveLength(DEFAULT_STATE_MACHINE.transitions.length + 1);
    // The new transition is an OUTGOING self-edge from WAITING (the selected
    // node): the first non-duplicate TARGET from WAITING is WAITING itself
    // (WAITING→WAITING does not exist; WAITING→CALLING already exists). The
    // node-level "Aksi" framing anchors the source to the selected node.
    const added = next.transitions[next.transitions.length - 1];
    expect(added.from).toBe('WAITING');
    expect(added.to).toBe('WAITING');
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
      transitions: [...customForm.transitions, { from: 'WAITING', to: 'CALLING', actionLabel: '', action: 'UPDATE_STATUS' }],
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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

  it('renders one typeless connection handle on every side of every state node', () => {
    // Feedback fix: the manager can draw a transition edge from any point to any
    // point only if each STATE node has one TYPELESS handle per side — a single
    // `source`-typed handle that, under ConnectionMode.Loose, both STARTS and
    // RECEIVES a connection. Pin their presence + per-node count so a regression
    // to the eight-handle (source + target per side) or two-handle (left/right
    // only) node is caught. React Flow stamps each handle with `data-handlepos`
    // (top/right/bottom/left); one typeless handle per side ⇒ 1 per side per
    // state node. The handles are CSS-hidden until hover/selection but stay in
    // the DOM (regression test queries the DOM).
    //
    // The canvas now also renders canvas-only Start/End terminal markers (one
    // non-interactive `right` handle on Start; FOUR typeless handles on End,
    // connectable in custom mode — dragging into one is the only route to an
    // End link). SCOPE the per-side count to STATE nodes
    // (`.react-flow__node-state`) so the marker handles do not inflate the
    // count and the "one per side per state node" invariant stays pinned.
    // React Flow stamps `react-flow__node-{type}` on the node wrapper.
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    const stateCount = DEFAULT_STATE_MACHINE.states.length;
    const top = document.querySelectorAll('.react-flow__node-state .react-flow__handle[data-handlepos="top"]');
    const bottom = document.querySelectorAll('.react-flow__node-state .react-flow__handle[data-handlepos="bottom"]');
    const left = document.querySelectorAll('.react-flow__node-state .react-flow__handle[data-handlepos="left"]');
    const right = document.querySelectorAll('.react-flow__node-state .react-flow__handle[data-handlepos="right"]');
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
    // Newly minted edges (onConnect / inline "Tambah transisi") use an opaque
    // `sm-edge-N` id from a per-instance monotonic counter — a DISTINCT prefix
    // from `formToFlow`'s index-based `${from}->${to}#${i}` ids — so a delete
    // (which leaves gaps in the index space) can never collide with a re-add.
    // React Flow stamps each edge's id as `data-id` on its rendered `<g>`, so
    // the prefix is observable in the DOM. A regression to the old
    // length-based `${from}->${to}#${length}` form would NOT match `^sm-edge-\d+$`.
    const onChange = vi.fn();
    const customForm = { ...defaultStateMachineForm(), mode: 'custom' as const };
    renderWorkflow(customForm, [], onChange);
    // Select the WAITING node → panel renders the inline "Transisi keluar"
    // editor → add an outgoing edge via the "Tambah transisi" button.
    selectStateNode('WAITING');
    // Navigate to the "Transisi keluar" sub-view (panel redesign).
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    fireEvent.click(screen.getByTestId('panel-add-transition'));
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

  // --- Panel navigation restructure (manager feedback) ---
  //
  // The node editor splits into an overview (name + editable description + two
  // nav cards "Transisi keluar"/"Aksi" + delete) and two sub-views
  // (transitions / actions), each with a "Kembali ke status" back button →
  // overview. The sub-view resets to overview when the selection changes.

  it('panel-goto-transitions navigates to the Transisi keluar sub-view; panel-back-to-status returns to overview (selection kept)', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('SERVING');
    const panel = screen.getByTestId('sm-properties');
    // Overview: nav card present, transitions editor NOT yet shown.
    expect(within(panel).getByTestId('panel-goto-transitions')).toBeInTheDocument();
    expect(within(panel).queryByTestId('panel-add-transition')).not.toBeInTheDocument();
    // Navigate to the "Transisi keluar" sub-view.
    fireEvent.click(within(panel).getByTestId('panel-goto-transitions'));
    expect(within(panel).getByTestId('panel-add-transition')).toBeInTheDocument();
    // The back button returns to the overview (the canvas selection is NOT
    // cleared — the node editor stays open; only the sub-view resets).
    fireEvent.click(within(panel).getByTestId('panel-back-to-status'));
    expect(within(panel).queryByTestId('panel-add-transition')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('panel-state-name')).toBeInTheDocument();
    // The selection is still active (sm-properties still shown, not the palette).
    expect(screen.getByTestId('sm-properties')).toBeInTheDocument();
    expect(screen.queryByTestId('sm-palette')).not.toBeInTheDocument();
  });

  it('panel-goto-actions navigates to the Aksi sub-view; panel-back-to-status returns to overview', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('SERVING');
    const panel = screen.getByTestId('sm-properties');
    expect(within(panel).queryByTestId('panel-add-node-action')).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByTestId('panel-goto-actions'));
    expect(within(panel).getByTestId('panel-add-node-action')).toBeInTheDocument();
    fireEvent.click(within(panel).getByTestId('panel-back-to-status'));
    expect(within(panel).queryByTestId('panel-add-node-action')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('panel-state-name')).toBeInTheDocument();
  });

  it('selecting a different node resets the sub-view to overview', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('SERVING');
    const panel = screen.getByTestId('sm-properties');
    // Enter the "Aksi" sub-view on SERVING.
    fireEvent.click(within(panel).getByTestId('panel-goto-actions'));
    expect(within(panel).getByTestId('panel-add-node-action')).toBeInTheDocument();
    // Select a different node on the canvas — the sub-view resets to overview
    // (the new node's name input is shown, NOT the previous sub-view).
    selectStateNode('WAITING');
    const panel2 = screen.getByTestId('sm-properties');
    expect(within(panel2).getByTestId('panel-state-name')).toBeInTheDocument();
    expect(within(panel2).queryByTestId('panel-add-node-action')).not.toBeInTheDocument();
  });

  it('the sm-panel-back button returns to the palette from a sub-view (via back-to-status → overview → sm-panel-back)', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('SERVING');
    const panel = screen.getByTestId('sm-properties');
    fireEvent.click(within(panel).getByTestId('panel-goto-actions'));
    // The top-level sm-panel-back lives on the overview; from a sub-view the
    // manager first returns to the overview (panel-back-to-status), then uses
    // sm-panel-back to clear the canvas selection (palette returns).
    fireEvent.click(within(panel).getByTestId('panel-back-to-status'));
    fireEvent.click(screen.getByTestId('sm-panel-back'));
    expect(screen.queryByTestId('sm-properties')).not.toBeInTheDocument();
    expect(screen.getByTestId('sm-palette')).toBeInTheDocument();
  });

  it('typing a description lifts via onEditStateDescription (form-only, no canvas re-seed)', () => {
    // Use a stateful parent so the controlled <textarea> reflects the lifted
    // form (a vi.fn() parent never feeds back, so the controlled value would
    // revert and React's value-tracker would deduplicate a subsequent change).
    let form: StateMachineForm = { ...defaultStateMachineForm(), mode: 'custom' };
    const onChange = vi.fn((next: StateMachineForm) => {
      form = next;
    });
    const { rerender } = render(<StateMachineWorkflow value={form} onChange={onChange} errors={[]} />);
    selectStateNode('WAITING');
    const descField = screen.getByTestId('panel-state-description') as HTMLTextAreaElement;
    // Before the edit, the WAITING node card shows the derived canonical
    // description ("Tiket menunggu dipanggil").
    const cardBefore = screen.getByTestId('sm-node-card-WAITING');
    expect(cardBefore).toHaveTextContent('Tiket menunggu dipanggil');
    // Typing a description lifts a form-only change (no canvas re-seed —
    // graphSignature excludes descriptions). The handler calls
    // `setNodes(withDescriptions(...))` before `lift` so the canvas node card
    // refreshes immediately (descriptions are canvas-rendered, unlike
    // nodeActions which are panel-only).
    fireEvent.change(descField, { target: { value: 'Antrian dimulai di sini' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(form.descriptions.WAITING).toBe('Antrian dimulai di sini');
    // The canvas node card updates to the new description WITHOUT a re-render
    // from the parent (the handler's `setNodes(withDescriptions(...))` patches
    // the local node state directly). This is the MAJOR-1 regression guard:
    // without `setNodes(withDescriptions(...))`, the card would stay stale
    // (showing the derived canonical copy) until a later structural change.
    const cardAfter = screen.getByTestId('sm-node-card-WAITING');
    expect(cardAfter).toHaveTextContent('Antrian dimulai di sini');
    // Re-render with the lifted form (stateful parent feeds back).
    rerender(<StateMachineWorkflow value={form} onChange={onChange} errors={[]} />);
    // Emptying the field clears the override (the key is deleted so
    // descriptionFor falls back to the derived canonical copy).
    const descField2 = screen.getByTestId('panel-state-description') as HTMLTextAreaElement;
    fireEvent.change(descField2, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(form.descriptions.WAITING).toBeUndefined();
    // The canvas node card reverts to the derived canonical copy.
    const cardCleared = screen.getByTestId('sm-node-card-WAITING');
    expect(cardCleared).toHaveTextContent('Tiket menunggu dipanggil');
    // The canvas edge count is unchanged (descriptions are form-only; no
    // graphSignature change → no re-seed).
    expect(document.querySelectorAll('.react-flow__edge').length).toBeGreaterThan(0);
  });

  it('selecting a node shows its panel (name input + Deskripsi + nav cards + delete button)', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('CALLING');
    const panel = screen.getByTestId('sm-properties');
    expect(within(panel).getByTestId('panel-state-name')).toBeInTheDocument();
    // The panel redesign: the overview shows an EDITABLE description <textarea>
    // (value = saved override, placeholder = derived canonical description).
    // CALLING has no saved override → the field is empty with the derived
    // canonical description as its placeholder.
    const descField = within(panel).getByTestId('panel-state-description') as HTMLTextAreaElement;
    expect(descField.value).toBe('');
    expect(descField.placeholder).toBe('Sedang dipanggil ke counter');
    // The overview surfaces the two nav cards (Transisi keluar / Aksi).
    expect(within(panel).getByTestId('panel-goto-transitions')).toBeInTheDocument();
    expect(within(panel).getByTestId('panel-goto-actions')).toBeInTheDocument();
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
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya', action: 'UPDATE_STATUS' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    });
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
        transitions: [{ from: 'ONHOLD', to: 'CALLING', actionLabel: 'Lanjut', action: 'UPDATE_STATUS' }],
        positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,      },
      [],
      onChange,
    );
    // ONHOLD already has 1 outgoing (to CALLING) → "1 transisi keluar".
    const card = screen.getByTestId('sm-node-card-ONHOLD');
    expect(card).toHaveTextContent('1 transisi keluar');
    // Select ONHOLD → panel renders the inline "Transisi keluar" editor → add
    // a self-edge (ONHOLD→ONHOLD is the first non-duplicate target since
    // ONHOLD→CALLING already exists). The node now has 2 outgoing → "2
    // transisi keluar".
    selectStateNode('ONHOLD');
    // Navigate to the "Transisi keluar" sub-view (panel redesign).
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    fireEvent.click(screen.getByTestId('panel-add-transition'));
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
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya', action: 'UPDATE_STATUS', sourceSide: 'bottom', targetSide: 'top' },
        ...DEFAULT_STATE_MACHINE.transitions.slice(1).map((t) => ({ ...t })),
      ],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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
  // Manager feedback: node-level — a state node's properties should surface
  // its OUTGOING actions as "Aksi" (the action type, read-only "Update Status")
  // + "Nilai" (the value = the target status, an editable <select> re-pointing
  // the target). No "Dari" (the source is the selected node, implicit) and no
  // inline label editing (the Caller button text stays editable via the
  // standalone edge editor). The read-only "Status" badge + consequence block
  // is gone; a read-only "Deskripsi" field replaces it. The standalone edge
  // editor (Dari / Ke / Label aksi / Hapus transisi) is kept unchanged — two
  // edit paths (inline node actions + click-an-edge).

  it('the state panel shows the inline "Transisi keluar" editor with outgoing transitions only', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('SERVING');
    const panel = screen.getByTestId('sm-properties');
    // Navigate to the "Transisi keluar" sub-view (panel redesign: the node
    // editor splits into overview + transitions/actions sub-views).
    fireEvent.click(within(panel).getByTestId('panel-goto-transitions'));
    // SERVING has one OUTGOING: SERVING → COMPLETED (index 4 in the default
    // graph). The "Transisi keluar" editor renders an editable "Label aksi"
    // input and a "Ke" select showing COMPLETED.
    const labelInput = within(panel).getByTestId('panel-transition-label-SERVING->COMPLETED#4') as HTMLInputElement;
    expect(labelInput).toBeInTheDocument();
    const toSelect = within(panel).getByTestId('panel-transition-to-SERVING->COMPLETED#4') as HTMLSelectElement;
    expect(toSelect).toBeInTheDocument();
    expect(toSelect.value).toBe('COMPLETED');
    // The incoming edge (CALLING → SERVING, index 1) is NOT listed (outgoing
    // only — the "Transisi keluar" panel shows the node's outgoing edges).
    expect(within(panel).queryByTestId('panel-transition-to-CALLING->SERVING#1')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('panel-transition-label-CALLING->SERVING#1')).not.toBeInTheDocument();
  });

  it('the state panel shows the editable Deskripsi field (derived description as placeholder)', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('SERVING');
    const panel = screen.getByTestId('sm-properties');
    // The "Deskripsi" field is an editable <textarea>; with no saved override
    // the field is empty and the derived canonical description is the placeholder.
    const descField = within(panel).getByTestId('panel-state-description') as HTMLTextAreaElement;
    expect(descField.value).toBe('');
    expect(descField.placeholder).toBe('Sedang dilayani');
    // The old "Status" badge / sub-description / consequence blocks are gone.
    expect(within(panel).queryByTestId('panel-state-status')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('panel-state-badge')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('panel-state-subdescription')).not.toBeInTheDocument();
    expect(within(panel).queryByTestId('panel-state-consequence')).not.toBeInTheDocument();
  });

  it('the state panel Deskripsi shows the derived summary as placeholder for a custom node', () => {
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'ONHOLD'],
      transitions: [
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil', action: 'UPDATE_STATUS' },
        { from: 'ONHOLD', to: 'CALLING', actionLabel: 'Lanjut', action: 'UPDATE_STATUS' },
      ],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    renderWorkflow(customForm);
    selectStateNode('ONHOLD');
    const panel = screen.getByTestId('sm-properties');
    // ONHOLD has 1 outgoing transition → derived "1 transisi keluar" is the
    // placeholder (no saved override → empty value).
    const descField = within(panel).getByTestId('panel-state-description') as HTMLTextAreaElement;
    expect(descField.value).toBe('');
    expect(descField.placeholder).toBe('1 transisi keluar');
    // No old badge block.
    expect(within(panel).queryByTestId('panel-state-badge')).not.toBeInTheDocument();
  });

  it('the inline "Tambah transisi" button adds a new outgoing edge from the selected node', () => {
    const onChange = vi.fn();
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil', action: 'UPDATE_STATUS' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    renderWorkflow(customForm, [], onChange);
    selectStateNode('WAITING');
    // Navigate to the "Transisi keluar" sub-view (panel redesign).
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    fireEvent.click(screen.getByTestId('panel-add-transition'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // The new edge is an OUTGOING self-edge from WAITING: the first non-duplicate
    // TARGET from WAITING is WAITING itself (WAITING→CALLING already exists;
    // WAITING→WAITING does not). The "Transisi keluar" framing anchors the
    // source to the selected node.
    expect(next.transitions).toHaveLength(2);
    const added = next.transitions[next.transitions.length - 1];
    expect(added.from).toBe('WAITING');
    expect(added.to).toBe('WAITING');
    expect(added.actionLabel).toBe('');
  });

  it('the inline "Tambah transisi" button is disabled when every status is already a target of an outgoing edge from this node', () => {
    // Outgoing framing: the button is disabled when every status is already a
    // TARGET of an outgoing edge from the selected node (no non-duplicate
    // target left). Construct: select CALLING with transitions CALLING→CALLING
    // (self — target CALLING) and CALLING→WAITING (target WAITING) → both
    // states are targets of outgoing edges from CALLING → button disabled.
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING'],
      transitions: [
        { from: 'CALLING', to: 'CALLING', actionLabel: 'ulang', action: 'UPDATE_STATUS' },
        { from: 'CALLING', to: 'WAITING', actionLabel: 'kembali', action: 'UPDATE_STATUS' },
      ],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    renderWorkflow(customForm);
    selectStateNode('CALLING');
    // Navigate to the "Transisi keluar" sub-view (panel redesign).
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    expect(screen.getByTestId('panel-add-transition')).toBeDisabled();
  });

  it('the inline "Ke" select re-routes the edge target (source stays the selected node)', () => {
    const onChange = vi.fn();
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const }, [], onChange);
    selectStateNode('SERVING');
    // Navigate to the "Transisi keluar" sub-view (panel redesign).
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    // SERVING's outgoing edge is SERVING → COMPLETED (index 4). Change "Ke"
    // to SKIPPED (a status that is not already the target of an outgoing edge
    // from SERVING, so the reroute is non-duplicate). The source stays SERVING;
    // the target is re-routed from COMPLETED to SKIPPED.
    const toSelect = screen.getByTestId('panel-transition-to-SERVING->COMPLETED#4') as HTMLSelectElement;
    fireEvent.change(toSelect, { target: { value: 'SKIPPED' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    const routed = next.transitions.find((t: Transition) => t.from === 'SERVING');
    expect(routed?.to).toBe('SKIPPED');
  });

  it('the inline "Hapus" button is disabled when only one transition remains', () => {
    // 2-state / 1-transition graph (WAITING→CALLING). Select the SOURCE node
    // (WAITING) — its sole OUTGOING edge is WAITING→CALLING. The Hapus button
    // on that edge is disabled (the ≥1-transition invariant).
    const oneTransitionForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil', action: 'UPDATE_STATUS' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    renderWorkflow(oneTransitionForm);
    selectStateNode('WAITING');
    // Navigate to the "Transisi keluar" sub-view (panel redesign).
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    const deleteBtn = screen.getByTestId('panel-transition-delete-WAITING->CALLING#0');
    expect(deleteBtn).toBeDisabled();
  });

  it('the inline "Hapus" button deletes the outgoing transition when more than one transition exists', () => {
    const onChange = vi.fn();
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const }, [], onChange);
    selectStateNode('SERVING');
    // Navigate to the "Transisi keluar" sub-view (panel redesign).
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    const deleteBtn = screen.getByTestId('panel-transition-delete-SERVING->COMPLETED#4');
    expect(deleteBtn).not.toBeDisabled();
    fireEvent.click(deleteBtn);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // The SERVING → COMPLETED transition (the outgoing edge from SERVING) is gone.
    expect(next.transitions.every((t: Transition) => !(t.from === 'SERVING' && t.to === 'COMPLETED'))).toBe(true);
  });

  it('the state panel shows the empty-state hint when the node has no outgoing transitions', () => {
    // LONELY has no OUTGOING real transition. It IS linked to the End marker
    // (`endSources: ['LONELY']`), so a LONELY→__end terminal edge really does
    // render — which is what gives the panel's `e.type !== "terminal"` filter
    // something to filter. Without that link the assertion below would pass
    // vacuously (no outgoing edge of any kind to exclude).
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'LONELY'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil', action: 'UPDATE_STATUS' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: ['LONELY'], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
    renderWorkflow(customForm);
    // The terminal edge is live on the canvas — the filter has real work to do.
    expect(screen.getByTestId('rf__edge-LONELY->__end')).toBeInTheDocument();
    selectStateNode('LONELY');
    const panel = screen.getByTestId('sm-properties');
    // Navigate to the "Transisi keluar" sub-view (panel redesign: the node
    // editor splits into overview + transitions/actions sub-views).
    fireEvent.click(within(panel).getByTestId('panel-goto-transitions'));
    expect(within(panel).getByTestId('panel-transitions-empty')).toHaveTextContent(
      'Belum ada transisi keluar. Tambah transisi untuk membuat tombol dari status ini ke status lain.',
    );
  });

  // --- Node-level "Aksi" — independent of edges ----------------
  // The node-level Aksi section is NOT linked to any transition: adding /
  // editing / deleting a node action must NOT create / remove / reroute any
  // edge on the canvas (the core acceptance of the decoupling).

  it('the state panel renders BOTH the "Transisi keluar" and "Aksi" sections', () => {
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('SERVING');
    const panel = screen.getByTestId('sm-properties');
    // The panel redesign splits the node editor into an overview (name +
    // description + two nav cards) and two sub-views (transitions / actions).
    // The overview surfaces both nav cards — the manager picks which sub-view.
    expect(within(panel).getByTestId('panel-goto-transitions')).toBeInTheDocument();
    expect(within(panel).getByTestId('panel-goto-actions')).toBeInTheDocument();
    // Navigate to "Transisi keluar" — SERVING has 1 outgoing edge → the <ul>
    // renders.
    fireEvent.click(within(panel).getByTestId('panel-goto-transitions'));
    expect(within(panel).getByTestId('panel-transitions')).toBeInTheDocument();
    // Return to the overview, then navigate to "Aksi" — the node-level Aksi
    // section renders (empty by default: the empty hint + "Tambah aksi" button).
    fireEvent.click(within(panel).getByTestId('panel-back-to-status'));
    fireEvent.click(within(panel).getByTestId('panel-goto-actions'));
    expect(within(panel).getByTestId('panel-node-actions-empty')).toBeInTheDocument();
    expect(within(panel).getByTestId('panel-add-node-action')).toBeInTheDocument();
  });

  it('adding a node action does NOT create an edge on the canvas (independence)', () => {
    const onChange = vi.fn();
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil', action: 'UPDATE_STATUS' }],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    renderWorkflow(customForm, [], onChange);
    selectStateNode('WAITING');
    const edgeCountBefore = document.querySelectorAll('.react-flow__edge').length;
    // Navigate to the "Aksi" sub-view (panel redesign: node editor splits into
    // overview + transitions/actions sub-views).
    fireEvent.click(screen.getByTestId('panel-goto-actions'));
    fireEvent.click(screen.getByTestId('panel-add-node-action'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // The transitions are UNCHANGED — no new edge.
    expect(next.transitions).toEqual(customForm.transitions);
    // A node action was added to WAITING's nodeActions list.
    expect(next.nodeActions.WAITING).toHaveLength(1);
    expect(next.nodeActions.WAITING[0]).toEqual({
      executionType: 'ON_ENTRY',
      type: 'UPDATE_STATUS',
      value: 'CALLING', // first non-self state
    });
    // The canvas edge count is unchanged (no re-seed, no new edge).
    const edgeCountAfter = document.querySelectorAll('.react-flow__edge').length;
    expect(edgeCountAfter).toBe(edgeCountBefore);
  });

  it('editing a node action (Saat / Nilai) does NOT change any edge', () => {
    const onChange = vi.fn();
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING', 'SKIPPED'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil', action: 'UPDATE_STATUS' }],
      positions: {},
      nodeActions: {
        WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
      },
      descriptions: {},
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    renderWorkflow(customForm, [], onChange);
    selectStateNode('WAITING');
    // Navigate to the "Aksi" sub-view (the panel redesign splits the node editor
    // into overview + transitions/actions sub-views).
    fireEvent.click(screen.getByTestId('panel-goto-actions'));
    // The "Aksi" action-type is a <select> dropdown (extensible — one option,
    // UPDATE_STATUS, today), not a read-only badge.
    const typeSelect = screen.getByTestId('panel-node-action-type-0');
    expect(typeSelect.tagName).toBe('SELECT');
    expect(typeSelect).toHaveValue('UPDATE_STATUS');
    // Edit "Aksi" (type) → UPDATE_STATUS. One option today, so the value is
    // unchanged, but the change exercises the dropdown's onChange →
    // onEditNodeAction({ type }) wiring (the patch path that future action
    // types will use) and proves no edge is touched.
    fireEvent.change(typeSelect, { target: { value: 'UPDATE_STATUS' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next0 = onChange.mock.calls[0][0];
    expect(next0.transitions).toEqual(customForm.transitions);
    expect(next0.nodeActions.WAITING[0].type).toBe('UPDATE_STATUS');
    // Edit "Saat" → ON_EXIT.
    fireEvent.change(screen.getByTestId('panel-node-action-saat-0'), { target: { value: 'ON_EXIT' } });
    expect(onChange).toHaveBeenCalledTimes(2);
    const next1 = onChange.mock.calls[1][0];
    expect(next1.transitions).toEqual(customForm.transitions);
    expect(next1.nodeActions.WAITING[0].executionType).toBe('ON_EXIT');
    // Edit "Nilai" → SKIPPED.
    fireEvent.change(screen.getByTestId('panel-node-action-to-0'), { target: { value: 'SKIPPED' } });
    expect(onChange).toHaveBeenCalledTimes(3);
    const next2 = onChange.mock.calls[2][0];
    expect(next2.transitions).toEqual(customForm.transitions);
    expect(next2.nodeActions.WAITING[0].value).toBe('SKIPPED');
  });

  it('deleting a node action does NOT remove any edge', () => {
    const onChange = vi.fn();
    const customForm: StateMachineForm = {
      mode: 'custom' as const,
      states: ['WAITING', 'CALLING'],
      transitions: [{ from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil', action: 'UPDATE_STATUS' }],
      positions: {},
      nodeActions: {
        WAITING: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'CALLING' }],
      },
      descriptions: {},
      endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    };
    renderWorkflow(customForm, [], onChange);
    selectStateNode('WAITING');
    // Navigate to the "Aksi" sub-view (panel redesign: node editor splits into
    // overview + transitions/actions sub-views).
    fireEvent.click(screen.getByTestId('panel-goto-actions'));
    fireEvent.click(screen.getByTestId('panel-node-action-delete-0'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    // The transition is untouched.
    expect(next.transitions).toEqual(customForm.transitions);
    // The node action is gone.
    expect(next.nodeActions.WAITING).toEqual([]);
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
        { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya', action: 'UPDATE_STATUS' },
        { from: 'WAITING', to: 'COMPLETED', actionLabel: 'Skip', action: 'UPDATE_STATUS' },
      ],
      positions: {}, nodeActions: {}, descriptions: {}, endSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,    };
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

describe('StateMachineWorkflow (Start/End terminal markers)', () => {
  /** Select a canvas-only terminal marker by clicking its node card. Drives
   *  the real React Flow selection path (onNodeClick → onSelectionChange →
   *  selectedNodeId → panel marker branch). */
  function selectMarker(key: 'start' | 'end'): void {
    fireEvent.click(screen.getByTestId(`sm-node-${key}`));
  }

  it('the custom-mode palette offers Mulai + Selesai draggable cards', () => {
    // Manager feedback: the Start/End markers are palette-draggable affordances
    // (not just auto-derived). The palette lists them alongside "Status". Scope
    // to the palette: the canvas Start marker also renders the "Mulai" label.
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    const palette = screen.getByTestId('sm-palette');
    expect(within(palette).getByText('Mulai')).toBeInTheDocument();
    expect(within(palette).getByText('Selesai')).toBeInTheDocument();
  });

  it('selecting the Start marker opens the marker panel (info + reset + delete)', () => {
    // The default graph's auto/auto markers both render, so the Start marker is
    // on the canvas and clickable. The panel branches to the read-only marker
    // view (no state-name editor for __start).
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectMarker('start');
    expect(screen.getByTestId('sm-properties')).toBeInTheDocument();
    expect(screen.getByTestId('panel-terminal-info-start')).toBeInTheDocument();
    expect(screen.getByTestId('panel-terminal-reset-start')).toBeInTheDocument();
    expect(screen.getByTestId('panel-terminal-delete-start')).toBeInTheDocument();
    // No state-name editor renders for a marker (it is not a real state).
    expect(screen.queryByTestId('panel-state-name')).not.toBeInTheDocument();
  });

  it('the reset button is disabled while the marker is auto (no-op reset)', () => {
    // An auto marker is already at the derived position → "Reset ke posisi
    // otomatis" is a no-op, so the button is disabled.
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectMarker('start');
    expect(screen.getByTestId('panel-terminal-reset-start')).toBeDisabled();
  });

  it('Hapus (delete) hides the marker — onChange sets terminalNodes.start to "hidden"', () => {
    const onChange = vi.fn();
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const }, [], onChange);
    selectMarker('start');
    fireEvent.click(screen.getByTestId('panel-terminal-delete-start'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.terminalNodes.start).toBe('hidden');
    // The End marker is untouched.
    expect(next.terminalNodes.end).toBe('auto');
  });

  it('Reset ke posisi otomatis on a pinned marker sets terminalNodes.start back to "auto"', () => {
    // A pinned marker ({x,y}) has the reset button ENABLED; clicking it lifts
    // the pin → 'auto' so the marker re-derives its position from the topology.
    const onChange = vi.fn();
    const form: StateMachineForm = {
      ...defaultStateMachineForm(),
      mode: 'custom' as const,
      terminalNodes: { start: { x: -500, y: 40 }, end: 'auto' },
    };
    renderWorkflow(form, [], onChange);
    selectMarker('start');
    expect(screen.getByTestId('panel-terminal-reset-start')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('panel-terminal-reset-start'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].terminalNodes.start).toBe('auto');
  });

  it('a status added from the palette gets NO terminal edge (a stray node is not an entry AND an exit)', () => {
    // Manager feedback: "a stray node with no transisi is automatically linked to
    // Start and End." A just-dropped status has in-degree 0 AND out-degree 0, so
    // it used to satisfy BOTH the source and the sink predicate in
    // `deriveTerminalMarkers` → it got a __start→S edge AND an S→__end edge,
    // reading as the flow's entry AND its exit at once. It is not wired into the
    // flow yet, so it gets neither; the default graph's real entry (WAITING) and
    // the manager's End link (COMPLETED) keep theirs.
    //
    // Drives the COMMIT path (not a fresh re-seed): the palette card sets
    // `application/reactflow: 'state'`, the canvas drop handler calls
    // `addStateAt` → `commit`, which re-derives the marker edges through
    // `formToFlowWithMarkers`. That is the manager's actual repro.
    const onChange = vi.fn();
    // `endSources: ['COMPLETED']` is the POSITIVE CONTROL for the negative
    // assertions below: it proves `rf__edge-<state>->__end` testids do render on
    // this canvas, so the missing `STATUS_1->__end` is a real absence rather
    // than an id that never existed.
    renderWorkflow(
      { ...defaultStateMachineForm(), mode: 'custom' as const, endSources: ['COMPLETED'] },
      [],
      onChange,
    );
    // Baseline: the Start edge is auto-derived on WAITING (sole source); the End
    // edge exists only because COMPLETED is a manager-drawn endSource.
    expect(screen.getByTestId('rf__edge-__start->WAITING')).toBeInTheDocument();
    expect(screen.getByTestId('rf__edge-COMPLETED->__end')).toBeInTheDocument();

    fireEvent.drop(screen.getByTestId('sm-canvas'), { dataTransfer: { getData: () => 'state' } });

    // The new status is on the canvas (and in the lifted form) — `nextStateName`
    // mints STATUS_1 (no collision with the 5 canonical names).
    expect(screen.getByTestId('sm-node-card-STATUS_1')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].states).toContain('STATUS_1');
    // It carries NO terminal edge in either direction.
    expect(screen.queryByTestId('rf__edge-__start->STATUS_1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rf__edge-STATUS_1->__end')).not.toBeInTheDocument();
    // Both markers still render, still wired to the real entry / linked exit.
    expect(screen.getByTestId('sm-node-start')).toBeInTheDocument();
    expect(screen.getByTestId('sm-node-end')).toBeInTheDocument();
    expect(screen.getByTestId('rf__edge-__start->WAITING')).toBeInTheDocument();
    expect(screen.getByTestId('rf__edge-COMPLETED->__end')).toBeInTheDocument();
  });

  it('a self-loop on the entry status KEEPS its Start arrow (manager repro)', () => {
    // Manager feedback: "WAITING memiliki transisi masuk dari Start dan aku mau
    // bikin self-loop, kemudian yang dari Start hilang." The self-loop used to
    // count toward WAITING's in-degree, so WAITING stopped being an entry point
    // and `deriveTerminalMarkers` dropped the `__start → WAITING` arrow —
    // looking to the manager like their existing connection was deleted.
    //
    // Drives the real COMMIT path, not a fresh re-seed: "+ Tambah transisi" on
    // WAITING picks the first non-duplicate target, which is WAITING itself, so
    // it adds exactly the self-loop the manager drew.
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    expect(screen.getByTestId('rf__edge-__start->WAITING')).toBeInTheDocument();

    selectStateNode('WAITING');
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    fireEvent.click(screen.getByTestId('panel-add-transition'));

    // The self-loop is on the canvas AND the Start arrow survived.
    expect(screen.getByTestId('rf__edge-sm-edge-0')).toBeInTheDocument();
    expect(screen.getByTestId('rf__edge-__start->WAITING')).toBeInTheDocument();
    expect(screen.getByTestId('sm-node-start')).toBeInTheDocument();
  });

  it('draws a self-loop as a long arc clear of the card, not a bezier through it', () => {
    // Manager feedback: "self-loop garisnya overlap dan jelek sekali, seharusnya
    // lebih panjang lagi." `getBezierPath` is degenerate when both endpoints sit
    // on the same card — a short backwards curve running through/behind the node
    // (edges render beneath nodes) with the label chip on top of it.
    // `TransitionEdge` branches to `getSelfLoopPath` for `source === target`.
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    selectStateNode('WAITING');
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
    fireEvent.click(screen.getByTestId('panel-add-transition'));

    const d = screen
      .getByTestId('rf__edge-sm-edge-0')
      .querySelector('path.react-flow__edge-path')!
      .getAttribute('d')!;
    // `M sx,sy C c1x,c1y c2x,c2y tx,ty` — pull every y out of the path. The
    // endpoints share a y (both handles sit at the card's vertical middle for
    // the seeded right→left routing); both control points must sit a full
    // SELF_LOOP_RADIUS above them, so the loop swings up and over the card.
    const ys = [...d.matchAll(/-?[\d.]+,(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys).toHaveLength(4);
    expect(Math.min(...ys)).toBeLessThanOrEqual(ys[0] - SELF_LOOP_RADIUS);
  });

  it('the End marker renders with ZERO endSources so it can be dragged into', () => {
    // The load-bearing UX invariant of the manual-End rule: with nothing linked,
    // the marker must still be on the canvas — it is the drop target, so hiding
    // it would make the first manual link impossible. The default graph declares
    // no endSources, so this is the out-of-the-box state.
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    expect(screen.getByTestId('sm-node-end')).toBeInTheDocument();
    // COMPLETED is a leaf (no outgoing transition) and is NOT auto-linked.
    expect(screen.queryByTestId('rf__edge-COMPLETED->__end')).not.toBeInTheDocument();
    // The Start marker's own auto-derivation is untouched by the End change.
    expect(screen.getByTestId('rf__edge-__start->WAITING')).toBeInTheDocument();
  });

  it('wiring a NEW status in as a leaf does not auto-link it to End (the manager repro, commit path)', () => {
    // The exact regression PR #103 left behind: a status is no longer isolated
    // (so the isolated-state exclusion does not cover it) but has no outgoing
    // transition — and was auto-linked to End the moment it was wired in.
    //
    // Driven through the real COMMIT path on a CONTROLLED harness (the parent
    // feeds each lifted form back as `value`, like AlurStatusDesigner does), so
    // the palette drop and the reroute both re-derive markers via
    // `formToFlowWithMarkers` exactly as they do in production.
    function Controlled(): JSX.Element {
      const [form, setForm] = useState<StateMachineForm>({
        ...defaultStateMachineForm(),
        mode: 'custom' as const,
        // Positive control (see below).
        endSources: ['COMPLETED'],
      });
      return <StateMachineWorkflow value={form} onChange={setForm} errors={[]} />;
    }
    render(<Controlled />);

    // Positive control: an End edge DOES render on this canvas.
    expect(screen.getByTestId('rf__edge-COMPLETED->__end')).toBeInTheDocument();

    // 1. Drop a new status from the palette → STATUS_1 (isolated so far).
    fireEvent.drop(screen.getByTestId('sm-canvas'), { dataTransfer: { getData: () => 'state' } });
    expect(screen.getByTestId('sm-node-card-STATUS_1')).toBeInTheDocument();

    // 2. Wire it IN: re-point WAITING→CALLING at STATUS_1 via the edge panel's
    //    "Ke" select. STATUS_1 now has in-degree 1 and out-degree 0 — a leaf.
    selectEdge('WAITING->CALLING#0');
    fireEvent.change(screen.getByTestId('panel-transition-to'), { target: { value: 'STATUS_1' } });
    expect(screen.getByTestId('rf__edge-WAITING->CALLING#0')).toBeInTheDocument();

    // 3. The leaf is NOT auto-linked to End — the manager must draw that line.
    expect(screen.queryByTestId('rf__edge-STATUS_1->__end')).not.toBeInTheDocument();
    // No End edge appeared for any other newly-leafed state either (CALLING lost
    // its only incoming edge but keeps its outgoing one, so it is not a leaf).
    expect(screen.queryByTestId('rf__edge-CALLING->__end')).not.toBeInTheDocument();
    // The marker + the manager's own link survive the commits.
    expect(screen.getByTestId('sm-node-end')).toBeInTheDocument();
    expect(screen.getByTestId('rf__edge-COMPLETED->__end')).toBeInTheDocument();
  });

  it('the End marker offers a connection handle on all four sides in custom mode', () => {
    // Dragging into the End marker is the ONLY route to an End link now, so a
    // single drop point on one side is a discoverability risk ("selalu tidak
    // bisa menghubungkan" is a standing complaint about this designer). The
    // marker mirrors StateNode's four typeless handles.
    renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
    const endHandles = document.querySelectorAll('.react-flow__node-end .react-flow__handle');
    expect(endHandles.length).toBe(4);
    expect(
      Array.from(endHandles)
        .map((h) => h.getAttribute('data-handlepos'))
        .sort(),
    ).toEqual(['bottom', 'left', 'right', 'top']);
    // All four are live drop targets in custom mode (React Flow stamps
    // `connectable` only on a handle with isConnectable={true}).
    expect(document.querySelectorAll('.react-flow__node-end .react-flow__handle.connectable').length).toBe(4);
  });

  it('the End marker handles are NOT connectable in read-only default mode', () => {
    // The read-only board must stay non-interactive — the four handles are
    // additive for the editable canvas only.
    renderWorkflow(defaultStateMachineForm());
    expect(document.querySelectorAll('.react-flow__node-end .react-flow__handle.connectable').length).toBe(0);
  });

  it('the marker panel reports the pinned position for a pinned marker', () => {
    // The info line surfaces the live pinned coordinates so the manager can see
    // where the marker is willed (vs the auto-derived rank offset).
    const form: StateMachineForm = {
      ...defaultStateMachineForm(),
      mode: 'custom' as const,
      terminalNodes: { start: { x: -500, y: 40 }, end: 'auto' },
    };
    renderWorkflow(form);
    selectMarker('start');
    expect(screen.getByTestId('panel-terminal-info-start')).toHaveTextContent('x=-500');
    expect(screen.getByTestId('panel-terminal-info-start')).toHaveTextContent('y=40');
  });

  describe('End marker — "Transisi masuk" list (endSources)', () => {
    /**
     * Manager feedback: "node masih otomatis linked ke end, seharusnya manual
     * linked." The End panel's "Transisi masuk" section lists ONLY the
     * manager-drawn `endSources` entries — there are no read-only "otomatis"
     * rows, because the End marker derives nothing from the graph shape. Every
     * row carries a "Hapus" button (lifts via `onRemoveEndSource`,
     * non-stamping), so nothing in the list is beyond the manager's control.
     */
    it('lists only the manager-drawn endSources, each with a Hapus button', () => {
      // Default graph: COMPLETED is a leaf (no outgoing transition) and WAITING
      // is mid-flow. Neither is listed by virtue of its shape — only WAITING,
      // because the manager drew that link.
      const form: StateMachineForm = {
        ...defaultStateMachineForm(),
        mode: 'custom' as const,
        endSources: ['WAITING'],
      };
      renderWorkflow(form);
      selectMarker('end');
      const panel = screen.getByTestId('sm-properties');
      // The "Transisi masuk" section renders.
      expect(within(panel).getByTestId('panel-end-incoming')).toBeInTheDocument();
      expect(within(panel).getByTestId('panel-end-incoming-list')).toBeInTheDocument();
      // WAITING is the drawn link → listed WITH a Hapus button.
      expect(within(panel).getByTestId('panel-end-source-WAITING')).toBeInTheDocument();
      expect(within(panel).getByTestId('panel-end-source-delete-WAITING')).toBeInTheDocument();
      // COMPLETED is a LEAF but was never linked → NOT listed. (The positive
      // assertion above proves `panel-end-source-*` rows do render here.)
      expect(within(panel).queryByTestId('panel-end-source-COMPLETED')).not.toBeInTheDocument();
      // Neither are the other unlinked states.
      expect(within(panel).queryByTestId('panel-end-source-CALLING')).not.toBeInTheDocument();
      expect(within(panel).queryByTestId('panel-end-source-SERVING')).not.toBeInTheDocument();
      expect(within(panel).queryByTestId('panel-end-source-SKIPPED')).not.toBeInTheDocument();
    });

    it('a LEAF state that IS an endSource gets a removable row (no read-only auto row)', () => {
      // COMPLETED is a leaf AND drawn into End. It used to render as a read-only
      // "Otomatis — status tanpa transisi keluar" row the manager could not
      // remove; now it is an ordinary manager-owned row with a Hapus button.
      const form: StateMachineForm = {
        ...defaultStateMachineForm(),
        mode: 'custom' as const,
        endSources: ['COMPLETED', 'WAITING'],
      };
      renderWorkflow(form);
      selectMarker('end');
      const panel = screen.getByTestId('sm-properties');
      expect(within(panel).getByTestId('panel-end-source-COMPLETED')).toBeInTheDocument();
      expect(within(panel).getByTestId('panel-end-source-delete-COMPLETED')).toBeInTheDocument();
      expect(within(panel).getByTestId('panel-end-source-delete-WAITING')).toBeInTheDocument();
      // The old read-only auto-row copy is gone from the panel entirely.
      expect(panel).not.toHaveTextContent('Otomatis — status tanpa transisi keluar');
    });

    it('Hapus on an explicit endSource calls onChange with endSources filtered (non-stamping)', () => {
      const onChange = vi.fn();
      const form: StateMachineForm = {
        ...defaultStateMachineForm(),
        mode: 'custom' as const,
        endSources: ['WAITING', 'SERVING'],
      };
      renderWorkflow(form, [], onChange);
      selectMarker('end');
      fireEvent.click(screen.getByTestId('panel-end-source-delete-WAITING'));
      expect(onChange).toHaveBeenCalledTimes(1);
      const next = onChange.mock.calls[0][0];
      // Non-stamping: only endSources mutated, transitions untouched.
      expect(next.endSources).toEqual(['SERVING']);
      expect(next.transitions).toEqual(form.transitions);
    });

    it('shows the empty hint when endSources is empty (the out-of-the-box state)', () => {
      // No endSources → the "Transisi masuk" list is empty regardless of graph
      // shape. This is now the DEFAULT graph's state: COMPLETED is a leaf but is
      // not listed, because nothing is auto-linked. (The marker no longer needs
      // to be pinned for this case — an 'auto' End marker always renders.)
      const form: StateMachineForm = {
        ...defaultStateMachineForm(),
        mode: 'custom' as const,
        endSources: [],
      };
      renderWorkflow(form);
      selectMarker('end');
      const panel = screen.getByTestId('sm-properties');
      expect(within(panel).getByTestId('panel-end-incoming-empty')).toBeInTheDocument();
      expect(within(panel).queryByTestId('panel-end-incoming-list')).not.toBeInTheDocument();
    });

    it('the End marker copy states the manual-only rule; the Start copy still describes auto derivation', () => {
      // The behaviour change must be legible to the manager in the panel, not
      // just in the canvas: End says it never links itself, Start still says it
      // points at entry statuses automatically.
      renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
      selectMarker('end');
      const endCopy = screen.getByTestId('panel-marker-description');
      expect(endCopy).toHaveTextContent('tidak pernah tersambung otomatis');
      expect(endCopy).toHaveTextContent('Seret garis dari sebuah status ke titik akhir');

      selectMarker('start');
      const startCopy = screen.getByTestId('panel-marker-description');
      expect(startCopy).toHaveTextContent('otomatis menunjuk ke status');
    });

    /**
     * Cascade regression (arch review, MAJOR). `commit` rebuilds `states` from
     * the canvas nodes but used to carry `endSources`/`nodeActions`/
     * `descriptions` from `value` verbatim, so deleting or renaming a state
     * that any of them referenced stranded a dead name in the LIFTED FORM.
     * The save use case cross-checks all three and throws `... is not a state
     * in the active state machine` → HTTP 400 on every later save, while every
     * panel lists live states only, so there was no in-app route to clear it.
     *
     * These assert on what `onChange` LIFTS (the form that would be sent to the
     * wire), not on the canvas — the canvas already hid the problem.
     */
    it('renaming a linked state REMAPS its endSource (the link survives the rename)', () => {
      const onChange = vi.fn();
      const form: StateMachineForm = {
        ...defaultStateMachineForm(),
        mode: 'custom' as const,
        endSources: ['COMPLETED'],
        descriptions: { COMPLETED: 'Tiket selesai dilayani' },
        nodeActions: { COMPLETED: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'COMPLETED' }] },
      };
      renderWorkflow(form, [], onChange);
      selectStateNode('COMPLETED');
      fireEvent.change(screen.getByTestId('panel-state-name'), { target: { value: 'SELESAI' } });

      expect(onChange).toHaveBeenCalledTimes(1);
      const next = onChange.mock.calls[0][0];
      expect(next.states).toContain('SELESAI');
      expect(next.states).not.toContain('COMPLETED');
      // The manager's End link FOLLOWS the rename — not pruned, not stranded.
      expect(next.endSources).toEqual(['SELESAI']);
      // Same for the name-keyed satellites, including the action's `value`
      // (also cross-checked by the save use case).
      expect(next.descriptions).toEqual({ SELESAI: 'Tiket selesai dilayani' });
      expect(next.nodeActions.SELESAI).toEqual([
        { executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'SELESAI' },
      ]);
      expect(next.nodeActions.COMPLETED).toBeUndefined();
      // Nothing in the lifted form still names a dead state — this is exactly
      // what the backend cross-check enforces.
      const live = new Set<string>(next.states);
      expect(next.endSources.every((s: string) => live.has(s))).toBe(true);
      expect(Object.keys(next.descriptions).every((k) => live.has(k))).toBe(true);
      expect(Object.keys(next.nodeActions).every((k) => live.has(k))).toBe(true);
    });

    it('deleting a linked state PRUNES its endSource (no stale entry reaches the wire)', () => {
      const onChange = vi.fn();
      const form: StateMachineForm = {
        ...defaultStateMachineForm(),
        mode: 'custom' as const,
        endSources: ['COMPLETED', 'SKIPPED'],
        descriptions: { COMPLETED: 'Tiket selesai dilayani' },
        nodeActions: {
          COMPLETED: [{ executionType: 'ON_ENTRY', type: 'UPDATE_STATUS', value: 'WAITING' }],
          // An action on a SURVIVING state whose target is the deleted one:
          // `nodeActions['SERVING'].value` is cross-checked too.
          SERVING: [{ executionType: 'ON_EXIT', type: 'UPDATE_STATUS', value: 'COMPLETED' }],
        },
      };
      renderWorkflow(form, [], onChange);
      selectStateNode('COMPLETED');
      fireEvent.click(screen.getByTestId('panel-delete-state'));

      expect(onChange).toHaveBeenCalledTimes(1);
      const next = onChange.mock.calls[0][0];
      expect(next.states).not.toContain('COMPLETED');
      // The deleted state's link is gone; the OTHER link is untouched (the
      // prune is surgical, not a blanket clear).
      expect(next.endSources).toEqual(['SKIPPED']);
      expect(next.descriptions.COMPLETED).toBeUndefined();
      expect(next.nodeActions.COMPLETED).toBeUndefined();
      // The surviving state's action pointed at the deleted state — dropped,
      // since "Update Status ke <deleted>" has no meaning left.
      expect(next.nodeActions.SERVING).toEqual([]);
      const live = new Set<string>(next.states);
      expect(next.endSources.every((s: string) => live.has(s))).toBe(true);
      expect(Object.keys(next.nodeActions).every((k) => live.has(k))).toBe(true);
      for (const actions of Object.values(next.nodeActions)) {
        expect((actions as { value: string }[]).every((a) => live.has(a.value))).toBe(true);
      }
    });

    it('a stale endSource name not in states is dropped from the panel list', () => {
      // `endSources` may carry a name that was since deleted from `states` (the
      // rename/delete cascade lives in the lib, but a malformed form could still
      // surface one). The panel's `stateSet.has(s)` guard drops it from the list.
      const form: StateMachineForm = {
        ...defaultStateMachineForm(),
        mode: 'custom' as const,
        endSources: ['GONE', 'WAITING'],
      };
      renderWorkflow(form);
      selectMarker('end');
      const panel = screen.getByTestId('sm-properties');
      expect(within(panel).queryByTestId('panel-end-source-GONE')).not.toBeInTheDocument();
      expect(within(panel).getByTestId('panel-end-source-WAITING')).toBeInTheDocument();
    });
  });

  // The "Aksi" dropdown per outgoing transition: what running that button DOES.
  // The manager's report is what it exists for — they drew `CALLING → WAITING`
  // to put a ticket back in the queue and got a "Pindah Kategori" button asking
  // for a destination category, because the backend inferred the meaning from
  // the target state. Now the edge says which it is, and the same endpoints can
  // mean either.
  describe('the "Aksi" dropdown on an outgoing transition', () => {
    /** Selects WAITING and opens its "Transisi keluar" sub-view. */
    function openWaitingTransitions(): HTMLElement {
      selectStateNode('WAITING');
      const panel = screen.getByTestId('sm-properties');
      fireEvent.click(within(panel).getByTestId('panel-goto-transitions'));
      return panel;
    }

    it('defaults to Ubah Status and offers Pindah Kategori', () => {
      renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const });
      const panel = openWaitingTransitions();
      const select = within(panel).getByTestId(
        'panel-transition-action-WAITING->CALLING#0',
      ) as HTMLSelectElement;
      expect(select.value).toBe('UPDATE_STATUS');
      expect([...select.options].map((o) => o.value)).toEqual([
        'UPDATE_STATUS',
        'TRANSFER_CATEGORY',
      ]);
      expect([...select.options].map((o) => o.textContent)).toEqual([
        'Ubah Status',
        'Pindah Kategori',
      ]);
    });

    it('lifts the chosen action onto that transition and leaves every other field alone', () => {
      const onChange = vi.fn();
      renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const }, [], onChange);
      const panel = openWaitingTransitions();

      fireEvent.change(
        within(panel).getByTestId('panel-transition-action-WAITING->CALLING#0'),
        { target: { value: 'TRANSFER_CATEGORY' } },
      );

      expect(onChange).toHaveBeenCalledTimes(1);
      const next = onChange.mock.calls[0][0];
      const edited = next.transitions.find(
        (t: { from: string; to: string }) => t.from === 'WAITING' && t.to === 'CALLING',
      );
      expect(edited.action).toBe('TRANSFER_CATEGORY');
      // Its label and endpoints are untouched — the action is a separate facet,
      // not a relabelling.
      expect(edited.actionLabel).toBe('Panggil Berikutnya');
      // No edge was created or removed: the graph shape is identical.
      expect(next.transitions).toHaveLength(defaultStateMachineForm().transitions.length);
      expect(next.states).toEqual([...DEFAULT_STATE_MACHINE.states]);
      // Every OTHER transition keeps its own action.
      expect(
        next.transitions
          .filter((t: { from: string; to: string }) => !(t.from === 'WAITING' && t.to === 'CALLING'))
          .every((t: { action: string }) => t.action === 'UPDATE_STATUS'),
      ).toBe(true);
    });

    it('renders the action a saved transition already carries', () => {
      // Round-trip proof: a stored TRANSFER_CATEGORY edge shows as such, so the
      // manager can see (and undo) what they chose.
      const base = defaultStateMachineForm();
      const form = {
        ...base,
        mode: 'custom' as const,
        transitions: base.transitions.map((t) =>
          t.from === 'WAITING' ? { ...t, action: 'TRANSFER_CATEGORY' as const } : t,
        ),
      };
      renderWorkflow(form);
      const panel = openWaitingTransitions();
      expect(
        (within(panel).getByTestId('panel-transition-action-WAITING->CALLING#0') as HTMLSelectElement)
          .value,
      ).toBe('TRANSFER_CATEGORY');
    });

    it('is editable from the standalone edge editor too, so both paths agree', () => {
      const onChange = vi.fn();
      renderWorkflow({ ...defaultStateMachineForm(), mode: 'custom' as const }, [], onChange);
      selectEdge('WAITING->CALLING#0');
      const panel = screen.getByTestId('sm-properties');

      fireEvent.change(within(panel).getByTestId('panel-transition-action'), {
        target: { value: 'TRANSFER_CATEGORY' },
      });

      const next = onChange.mock.calls[0][0];
      expect(
        next.transitions.find(
          (t: { from: string; to: string }) => t.from === 'WAITING' && t.to === 'CALLING',
        ).action,
      ).toBe('TRANSFER_CATEGORY');
    });
  });
});

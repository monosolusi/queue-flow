/**
 * Regression test for the "only certain sides connect even when empty" bug.
 *
 * Manager feedback: "padahal ada 2 titik di atas, dan 2 titik di tiap sisi, nah
 * kenapa yang bisa dihubungkan hanya sisi tertentu meski sisi itu kosong?"
 *
 * Historical root cause (verified in the @xyflow/react source
 * `XYHandle.isValidHandle`): under `ConnectionMode.Strict` (the React Flow
 * default) a connection that STARTS at a `source` handle is only valid when it
 * ENDS on a `target`-TYPED handle, and the node used to render one `source` +
 * one `target` handle per side. React Flow drops onto the handle under the
 * cursor; when that nearest handle was a `source`, the drop was rejected — so a
 * side read unconnectable whenever its `source` handle was the nearer of the
 * pair, even though nothing was connected there yet. That two-handles-per-side
 * geometry is gone now (see the current mechanism below); this paragraph is
 * retained only as the history of the original strict-mode bug.
 *
 * Fix: the parent `<ReactFlow>` is configured with `connectionMode={ConnectionMode.
 * Loose}`, whose validity branch is "any handle but the start handle" — so a
 * drag may land on ANY handle of another node. Each side now carries a SINGLE
 * TYPELESS `source`-typed handle (one per side) that, under Loose, both STARTS
 * and RECEIVES a connection, so every visible dot is a drag-from AND a drop-to
 * ("drag from all points to all points"). Because every drag starts at a
 * `source`-typed handle, the START-handle-TYPE arrow-reversal can never fire, so
 * the arrow always follows the drag direction (pinned by the sibling
 * `StateMachineWorkflow.test.tsx` "makes every handle a bidirectional typeless
 * connection point" test).
 *
 * `connectionMode` has NO jsdom DOM surface — React Flow keeps it in its store
 * and stamps no attribute. The live drag itself needs real pointer geometry that
 * jsdom cannot provide (see CLAUDE.md frontend-RTL gotchas), so the connection
 * outcome is not exercisable here either. The jsdom-observable proxy is the prop
 * the component passes to `<ReactFlow>`: we mock the `ReactFlow` named export
 * (re-exporting everything else from the real module) to capture it. This is the
 * same "cover the jsdom-untestable behavior through a focused seam" pattern the
 * suite already uses for the duplicate-toast (`onConnectEnd`) logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import {
  ConnectionMode,
  type Connection,
  type FinalConnectionState,
  type ReactFlowProps,
} from '@xyflow/react';
import type { StateMachineForm } from '../lib/state-machine';
import { defaultStateMachineForm } from '../lib/state-machine';
import { END_NODE_ID, START_NODE_ID } from '../lib/state-machine-flow';

// Capture the props the component passes to `<ReactFlow>`. `connectionMode` has
// no DOM surface, so we record it here. Mocked `ReactFlow` returns nothing — the
// real `ReactFlowProvider` (kept) still provides the store `useReactFlow()` reads
// inside `FlowCanvas`, so the component mounts without the canvas DOM.
let capturedReactFlowProps: ReactFlowProps | null = null;

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlow: (props: ReactFlowProps) => {
      capturedReactFlowProps = props;
      return null;
    },
  };
});

// Import AFTER `vi.mock` (hoisted) so the component sees the mocked `ReactFlow`.
import { StateMachineWorkflow } from './StateMachineWorkflow';

describe('StateMachineWorkflow connection mode (every side accepts a drop)', () => {
  beforeEach(() => {
    // Reset so a sibling test added later never reads a stale capture.
    capturedReactFlowProps = null;
  });

  afterEach(() => {
    // `document.elementFromPoint` does not exist in jsdom, so a stub must be
    // DELETED rather than restored — leaving one behind would make a later test
    // resolve a node id it never set up.
    delete (document as Partial<Document>).elementFromPoint;
  });

  /**
   * Stub the one DOM API `nodeIdUnderPointer` depends on. jsdom does not
   * implement `document.elementFromPoint` (it is `undefined`, not a stub) and
   * does no layout, so the real hit test is browser-only; the stub covers the
   * WIRING around it. Returns the spy so a test can assert the coordinates.
   */
  function stubElementFromPoint(result: Element | null) {
    const lookup = vi.fn(() => result);
    (document as Partial<Document>).elementFromPoint = lookup as Document['elementFromPoint'];
    return lookup;
  }

  /** The `FinalConnectionState` React Flow hands `onConnectEnd`, defaulted to
   *  the rejected same-node drop (`isValid: null`) the self-loop fallback keys
   *  off. Overrides narrow it to the case under test. */
  function connectionState(overrides: Record<string, unknown>) {
    return {
      isValid: null,
      fromNode: { id: 'WAITING' },
      fromHandle: { id: 'right' },
      toNode: { id: 'WAITING' },
      ...overrides,
    } as unknown as FinalConnectionState;
  }

  /** Drive the captured `onConnectEnd`. Wrapped in `act` because the self-loop
   *  branch calls `commit`, which sets React state (the rejected branches do
   *  not — the wrapper keeps both paths warning-free). `event` defaults to a
   *  mouse release; the touch tests pass their own. */
  function fireConnectEnd(
    state: FinalConnectionState,
    event: MouseEvent | TouchEvent = new MouseEvent('mouseup'),
  ): void {
    act(() => {
      capturedReactFlowProps!.onConnectEnd!(event, state);
    });
  }

  it('configures React Flow with ConnectionMode.Loose', () => {
    const customForm: StateMachineForm = { ...defaultStateMachineForm(), mode: 'custom' };
    render(<StateMachineWorkflow value={customForm} onChange={vi.fn()} errors={[]} />);
    expect(capturedReactFlowProps).not.toBeNull();
    // Loose mode is the fix: a source-start drag may land on a `source` handle,
    // so every side accepts a drop (strict mode rejected same-type drops).
    expect(capturedReactFlowProps!.connectionMode).toBe(ConnectionMode.Loose);
  });

  describe('End marker explicit connections (endSources)', () => {
    /**
     * The End marker is a visual sink. Auto-derived edges still appear for
     * states with no outgoing transitions (the "auto sink" rule), but a manager
     * may ALSO drag an explicit connection from any state into End, and multiple
     * are allowed. `endSources` is the persisted wire contract for those explicit
     * connections (a flat array of state names). These tests cover the
     * jsdom-observable proxy of that behavior: `isValidConnection` (the gate
     * that rejects duplicates) and `onConnect` (the stamp path for a new
     * explicit End connection). The live drag itself needs real pointer
     * geometry jsdom cannot provide.
     */
    function customForm(overrides: Partial<StateMachineForm> = {}): StateMachineForm {
      return {
        ...defaultStateMachineForm(),
        mode: 'custom',
        states: ['WAITING', 'CALLING', 'SERVING'],
        transitions: [
          { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' },
          { from: 'CALLING', to: 'SERVING', actionLabel: 'Layan' },
        ],
        ...overrides,
      };
    }

    it('isValidConnection accepts a new explicit End connection from a non-sink state', () => {
      const form = customForm({ endSources: [] });
      render(<StateMachineWorkflow value={form} onChange={vi.fn()} errors={[]} />);
      const isValid = capturedReactFlowProps!.isValidConnection!;
      // WAITING has an outgoing transition (WAITING→CALLING) so it is NOT an
      // auto sink, and `endSources: []` means no explicit edge yet — so a drag
      // from WAITING into End is accepted. (SERVING, the auto sink, is already
      // connected to End by the auto-derived edge and would be rejected.)
      const result = isValid({
        source: 'WAITING',
        target: END_NODE_ID,
        sourceHandleId: 's-top',
        targetHandleId: 't-top',
      } as unknown as Connection);
      expect(result).toBe(true);
    });

    it('isValidConnection rejects a duplicate End connection (state already an endSource)', () => {
      const form = customForm({ endSources: ['WAITING'] });
      render(<StateMachineWorkflow value={form} onChange={vi.fn()} errors={[]} />);
      const isValid = capturedReactFlowProps!.isValidConnection!;
      // WAITING is not an auto sink, but it IS listed in `endSources`, so the
      // explicit edge `WAITING→__end#x` is present and a second drag is rejected.
      const result = isValid({
        source: 'WAITING',
        target: END_NODE_ID,
        sourceHandleId: 's-top',
        targetHandleId: 't-top',
      } as unknown as Connection);
      expect(result).toBe(false);
    });

    it('isValidConnection rejects an End connection from an auto-sink state (already wired to End)', () => {
      const form = customForm({ endSources: [] });
      render(<StateMachineWorkflow value={form} onChange={vi.fn()} errors={[]} />);
      const isValid = capturedReactFlowProps!.isValidConnection!;
      // SERVING has no outgoing transition → `formToFlowWithMarkers` emits the
      // auto-derived `SERVING→__end` edge → `hasEndSource` is true → rejected,
      // even though `endSources` is empty. The auto-sink rule and the explicit
      // endSources share the same End target, so a state can never have both.
      const result = isValid({
        source: 'SERVING',
        target: END_NODE_ID,
        sourceHandleId: 's-top',
        targetHandleId: 't-top',
      } as unknown as Connection);
      expect(result).toBe(false);
    });

    it('isValidConnection rejects an End connection whose source is a terminal marker', () => {
      const form = customForm({ endSources: [] });
      render(<StateMachineWorkflow value={form} onChange={vi.fn()} errors={[]} />);
      const isValid = capturedReactFlowProps!.isValidConnection!;
      // The Start marker must never originate an End connection.
      const result = isValid({
        source: START_NODE_ID,
        target: END_NODE_ID,
        sourceHandleId: 's-top',
        targetHandleId: 't-top',
      } as unknown as Connection);
      expect(result).toBe(false);
    });

    it('isValidConnection rejects any connection whose target is the Start marker', () => {
      const form = customForm({ endSources: [] });
      render(<StateMachineWorkflow value={form} onChange={vi.fn()} errors={[]} />);
      const isValid = capturedReactFlowProps!.isValidConnection!;
      const result = isValid({
        source: 'WAITING',
        target: START_NODE_ID,
        sourceHandleId: 's-top',
        targetHandleId: 't-top',
      } as unknown as Connection);
      expect(result).toBe(false);
    });

    it('onConnect stamps a new explicit End connection via endSources (non-stamping onChange)', () => {
      const onChange = vi.fn();
      const form = customForm({ endSources: [] });
      render(<StateMachineWorkflow value={form} onChange={onChange} errors={[]} />);
      const onConnect = capturedReactFlowProps!.onConnect!;
      // WAITING is a non-sink (has WAITING→CALLING), so the auto-derived End
      // edge is NOT present and onConnect's `hasEndSource` guard passes.
      onConnect({
        source: 'WAITING',
        target: END_NODE_ID,
        sourceHandleId: 's-top',
        targetHandleId: 't-top',
      } as unknown as Connection);
      expect(onChange).toHaveBeenCalledOnce();
      const [next] = onChange.mock.calls[0];
      // Non-stamping: endSources is the only mutated field, no transition added.
      expect(next.endSources).toEqual(['WAITING']);
      expect(next.transitions).toEqual(form.transitions);
    });

    it('onConnect into End ignores a duplicate (no onChange, no double-add)', () => {
      // Loose mode can fire onConnect for a handle pair that isValidConnection
      // would have rejected; the component must stay idempotent. A state already
      // in `endSources` has an explicit End edge → `hasEndSource` is true.
      const onChange = vi.fn();
      const form = customForm({ endSources: ['WAITING'] });
      render(<StateMachineWorkflow value={form} onChange={onChange} errors={[]} />);
      const onConnect = capturedReactFlowProps!.onConnect!;
      onConnect({
        source: 'WAITING',
        target: END_NODE_ID,
        sourceHandleId: 's-top',
        targetHandleId: 't-top',
      } as unknown as Connection);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('onConnect into End ignores an auto-sink source (already auto-wired to End)', () => {
      const onChange = vi.fn();
      const form = customForm({ endSources: [] });
      render(<StateMachineWorkflow value={form} onChange={onChange} errors={[]} />);
      const onConnect = capturedReactFlowProps!.onConnect!;
      // SERVING is an auto sink — the auto-derived edge already reaches End,
      // so `hasEndSource` is true and onConnect no-ops (no double-add to
      // endSources for a state that already reaches End via the auto rule).
      onConnect({
        source: 'SERVING',
        target: END_NODE_ID,
        sourceHandleId: 's-top',
        targetHandleId: 't-top',
      } as unknown as Connection);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('self-loop drawn on the canvas (onConnectEnd fallback)', () => {
    /**
     * Manager feedback: "current node cannot have self-loop". The natural
     * gesture — drag out of a node's handle and drop back onto the SAME handle
     * — is rejected INSIDE React Flow: `@xyflow/system`'s `isValidHandle` under
     * `ConnectionMode.Loose` only accepts a drop when
     * `handleNodeId !== fromNodeId || handleId !== fromHandleId`, so
     * `onConnect` never fires and our `isValidConnection` never even runs.
     * React Flow does still fill `connectionState.toNode` on that rejected drop
     * (with `isValid === null`), which is what `onConnectEnd` keys off to create
     * the self-loop programmatically — but ONLY when the release landed on a
     * handle. For the far more common "released over my own card" gesture React
     * Flow reports nothing, and the component resolves the node from the DOM
     * (`nodeIdUnderPointer`); those cases are the sibling describe below.
     *
     * A real pointer-geometry drag is jsdom-UNTESTABLE here (no `PointerEvent`
     * constructor, `fireEvent.pointerDown` strips `isPrimary`), so — as with the
     * `connectionMode` prop above — the seam is the captured callback, driven
     * directly with the connection state React Flow builds.
     */
    /** A three-state chain in custom mode. WAITING is the entry status the
     *  manager reported the bug on (it has an outgoing transition and the
     *  Start marker's arrow). */
    function loopForm(overrides: Partial<StateMachineForm> = {}): StateMachineForm {
      return {
        ...defaultStateMachineForm(),
        mode: 'custom',
        states: ['WAITING', 'CALLING', 'SERVING'],
        transitions: [
          { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' },
          { from: 'CALLING', to: 'SERVING', actionLabel: 'Layan' },
        ],
        ...overrides,
      };
    }

    it('creates the self-loop when the drag ended on the node it started from', () => {
      const onChange = vi.fn();
      render(<StateMachineWorkflow value={loopForm()} onChange={onChange} errors={[]} />);
      fireConnectEnd(connectionState({}));
      expect(onChange).toHaveBeenCalledOnce();
      const [next] = onChange.mock.calls[0];
      const loop = next.transitions.filter(
        (t: { from: string; to: string }) => t.from === 'WAITING' && t.to === 'WAITING',
      );
      expect(loop).toHaveLength(1);
      // Two DISTINCT adjacent sides: the dragged-from side stays the source, the
      // next side clockwise takes the arrowhead — so the loop has two real
      // endpoints and arcs around that corner of the card.
      expect(loop[0].sourceSide).toBe('right');
      expect(loop[0].targetSide).toBe('top');
      // The existing transitions are untouched.
      expect(next.transitions).toHaveLength(loopForm().transitions.length + 1);
    });

    it('does NOT double-create when React Flow already committed the connection', () => {
      // Dropping on a DIFFERENT handle of the same node IS valid under Loose
      // mode → `onConnect` already added the edge and `isValid` is true. The
      // fallback must stay out of the way or one drag yields two loops.
      const onChange = vi.fn();
      render(<StateMachineWorkflow value={loopForm()} onChange={onChange} errors={[]} />);
      fireConnectEnd(connectionState({ isValid: true }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not add a second loop when the status already has one', () => {
      const onChange = vi.fn();
      const form = loopForm({
        transitions: [
          { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' },
          { from: 'WAITING', to: 'WAITING', actionLabel: 'Ulang' },
          { from: 'CALLING', to: 'SERVING', actionLabel: 'Layan' },
        ],
      });
      render(<StateMachineWorkflow value={form} onChange={onChange} errors={[]} />);
      fireConnectEnd(connectionState({}));
      // The manager gets a toast instead (the pure decision is unit-tested in
      // `state-machine-flow.test.ts`); no edge is added.
      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not create a self-loop when the drag ended on a different node', () => {
      const onChange = vi.fn();
      render(<StateMachineWorkflow value={loopForm()} onChange={onChange} errors={[]} />);
      fireConnectEnd(connectionState({ toNode: { id: 'CALLING' } }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not create a self-loop when the drag was dropped in empty space', () => {
      const onChange = vi.fn();
      render(<StateMachineWorkflow value={loopForm()} onChange={onChange} errors={[]} />);
      // Nothing under the pointer either — the DOM fallback below resolves null.
      stubElementFromPoint(null);
      fireConnectEnd(connectionState({ toNode: null }));
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('self-loop released over the card BODY (DOM pointer fallback)', () => {
    /**
     * The gap this closes: React Flow fills `connectionState.toNode` only when
     * the release landed on a HANDLE (`isValidHandle` keys everything off the
     * handle element under the cursor). The manager's gesture is "drag out of
     * the status, drag back onto the status, release" — usually over the card
     * BODY, where React Flow reports nothing and the drag was a no-op.
     *
     * `nodeIdUnderPointer` resolves the release point with
     * `document.elementFromPoint(...).closest('.react-flow__node')` and reads
     * `data-id` — React Flow's own DOM contract (it queries
     * `.react-flow__node[data-id="…"]` internally; verified in @xyflow/react
     * 12.11.2).
     *
     * jsdom does NOT implement `document.elementFromPoint` (it is `undefined`,
     * not a stub) and performs no layout, so the HIT TEST itself is
     * real-browser-only. These tests stub the lookup to cover the WIRING — that
     * the resolved node id reaches the decision, that the coordinates come from
     * the right place on mouse vs touch, and that the lookup is skipped when
     * React Flow already answered.
     */
    function loopForm(overrides: Partial<StateMachineForm> = {}): StateMachineForm {
      return {
        ...defaultStateMachineForm(),
        mode: 'custom',
        states: ['WAITING', 'CALLING', 'SERVING'],
        transitions: [
          { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' },
          { from: 'CALLING', to: 'SERVING', actionLabel: 'Layan' },
        ],
        ...overrides,
      };
    }

    /** A detached stand-in for a React Flow node wrapper's inner content — what
     *  `elementFromPoint` returns when the manager releases over the card body
     *  (the `<span>` inside `StateNode`, not the wrapper itself). `closest`
     *  walks a detached tree fine, which is exactly the lookup under test. */
    function nodeBodyElement(nodeId: string): Element {
      const wrapper = document.createElement('div');
      wrapper.className = 'react-flow__node react-flow__node-state';
      wrapper.setAttribute('data-id', nodeId);
      const body = document.createElement('span');
      wrapper.appendChild(body);
      return body;
    }

    function firedSelfLoops(onChange: ReturnType<typeof vi.fn>): { from: string; to: string }[] {
      if (onChange.mock.calls.length === 0) return [];
      const [next] = onChange.mock.calls[0];
      return next.transitions.filter((t: { from: string; to: string }) => t.from === t.to);
    }

    it('creates the self-loop when the release was over the card body of its own node', () => {
      const onChange = vi.fn();
      render(<StateMachineWorkflow value={loopForm()} onChange={onChange} errors={[]} />);
      stubElementFromPoint(nodeBodyElement('WAITING'));
      // React Flow reports NO target node: the release was not on a handle.
      fireConnectEnd(connectionState({ toNode: null }));
      expect(firedSelfLoops(onChange)).toEqual([
        expect.objectContaining({ from: 'WAITING', to: 'WAITING' }),
      ]);
    });

    it('reads the release point from clientX/clientY on a mouse release', () => {
      render(<StateMachineWorkflow value={loopForm()} onChange={vi.fn()} errors={[]} />);
      const lookup = stubElementFromPoint(nodeBodyElement('WAITING'));
      fireConnectEnd(
        connectionState({ toNode: null }),
        new MouseEvent('mouseup', { clientX: 120, clientY: 240 }),
      );
      expect(lookup).toHaveBeenCalledWith(120, 240);
    });

    it('reads the release point from changedTouches on a touch release (kiosk)', () => {
      // On `touchend` the `touches` list is EMPTY — the lifted finger is only in
      // `changedTouches`, so reading `touches[0]` would lose the coordinates and
      // the gesture would silently do nothing on the touch kiosk.
      render(<StateMachineWorkflow value={loopForm()} onChange={vi.fn()} errors={[]} />);
      const lookup = stubElementFromPoint(nodeBodyElement('WAITING'));
      const touchEnd = {
        changedTouches: [{ clientX: 33, clientY: 44 }],
        touches: [],
      } as unknown as TouchEvent;
      fireConnectEnd(connectionState({ toNode: null }), touchEnd);
      expect(lookup).toHaveBeenCalledWith(33, 44);
    });

    it('never hijacks a release over a DIFFERENT node', () => {
      const onChange = vi.fn();
      render(<StateMachineWorkflow value={loopForm()} onChange={onChange} errors={[]} />);
      stubElementFromPoint(nodeBodyElement('CALLING'));
      fireConnectEnd(connectionState({ toNode: null }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('never fires for a release over a canvas-only terminal marker', () => {
      // The Start/End markers render as `.react-flow__node` wrappers too, so the
      // DOM lookup CAN resolve one — the id equality check is what rejects it.
      const onChange = vi.fn();
      render(<StateMachineWorkflow value={loopForm()} onChange={onChange} errors={[]} />);
      stubElementFromPoint(nodeBodyElement(END_NODE_ID));
      fireConnectEnd(connectionState({ toNode: null }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not add a second loop when the status already has one', () => {
      const onChange = vi.fn();
      const form = loopForm({
        transitions: [
          { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil' },
          { from: 'WAITING', to: 'WAITING', actionLabel: 'Ulang' },
          { from: 'CALLING', to: 'SERVING', actionLabel: 'Layan' },
        ],
      });
      render(<StateMachineWorkflow value={form} onChange={onChange} errors={[]} />);
      stubElementFromPoint(nodeBodyElement('WAITING'));
      fireConnectEnd(connectionState({ toNode: null }));
      expect(onChange).not.toHaveBeenCalled();
    });

    it('tolerates an environment with no elementFromPoint instead of throwing', () => {
      // jsdom does not implement it at all. Without the `typeof` guard in
      // `nodeIdUnderPointer`, EVERY rejected drag in this suite (and any future
      // test that fires `onConnectEnd` without stubbing) would blow up on a
      // TypeError inside a React event handler. No stub here on purpose.
      const onChange = vi.fn();
      render(<StateMachineWorkflow value={loopForm()} onChange={onChange} errors={[]} />);
      expect(() => fireConnectEnd(connectionState({ toNode: null }))).not.toThrow();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('skips the DOM lookup entirely when React Flow already resolved a target', () => {
      // The hit test is an extra layout read on every connect-end; the common
      // path (released on a handle) must not pay for it.
      render(<StateMachineWorkflow value={loopForm()} onChange={vi.fn()} errors={[]} />);
      const lookup = stubElementFromPoint(nodeBodyElement('WAITING'));
      fireConnectEnd(connectionState({ toNode: { id: 'WAITING' } }));
      expect(lookup).not.toHaveBeenCalled();
    });
  });
});
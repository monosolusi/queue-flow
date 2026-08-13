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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ConnectionMode, type Connection, type ReactFlowProps } from '@xyflow/react';
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
});
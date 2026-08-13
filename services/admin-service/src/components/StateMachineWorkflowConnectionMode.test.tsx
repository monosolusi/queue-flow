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
import { ConnectionMode, type ReactFlowProps } from '@xyflow/react';
import type { StateMachineForm } from '../lib/state-machine';
import { defaultStateMachineForm } from '../lib/state-machine';

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
});
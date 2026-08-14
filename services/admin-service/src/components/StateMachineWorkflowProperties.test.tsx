import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  REQUEUE_POLICY_LABELS,
  type StateMachineForm,
} from '../lib/state-machine';
import type { FlowEdge, FlowNode } from '../lib/state-machine-flow';
import type { WorkflowHandlers } from './StateMachineWorkflowNodes';
import { StateMachineWorkflowProperties } from './StateMachineWorkflowProperties';
import type { RequeuePolicyDto, TransitionActionType } from '../api/types';

/**
 * Properties-panel tests for the "Kebijakan Antrian Ulang" (re-queue policy)
 * control. The panel is presentational — it receives the form, the canvas
 * nodes/edges, and a `WorkflowHandlers` stub, then renders the edge editor when
 * an edge is selected. The control is shown ONLY on a `→ WAITING` edge whose
 * `action === 'UPDATE_STATUS'`; this is the load-bearing visibility rule, so
 * each branch has a present/absent test.
 */

/** A minimal custom form with the two canonical states a re-queue edge needs. */
function formWith(states: string[] = ['CALLING', 'WAITING']): StateMachineForm {
  return {
    mode: 'custom',
    states,
    transitions: [
      {
        from: 'CALLING',
        to: 'WAITING',
        actionLabel: 'Kembalikan ke Antrian',
        action: 'UPDATE_STATUS',
        requeuePolicy: { kind: 'KEEP' },
      },
    ],
    positions: {},
    nodeActions: {},
    descriptions: {},
    endSources: [],
    terminalNodes: { start: 'auto', end: 'auto' },
  };
}

/** Build a `FlowEdge` for the selected edge with the given data. */
function edgeWith(
  data: Partial<FlowEdge['data']> & { actionLabel?: string; action?: TransitionActionType } = {},
  id = 'CALLING->WAITING#0',
  source = 'CALLING',
  target = 'WAITING',
): FlowEdge {
  return {
    id,
    source,
    target,
    type: 'transition',
    data: {
      actionLabel: data.actionLabel ?? 'Kembalikan ke Antrian',
      action: data.action ?? 'UPDATE_STATUS',
      requeuePolicy: data.requeuePolicy ?? { kind: 'KEEP' },
    },
  };
}

/** Build a `WorkflowHandlers` stub capturing the requeue-policy lift call. */
function handlersStub(): { handlers: WorkflowHandlers; onRequeue: ReturnType<typeof vi.fn> } {
  const onRequeue = vi.fn();
  const handlers: WorkflowHandlers = {
    mode: 'custom',
    transitionsCount: 1,
    onRenameState: vi.fn(),
    onDeleteState: vi.fn(),
    onEditTransitionLabel: vi.fn(),
    onEditTransitionAction: vi.fn(),
    onEditTransitionRequeuePolicy: onRequeue,
    onDeleteTransition: vi.fn(),
    onRerouteTransition: vi.fn(),
    onAddTransitionFrom: vi.fn(),
    onAddNodeAction: vi.fn(),
    onDeleteNodeAction: vi.fn(),
    onEditNodeAction: vi.fn(),
    onEditStateDescription: vi.fn(),
    onResetTerminalAuto: vi.fn(),
    onDeleteTerminal: vi.fn(),
    onDropTerminal: vi.fn(),
    onRemoveEndSource: vi.fn(),
  };
  return { handlers, onRequeue };
}

function renderPanel(
  form: StateMachineForm,
  edge: FlowEdge,
  handlers: WorkflowHandlers,
): void {
  const nodes: FlowNode[] = [];
  render(
    <StateMachineWorkflowProperties
      mode="custom"
      selectedNodeId={null}
      selectedEdgeId={edge.id}
      form={form}
      nodes={nodes}
      edges={[edge]}
      handlers={handlers}
      onClearSelection={vi.fn()}
    />,
  );
}

describe('StateMachineWorkflowProperties — Kebijakan Antrian Ulang control', () => {
  it('renders the requeue control for a CALLING → WAITING UPDATE_STATUS edge', () => {
    const form = formWith();
    const edge = edgeWith();
    const { handlers } = handlersStub();
    renderPanel(form, edge, handlers);
    // The standalone edge editor renders the control with a testid scoped to the edge id.
    const select = screen.getByTestId(`panel-transition-requeue-${edge.id}`) as HTMLSelectElement;
    // The three policy options are present, labelled in Indonesian. Scoped to the
    // select's options — the hint paragraph repeats the labels as prose, so a
    // global getByText would match both.
    const options = Array.from(select.options).map((o) => o.textContent);
    for (const kind of ['KEEP', 'TO_BACK', 'BACK_N'] as const) {
      expect(options).toContain(REQUEUE_POLICY_LABELS[kind]);
    }
  });

  it('does NOT render the requeue control for a non-WAITING target edge', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [
        {
          from: 'WAITING',
          to: 'CALLING',
          actionLabel: 'Panggil Berikutnya',
          action: 'UPDATE_STATUS',
          requeuePolicy: { kind: 'KEEP' },
        },
      ],
      positions: {},
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const edge = edgeWith({}, 'WAITING->CALLING#0', 'WAITING', 'CALLING');
    const { handlers } = handlersStub();
    renderPanel(form, edge, handlers);
    expect(screen.queryByTestId(`panel-transition-requeue-${edge.id}`)).not.toBeInTheDocument();
  });

  it('does NOT render the requeue control for a TRANSFER_CATEGORY edge (even when it targets WAITING)', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [
        {
          from: 'CALLING',
          to: 'WAITING',
          actionLabel: 'Pindah Kategori',
          action: 'TRANSFER_CATEGORY',
          requeuePolicy: { kind: 'KEEP' },
        },
      ],
      positions: {},
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const edge = edgeWith({ action: 'TRANSFER_CATEGORY' });
    const { handlers } = handlersStub();
    renderPanel(form, edge, handlers);
    expect(screen.queryByTestId(`panel-transition-requeue-${edge.id}`)).not.toBeInTheDocument();
  });

  it('reveals the n input when the policy is BACK_N (and hides it for KEEP)', () => {
    // The panel is presentational: the n input's presence is driven by the edge
    // `data.requeuePolicy.kind` from props (the parent re-renders with the new
    // policy after the handler fires), not by a local UI state. So the reveal is
    // tested by rendering with each policy and asserting presence, NOT by
    // firing a change event that the stub handler does not feed back.
    const form = formWith();

    // KEEP → n input absent.
    const keepEdge = edgeWith({ requeuePolicy: { kind: 'KEEP' } }, 'KEEP#edge');
    const keepHandlers = handlersStub().handlers;
    const { unmount } = render(
      <StateMachineWorkflowProperties
        mode="custom"
        selectedNodeId={null}
        selectedEdgeId={keepEdge.id}
        form={form}
        nodes={[]}
        edges={[keepEdge]}
        handlers={keepHandlers}
        onClearSelection={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(`panel-transition-requeue-n-${keepEdge.id}`)).not.toBeInTheDocument();
    unmount();

    // BACK_N → n input present.
    const backNEdge = edgeWith({ requeuePolicy: { kind: 'BACK_N', n: 2 } }, 'BACKN#edge');
    const backHandlers = handlersStub().handlers;
    render(
      <StateMachineWorkflowProperties
        mode="custom"
        selectedNodeId={null}
        selectedEdgeId={backNEdge.id}
        form={form}
        nodes={[]}
        edges={[backNEdge]}
        handlers={backHandlers}
        onClearSelection={vi.fn()}
      />,
    );
    expect(screen.getByTestId(`panel-transition-requeue-n-${backNEdge.id}`)).toBeInTheDocument();
  });

  it('lifts onEditTransitionRequeuePolicy when the manager switches kind (BACK_N defaults n to 1)', () => {
    const form = formWith();
    const edge = edgeWith();
    const { handlers, onRequeue } = handlersStub();
    renderPanel(form, edge, handlers);
    fireEvent.change(screen.getByTestId(`panel-transition-requeue-${edge.id}`), {
      target: { value: 'BACK_N' },
    });
    expect(onRequeue).toHaveBeenCalledWith(edge.id, { kind: 'BACK_N', n: 1 });
  });

  it('lifts onEditTransitionRequeuePolicy with { kind } (no n) when switching to TO_BACK', () => {
    const form = formWith();
    const edge = edgeWith();
    const { handlers, onRequeue } = handlersStub();
    renderPanel(form, edge, handlers);
    fireEvent.change(screen.getByTestId(`panel-transition-requeue-${edge.id}`), {
      target: { value: 'TO_BACK' },
    });
    expect(onRequeue).toHaveBeenCalledWith(edge.id, { kind: 'TO_BACK' });
  });

  it('drops n when switching away from BACK_N back to KEEP', () => {
    const form = formWith();
    // Start from a BACK_N policy so the n input is visible.
    const edge = edgeWith({ requeuePolicy: { kind: 'BACK_N', n: 3 } });
    const { handlers, onRequeue } = handlersStub();
    renderPanel(form, edge, handlers);
    expect(screen.getByTestId(`panel-transition-requeue-n-${edge.id}`)).toBeInTheDocument();
    // Switch back to KEEP — n is dropped (the wire stays sparse).
    fireEvent.change(screen.getByTestId(`panel-transition-requeue-${edge.id}`), {
      target: { value: 'KEEP' },
    });
    expect(onRequeue).toHaveBeenCalledWith(edge.id, { kind: 'KEEP' });
    expect('n' in (onRequeue.mock.calls[0][1] as RequeuePolicyDto)).toBe(false);
  });

  it('lifts an n edit as { kind: "BACK_N", n }', () => {
    const form = formWith();
    const edge = edgeWith({ requeuePolicy: { kind: 'BACK_N', n: 1 } });
    const { handlers, onRequeue } = handlersStub();
    renderPanel(form, edge, handlers);
    fireEvent.change(screen.getByTestId(`panel-transition-requeue-n-${edge.id}`), {
      target: { valueAsNumber: 5 },
    });
    expect(onRequeue).toHaveBeenCalledWith(edge.id, { kind: 'BACK_N', n: 5 });
  });

  it('clamps a negative n edit to 0', () => {
    const form = formWith();
    const edge = edgeWith({ requeuePolicy: { kind: 'BACK_N', n: 1 } });
    const { handlers, onRequeue } = handlersStub();
    renderPanel(form, edge, handlers);
    fireEvent.change(screen.getByTestId(`panel-transition-requeue-n-${edge.id}`), {
      target: { valueAsNumber: -3 },
    });
    expect(onRequeue).toHaveBeenCalledWith(edge.id, { kind: 'BACK_N', n: 0 });
  });
});

describe('StateMachineWorkflowProperties — node "Transisi keluar" sub-view requeue control', () => {
  /** Build a FlowNode for the selected node + an outgoing edge. */
  function nodeWithOutgoing(
    nodeName: string,
    edge: FlowEdge,
  ): { nodes: FlowNode[]; edges: FlowEdge[] } {
    const nodes: FlowNode[] = [
      { id: nodeName, type: 'state', position: { x: 0, y: 0 }, data: { name: nodeName, description: '' } },
    ];
    return { nodes, edges: [edge] };
  }

  function renderPanelForNode(
    form: StateMachineForm,
    nodeName: string,
    edge: FlowEdge,
    handlers: WorkflowHandlers,
  ): void {
    const { nodes, edges } = nodeWithOutgoing(nodeName, edge);
    render(
      <StateMachineWorkflowProperties
        mode="custom"
        selectedNodeId={nodeName}
        selectedEdgeId={null}
        form={form}
        nodes={nodes}
        edges={edges}
        handlers={handlers}
        onClearSelection={vi.fn()}
      />,
    );
    // Open the "Transisi keluar" sub-view.
    fireEvent.click(screen.getByTestId('panel-goto-transitions'));
  }

  it('renders the requeue control in the outgoing-transitions row for a → WAITING UPDATE_STATUS edge', () => {
    const form = formWith();
    const edge = edgeWith({}, 'CALLING->WAITING#0', 'CALLING', 'WAITING');
    const { handlers } = handlersStub();
    renderPanelForNode(form, 'CALLING', edge, handlers);
    expect(screen.getByTestId(`panel-transition-requeue-${edge.id}`)).toBeInTheDocument();
  });

  it('does NOT render the requeue control in the row for a non-WAITING outgoing edge', () => {
    const form: StateMachineForm = {
      mode: 'custom',
      states: ['WAITING', 'CALLING'],
      transitions: [
        {
          from: 'WAITING',
          to: 'CALLING',
          actionLabel: 'Panggil Berikutnya',
          action: 'UPDATE_STATUS',
          requeuePolicy: { kind: 'KEEP' },
        },
      ],
      positions: {},
      nodeActions: {},
      descriptions: {},
      endSources: [],
      terminalNodes: { start: 'auto', end: 'auto' },
    };
    const edge = edgeWith({}, 'WAITING->CALLING#0', 'WAITING', 'CALLING');
    const { handlers } = handlersStub();
    renderPanelForNode(form, 'WAITING', edge, handlers);
    expect(screen.queryByTestId(`panel-transition-requeue-${edge.id}`)).not.toBeInTheDocument();
  });

  it('lifts onEditTransitionRequeuePolicy from the outgoing-transitions row', () => {
    const form = formWith();
    const edge = edgeWith();
    const { handlers, onRequeue } = handlersStub();
    renderPanelForNode(form, 'CALLING', edge, handlers);
    fireEvent.change(screen.getByTestId(`panel-transition-requeue-${edge.id}`), {
      target: { value: 'TO_BACK' },
    });
    expect(onRequeue).toHaveBeenCalledWith(edge.id, { kind: 'TO_BACK' });
  });
});
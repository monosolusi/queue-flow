/**
 * Visual drag-and-drop workflow builder for the "Alur Status Tiket" state
 * machine, backed by the open-source React Flow library (`@xyflow/react` v12).
 * Replaces the form-based {@link StateMachineEditor} on the operational
 * `/admin/config` surface (the wizard keeps the form editor — first-run only).
 *
 * States become nodes; transitions become edges drawn between nodes. The manager
 * drags a "Status" card from the palette onto the canvas to add a state, and
 * drags between a node's connection handles to draw a transition edge (or uses
 * the inline "Tambah aksi" button in the selected node's properties panel).
 *
 * **Wire contract unchanged.** The component is a different VIEW over the same
 * {@link StateMachineForm} + same `lib/state-machine` helpers: it lifts
 * graph-structure changes to the parent via `onChange(next: StateMachineForm)`,
 * and AdminPanel's existing save path calls `toStateMachineDto` (the single
 * wire-boundary mapper). Positions are now sourced from the form
 * (`value.positions`) and lifted back on a drag-stop via `commit` →
 * `flowToGraph` → `onChange`; they travel the wire in the separate
 * `nodePositions` map (built by `toNodePositionsDto`). `validateCustomStateMachine`
 * stays the validation authority; the component structurally prevents what it
 * can (duplicate edges in `onConnect`, the ≥1-transition delete guard) and
 * surfaces the rest via the `errors` list.
 *
 * **Controlled-with-internal-state pattern.** The component owns React Flow
 * `nodes`/`edges` in `useState` (initialized from `formToFlow(value, autoLayout)`)
 * and lifts graph-structure changes to the parent. A `lastEmitted` ref holds the
 * signature of the last value emitted; a `useEffect([value])` re-syncs from an
 * EXTERNAL value change (post-save re-seed, prefill change) — preserving
 * positions for surviving state names — and skips our own changes (we update
 * the ref when we emit) so a self-driven `onChange` never round-trips into a
 * position reset.
 *
 * **Position lift trace (load-bearing).** A node drag updates internal node
 * state only (`onNodesChange` never calls `onChange`); positions reach the
 * parent form ONLY on `onNodeDragStop` → `commit` → `onChange`. The round-trip
 * is: (a) drag a node — `onNodesChange` updates local `nodes` (no lift); (b)
 * drop — `onNodeDragStop` rebuilds `nextNodes` from the callback arg's final
 * positions (NOT `nodesRef`, which may lag the batched `setNodes`) and calls
 * `commit`; (c) `commit` → `flowToGraph` captures `positions` → builds a form
 * WITH positions → stamps `lastEmitted.current = graphSignature(form)` (which
 * now includes positions) BEFORE `onChange`; (d) the parent re-renders with the
 * new `value`, the sync effect compares `graphSignature(value)` against
 * `lastEmitted.current` → EQUAL → skip the re-seed → no snap. A source-driven
 * position edit, by contrast, comes in as a `value` whose signature differs
 * (positions changed, not stamped by us) → the effect re-seeds the canvas to
 * the source positions via `formToFlow(value, oldPositions)` (correct: the
 * source is the new source of truth).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  ConnectionMode,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  type StateMachineForm,
  defaultStateMachineForm,
  graphSignature,
} from '../lib/state-machine';
import {
  flowToGraph,
  formToFlowWithMarkers,
  isTerminalNodeId,
  nextStateName,
  withDescriptions,
  DEFAULT_SOURCE_HANDLE,
  DEFAULT_TARGET_HANDLE,
  EDGE_ARROW_MARKER,
  isDuplicateTransition,
  rejectionMessageForConnection,
  type FlowEdge,
  type FlowNode,
} from '../lib/state-machine-flow';
import {
  StateIcon,
  WorkflowContext,
  edgeTypes,
  nodeTypes,
  type WorkflowHandlers,
} from './StateMachineWorkflowNodes';
import { StateMachineWorkflowProperties } from './StateMachineWorkflowProperties';
import { useToast } from '../toast/useToast';
import './state-machine-workflow.css';

export function StateMachineWorkflow({
  value,
  onChange,
  errors,
}: {
  value: StateMachineForm;
  onChange: (next: StateMachineForm) => void;
  errors: string[];
}): JSX.Element {
  const [nodes, setNodes] = useState<FlowNode[]>(
    () => formToFlowWithMarkers(value, {}).nodes,
  );
  const [edges, setEdges] = useState<FlowEdge[]>(
    () => formToFlowWithMarkers(value, {}).edges,
  );
  // Signature of the last value we emitted (or the initial value). The sync
  // effect compares the incoming `value` signature against this; a mismatch
  // means an external reset (we did NOT emit it), so we re-sync. When WE cause
  // a change we update this ref before `onChange`, so the effect skips the
  // round-trip and preserves canvas positions.
  const lastEmitted = useRef<string>(graphSignature(value));
  // Monotonic per-instance counter for newly minted edge ids. Edges rebuilt by
  // `formToFlow` (external reset) use index-based ids `${from}->${to}#${i}`;
  // edges minted here (`onConnect` / "Tambah Transisi") use `sm-edge-N` — a
  // distinct prefix so the two id spaces NEVER collide, and ids no longer
  // encode source/target (so a state rename never leaves a stale edge id).
  // Monotonic ⇒ unique across adds even after deletes leave gaps in the
  // index-based ids (the M1 collision: a length-based id used to match a
  // surviving index-based id after a delete).
  const edgeIdSeq = useRef(0);
  const mintEdgeId = useCallback(() => `sm-edge-${edgeIdSeq.current++}`, []);
  // Touch-surface double-tap guard (CLAUDE.md: flip the ref before the first
  // await, reset after the commit flushes). "Tambah Status" / "Tambah
  // Transisi" are synchronous, but two same-tap clicks land before the parent
  // re-renders; the ref absorbs the second. Reset unconditionally in the
  // value-sync effect (below) which runs after every `onChange` round-trip —
  // the parent has then re-rendered with our emitted change, so a queued
  // second tap re-evaluates against fresh state.
  const addPendingRef = useRef(false);
  // Toast channel for the connection-rejection feedback (the manager's "tidak
  // ada error, tidak tahu kenapa" report: a duplicate edge draw was a silent
  // no-op). `useToast()` is a NO-OP when no `ToastProvider` is mounted (verified),
  // so existing component tests that render without a provider keep working —
  // the `onConnectEnd` call is a safe no-op in every existing test.
  const toast = useToast();

  // Latest nodes/edges held in refs so `onNodeDragStop` can read the current
  // committed state without being recreated every render (avoids stale-closure
  // reads). Updated each render (no effect needed — the ref is a mutable
  // container). `onNodeDragStop` does NOT read these for the dragged node's
  // final position: it uses the callback arg `draggedNodes` for that (see the
  // comment on `onNodeDragStop` for the stale-closure race that avoids).
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // Selection state for the right-side properties panel. Single-select: when
  // the manager clicks a node/edge, we mark that one selected in local node/edge
  // state (so React Flow's `.selected` class applies + `onSelectionChange`
  // fires) and track its id here. `onSelectionChange` is the single source of
  // truth for these ids — it reads the selected node/edge from the React Flow
  // store (which syncs from our `nodes`/`edges` via `StoreUpdater`). Cleared
  // when `mode` changes or on external reset so a stale selection never edits a
  // node that no longer exists.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // Clear the canvas selection — used by the right panel's "Kembali ke pilihan
  // status" back button so the manager returns from the node/edge editor to the
  // node-picker (palette) view. Mirrors the single-select semantics of
  // `onNodeClick`/`onEdgeClick`: clear the `selected` flag on every node AND
  // edge in local state (so React Flow's `.selected` class drops via the
  // `StoreUpdater` sync) and clear the tracked ids. The `onSelectionChange`
  // callback then fires from the store sync and reaffirms `null` here — the
  // tracked-id setters below are the authoritative clear for the panel switch.
  const clearSelection = useCallback(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, selected: false })));
    setEdges((prev) => prev.map((e) => ({ ...e, selected: false })));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, []);

  // External reset: rebuild nodes/edges from the incoming value, PRESERVING
  // positions for surviving state names (a post-save re-seed keeps the nodes
  // where the manager left them). Reads prior positions inside the setNodes
  // callback so it always sees the latest committed node state. Clears
  // selection — a stale selected node/edge id must never edit a node that no
  // longer exists after the re-seed.
  //
  // Handle routing is NO LONGER rebuilt from the prior edges — the form is the
  // source of truth now (`formToFlow` reads `t.sourceSide`/`t.targetSide`
  // directly), so a redraw always respects the source. The `graphSignature`
  // canonicalizes undefined→default, so a save+re-GET (which merges non-default
  // sides back from `edgeRoutingLayout`) produces the same signature as the
  // pre-save form → the guard skips the re-seed and handles survive in-session.
  useEffect(() => {
    const sig = graphSignature(value);
    if (sig !== lastEmitted.current) {
      lastEmitted.current = sig;
      const oldPositions: Record<string, { x: number; y: number }> = {};
      setNodes((prev) => {
        // Only REAL state nodes carry a position worth preserving across a
        // re-seed — the Start/End terminal markers are auto-derived from the
        // real topology, so their positions recompute from the new
        // `realPositions` inside `formToFlowWithMarkers` (correct: they always
        // reflect the live graph).
        for (const n of prev) if (n.type === 'state') oldPositions[n.data.name] = n.position;
        return formToFlowWithMarkers(value, oldPositions).nodes;
      });
      setEdges(() => formToFlowWithMarkers(value, {}).edges);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    }
    // Always reset the double-tap guard after a value round-trip. By the time
    // this effect runs, the parent has re-rendered with our emitted change
    // (commit → onChange → parent setState → re-render → new `value` prop), so a
    // queued second tap is safe to admit again — it re-evaluates against fresh
    // state and the duplicate-edge / nextStateName guards do the rest.
    addPendingRef.current = false;
  }, [value]);

  // Clear selection when the mode flips — a node selected in custom mode is
  // not editable in default mode (read-only canvas), and a stale id could map
  // to a node that the default-graph force-reset removed.
  useEffect(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, [value.mode]);

  // Lift a node/edge mutation to the parent + stamp the last-emitted signature
  // so the sync effect above skips the round-trip (positions preserved). Also
  // refresh every node's `data.description` from the next form — a mutation
  // that changes a state's outgoing-transition count (delete state, delete/add
  // transition) must update the affected node cards' descriptions. The
  // description is CANVAS-ONLY (`flowToGraph` ignores it), so this never changes
  // the wire form.
  const commit = useCallback(
    (nextNodes: FlowNode[], nextEdges: FlowEdge[]) => {
      const { states, transitions, positions } = flowToGraph(nextNodes, nextEdges);
      const form: StateMachineForm = { mode: value.mode, states, transitions, positions };
      const refreshed = withDescriptions(nextNodes, form);
      setNodes(refreshed);
      setEdges(nextEdges);
      lastEmitted.current = graphSignature(form);
      onChange(form);
    },
    [value.mode, onChange],
  );

  // Apply React Flow's internal change stream (drag position, selection) to the
  // local node/edge state. Positions are NOT lifted here — a node drag updates
  // internal state only (so the live drag is smooth and does not call `onChange`
  // on every pixel); positions reach the parent form ONLY on `onNodeDragStop`
  // below. `remove` changes are dropped here — deletion is owned exclusively by
  // the "Hapus" buttons (which `commit` → lift to the parent form), so React
  // Flow's own remove path (already disabled via `deleteKeyCode={null}`) can
  // never desync the internal canvas state from the parent's form. The cast is
  // load-bearing: `applyNodeChanges` is generic over `Node` (wide `data`), so it
  // returns `Node[]`; we narrow back to our `FlowNode` (the runtime shape is
  // unchanged — it only spreads our objects).
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const safe = changes.filter((c) => c.type !== 'remove');
    setNodes((prev) => applyNodeChanges(safe, prev) as FlowNode[]);
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const safe = changes.filter((c) => c.type !== 'remove');
    setEdges((prev) => applyEdgeChanges(safe, prev) as FlowEdge[]);
  }, []);

  // Lift positions to the parent form on drag-stop (load-bearing — positions
  // must reach the form to persist; `onNodesChange` deliberately does not lift
  // on every move). Uses the callback arg's `draggedNodes` final positions
  // (NOT `nodesRef.current`) to avoid a stale-closure race: `onNodesChange`'s
  // `setNodes` is batched, so `nodesRef.current` may not yet reflect the final
  // drag position at dragStop time. The callback arg carries the authoritative
  // final positions, so we merge those into the ref's node array and `commit`.
  const onNodeDragStop = useCallback(
    (_e: unknown, _node: Node, draggedNodes: Node[]) => {
      if (draggedNodes.length === 0) return;
      const moved = new Map(draggedNodes.map((n) => [n.id, n.position]));
      const nextNodes = nodesRef.current.map((n) =>
        moved.has(n.id) ? { ...n, position: moved.get(n.id)! } : n,
      );
      commit(nextNodes, edgesRef.current);
    },
    [commit],
  );

  // Draw a transition edge by connecting a source handle to a target handle.
  // Guard: skip a duplicate edge (same source/target) — the structural
  // prevention `validateCustomStateMachine` also catches.
  const onConnect = useCallback(
    (connection: Connection) => {
      const from = connection.source;
      const to = connection.target;
      if (!from || !to) return;
      // Defensive duplicate guard: the live `isValidConnection` below already
      // rejects a duplicate during the drag, but keep the check so a real
      // connection that somehow bypassed the live guard (e.g. a future RF
      // internals change) never seeds a duplicate edge. Centralized in
      // `isDuplicateTransition` so all three reject sites stay identical.
      if (isDuplicateTransition(edges, from, to)) return;
      const newEdge: FlowEdge = {
        id: mintEdgeId(),
        source: from,
        target: to,
        type: 'transition',
        data: { actionLabel: '' },
        // Carry the exact handles the manager dragged (which side → which
        // side) so the bezier routes through them — vertical when a top/bottom
        // handle was used. React Flow supplies `sourceHandle`/`targetHandle` on
        // the connection; fall back to the canonical L→R default if absent.
        sourceHandle: connection.sourceHandle ?? DEFAULT_SOURCE_HANDLE,
        targetHandle: connection.targetHandle ?? DEFAULT_TARGET_HANDLE,
        // Closed arrow at the target end so the edge reads "from → to"
        // (manager feedback: no arrow = confusing direction).
        markerEnd: EDGE_ARROW_MARKER,
      };
      commit(nodes, [...edges, newEdge]);
    },
    [edges, nodes, commit, mintEdgeId],
  );

  // Live connection validation (during the drag): reject a duplicate edge so
  // React Flow marks the in-progress connection invalid (the target handle
  // drops its "valid" affordance) and — critically — sets `connectionState.
  // isValid === false` on connect-end, which `onConnectEnd` turns into a toast.
  // This is the fix for "tidak bisa tarik garis dari bottom ke up, tidak ada
  // error": a re-drawn back-edge (e.g. the default graph's SKIPPED → CALLING)
  // was a silent no-op before. `connection.source`/`target` are `string | null`
  // on a `Connection` (null only in a degenerate no-endpoint case that React
  // Flow never raises for a real drag) — treat a missing endpoint as allowed so
  // the guard never false-negatives a half-formed connection.
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const from = connection.source;
      const to = connection.target;
      if (!from || !to) return true;
      // Defensive: the Start/End marker handles are `isConnectable={false}` so a
      // drag can never start/end on them, but guard anyway so a future RF
      // internals change (or a programmatic connection) can never seed a real
      // transition edge onto a terminal marker — the markers are canvas-only
      // and never reach the form/wire.
      if (isTerminalNodeId(from) || isTerminalNodeId(to)) return false;
      return !isDuplicateTransition(edges, from, to);
    },
    [edges],
  );

  // Surface WHY a draw failed: when the manager drops a connection that
  // `isValidConnection` rejected (a duplicate), show an info toast naming the
  // pair — "Transisi dari X ke Y sudah ada." The toast auto-dismisses (info
  // variant, 6s) so it notices without nagging. `isValid === false` ⟹ duplicate
  // (our only rejection reason); the no-target (dropped in empty space) and
  // no-connection cases return null (no toast — nothing was attempted). The
  // decision is the pure `rejectionMessageForConnection` (unit-tested); this is
  // the thin side-effect wrapper, kept out of the lib because `onConnectEnd`
  // itself can't be exercised in jsdom.
  const onConnectEnd = useCallback<OnConnectEnd>(
    (_event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      const message = rejectionMessageForConnection(
        {
          isValid: connectionState.isValid,
          fromId: connectionState.fromNode?.id ?? null,
          toId: connectionState.toNode?.id ?? null,
        },
        edges,
      );
      if (message) toast.show(message, { variant: 'info', durationMs: 6000 });
    },
    [edges, toast],
  );

  // Add a new state node (drag-drop + button share this). When `name` is
  // omitted the name is generated via `nextStateName` (non-colliding with
  // existing + canonical names) so the manager never lands on a duplicate the
  // validation would reject; when `name` is supplied (a canonical status add
  // from the calibrated picker) it is used verbatim — the canonical names ARE
  // the load-bearing system identities, so the node is added under that exact
  // name. A supplied name already on the canvas is a no-op (the picker only
  // offers statuses NOT yet present, but guard anyway so a race or a stale
  // click can never seed a duplicate node id). The `description` placeholder is
  // refreshed by `commit` (via `withDescriptions` from the next form) before it
  // reaches `setNodes`, so it never renders.
  const addStateAt = useCallback(
    (position: { x: number; y: number }, name?: string) => {
      const newName = name ?? nextStateName(value.states);
      // Trim-aware duplicate guard so a state stored with stray whitespace cannot
      // slip the guard and seed a second node under the same canonical name.
      if (name && value.states.some((s) => s.trim() === name)) return;
      const newNode: FlowNode = { id: newName, type: 'state', position, data: { name: newName, description: '' } };
      commit([...nodes, newNode], edges);
    },
    [nodes, edges, value.states, commit],
  );

  // Handlers the custom node/edge components + the properties panel reach via
  // context (the panel receives them as a prop). Behavior-only — no `form` data
  // field (ISP: the panel takes `form` as its own prop, and `StateNode` reads
  // `data.description` computed by `formToFlow`/`withDescriptions`, so the
  // context carries no data). Recreated when the graph/mode changes so they
  // always read the latest committed state.
  const handlers = useMemo<WorkflowHandlers>(
    () => ({
      mode: value.mode,
      transitionsCount: value.transitions.length,
      onRenameState: (oldName, newName) => {
        if (newName === oldName) return;
        // Empty/whitespace name fallback (manager feedback: "ketika nama status
        // node dihapus, error"). Clearing the name input used to commit a node
        // with an empty id (`''`), which then tripped
        // `validateCustomStateMachine` → "Nama status tidak boleh kosong" and
        // blocked the save — a degenerate empty node the manager never wanted.
        // No-op instead: the controlled input reverts to the prior name on
        // re-render (no state change commits), so the name can never be blank.
        if (!newName.trim()) return;
        // Guard a rename onto an existing state name — the node id IS the state
        // name, so a rename to an in-use id would produce two nodes with the
        // same React key + a duplicate state in the form. No-op (the controlled
        // input reverts to the prior name on re-render) instead of corrupting
        // the canvas. Mirrors onConnect's duplicate-edge guard structurally.
        if (nodes.some((n) => n.id === newName)) return;
        const nextNodes = nodes.map((n) =>
          n.id === oldName ? { ...n, id: newName, data: { ...n.data, name: newName, description: '' } } : n,
        );
        // Propagate the rename to every referencing edge so no edge dangles.
        const nextEdges = edges.map((e) => ({
          ...e,
          source: e.source === oldName ? newName : e.source,
          target: e.target === oldName ? newName : e.target,
        }));
        // Preserve selection across a rename so the panel stays open on the
        // renamed node (the manager types in the panel's name input — losing
        // selection mid-rename would close the panel and break the flow).
        if (selectedNodeId === oldName) setSelectedNodeId(newName);
        // `commit` refreshes the renamed node's `description` from the next form
        // via `withDescriptions` (the placeholder above is never rendered).
        commit(nextNodes, nextEdges);
      },
      onDeleteState: (name) => {
        // Cascade: drop the node + every transition referencing it so the
        // graph stays valid (no dangling edges). Clear selection — the selected
        // node is gone, so the panel must close (otherwise it would render an
        // editor for a node id that no longer maps to a live node).
        const nextNodes = nodes.filter((n) => n.id !== name);
        const nextEdges = edges.filter((e) => e.source !== name && e.target !== name);
        if (selectedNodeId === name) setSelectedNodeId(null);
        commit(nextNodes, nextEdges);
      },
      onEditTransitionLabel: (edgeId, label) => {
        const nextEdges = edges.map((e) =>
          e.id === edgeId ? { ...e, data: { ...e.data, actionLabel: label } } : e,
        );
        commit(nodes, nextEdges);
      },
      onDeleteTransition: (edgeId) => {
        if (value.transitions.length <= 1) return; // ≥1-transition invariant
        const nextEdges = edges.filter((e) => e.id !== edgeId);
        if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
        commit(nodes, nextEdges);
      },
      // Re-point an edge's endpoints from the panel's "Dari"/"Ke" selects (the
      // manager's "can't connect SERVING to COMPLETED from the panel, only by
      // dragging handles" feedback). Controlled-component revert: a rejected
      // reroute must NOT call `commit`/`onChange`, so the `<select>` reverts to
      // the live edge value on the next re-render (no state change leaked).
      onRerouteTransition: (edgeId, from, to) => {
        const edge = edges.find((e) => e.id === edgeId);
        if (!edge) return;
        // No-op when the new pair equals the current endpoints (the `<select>`
        // fires `onChange` even for a no-change re-pick in some browsers).
        if (edge.source === from && edge.target === to) return;
        // Duplicate guard: a DIFFERENT edge already claims this pair. No-op
        // (return WITHOUT committing) so the controlled `<select>` reverts to
        // the live edge value and the form never accepts the duplicate. The
        // toast names the pair so the manager knows why nothing moved. Reuses
        // the single source of truth {@link isDuplicateTransition} (the fourth
        // reject site) — the `e.id !== edgeId` self-exclusion is unnecessary:
        // the no-op guard above already guarantees this edge's live endpoints
        // differ from `from`/`to`, so it cannot match its own pair here.
        if (isDuplicateTransition(edges, from, to)) {
          toast.show(`Transisi dari ${from} ke ${to} sudah ada.`, { variant: 'info', durationMs: 6000 });
          return;
        }
        // Keep `sourceHandle`/`targetHandle`/`markerEnd` as-is — `commit` →
        // `flowToGraph` rebuilds transitions and `withDescriptions` refreshes
        // node descriptions (a re-routed edge changes the source/target
        // states' outgoing/incoming counts).
        const nextEdges = edges.map((e) => (e.id === edgeId ? { ...e, source: from, target: to } : e));
        commit(nodes, nextEdges);
      },
      // Add a new OUTGOING transition from the given source state (the inline
      // "Tambah aksi" button in the node properties panel). The panel's
      // Kaleo-style "Aksi" framing: the action shown for a node is "Update
      // Status ke <Nilai>", so the new edge's `source` IS the selected node
      // and `target` is the first non-duplicate candidate (a status not
      // already the target of an outgoing edge from this source). No-op when
      // every status is already a target of an outgoing edge from this source
      // (the button is disabled in that case, but guard anyway so a stale click
      // can't seed a duplicate). Double-tap guard via `addPendingRef` (same as
      // the old add buttons). The wire contract is unchanged — `actionLabel`
      // stays per-Transition on the wire; this is a presentation reframing only.
      onAddTransitionFrom: (source) => {
        if (addPendingRef.current) return;
        const target = value.states.find((s) => !isDuplicateTransition(edges, source, s));
        if (!target) return; // no non-duplicate target left — no-op
        addPendingRef.current = true;
        const newEdge: FlowEdge = {
          id: mintEdgeId(),
          source,
          target,
          type: 'transition',
          data: { actionLabel: '' },
          sourceHandle: DEFAULT_SOURCE_HANDLE,
          targetHandle: DEFAULT_TARGET_HANDLE,
          markerEnd: EDGE_ARROW_MARKER,
        };
        commit(nodes, [...edges, newEdge]);
      },
    }),
    [value, nodes, edges, commit, selectedNodeId, selectedEdgeId, toast, mintEdgeId],
  );

  // Click-to-select: mark the clicked node as the sole selected node (clear any
  // selected edge), and let the store sync propagate to `onSelectionChange`,
  // which sets `selectedNodeId`. We set the selected flag in local node/edge
  // state (rather than calling React Flow's store action directly) so the
  // `.selected` class applies via the prop-driven `StoreUpdater` sync and
  // `onSelectionChange` fires as the single source of truth for the ids. This
  // is the primary selection path; React Flow's own drag-select / keyboard
  // selection also fires `onSelectionChange` (same store path). The handler
  // signatures use the proper React Flow `Node`/`Edge` types (the `id` field is
  // the only field read; the rest is structurally compatible).
  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === node.id })));
      setEdges((prev) => prev.map((e) => ({ ...e, selected: false })));
    },
    [],
  );
  const onEdgeClick = useCallback(
    (_event: unknown, edge: Edge) => {
      setEdges((prev) => prev.map((e) => ({ ...e, selected: e.id === edge.id })));
      setNodes((prev) => prev.map((n) => ({ ...n, selected: false })));
    },
    [],
  );
  // Single source of truth for the selected ids — reads from the React Flow
  // store's selectedNodes/selectedEdges (which our local-state flag updates
  // propagate to via `StoreUpdater`). Single-select: take the first if multi.
  const onSelectionChange = useCallback(
    ({ nodes: selNodes, edges: selEdges }: OnSelectionChangeParams) => {
      setSelectedNodeId(selNodes[0]?.id ?? null);
      setSelectedEdgeId(selEdges[0]?.id ?? null);
    },
    [],
  );

  const editorDescribedBy = errors.length > 0 ? 'sm-errors' : undefined;
  const isCustom = value.mode === 'custom';

  return (
    <>
      <fieldset className="radio-group" data-testid="sm-mode">
        <legend>Jenis alur status</legend>
        <label className="radio-group__item">
          <input
            type="radio"
            name="sm-mode"
            value="default"
            checked={value.mode === 'default'}
            onChange={() => onChange(defaultStateMachineForm())}
          />
          Gunakan alur status standar
        </label>
        <label className="radio-group__item">
          <input
            type="radio"
            name="sm-mode"
            value="custom"
            checked={value.mode === 'custom'}
            onChange={() => onChange({ ...value, mode: 'custom' })}
          />
          Susun alur status sendiri
        </label>
      </fieldset>

      <div
        className="sm-workflow-layout"
        role="group"
        aria-label="Editor alur status"
        aria-describedby={editorDescribedBy}
      >
        <ReactFlowProvider>
          <FlowCanvas
            nodes={nodes}
            edges={edges}
            isCustom={isCustom}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onConnectEnd={onConnectEnd}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onNodeDragStop={onNodeDragStop}
            onSelectionChange={onSelectionChange}
            onDropPosition={addStateAt}
            handlers={handlers}
          />
        </ReactFlowProvider>
        {isCustom && (selectedNodeId || selectedEdgeId ? (
          <StateMachineWorkflowProperties
            mode={value.mode}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            form={value}
            nodes={nodes}
            edges={edges}
            handlers={handlers}
            onClearSelection={clearSelection}
          />
        ) : (
          <aside className="sm-properties" data-testid="sm-palette" aria-label="Pilihan status">
            <p className="sm-properties__heading">Pilihan status</p>
            <p className="sm-palette__hint">Seret kartu ke kanvas untuk menambah status.</p>
            <div
              className="sm-palette__item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/reactflow', 'state');
                e.dataTransfer.effectAllowed = 'move';
              }}
            >
              <StateIcon size={18} />
              <span>Status</span>
            </div>
          </aside>
        ))}
      </div>

      {isCustom && errors.length > 0 && (
        <ul className="wizard__errors" id="sm-errors" data-testid="sm-errors">
          {errors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The canvas inner component — must live inside `<ReactFlowProvider>` so
 * `useReactFlow` (for drop-to-flow-position) resolves. Wraps the canvas in the
 * handler context so the custom node/edge components reach the parent's
 * mutation handlers. Wires `onNodeClick`/`onEdgeClick`/`onSelectionChange` so
 * clicking a node/edge drives the right-side properties panel.
 */
function FlowCanvas({
  nodes,
  edges,
  isCustom,
  onNodesChange,
  onEdgesChange,
  onConnect,
  isValidConnection,
  onConnectEnd,
  onNodeClick,
  onEdgeClick,
  onNodeDragStop,
  onSelectionChange,
  onDropPosition,
  handlers,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  isCustom: boolean;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  isValidConnection: (connection: Connection | Edge) => boolean;
  onConnectEnd: OnConnectEnd;
  onNodeClick: (event: unknown, node: Node) => void;
  onEdgeClick: (event: unknown, edge: Edge) => void;
  /** Lifts positions to the parent on drag-stop (see `onNodeDragStop` above). */
  onNodeDragStop: (event: unknown, node: Node, draggedNodes: Node[]) => void;
  onSelectionChange: (params: OnSelectionChangeParams) => void;
  onDropPosition: (position: { x: number; y: number }) => void;
  handlers: WorkflowHandlers;
}): JSX.Element {
  const { screenToFlowPosition } = useReactFlow();
  return (
    <WorkflowContext.Provider value={handlers}>
      <div
        className="sm-canvas"
        data-testid="sm-canvas"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          e.preventDefault();
          const type = e.dataTransfer.getData('application/reactflow');
          if (type !== 'state') return;
          const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          onDropPosition(position);
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onConnectEnd={onConnectEnd}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={onSelectionChange}
          nodesDraggable={isCustom}
          nodesConnectable={isCustom}
          elementsSelectable={isCustom}
          connectionMode={ConnectionMode.Loose}
          fitView
          deleteKeyCode={null}
          // TYPELESS handles + Loose connection mode (manager feedback: "Buat
          // Alur Status Tiket transisi bisa ditarik dari semua titik ke semua
          // titik"). Every handle is `source`-typed (one per side), so a drag
          // started at ANY handle may LAND on any handle of another node — Loose
          // mode's validity is "any handle but the one the drag started at". AND
          // because every drag starts at a `source`-typed handle, the START-
          // handle-TYPE arrow-reversal can never fire (React Flow keys an edge's
          // source/target on the START handle's TYPE: start at a `source` →
          // source=startNode, target=dropNode; the reverse would only happen if
          // a drag started at a `target`-typed handle, which no longer exists).
          // So the arrow always points where the manager dropped (drag
          // direction, manager feedback "panah sesuai arah tarikan") — no drop-
          // only target handles are needed. CANVAS-ONLY — never reaches the wire
          // Transition. See the `StateNode` JSDoc for the full typeless pattern.
          // Hide the React Flow attribution badge: the link points to
          // reactflow.dev (unreachable on the offline LAN, NFR-REL-01) and would
          // confuse a non-technical manager. The MIT license does not require
          // it; the URL constant remains in the bundle (allowlisted in the
          // offline-assets gate) but is never rendered or fetched.
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </WorkflowContext.Provider>
  );
}

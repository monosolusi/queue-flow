/**
 * Right-side properties panel for the "Alur Status Tiket" workflow builder
 * ({@link StateMachineWorkflow}). Receives the current selection
 * (`selectedNodeId` / `selectedEdgeId`), the form, the canvas nodes/edges, and
 * the mutation handlers; renders the node editor or the edge editor.
 *
 * The node editor is a NAVIGATION PATTERN (manager feedback: "when editing
 * aksi/transisi keluar, the sidebar scroll is too long"). The overview shows
 * the name + editable description + two nav cards ("Transisi keluar", "Aksi") +
 * delete; clicking a nav card opens a dedicated full sub-view with a
 * "Kembali ke status" back button that returns to the overview (it does NOT
 * clear the canvas selection — that is `sm-panel-back`'s job, which stays on
 * the overview). The sub-view resets to `overview` whenever the canvas
 * selection changes (so selecting another node never lands the manager mid-
 * sub-view on a different status). This is pure UI routing state — the
 * component is otherwise presentational.
 *
 * Visual-only redesign (manager feedback): the canvas node/edge carry no inline
 * `<input>` and no "Hapus" button — those moved here. The panel renders ONLY
 * when a node or edge is selected on the canvas; the empty-selection view is
 * the PALETTE (node picker), owned and rendered by the parent — this component
 * is mounted only when there IS a selection. A "Kembali ke pilihan status"
 * back button at the top of the overview clears the canvas selection (via
 * `onClearSelection`) so the right panel returns to the node-picker view. Touch
 * targets are ≥44px (CLAUDE.md a11y baseline); inputs are labelled with sibling
 * `<label>` elements (ARIA: sibling label, not a wrapping `aria-label`). The
 * node name input uppercases on change (mirroring the form editor convention)
 * and lifts a rename via `onRenameState(oldName, newName)`. The description
 * field is an editable `<textarea>` whose placeholder is the derived fallback
 * (`describeState`); a non-empty saved override wins (`descriptionFor`), an
 * empty value clears the override (falls back to the derived copy). The edge
 * action-label input lifts via `onEditTransitionLabel(edgeId, label)`. The edge
 * delete button is disabled when only one transition remains — the
 * ≥1-transition invariant (preserves the existing guard). The panel renders
 * only in custom mode (default mode is read-only canvas only).
 */
import { useEffect, useState } from "react";
import {
  describeState,
  deriveAutoSinks,
  NODE_ACTION_TYPE_LABELS,
  type StateMachineForm,
} from "../lib/state-machine";
import {
  isDuplicateTransition,
  type FlowEdge,
  type FlowNode,
} from "../lib/state-machine-flow";
import type { WorkflowHandlers } from "./StateMachineWorkflowNodes";
import type { NodeActionType } from "../api/types";

/** The action-type options shown in the "Aksi" dropdown, built from the shared
 *  `NODE_ACTION_TYPE_LABELS` map (the single source of truth in the pure
 *  `state-machine.ts` — a `Record<NodeActionType, string>` exhaustive guard, so
 *  a future action type is a one-line addition there that flows here
 *  automatically). One option today (`UPDATE_STATUS`); the manager chose a
 *  dropdown over a read-only badge so the control is structurally ready as
 *  more action types arrive. */
const NODE_ACTION_TYPE_OPTIONS: ReadonlyArray<{ value: NodeActionType; label: string }> = (
  Object.keys(NODE_ACTION_TYPE_LABELS) as NodeActionType[]
).map((value) => ({ value, label: NODE_ACTION_TYPE_LABELS[value] }));

export interface WorkflowPropertiesPanelProps {
  mode: "default" | "custom";
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  form: StateMachineForm;
  nodes: FlowNode[];
  edges: FlowEdge[];
  handlers: WorkflowHandlers;
  onClearSelection: () => void;
}

/** The active sub-view of the node editor (overview / transitions / actions).
 *  Resets to `overview` whenever the canvas node selection changes. */
type NodePanelView = "overview" | "transitions" | "actions";

/**
 * The right-side panel. Renders one of two editor surfaces (the empty-
 * selection view is the PALETTE, owned by the parent — this component is
 * mounted only when there IS a selection):
 *  1. Node editor — when a node is selected. A navigation pattern: an overview
 *     (name + editable description + nav cards + delete) that drills into a
 *     full "Transisi keluar" or "Aksi" sub-view via local UI-routing state.
 *  2. Edge editor — when an edge is selected (unchanged — a separate selection,
 *     not a node sub-view).
 *
 * Both the overview and the edge editor start with a "Kembali ke pilihan
 * status" back button that calls `onClearSelection` to drop the canvas
 * selection so the right panel returns to the node-picker (palette) view. The
 * node sub-views' "Kembali ke status" back button returns to the OVERVIEW only
 * (it does NOT clear the canvas selection). The panel is hidden in default mode
 * (the parent renders it only in custom mode); this component still guards on
 * `mode` so a mis-wired mount stays presentational and renders nothing rather
 * than editing controls.
 */
export function StateMachineWorkflowProperties({
  mode,
  selectedNodeId,
  selectedEdgeId,
  form,
  nodes,
  edges,
  handlers,
  onClearSelection,
}: WorkflowPropertiesPanelProps): JSX.Element | null {
  // Sub-view routing state (overview / transitions / actions). MUST be declared
  // before any early return (Rules of Hooks). Reset to `overview` whenever the
  // canvas node selection changes so selecting another node never lands the
  // manager mid-sub-view on a different status.
  const [view, setView] = useState<NodePanelView>("overview");
  useEffect(() => {
    setView("overview");
  }, [selectedNodeId]);

  // In default mode the canvas is read-only — no panel editing controls.
  if (mode !== "custom") return <></>;

  const selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;
  const selectedEdge = selectedEdgeId
    ? edges.find((e) => e.id === selectedEdgeId) ?? null
    : null;

  // The back button is the same in both the node-overview and edge-editor views
  // — hoisted once so the JSX is not duplicated. Inline `<svg>` (no external
  // assets — NFR-REL-01) using `currentColor` so it adapts to tokens + light/dark.
  const backButton = (
    <button
      type="button"
      className="sm-properties__back"
      data-testid="sm-panel-back"
      aria-label="Kembali ke pilihan status"
      onClick={onClearSelection}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <path
          d="M15 5l-7 7 7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Kembali ke pilihan status
    </button>
  );

  // The sub-view back button — returns from a node sub-view (Transisi keluar /
  // Aksi) to the overview. It does NOT clear the canvas selection (that is
  // `sm-panel-back`'s job, which stays on the overview). Same inline `<svg>`
  // affordance, distinct testid + visible label (the accessible name).
  const subViewBackButton = (
    <button
      type="button"
      className="sm-properties__back sm-properties__back--sub"
      data-testid="panel-back-to-status"
      onClick={() => setView("overview")}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <path
          d="M15 5l-7 7 7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Kembali ke status
    </button>
  );

  // Sub-view routing state lives above (before the early return) to satisfy
  // the Rules of Hooks. `view`/`setView` are read/written below.

  if (selectedNode) {
    // Canvas-only terminal markers (Start/End) — auto-derived visual
    // affordances, NOT real states. They carry no name/description on the form,
    // so the state editor below would render a spurious editor for `__start`/
    // `__end`. Branch to a read-only marker panel first: a heading naming the
    // marker + a hint explaining what it denotes (entry/exit). No editing
    // controls — the manager cannot rename/delete a marker (it is derived from
    // the topology, not a form entity); the back button returns to the palette.
    if (selectedNode.type === "start" || selectedNode.type === "end") {
      const isStart = selectedNode.type === "start";
      const key = isStart ? "start" : "end";
      const terminal = form.terminalNodes[key];
      const isAuto = terminal === "auto";
      const isHidden = terminal === "hidden";
      const posInfo = isAuto
        ? "Posisi otomatis — diturunkan dari status pada kanvas."
        : isHidden
          ? "Tersembunyi."
          : `Posisi ditetapkan: x=${(terminal as { x: number; y: number }).x}, y=${(terminal as { x: number; y: number }).y}`;
      // End-marker-only: the "Transisi masuk" list. Auto sinks come from the
      // SHARED `deriveAutoSinks` — the same predicate that draws the canvas's
      // auto sink→End arrows, so this list can never drift from the arrows the
      // manager sees (it used to re-implement the out-degree rule here, which
      // already listed an isolated status the canvas does NOT link to End, and
      // would have drifted again on the self-loop fix). Explicit = the
      // manager-drawn `endSources` entries that are NOT auto sinks (de-duped on
      // the canvas — an endSource that is also a sink already has an auto arrow
      // and is NOT re-listed as explicit). Each explicit row carries a "Hapus"
      // button (lifts via `onRemoveEndSource`, non-stamping); auto rows are
      // read-only (topology-derived — delete the state's outgoing transitions
      // or the state itself to remove one).
      let endIncoming: JSX.Element | null = null;
      if (!isStart) {
        const stateSet = new Set(form.states);
        const autoSinks = deriveAutoSinks(form.states, form.transitions);
        const autoSinkSet = new Set(autoSinks);
        const explicit = form.endSources.filter(
          (s) => stateSet.has(s) && !autoSinkSet.has(s),
        );
        const rows: JSX.Element[] = [
          ...autoSinks.map((s) => (
            <li
              key={`auto-${s}`}
              className="sm-properties__action"
              data-testid={`panel-end-source-${s}`}
            >
              <span className="sm-properties__action-label">{s}</span>
              {/* "ke status lain" is load-bearing copy: a status whose only
                  outgoing transition points at ITSELF still counts as an exit
                  point, so "tanpa transisi keluar" would read as a lie next to
                  a status that visibly has one. */}
              <span className="sm-properties__hint">Otomatis — tidak punya transisi ke status lain</span>
            </li>
          )),
          ...explicit.map((s) => (
            <li
              key={`explicit-${s}`}
              className="sm-properties__action"
              data-testid={`panel-end-source-${s}`}
            >
              <span className="sm-properties__action-label">{s}</span>
              <button
                type="button"
                className="sm-properties__action-delete"
                data-testid={`panel-end-source-delete-${s}`}
                aria-label={`Hapus transisi masuk dari ${s}`}
                onClick={() => handlers.onRemoveEndSource(s)}
              >
                Hapus
              </button>
            </li>
          )),
        ];
        endIncoming = (
          <div className="sm-properties__field" data-testid="panel-end-incoming">
            <p className="sm-properties__label" id="panel-end-incoming-label">
              Transisi masuk
            </p>
            <p className="sm-properties__hint">
              Status yang berakhir di titik akhir. Seret garis dari sebuah status ke titik akhir untuk menambahkan.
            </p>
            {rows.length === 0 ? (
              <p className="sm-properties__hint" data-testid="panel-end-incoming-empty">
                Belum ada transisi masuk. Seret garis dari sebuah status ke titik akhir untuk menambahkan.
              </p>
            ) : (
              <ul
                className="sm-properties__actions"
                aria-labelledby="panel-end-incoming-label"
                data-testid="panel-end-incoming-list"
              >
                {rows}
              </ul>
            )}
          </div>
        );
      }
      return (
        <aside className="sm-properties" data-testid="sm-properties" aria-label="Properti titik alur">
          {backButton}
          <p className="sm-properties__heading">{isStart ? "Titik awal alur" : "Titik akhir alur"}</p>
          <div className="sm-properties__field">
            <p className="sm-properties__hint" data-testid="panel-marker-description">
              {isStart
                ? "Status awal — status yang punya transisi keluar tapi tidak punya transisi masuk. Panah keluar dari titik ini ke status pertama. Status yang belum punya transisi sama sekali tidak terhubung ke sini. Transisi dari sebuah status ke dirinya sendiri tidak dihitung."
                : "Status akhir — status yang punya transisi masuk tapi tidak punya transisi keluar. Panah masuk ke titik ini dari status terakhir. Status yang belum punya transisi sama sekali tidak terhubung ke sini. Transisi dari sebuah status ke dirinya sendiri tidak dihitung. Seret garis dari sebuah status ke titik akhir untuk menambahkan transisi masuk."}
            </p>
            <p className="sm-properties__hint" data-testid={`panel-terminal-info-${key}`}>
              {posInfo}
            </p>
          </div>
          {endIncoming}
          <div className="sm-properties__field">
            <button
              type="button"
              className="btn btn--secondary sm-properties__add-action"
              data-testid={`panel-terminal-reset-${key}`}
              onClick={() => handlers.onResetTerminalAuto(key)}
              disabled={isAuto}
            >
              Reset ke posisi otomatis
            </button>
            <button
              type="button"
              className="btn btn--ghost sm-properties__delete"
              data-testid={`panel-terminal-delete-${key}`}
              onClick={() => handlers.onDeleteTerminal(key)}
            >
              Hapus
            </button>
          </div>
        </aside>
      );
    }
    const name = selectedNode.data.name;
    // The node's OUTGOING transitions — now reframed as the independent
    // "Transisi keluar" surface (the Caller-button LABELS), decoupled from the
    // Node-level "Aksi" (below). A transition's only domain effect
    // is updating the ticket status to the target, so the action TYPE is fixed
    // "Update Status" — but that is now surfaced in the separate "Aksi" section
    // (node-level, NOT linked to any edge); here the transition is the
    // button-label + target surface. Each row renders an editable "Label aksi"
    // input (the Caller button text — `onEditTransitionLabel`, the same input
    // the standalone edge editor carries) + a "Ke" select (re-point the TARGET
    // via `onRerouteTransition`, source stays this node) + a "Hapus" button
    // (`onDeleteTransition`, disabled when only one transition remains — the
    // ≥1-transition invariant). The edges are read directly from the canvas
    // because the inline editor needs the edge `id` to call the handlers — the
    // outgoing edges are exactly `edges.filter(e => e.source === name)`.
    // Terminal edges (sink→End) are excluded so a sink state with no real
    // outgoing transitions shows the empty hint, not a spurious row. The
    // `actionLabel` STAYS per-Transition on the wire (unchanged) — this is a
    // presentation reframing, not a wire/domain change (the new node-level
    // "Aksi" travel the separate `nodeActions` wire map).
    const outgoing = edges.filter((e) => e.source === name && e.type !== "terminal");
    // The "+ Tambah transisi" button is disabled when every status on the
    // canvas is already a TARGET of an outgoing edge from this node (no
    // non-duplicate target left — adding would produce a duplicate edge, which
    // the graph invariant rejects). `isDuplicateTransition` is the single
    // source of truth for the duplicate check, shared with onConnect /
    // onRerouteTransition / onAddTransitionFrom.
    const canAddTransition = !form.states.every((s) => isDuplicateTransition(edges, name, s));
    // The node's node-level actions, NOT linked to any edge. Read
    // from `form.nodeActions[name]` (a persisted, independent list keyed by
    // state name). Panel-only: a node-action edit lifts as a form-only change
    // (no canvas node/edge change — `graphSignature` excludes `nodeActions`).
    const nodeActions = form.nodeActions[name] ?? [];
    // The derived description fallback — shown as the edit field's placeholder
    // when no saved override is present (`descriptionFor` returns the saved
    // override when non-empty, else this derived copy).
    const derivedDescription = describeState(form, name);
    const savedDescription = form.descriptions?.[name] ?? "";

    if (view === "transitions") {
      return (
        <aside className="sm-properties" data-testid="sm-properties" aria-label="Properti transisi keluar">
          {subViewBackButton}
          {/* "Transisi keluar" — the node's OUTGOING transitions, the
              independent Caller-button LABEL surface. Each row is an editable
              "Label aksi" input (the Caller button text) + a "Ke" select
              (re-point the TARGET via onRerouteTransition, source stays this
              node) + a "Hapus" button (onDeleteTransition, disabled when only
              one transition remains). "+ Tambah transisi" adds a new outgoing
              edge (onAddTransitionFrom). The label is ALSO editable via the
              standalone edge editor (select an edge on the canvas) — the kept
              full-edit path. */}
          <div className="sm-properties__field">
            <p className="sm-properties__label" id="panel-transitions-label">
              Transisi keluar
            </p>
            <p className="sm-properties__hint">
              Tombol di layar petugas untuk memindahkan tiket dari status ini ke status lain.
            </p>
            {outgoing.length === 0 ? (
              <p className="sm-properties__hint" data-testid="panel-transitions-empty">
                Belum ada transisi keluar. Tambah transisi untuk membuat tombol dari status ini ke status lain.
              </p>
            ) : (
              <ul
                className="sm-properties__actions"
                aria-labelledby="panel-transitions-label"
                data-testid="panel-transitions"
              >
                {outgoing.map((edge) => {
                  const labelId = `panel-transition-label-${edge.id}`;
                  const toId = `panel-transition-to-${edge.id}`;
                  return (
                    <li key={edge.id} className="sm-properties__action">
                      <label className="sm-properties__action-label" htmlFor={labelId}>
                        Label aksi
                      </label>
                      <input
                        id={labelId}
                        type="text"
                        className="sm-properties__input"
                        data-testid={`panel-transition-label-${edge.id}`}
                        placeholder="Label aksi"
                        value={edge.data.actionLabel}
                        aria-describedby="panel-transition-label-hint"
                        onChange={(e) => handlers.onEditTransitionLabel(edge.id, e.target.value)}
                      />
                      <label className="sm-properties__action-label" htmlFor={toId}>
                        Ke
                      </label>
                      <select
                        id={toId}
                        className="sm-properties__input"
                        data-testid={`panel-transition-to-${edge.id}`}
                        value={edge.target}
                        onChange={(e) => handlers.onRerouteTransition(edge.id, name, e.target.value)}
                      >
                        {form.states.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="sm-properties__action-delete"
                        data-testid={`panel-transition-delete-${edge.id}`}
                        aria-label="Hapus transisi"
                        disabled={handlers.transitionsCount <= 1}
                        onClick={() => handlers.onDeleteTransition(edge.id)}
                      >
                        Hapus
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p id="panel-transition-label-hint" className="sm-properties__hint">
              Teks tombol yang muncul di layar petugas.
            </p>
            <button
              type="button"
              className="btn btn--secondary sm-properties__add-action"
              data-testid="panel-add-transition"
              onClick={() => handlers.onAddTransitionFrom(name)}
              disabled={!canAddTransition}
            >
              + Tambah transisi
            </button>
          </div>
        </aside>
      );
    }

    if (view === "actions") {
      return (
        <aside className="sm-properties" data-testid="sm-properties" aria-label="Properti aksi otomatis">
          {subViewBackButton}
          {/* "Aksi" — node-level actions, NOT linked to any edge.
              Each row is "Saat" (ON_ENTRY/ON_EXIT, when the action fires) + an
              "Aksi" dropdown (the action type — `UPDATE_STATUS` today, editable
              via a <select> so the control is ready as more action types
              arrive) + "Nilai" (the target status, an editable <select> of all
              states) + a "Hapus" button. "+ Tambah aksi" adds a new node-level
              action (onAddNodeAction). Panel-only: the canvas never reflects
              these (they are not transitions); a node-action edit lifts as a
              form-only change (no re-seed). */}
          <div className="sm-properties__field">
            <p className="sm-properties__label" id="panel-node-actions-label">
              Aksi
            </p>
            <p className="sm-properties__hint">
              Aksi otomatis — dijalankan saat tiket masuk atau keluar dari status ini, tanpa perlu tombol dari petugas.
            </p>
            {nodeActions.length === 0 ? (
              <p className="sm-properties__hint" data-testid="panel-node-actions-empty">
                Belum ada aksi otomatis. Tambah aksi untuk menjalankan sesuatu saat tiket masuk atau keluar dari status ini.
              </p>
            ) : (
              <ul
                className="sm-properties__actions"
                aria-labelledby="panel-node-actions-label"
                data-testid="panel-node-actions"
              >
                {nodeActions.map((action, i) => {
                  const saatId = `panel-node-action-saat-${i}`;
                  const typeId = `panel-node-action-type-${i}`;
                  const toId = `panel-node-action-to-${i}`;
                  return (
                    <li key={i} className="sm-properties__action">
                      <label className="sm-properties__action-label" htmlFor={saatId}>
                        Saat
                      </label>
                      <select
                        id={saatId}
                        className="sm-properties__input"
                        data-testid={`panel-node-action-saat-${i}`}
                        value={action.executionType}
                        onChange={(e) =>
                          handlers.onEditNodeAction(name, i, {
                            executionType: e.target.value as "ON_ENTRY" | "ON_EXIT",
                          })
                        }
                      >
                        <option value="ON_ENTRY">Saat masuk</option>
                        <option value="ON_EXIT">Saat keluar</option>
                      </select>
                      <label className="sm-properties__action-label" htmlFor={typeId}>
                        Aksi
                      </label>
                      <select
                        id={typeId}
                        className="sm-properties__input"
                        data-testid={`panel-node-action-type-${i}`}
                        value={action.type}
                        onChange={(e) =>
                          handlers.onEditNodeAction(name, i, {
                            type: e.target.value as NodeActionType,
                          })
                        }
                      >
                        {NODE_ACTION_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <label className="sm-properties__action-label" htmlFor={toId}>
                        Nilai
                      </label>
                      <select
                        id={toId}
                        className="sm-properties__input"
                        data-testid={`panel-node-action-to-${i}`}
                        value={action.value}
                        onChange={(e) => handlers.onEditNodeAction(name, i, { value: e.target.value })}
                      >
                        {form.states.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="sm-properties__action-delete"
                        data-testid={`panel-node-action-delete-${i}`}
                        aria-label="Hapus aksi"
                        onClick={() => handlers.onDeleteNodeAction(name, i)}
                      >
                        Hapus
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <button
              type="button"
              className="btn btn--secondary sm-properties__add-action"
              data-testid="panel-add-node-action"
              onClick={() => handlers.onAddNodeAction(name)}
            >
              + Tambah aksi
            </button>
          </div>
        </aside>
      );
    }

    // overview (default sub-view)
    return (
      <aside className="sm-properties" data-testid="sm-properties" aria-label="Properti status">
        {backButton}
        <p className="sm-properties__heading">Status terpilih</p>
        <div className="sm-properties__field">
          <label className="sm-properties__label" htmlFor="panel-state-name">
            Nama status
          </label>
          <input
            id="panel-state-name"
            type="text"
            className="sm-properties__input"
            data-testid="panel-state-name"
            value={name}
            onChange={(e) => handlers.onRenameState(selectedNode.id, e.target.value.toUpperCase())}
          />
        </div>
        {/* Editable "Deskripsi" — a saved per-state override when non-empty,
            otherwise the derived fallback (canonical copy for a canonical
            name, or a summary of outgoing transitions for a custom name). The
            field is a <textarea> whose placeholder shows the derived fallback
            (`describeState`); an empty value clears the override (lifts via
            `onEditStateDescription`, which deletes the key so `descriptionFor`
            falls back to the derived copy). The description travels INSIDE the
            `stateMachine` wire object (not a top-level field), so no new
            passthrough site. The canvas node card's `data.description`
            refreshes via the `formToFlow`/`withDescriptions` memo recompute. */}
        <div className="sm-properties__field">
          <label className="sm-properties__label" htmlFor="panel-state-description">
            Deskripsi
          </label>
          <textarea
            id="panel-state-description"
            className="sm-properties__input sm-properties__textarea"
            data-testid="panel-state-description"
            rows={3}
            placeholder={derivedDescription}
            value={savedDescription}
            onChange={(e) => handlers.onEditStateDescription(name, e.target.value)}
          />
          <p className="sm-properties__hint">
            Kosongkan untuk memakai deskripsi bawaan: {derivedDescription}
          </p>
        </div>
        {/* Nav cards — drill into the "Transisi keluar" / "Aksi" sub-views.
            Each is a full-width button with a row layout (label + count) so the
            manager sees the section's item count at a glance. ≥44px touch
            target; `:hover`/`:focus-visible` states; theme-aware via tokens. */}
        <button
          type="button"
          className="sm-properties__nav-card"
          data-testid="panel-goto-transitions"
          onClick={() => setView("transitions")}
        >
          <span className="sm-properties__nav-label">Transisi keluar</span>
          <span className="sm-properties__nav-count">
            {outgoing.length} transisi
          </span>
        </button>
        <button
          type="button"
          className="sm-properties__nav-card"
          data-testid="panel-goto-actions"
          onClick={() => setView("actions")}
        >
          <span className="sm-properties__nav-label">Aksi</span>
          <span className="sm-properties__nav-count">
            {nodeActions.length} aksi
          </span>
        </button>
        <button
          type="button"
          className="btn btn--ghost sm-properties__delete"
          data-testid="panel-delete-state"
          aria-label={`Hapus status ${name}`}
          onClick={() => handlers.onDeleteState(selectedNode.id)}
        >
          Hapus status
        </button>
      </aside>
    );
  }

  if (selectedEdge) {
    const from = selectedEdge.source;
    const to = selectedEdge.target;
    const label = selectedEdge.data.actionLabel;
    const onlyTransition = handlers.transitionsCount <= 1;
    return (
      <aside className="sm-properties" data-testid="sm-properties" aria-label="Properti transisi">
        {backButton}
        <p className="sm-properties__heading">Transisi terpilih</p>
        <div className="sm-properties__field" data-testid="panel-transition-route">
          <label className="sm-properties__label" htmlFor="panel-transition-from">
            Dari
          </label>
          <select
            id="panel-transition-from"
            className="sm-properties__input"
            data-testid="panel-transition-from"
            value={from}
            onChange={(e) => handlers.onRerouteTransition(selectedEdge.id, e.target.value, to)}
          >
            {form.states.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span aria-hidden="true" className="sm-properties__route-arrow">→</span>
          <label className="sm-properties__label" htmlFor="panel-transition-to">
            Ke
          </label>
          <select
            id="panel-transition-to"
            className="sm-properties__input"
            data-testid="panel-transition-to"
            value={to}
            onChange={(e) => handlers.onRerouteTransition(selectedEdge.id, from, e.target.value)}
          >
            {form.states.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="sm-properties__field">
          <label className="sm-properties__label" htmlFor="panel-action-label">
            Label aksi
          </label>
          <input
            id="panel-action-label"
            type="text"
            className="sm-properties__input"
            data-testid="panel-action-label"
            placeholder="Label aksi"
            value={label}
            aria-describedby="panel-action-label-hint"
            onChange={(e) => handlers.onEditTransitionLabel(selectedEdge.id, e.target.value)}
          />
          <p id="panel-action-label-hint" className="sm-properties__hint">
            Teks tombol yang muncul di layar petugas.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--ghost sm-properties__delete"
          data-testid="panel-delete-transition"
          aria-label="Hapus transisi"
          onClick={() => handlers.onDeleteTransition(selectedEdge.id)}
          disabled={onlyTransition}
        >
          Hapus transisi
        </button>
        {onlyTransition && (
          <p className="sm-properties__hint">Minimal satu transisi harus tetap ada.</p>
        )}
      </aside>
    );
  }

  // The parent guarantees a selection when it mounts this component (it
  // switches to the palette view when nothing is selected). Keep this
  // defensive so a mis-wired mount stays presentational — return nothing
  // rather than an editor for a selection that no longer maps to a live
  // node/edge (e.g. a delete that cleared selection between render passes).
  return null;
}
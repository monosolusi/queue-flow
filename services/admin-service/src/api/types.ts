/**
 * Wire contract between admin-service and core-api. These types mirror the
 * DTOs core-api exposes over REST (`GET|PUT /api/system/config`,
 * `GET /api/system/state-machine`). There is no shared package, so the
 * contract is duplicated here intentionally — the ISP boundary means the admin
 * service only knows its own slice of the API (never caller/kiosk/tv-snapshot
 * DTOs).
 */

import { BROWSER_TIMEZONE } from '../lib/timezone';

export type PriorityPolicy = 'FIFO_GLOBAL' | 'CATEGORY_PRIORITY';
export type DailyResetMode = 'AUTOMATIC_CRON' | 'MANUAL';

/** A per-surface light/dark choice (QUE-47). Light is the default. */
export type ThemeMode = 'light' | 'dark';
/** The four deployable frontend surfaces a manager can theme independently. */
export type ServiceSurface = 'kiosk' | 'tv' | 'caller' | 'admin';
/** Persisted shape: one {@link ThemeMode} per {@link ServiceSurface}. */
export type ServiceThemesMap = Record<ServiceSurface, ThemeMode>;
/** All-light default — matches `ServiceThemes.DEFAULT` and the CSS `:root`
 *  light default (zero visual regression / clean-store prefill). */
export const DEFAULT_SERVICE_THEMES: ServiceThemesMap = {
  kiosk: 'light',
  tv: 'light',
  caller: 'light',
  admin: 'light',
};

/**
 * The TV-display grid layout contract — a TradingView-style 12-column grid
 * canvas where each placed widget occupies a `{ x, y, w, h }` rect (column /
 * row units). Replaces the former 1D panel-order/size map. The friendly
 * display names for each component type live in
 * {@link import('../lib/tv-grid-layout').TV_COMPONENT_LABELS}, never here.
 *
 * The contract is intentionally duplicated across three services
 * (core-api / admin / tv-display-service) — there is no shared package (the
 * standalone-service ethos). The three definitions MUST stay in lock-step; a
 * divergence is a bug. `runningText` is no longer special-cased — it is a
 * first-class widget placed on the grid like the other four (the TV renders
 * it wherever its rect lands, not always pinned as a footer).
 */
export type TvComponentType =
  | 'nowServing'
  | 'waitingQueue'
  | 'callHistory'
  | 'countersServing'
  | 'runningText';

/** One placed widget on the TV grid. `id` is a client-minted UUID identifying
 *  the widget instance (two widgets may share a `component` type but never an
 *  `id`). Coordinates are in column/row units against the 12-col grid. */
export interface TvWidget {
  readonly id: string;
  readonly component: TvComponentType;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
/** Persisted shape: an ordered list of placed widgets (no key→config map — the
 *  layout is a free-form grid, not a fixed panel set). */
export type TvGridLayout = readonly TvWidget[];

/** Grid geometry constants (mirror core-api's `TvGridLayout` VO exactly). */
export const GRID_COLS = 12;
export const GRID_MAX_ROWS = 20;
export const GRID_MIN_W = 1;
export const GRID_MIN_H = 1;

/** Stable component-type list (matches the backend `TV_COMPONENT_TYPES`). */
export const TV_COMPONENT_TYPES: readonly TvComponentType[] = [
  'nowServing',
  'waitingQueue',
  'callHistory',
  'countersServing',
  'runningText',
];

/** Default widget size per component (palette drop / click-add). A component's
 *  default size mirrors the PRD §7 visual emphasis — `nowServing` is the hero
 *  (full width, 4 rows), the side-by-side panels share a 6-col row, the
 *  `runningText` marquee is a 1-row strip. */
export const DEFAULT_WIDGET_SIZE: Record<TvComponentType, { w: number; h: number }> = {
  nowServing: { w: 12, h: 4 },
  waitingQueue: { w: 6, h: 3 },
  callHistory: { w: 6, h: 3 },
  countersServing: { w: 12, h: 3 },
  runningText: { w: 12, h: 1 },
};

/** All-five-widgets default layout — matches `TvGridLayout.DEFAULT` (the PRD
 *  default so a store that never configures this keeps the existing TV layout
 *  — zero visual regression, mirroring `DEFAULT_SERVICE_THEMES`). `nowServing`
 *  is the hero on row 0; `waitingQueue` + `callHistory` share row 4;
 *  `countersServing` sits below; `runningText` is the bottom strip. */
export const DEFAULT_TV_GRID_LAYOUT: TvGridLayout = [
  { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
  { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
  { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
  { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
  { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
];

/**
 * What a `→ WAITING` re-queue does to queue order — declared per edge by the
 * manager (the "workflow is source of truth" principle). Meaningful ONLY on an
 * edge whose `to === 'WAITING'`; on any other edge a non-KEEP policy is invalid
 * (enforced in `validateCustomStateMachine` and at the core-api save boundary).
 *
 * - `KEEP` (default) — the ticket keeps its current queue slot (today's FIFO
 *   behavior, and what every edge configured before this field existed means).
 * - `TO_BACK` — "paling belakang": move the ticket to the tail of the waiting
 *   queue.
 * - `BACK_N(n)` — "mundur n posisi": move the ticket back `n` positions within
 *   its own category (`n` is a non-negative integer; `0` = front, large `n` =
 *   back). `n` is only present when `kind === 'BACK_N'`.
 *
 * Mirrors core-api's `RequeuePolicy` VO.
 */
export type RequeuePolicyKind = 'KEEP' | 'TO_BACK' | 'BACK_N';

/** The wire shape of a {@link RequeuePolicyKind} declaration. `n` is present
 *  ONLY when `kind === 'BACK_N'`. */
export interface RequeuePolicyDto {
  readonly kind: RequeuePolicyKind;
  readonly n?: number;
}

export interface StateTransitionDto {
  readonly from: string;
  readonly to: string;
  readonly actionLabel: string;
  /** Optional on the wire: absent means `KEEP`, which is what every edge
   *  configured before this field existed means (core-api's
   *  `StateTransitionRule` default). Only meaningful on an edge whose `to ===
   *  'WAITING'`. Mirrors a sparse-on-the-wire, required-in-the-form lifecycle. */
  readonly requeuePolicy?: RequeuePolicyDto;
}

export interface StateMachineDto {
  readonly states: readonly string[];
  readonly transitions: readonly StateTransitionDto[];
  /**
   * Per-state editable descriptions (intrinsic per-state metadata, part of the
   * state-machine definition). Travels INSIDE the `stateMachine` object (NOT a
   * top-level field), so `REQUIRED_CONFIG_FIELDS` needs no new entry and the
   * full-save passthrough sites (PrinterConfigPage/TvLayoutPage/wizard) need no
   * new passthrough — they already pass `stateMachine` through. `{}` means "no
   * per-state overrides — derive from the canonical copy / outgoing-transition
   * count" (the {@link DEFAULT_STATE_MACHINE} default). Always present on the
   * read projection — the backend defaults to `{}` when unset (lazy-key
   * backward-compat, mirroring the `timezone`-in-`daily_reset_policy` pattern).
   */
  readonly descriptions: Record<string, string>;
}

/**
 * Which side of a node an edge attaches to. The four React Flow handle sides.
 * Connection-point (handle) routing is now sourced from the form transitions
 * (`Transition.sourceSide`/`targetSide`) and persisted in the separate
 * {@link EdgeRoutingLayoutDto} map — NOT on the wire {@link StateTransitionDto}
 * (which carries `{ from, to, actionLabel, requeuePolicy }` only).
 */
export type EdgeSide = 'top' | 'right' | 'bottom' | 'left';

/** A directed pair of connection sides for one transition edge. */
export interface EdgeSides {
  readonly sourceSide: EdgeSide;
  readonly targetSide: EdgeSide;
}

/**
 * The sparse edge-routing layout map keyed by `"from->to"`. Only edges with
 * NON-DEFAULT connection points are included — the default routing
 * (`sourceSide='right'`, `targetSide='left'`) is OMITTED, so `{}` means "every
 * edge uses the default left→right routing". Mirrors the backend
 * `edgeRoutingLayout` JSONB map on `SystemConfiguration`.
 */
export type EdgeRoutingLayoutDto = Record<string, EdgeSides>;

/**
 * One state node's canvas position (column/row-pixel coordinates on the
 * state-machine diagram). Mirrors core-api's `NodePosition` VO. Keyed by
 * state NAME (not id — the state-machine graph carries no ids), so a state
 * rename renames the key (the form helpers `updateState`/`removeState` keep
 * the map consistent).
 */
export interface NodePosition {
  readonly x: number;
  readonly y: number;
}

/**
 * Persisted node positions for the state-machine diagram, keyed by state
 * name. `{}` means "use the deterministic `autoLayout`" (the client's
 * left-to-right ranking). Non-sparse: every state whose position is known
 * has an entry. NOT change-gated for audit (an appearance concern, like
 * {@link EdgeRoutingLayoutDto} / `tvPanelLayout` / `serviceThemes` /
 * `brandColor`). Mirrors core-api's `NodePositions` VO + the
 * `edgeRoutingLayout` field-for-field precedent.
 */
export type NodePositionsDto = Record<string, NodePosition>;

/**
 * When a node-level action executes (execution-type, closed enum).
 * `ON_ENTRY` fires on entering the status; `ON_EXIT` fires on leaving it.
 * Mirrors core-api's `NodeActionExecutionType` VO.
 */
export type NodeActionExecutionType = 'ON_ENTRY' | 'ON_EXIT';
/**
 * What a node-level action does (closed enum — the only QMS action semantic
 * today; widening is a future PR). Mirrors core-api's `NodeActionType` VO.
 */
export type NodeActionType = 'UPDATE_STATUS';
/**
 * One node-level action, NOT linked to any transition edge. An
 * `UPDATE_STATUS` action sets the ticket status to `value` (a state name).
 * Mirrors core-api's `NodeActionProps` VO.
 */
export interface NodeActionDto {
  readonly executionType: NodeActionExecutionType;
  readonly type: NodeActionType;
  readonly value: string;
}
/**
 * Persisted node-level actions keyed by state name. An admin-
 * only config concern — NOT consumed by caller/tv/kiosk (ISP). Mirrors core-
 * api's `NodeActions` VO + the `nodePositions` field-for-field precedent:
 * keyed by state name so a rename moves the key (the form helpers
 * `updateState`/`removeState` keep the map consistent). `{}` means "no node-
 * level actions" (the default — the manager adds them on the properties
 * panel). Not change-gated for audit (an appearance/config concern, like
 * {@link NodePositionsDto} / {@link EdgeRoutingLayoutDto} / `brandColor`).
 */
export type NodeActionsDto = Record<string, NodeActionDto[]>;

/**
 * One terminal (Start/End) marker's persisted state. `'auto'` — derive the
 * marker position from the real node bounds (the default; current UX).
 * `{x,y}` — manager-pinned explicit position. `'hidden'` — manager deleted;
 * marker omitted. Mirrors core-api's `TerminalNodeState` VO. This field controls
 * marker PRESENCE + POSITION only. Both markers' edges are manual only — the
 * Start marker's outgoing edges come from {@link StartSourcesDto} and the End
 * marker's incoming edges come from {@link EndSourcesDto}.
 */
export type TerminalNodeStateDto = 'auto' | 'hidden' | { readonly x: number; readonly y: number };

/**
 * Persisted Start/End terminal-marker states. A fixed-shape `{ start, end }`
 * (NOT keyed by state name, unlike `nodePositions`/`nodeActions` — the terminal
 * ids `__start`/`__end` are reserved canvas markers, not state names, so the
 * backend `nodePositions` cross-check would reject them → a dedicated field).
 * Mirrors core-api's `TerminalNodes` VO + the `nodeActions` field-for-field
 * precedent. Not change-gated for audit (an appearance concern, like
 * {@link NodePositionsDto} / {@link NodeActionsDto}).
 */
export interface TerminalNodesDto {
  readonly start: TerminalNodeStateDto;
  readonly end: TerminalNodeStateDto;
}

/**
 * Persisted explicit End-marker connections — a flat array of state NAMES the
 * manager dragged a connection from into the End terminal marker (multiple
 * allowed). Purely visual metadata, like {@link NodePositionsDto} /
 * {@link TerminalNodesDto}: the End marker is a canvas-only affordance, NOT a
 * real state, so `__end` never reaches the wire `transitions` (the diagram
 * filters terminal edges at `flowToGraph`). Mirrors core-api's `endSources`
 * field-for-field. Not change-gated for audit (an appearance concern, like
 * {@link TerminalNodesDto}). This is the SOLE source of the End marker's
 * incoming arrows — nothing about the graph shape adds one — so `[]` means the
 * End marker renders with no incoming arrow at all (it still renders: it is the
 * drop target the manager drags into). Every entry draws exactly one arrow.
 */
export type EndSourcesDto = readonly string[];

/**
 * Empty end-sources list — "no End connections drawn yet". Matches the backend
 * `EndSources.DEFAULT`, and is what {@link DEFAULT_STATE_MACHINE} carries: the
 * PRD §7 default graph declares no End connections (mirroring
 * {@link DEFAULT_TERMINAL_NODES}).
 */
export const DEFAULT_END_SOURCES: EndSourcesDto = [];

/**
 * The Start marker's OUTGOING arrows — a flat list of state names the Start
 * marker connects to (one `__start → S` terminal edge per entry). Mirrors
 * {@link EndSourcesDto} field-for-field and mirrors core-api's `startSources`
 * field-for-field. This is the SOLE source of the Start marker's outgoing
 * arrows — nothing about the graph shape adds one (the auto-derive-from-
 * topology rule is GONE) — so `[]` means the Start marker renders BARE (no
 * arrow); it still renders (it is the drag source the manager drags from).
 * Every entry draws exactly one arrow. Not change-gated for audit (an
 * appearance concern, like {@link EndSourcesDto}).
 */
export type StartSourcesDto = readonly string[];

/**
 * Empty start-sources list — "no Start connections drawn yet". Matches the
 * backend `StartSources.DEFAULT`, and is what {@link DEFAULT_STATE_MACHINE}
 * carries: the PRD §7 default graph declares no Start connections (Start is
 * manual-only — no backfill from topology), so the default-graph Start marker
 * renders BARE until the manager draws a connection from it.
 */
export const DEFAULT_START_SOURCES: StartSourcesDto = [];

/** How the kiosk produces a thermal-printer receipt. `chrome` prints via the
 *  browser's print dialog (the default — zero setup, uses the manager's
 *  Chrome print settings); `network-escpos` streams raw ESC/POS bytes over TCP
 *  to a thermal printer on the local network (the core-api proxies the print so
 *  the kiosk never opens a raw socket itself — NFR-SEC-01). The enum stays as
 *  the wire `value=`; a friendly Indonesian label renders via
 *  {@link import('../lib/labels').PRINTER_MODE_LABELS} (never the raw enum). */
export type PrinterMode = 'chrome' | 'network-escpos' | 'usb-serial';
/** Receipt paper width in mm. Drives `@page` size for chrome printing and the
 *  ESC/POS column count (58mm → 32 cols, 80mm → 48 cols) for network printing. */
export type PrinterPaperWidth = 58 | 80;
/** When the thermal printer cuts the receipt. `full` / `partial` send the
 *  corresponding ESC/POS cut command; `none` omits it (the paper stays
 *  connected). Chrome ignores this (the operator tears the paper manually). */
export type PrinterCutMode = 'full' | 'partial' | 'none';

/**
 * Printer configuration for the kiosk receipt printer (a top-level config
 * field, sibling to `tvPanelLayout` / `edgeRoutingLayout` / `nodePositions`).
 * Mirrors core-api's `PrinterConfiguration` VO field-for-field. The manager
 * edits it on the dedicated `/printer-config` page; the kiosk reads it at boot
 * and selects its print provider accordingly. REQUIRED on the PUT
 * (`REQUIRED_CONFIG_FIELDS` includes it), so every full-save site carries it.
 *
 * `host` / `port` are only meaningful in `network-escpos` mode (the editor
 * hides them when `mode !== 'network-escpos'`); they are still sent on the wire
 * as the last-entered values so a mode switch back to network is
 * non-destructive. `baudRate` is only meaningful in `usb-serial` mode (the Web
 * Serial speed); it is carried on all modes for the same non-destructive
 * reason. The kiosk pairs the USB printer once on-device (a kiosk setup
 * overlay); the admin only sets the serial speed here.
 */
export interface PrinterConfigurationDto {
  readonly mode: PrinterMode;
  readonly paperWidth: PrinterPaperWidth;
  /** Printer host (IP / hostname). `''` when `mode === 'chrome'` (and hidden in
   *  the editor — chrome needs no host). */
  readonly host: string;
  /** TCP port the printer listens on (default 9100, the ESC/POS standard). */
  readonly port: number;
  readonly cutMode: PrinterCutMode;
  /** Serial baud rate for `usb-serial` (Web Serial `port.open({ baudRate })`).
   *  Default 9600; ignored by chrome/network-escpos but carried on the wire. */
  readonly baudRate: number;
}

export interface DailyResetPolicyDto {
  readonly mode: DailyResetMode;
  readonly cronExpression: string | null;
  readonly resetTicketNumberTo: number;
  readonly archivePreviousDayData: boolean;
  /** IANA timezone the daily-reset cron fires in (always present on the read
   *  projection — the backend VO defaults to the server's local TZ when
   *  unset). QUE-42. */
  readonly timezone: string;
}

export interface ConfigCategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface ConfigRoutingRuleDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategoryIds: readonly string[];
  readonly priorityPolicy: PriorityPolicy;
}

/** Full config projection from `GET /api/system/config`. */
export interface SystemConfigurationDto {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
  readonly stateMachine: StateMachineDto;
  readonly dailyResetPolicy: DailyResetPolicyDto;
  readonly categories: readonly ConfigCategoryDto[];
  readonly routingRules: readonly ConfigRoutingRuleDto[];
  readonly brandColor: string;
  /** Per-service light/dark theme map (QUE-47). Admin reads + edits the full
   *  map; each other service reads only its own surface key (ISP). */
  readonly serviceThemes: ServiceThemesMap;
  /** TV-display grid layout: a list of placed widgets on a 12-col grid. Admin
   *  reads + edits the full array on the dedicated `/tv-layout` page; the TV
   *  service reads the whole array at boot and lays each widget out at its
   *  `{ x, y, w, h }` rect on a CSS grid (the PRD default mirrors the former
   *  fixed-panel layout — zero visual regression). */
  readonly tvPanelLayout: TvGridLayout;
  /** Sparse edge-routing layout (`from->to` → sides) for the state-machine
   *  diagram. Always present — the backend defaults to `{}` (every edge uses
   *  the default L→R routing); `toForm` keeps a defensive `?? {}` coercion
   *  (belt-and-suspenders, same as `tvPanelLayout ?? DEFAULT_TV_GRID_LAYOUT`). */
  readonly edgeRoutingLayout: EdgeRoutingLayoutDto;
  /** State-node canvas positions keyed by state name (appearance concern,
   *  not change-gated). Always present — the backend defaults to `{}` (use
   *  the deterministic autoLayout); `toForm` keeps a defensive `?? {}`
   *  coercion (belt-and-suspenders, same as `edgeRoutingLayout`). */
  readonly nodePositions: NodePositionsDto;
  /** Node-level actions keyed by state name (admin-only config).
   *  Always present — the backend defaults to `{}` (no node-level actions);
   *  `toForm` keeps a defensive `?? {}` coercion (belt-and-suspenders, same as
   *  `nodePositions`). */
  readonly nodeActions: NodeActionsDto;
  /** Start/End terminal-marker states (appearance concern, not change-gated).
   *  Always present — the backend defaults to {@link DEFAULT_TERMINAL_NODES}
   *  (auto/auto) so a store that never touches the markers gets both entry/exit
   *  affordances on the canvas: an auto-positioned Start (when the topology has
   *  an entry state) and the always-present End drop target; `toForm` keeps a
   *  defensive `?? DEFAULT_TERMINAL_NODES` coercion (belt-and-suspenders, same
   *  as `nodeActions`). */
  readonly terminalNodes: TerminalNodesDto;
  /** Explicit End-marker connections (a flat array of state names the manager
   *  dragged into the End terminal marker). Always present — the backend
   *  defaults to {@link DEFAULT_END_SOURCES} so a store that never drags into
   *  End simply has no incoming End arrows; `toForm` keeps a defensive `?? []`
   *  coercion (belt-and-suspenders, same as `terminalNodes`). */
  readonly endSources: EndSourcesDto;
  /** Explicit Start-marker connections (a flat array of state names the manager
   *  dragged out of the Start terminal marker). Always present — the backend
   *  defaults to {@link DEFAULT_START_SOURCES} so a store that never drags from
   *  Start simply has no outgoing Start arrows (the marker renders BARE);
   *  `toForm` keeps a defensive `?? []` coercion (belt-and-suspenders, same as
   *  `endSources`). Start is MANUAL-ONLY — no backfill from topology. */
  readonly startSources: StartSourcesDto;
  /** Printer configuration for the kiosk receipt printer. Always present — the
   *  backend defaults to {@link DEFAULT_PRINTER_CONFIGURATION} so a store that
   *  never configures the printer keeps the chrome default (zero behavior
   *  change). `toForm` keeps a defensive `coercePrinterConfiguration` coercion
   *  (belt-and-suspenders, same as `serviceThemes` / `tvPanelLayout`). */
  readonly printerConfiguration: PrinterConfigurationDto;
}

/**
 * One category in the wizard / admin payload. `id` is optional: send the
 * existing id to preserve it across a re-save (keeps `QueueTicket.categoryId`
 * valid — the backend reuses it via `Identifier.of(id)`); omit it for a newly
 * added category so the backend mints one. The backend `WizardCategoryDto`
 * already accepts this field.
 */
export interface WizardCategoryDto {
  readonly id?: string;
  readonly code: string;
  readonly name: string;
}

/** One counter routing rule in the wizard payload (categories referenced by code). */
export interface WizardRoutingRuleDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategoryCodes: readonly string[];
  readonly priorityPolicy: PriorityPolicy;
}

/**
 * The wizard / admin save payload for `PUT /api/system/config`. The `actor`
 * field was removed (QUE-43): the server now derives the audit actor from the
 * authenticated admin's bearer token, so the client never sends it. On the
 * pre-setup wizard path there is no token, so the server uses a `'system'`
 * sentinel — no client change is needed beyond omitting the field.
 */
export interface SaveSystemConfigurationPayload {
  readonly storeName: string;
  readonly stateMachine: StateMachineDto;
  readonly dailyReset: DailyResetPolicyDto;
  readonly categories: readonly WizardCategoryDto[];
  readonly routingRules: readonly WizardRoutingRuleDto[];
  readonly brandColor: string;
  readonly serviceThemes: ServiceThemesMap;
  readonly tvPanelLayout: TvGridLayout;
  /** Sparse edge-routing layout for the state-machine diagram. REQUIRED on the
   *  PUT — the client is the source of truth for handles now and always sends
   *  the map (built by `toEdgeRoutingLayoutDto`); `{}` when every edge uses the
   *  default routing. */
  readonly edgeRoutingLayout: EdgeRoutingLayoutDto;
  /** State-node canvas positions (REQUIRED on the PUT — the client is the
   *  source of truth for positions now and always sends the map, built by
   *  `toNodePositionsDto`; `{}` when the canvas was never customized). */
  readonly nodePositions: NodePositionsDto;
  /** Node-level actions keyed by state name (REQUIRED on the PUT — the client
   *  is the source of truth for node actions now and always sends the map,
   *  built by `toNodeActionsDto`; `{}` when no node-level actions were added). */
  readonly nodeActions: NodeActionsDto;
  /** Start/End terminal-marker states (REQUIRED on the PUT — the client is the
   *  source of truth for terminal markers now and always sends the map, built
   *  by `toTerminalNodesDto`; `auto/auto` when the canvas was never
   *  customized). */
  readonly terminalNodes: TerminalNodesDto;
  /** Explicit End-marker connections — REQUIRED on the PUT (the client is the
   *  source of truth for explicit End connections now and always sends the
   *  array, built by `toEndSourcesDto`; `[]` when the manager never dragged into
   *  End). */
  readonly endSources: EndSourcesDto;
  /** Explicit Start-marker connections — REQUIRED on the PUT (the client is the
   *  source of truth for explicit Start connections now and always sends the
   *  array, built by `toStartSourcesDto`; `[]` when the manager never dragged
   *  from Start — the marker renders BARE). Start is MANUAL-ONLY — no backfill
   *  from topology. */
  readonly startSources: StartSourcesDto;
  /** Printer configuration — REQUIRED on the PUT (the client is the source of
   *  truth for the printer mode + settings); the dedicated `/printer-config`
   *  page edits it, every other full-save site passes it through unchanged. */
  readonly printerConfiguration: PrinterConfigurationDto;
}

/** Result of `PUT /api/system/config`. */
export interface SaveSystemConfigurationResult {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
  readonly brandColor: string;
  readonly serviceThemes: ServiceThemesMap;
  readonly tvPanelLayout: TvGridLayout;
  /** Always echoed by the backend (the save result mirrors the persisted map).
   *  The save path ignores the result body and re-GETs, so this is not
   *  load-bearing; kept for contract completeness (mirrors `tvPanelLayout`). */
  readonly edgeRoutingLayout: EdgeRoutingLayoutDto;
  /** Always echoed by the backend (mirrors the persisted map). The save path
   *  ignores the result body and re-GETs, so this is not load-bearing; kept
   *  for contract completeness (mirrors `edgeRoutingLayout`). */
  readonly nodePositions: NodePositionsDto;
  /** Always echoed by the backend (mirrors the persisted map). The save path
   *  ignores the result body and re-GETs, so this is not load-bearing; kept
   *  for contract completeness (mirrors `nodePositions`). */
  readonly nodeActions: NodeActionsDto;
  /** Always echoed by the backend (mirrors the persisted map). The save path
   *  ignores the result body and re-GETs, so this is not load-bearing; kept for
   *  contract completeness (mirrors `nodeActions`). */
  readonly terminalNodes: TerminalNodesDto;
  /** Always echoed by the backend (mirrors the persisted array). The save path
   *  ignores the result body and re-GETs, so this is not load-bearing; kept for
   *  contract completeness (mirrors `terminalNodes`). */
  readonly endSources: EndSourcesDto;
  /** Always echoed by the backend (mirrors the persisted array). The save path
   *  ignores the result body and re-GETs, so this is not load-bearing; kept for
   *  contract completeness (mirrors `endSources`). */
  readonly startSources: StartSourcesDto;
  /** Always echoed by the backend (the save result mirrors the persisted config).
   *  The save path ignores the result body and re-GETs, so this is not
   *  load-bearing; kept for contract completeness (mirrors `nodePositions`). */
  readonly printerConfiguration: PrinterConfigurationDto;
}

/**
 * The PRD §7 default category preset (prefilled into the wizard's Step 1
 * category designer when the manager keeps the "default" template). Like
 * {@link DEFAULT_STATE_MACHINE} this is a client mirror of the PRD §7 reference
 * config. `id` is intentionally absent — the backend mints one on first save;
 * on a re-edit the prefill carries the existing ids and the wizard's
 * id-preserving force-reset keeps them (see `defaultCategoriesWithIds`).
 */
export const DEFAULT_CATEGORIES: readonly WizardCategoryDto[] = [
  { code: 'A', name: 'Customer Service' },
  { code: 'B', name: 'Kasir & Pembayaran' },
];

/**
 * The PRD §7 default state machine (prefilled into the wizard designer).
 *
 * Each transition is a complete `StateTransitionDto` (`from`, `to`,
 * `actionLabel`) — the per-edge `action` flag was removed, so every edge is a
 * plain status change and the many places that build a form by copying these
 * edges need no per-field defaulting. "Pindah Kategori" (FR-CLR-03) is now a
 * standalone counter action, not a flow edge.
 */
export const DEFAULT_STATE_MACHINE: StateMachineDto = {
  states: ['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED'],
  // Every default edge is a plain status change: the PRD §7 flow has no category
  // move.
  transitions: [
    { from: 'WAITING', to: 'CALLING', actionLabel: 'Panggil Berikutnya' },
    { from: 'CALLING', to: 'SERVING', actionLabel: 'Mulai Melayani' },
    { from: 'CALLING', to: 'SKIPPED', actionLabel: 'Lewati / Absen' },
    { from: 'SKIPPED', to: 'CALLING', actionLabel: 'Panggil Ulang' },
    { from: 'SERVING', to: 'COMPLETED', actionLabel: 'Selesai Layan' },
  ],
  // No per-state description overrides — the canonical copy (describeState) is
  // the fallback for each of the 5 PRD §7 default statuses. `{}` = derive.
  descriptions: {},
};

export const DEFAULT_DAILY_RESET: DailyResetPolicyDto = {
  mode: 'AUTOMATIC_CRON',
  cronExpression: '0 0 * * *',
  resetTicketNumberTo: 1,
  archivePreviousDayData: true,
  timezone: BROWSER_TIMEZONE,
};

/**
 * Empty edge-routing layout — "every edge uses the default L→R routing".
 * Matches the backend `EdgeRoutingLayout.DEFAULT` so a store that never
 * customizes handle routing keeps the existing diagram look (zero visual
 * regression, mirroring {@link DEFAULT_TV_GRID_LAYOUT}).
 */
export const DEFAULT_EDGE_ROUTING_LAYOUT: EdgeRoutingLayoutDto = {};

/**
 * Empty node-positions map — "use the deterministic `autoLayout`". Matches
 * the backend `NodePositions.DEFAULT` so a store that never customizes node
 * positions keeps the existing diagram layout (zero visual regression,
 * mirroring {@link DEFAULT_EDGE_ROUTING_LAYOUT}).
 */
export const DEFAULT_NODE_POSITIONS: NodePositionsDto = {};

/**
 * Empty node-actions map — "no node-level actions". Matches the backend
 * `NodeActions.DEFAULT` so a store that never adds node actions keeps the
 * empty default (zero behavior change, mirroring
 * {@link DEFAULT_NODE_POSITIONS}).
 */
export const DEFAULT_NODE_ACTIONS: NodeActionsDto = {};

/**
 * Auto/auto terminal markers — "derive both markers' POSITION from the real
 * node bounds". Position is all that `'auto'` governs for either marker: its
 * EDGES are manual-only ({@link StartSourcesDto} for Start, {@link EndSourcesDto}
 * for End), and its presence is unconditional. Matches the backend
 * `TerminalNodes.DEFAULT` so a store that never touches the markers gets both
 * affordances on the canvas (mirroring {@link DEFAULT_NODE_ACTIONS}).
 */
export const DEFAULT_TERMINAL_NODES: TerminalNodesDto = { start: 'auto', end: 'auto' };

/**
 * Required top-level fields on a `PUT /api/system/config` payload, mirroring
 * the backend's `REQUIRED_CONFIG_FIELDS` guard (`system-config.controller`).
 * The backend validates *presence* at the transport boundary and 400s on a
 * missing field (a missing top-level field would otherwise dereference
 * `undefined` and surface as a 500). The admin client is the source of truth
 * for every field here and always sends them — this constant is the
 * documentation surface that lists every field a full-save site MUST carry,
 * so a new required field (like `endSources`) has one place to be registered.
 * `actor` is NOT listed (server-derived from the bearer token, QUE-43);
 * `descriptions` is NOT listed (it travels INSIDE `stateMachine`, so no new
 * top-level entry — see {@link StateMachineDto.descriptions}).
 */
export const REQUIRED_CONFIG_FIELDS: readonly (keyof SaveSystemConfigurationPayload)[] = [
  'storeName',
  'stateMachine',
  'dailyReset',
  'categories',
  'routingRules',
  'brandColor',
  'serviceThemes',
  'tvPanelLayout',
  'edgeRoutingLayout',
  'nodePositions',
  'nodeActions',
  'terminalNodes',
  'endSources',
  'startSources',
  'printerConfiguration',
];

/**
 * The default printer configuration — chrome (browser print dialog), 80mm
 * paper, partial cut. Matches the backend `PrinterConfiguration.DEFAULT` so a
 * store that never configures the printer keeps the existing chrome behavior
 * (zero behavior change — the kiosk already prints via the browser). The host
 * is `''` (chrome needs no host) and the port defaults to 9100 (the ESC/POS
 * standard, irrelevant until the manager switches to network mode).
 */
export const DEFAULT_PRINTER_CONFIGURATION: PrinterConfigurationDto = {
  mode: 'chrome',
  paperWidth: 80,
  host: '',
  port: 9100,
  cutMode: 'partial',
  baudRate: 9600,
};

/**
 * The shared accent color the four frontends hardcode in `:root` (`--accent:
 * #2563eb`). The wizard + admin panel prefill their `<input type="color">` with
 * this on a clean store, and the backend `BrandColor.DEFAULT` mirrors it so a
 * store that never sets a brand color keeps the existing look (zero visual
 * regression, AC1 "default yang masuk akal"). The UI emits `#rrggbb` only; the
 * backend VO additionally accepts OKLCH / `#rrggbbaa` for direct API calls.
 */
export const DEFAULT_BRAND_COLOR = '#2563eb';

// --- Analytics & audit-trail read surface (FR-ADM-03 / QUE-26) ----------------

/**
 * Per-category breakdown row in a {@link DailyReportDto}. Mirrors core-api's
 * `CategoryBreakdownDto` (`application/reporting/get-daily-report.use-case`).
 */
export interface CategoryBreakdownDto {
  readonly categoryId: string;
  readonly code: string;
  readonly categoryName: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
}

/**
 * Daily queue analytics report from `GET /api/reports/daily?date=YYYY-MM-DD`.
 * Mirrors core-api's `DailyReportDto`. The controller returns a zero-shape
 * (`totalTickets: 0`, empty `perCategory`) when no tickets exist for the date,
 * so this DTO is never null over the wire.
 */
export interface DailyReportDto {
  readonly date: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly perCategory: readonly CategoryBreakdownDto[];
}

/**
 * One counter's performance from `GET /api/reports/counters/:id?date=YYYY-MM-DD`.
 * Mirrors core-api's `CounterPerformanceDto`. Zero-shape when the counter served
 * nothing that day.
 */
export interface CounterPerformanceDto {
  readonly counterId: number;
  readonly date: string;
  readonly ticketsServed: number;
  readonly avgServiceTimeMs: number;
}

// --- Range analytics read surface (FR-ADM-03 / QUE-44) -----------------------

/**
 * One day's aggregate within a {@link RangeReportDto}. Mirrors core-api's
 * `DailyPointDto`. Days with no tickets surface as zero-point rows so the trend
 * chart renders a continuous axis.
 */
export interface DailyPointDto {
  readonly date: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly ticketsServed: number;
}

/** One counter's aggregate over a range. Mirrors core-api's `CounterRangeBreakdownDto`. */
export interface CounterRangeBreakdownDto {
  readonly counterId: number;
  readonly ticketsServed: number;
  readonly avgServiceTimeMs: number;
}

/**
 * Range queue analytics report from `GET /api/reports/range?from=&to=`. Mirrors
 * core-api's `RangeReportDto`. Range totals + a per-day series (for trend
 * visualization) + per-category and per-counter aggregates over the range. The
 * controller returns a zero-shape (with a per-day zero series) when no tickets
 * exist in the range, so this DTO is never null over the wire.
 */
export interface RangeReportDto {
  readonly from: string;
  readonly to: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly perDay: readonly DailyPointDto[];
  readonly perCategory: readonly CategoryBreakdownDto[];
  readonly perCounter: readonly CounterRangeBreakdownDto[];
}

// --- Live queue state read surface (FR-ADM-03 / QUE-44 Dashboard) ------------

/**
 * Transport-agnostic projection of a live queue ticket. Mirrors core-api's
 * `TicketStateDto` (`application/queue/ticket-state.dto`). `counterId` is null
 * for a WAITING ticket (not yet called to a counter).
 */
export interface TicketStateDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly status: string;
  readonly counterId: number | null;
}

/**
 * Live queue board state from `GET /api/queue/board`. Mirrors core-api's
 * `TvBoardStateDto` (the `Tv` prefix is historical on the backend; the admin
 * dashboard consumes the same read for its live operational status). `active`
 * is every CALLING/SERVING ticket across all counters, oldest-updated first —
 * the last entry is the most-recently-touched (the now-serving ticket).
 */
export interface QueueBoardStateDto {
  readonly active: readonly TicketStateDto[];
  readonly waiting: readonly TicketStateDto[];
  readonly waitingCount: number;
}

/**
 * A category assigned to a counter. Mirrors core-api's `AssignedCategoryDto`.
 */
export interface AssignedCategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * A configured counter from `GET /api/counters`. Mirrors core-api's
 * `CounterDto` (`application/store-config/list-counters.use-case`). Used by the
 * dashboard to label the counter-status list.
 */
export interface CounterDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategories: readonly AssignedCategoryDto[];
  readonly priorityPolicy: PriorityPolicy;
}

/**
 * Opaque before/after snapshot recorded with an audit entry (an arbitrary JSON
 * object on the server). Mirrors core-api's `AuditSnapshot`
 * (`Record<string, unknown>`); kept loose so the client never assumes a shape.
 */
export type AuditSnapshot = Record<string, unknown>;

/**
 * One audit-trail entry from `GET /api/audit/log`. Mirrors core-api's
 * `AuditLogEntryDto`. `action` is the serialized enum string (e.g.
 * `'MANUAL_RESET'`, `'STATE_SCHEMA_CHANGE'`, `'ARCHIVE_PREVIOUS_DAY'`).
 */
export interface AuditLogEntryDto {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly before: AuditSnapshot | null;
  readonly after: AuditSnapshot;
  readonly occurredAt: number;
}

// --- Manual override operations (FR-ADM-02 / QUE-25) -------------------------

/**
 * Result of `POST /api/system/daily-reset` (the manual daily-reset override).
 * Mirrors core-api's `ResetDailyQueueResult`. `archivedCount` is present when
 * the active policy archives prior-day tickets (the default policy does, so it
 * is usually present — 0 when no prior-day tickets existed).
 */
export interface ManualResetResultDto {
  readonly status: 'reset';
  readonly date: string;
  readonly resetTo: number;
  readonly archivedCount?: number;
}

/**
 * Result of `POST /api/system/cleanup-transaction-log` (the transaction-log
 * cleanup override). Mirrors core-api's `CleanupTransactionLogResult`.
 * `deletedCount` is how many archived transactions older than the retention
 * window were permanently removed.
 */
export interface CleanupTransactionLogResultDto {
  readonly status: 'cleaned';
  readonly retentionDays: number;
  readonly deletedCount: number;
}

// --- Identity & access (QUE-43) ----------------------------------------------

/**
 * The role a {@link UserDto} / {@link AuthUserDto} may carry. Mirrors core-api's
 * `UserRole` enum. The wire `value=` stays the enum; user-visible copy renders a
 * friendly Indonesian label via {@link USER_ROLE_LABELS} (never the raw enum).
 */
export type UserRole = 'admin' | 'caller-staff';

/**
 * The authenticated principal, returned by `GET /api/auth/me` and embedded in
 * the {@link LoginResponseDto}. Carries no `createdAt` (the `/me` projection is
 * the minimal identity slice — the created-at timestamp lives on {@link UserDto}).
 */
export interface AuthUserDto {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
}

/**
 * Result of `POST /api/auth/login`. The opaque bearer `token` is stored in
 * `qms.admin.token` (see `auth/token-store`) and threaded as
 * `Authorization: Bearer <token>` on every protected request. The client never
 * decodes the token (no JWT lib — NFR-REL-01); it reads `/api/auth/me` for the
 * current user.
 */
export interface LoginResponseDto {
  readonly token: string;
  readonly user: AuthUserDto;
}

/**
 * One user account from `GET /api/users` / `POST /api/users` /
 * `POST /api/auth/setup-admin`. Mirrors core-api's `UserDto`. `createdAt` is a
 * Unix-epoch millisecond timestamp (the backend stores BIGINT ms, matching the
 * audit-log + lifecycle timestamps convention).
 */
export interface UserDto {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
  readonly createdAt: number;
}
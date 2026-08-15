import type { Pool } from 'pg';
import {
  type ISystemConfigurationRepository,
  SystemConfiguration,
} from '../../../domain/store-config';
import { BrandColor } from '../../../domain/store-config/value-objects/brand-color';
import {
  DailyResetMode,
  DailyResetPolicy,
  type DailyResetPolicyProps,
} from '../../../domain/store-config/value-objects/daily-reset-policy';
import {
  ServiceThemes,
  type ServiceThemesMap,
} from '../../../domain/store-config/value-objects/service-themes';
import {
  TvPanelLayout,
  type TvGridLayout,
} from '../../../domain/store-config/value-objects/tv-panel-layout';
import {
  EdgeRoutingLayout,
  type EdgeRoutingLayoutMap,
} from '../../../domain/store-config/value-objects/edge-routing-layout';
import {
  NodePositions,
  type NodePositionsMap,
} from '../../../domain/store-config/value-objects/node-positions';
import {
  NodeActions,
  type NodeActionsMap,
} from '../../../domain/store-config/value-objects/node-actions';
import {
  TerminalNodes,
  type TerminalNodesProps,
} from '../../../domain/store-config/value-objects/terminal-nodes';
import {
  EndSources,
  type EndSourcesDto,
} from '../../../domain/store-config/value-objects/end-sources';
import {
  StartSources,
  type StartSourcesDto,
} from '../../../domain/store-config/value-objects/start-sources';
import {
  PrinterConfiguration,
  type PrinterConfigurationDto,
} from '../../../domain/store-config/value-objects/printer-configuration';
import { StateMachine } from '../../../domain/store-config/state-machine';
import { StateSchema } from '../../../domain/store-config/value-objects/state-schema';
import { StateDescriptions } from '../../../domain/store-config/value-objects/state-descriptions';
import { StateTransitionRule } from '../../../domain/store-config/value-objects/state-transition-rule';
import { Identifier, requeuePolicyFromWire } from '../../../domain/shared';
import { withDbClient } from './transaction-context';

interface ConfigRow {
  id: string;
  store_name: string;
  is_initial_setup_completed: boolean;
  state_machine: {
    states: string[];
    transitions: {
      from: string;
      to: string;
      actionLabel: string;
      /** Stale `action` key from a pre-feature row — ignored on read, dropped on
       *  the next save (no migration). Kept loose (`string`, not the deleted
       *  enum) so a SELECT * on an existing JSONB document does not fail the
       *  row's type. */
      action?: string;
      /** What an `-> WAITING` edge does to the WAITING queue's order — lazy
       *  key (absent on pre-feature rows, defaults to KEEP via
       *  `requeuePolicyFromWire`). Same lazy-key pattern as `descriptions`
       *  below: no SQL migration (the field lives inside the `state_machine`
       *  JSONB document), the key appears on the next save. */
      requeuePolicy?: { kind: string; n?: number };
    }[];
    /** Per-state description overrides — lazy key (absent on pre-feature rows,
     *  defaults to `{}`). Mirrors the `timezone`-in-`daily_reset_policy` lazy-
     *  key pattern. */
    descriptions?: Record<string, string>;
  };
  daily_reset_policy: DailyResetPolicyProps;
  brand_color: string;
  service_themes: ServiceThemesMap | null;
  tv_panel_layout: TvGridLayout | null;
  edge_routing_layout: EdgeRoutingLayoutMap | null;
  node_positions: NodePositionsMap | null;
  node_actions: NodeActionsMap | null;
  terminal_nodes: TerminalNodesProps | null;
  end_sources: EndSourcesDto | null;
  start_sources: StartSourcesDto | null;
  printer_configuration: PrinterConfigurationDto | null;
}

/**
 * PostgreSQL implementation of {@link ISystemConfigurationRepository} (QUE-30).
 * Stores the singleton {@link SystemConfiguration} as one row (PK `id`); the
 * state machine and daily-reset policy are serialized to JSONB. `save` is a
 * single-statement upsert (`INSERT ... ON CONFLICT (id) DO UPDATE`), so it is
 * atomic on its own even when called outside a transaction — a crash between
 * the (nonexistent) truncate and insert cannot leave the table empty. When
 * enlisted on an ambient transaction (wizard finalization), it commits
 * atomically with the audit entry. The singleton id is preserved across saves
 * by the use case, so the upsert always targets the one existing row.
 */
export class PostgresSystemConfigurationRepository implements ISystemConfigurationRepository {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<SystemConfiguration | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<ConfigRow>('SELECT * FROM system_configuration LIMIT 1');
      return rows.length ? toConfig(rows[0]) : null;
    });
  }

  async save(config: SystemConfiguration): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO system_configuration (id, store_name, is_initial_setup_completed, state_machine, daily_reset_policy, brand_color, service_themes, tv_panel_layout, edge_routing_layout, node_positions, node_actions, terminal_nodes, end_sources, start_sources, printer_configuration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET
           store_name                = EXCLUDED.store_name,
           is_initial_setup_completed = EXCLUDED.is_initial_setup_completed,
           state_machine             = EXCLUDED.state_machine,
           daily_reset_policy        = EXCLUDED.daily_reset_policy,
           brand_color               = EXCLUDED.brand_color,
           service_themes            = EXCLUDED.service_themes,
           tv_panel_layout           = EXCLUDED.tv_panel_layout,
           edge_routing_layout       = EXCLUDED.edge_routing_layout,
           node_positions            = EXCLUDED.node_positions,
           node_actions              = EXCLUDED.node_actions,
           terminal_nodes            = EXCLUDED.terminal_nodes,
           end_sources               = EXCLUDED.end_sources,
           start_sources             = EXCLUDED.start_sources,
           printer_configuration     = EXCLUDED.printer_configuration`,
        [
          config.id.value,
          config.storeName,
          config.isInitialSetupCompleted,
          JSON.stringify(serializeStateMachine(config.stateMachine)),
          JSON.stringify({
            mode: config.dailyResetPolicy.mode,
            cronExpression: config.dailyResetPolicy.cronExpression,
            resetTicketNumberTo: config.dailyResetPolicy.resetTicketNumberTo,
            archivePreviousDayData: config.dailyResetPolicy.archivePreviousDayData,
            timezone: config.dailyResetPolicy.timezone,
          }),
          config.brandColor.value,
          JSON.stringify(config.serviceThemes.toDto()),
          JSON.stringify(config.tvPanelLayout.toDto()),
          JSON.stringify(config.edgeRoutingLayout.toDto()),
          JSON.stringify(config.nodePositions.toDto()),
          JSON.stringify(config.nodeActions.toDto()),
          JSON.stringify(config.terminalNodes.toDto()),
          JSON.stringify(config.endSources.toDto()),
          JSON.stringify(config.startSources.toDto()),
          JSON.stringify(config.printerConfiguration.toDto()),
        ],
      );
    });
  }
}

function serializeStateMachine(sm: StateMachine) {
  return {
    states: [...sm.stateSchema.states],
    transitions: sm.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      actionLabel: t.actionLabel,
      requeuePolicy: t.requeuePolicy,
    })),
    // Per-state description overrides, materialized from the VO. Always written
    // (the VO defaults to `{}` = no overrides) so the `descriptions` key appears
    // lazily on the next save of a pre-feature row (mirrors the `timezone`-in-
    // `daily_reset_policy` lazy-key pattern). No SQL migration needed.
    descriptions: sm.stateDescriptions.toDto(),
  };
}

/**
 * Canonical label for a `-> WAITING` re-queue edge — the wording the aggregate
 * itself documents for this transition ("Kembalikan ke Antrian"). Used only to
 * normalise a stale pre-feature row (see `toConfig`).
 */
const REQUEUE_ACTION_LABEL = 'Kembalikan ke Antrian';

function toConfig(row: ConfigRow): SystemConfiguration {
  const sm = row.state_machine;
  return SystemConfiguration.reconstitute({
    id: Identifier.of(row.id),
    storeName: row.store_name,
    isInitialSetupCompleted: row.is_initial_setup_completed,
    stateMachine: new StateMachine(
      StateSchema.of(sm.states),
      // `requeuePolicy` is a lazy key: a pre-feature row carries none, and
      // `requeuePolicyFromWire` recovers `undefined` to KEEP — the meaning every
      // edge configured before the field existed had. No SQL migration — it lives
      // inside the `state_machine` JSONB document and appears lazily on the next
      // save. A stale `action: 'TRANSFER_CATEGORY'` row authored a *category move*
      // under the pre-feature model; category moves are now a standalone counter
      // action, not an edge. The edge survives as a re-queue (`-> WAITING`), but
      // the label the manager chose for a transfer (often "Pindah Kategori") no
      // longer fits a re-queue and would duplicate the standalone "Pindah
      // Kategori" button on the caller — same label, different behaviour.
      // Normalise it to the canonical re-queue label so the surviving edge says
      // what it now does. The stale `action` key itself is dropped on the next
      // save (no migration). Any other stale `action` value (e.g.
      // 'UPDATE_STATUS') is ignored — the label stands.
      sm.transitions.map((t) =>
        StateTransitionRule.of(
          t.from,
          t.to,
          t.action === 'TRANSFER_CATEGORY' ? REQUEUE_ACTION_LABEL : t.actionLabel,
          requeuePolicyFromWire(t.requeuePolicy),
        ),
      ),
      // Lazy-key backward-compat: a pre-feature row's `state_machine` JSONB
      // carries no `descriptions` key, so `sm.descriptions` is `undefined`.
      // `StateDescriptions.of(undefined)` recovers to the empty default (derive
      // from canonical copy), mirroring the `timezone`-in-`daily_reset_policy`
      // fallback. No SQL migration — the key appears lazily on the next save.
      StateDescriptions.of(sm.descriptions ?? undefined),
    ),
    dailyResetPolicy: deserializePolicy(row.daily_reset_policy),
    // Defensive `?? BrandColor.DEFAULT.value` for the boot window between a code
    // deploy and the 0004 migration applying (the runner auto-runs on boot before
    // serving, but a SELECT * on a pre-migration row has no brand_color column).
    // The `NOT NULL DEFAULT '#2563eb'` migration backfills existing rows, so the
    // fallback is belt-and-suspenders — it prevents a 500 instead of surfacing a
    // malformed (missing) column value.
    brandColor: BrandColor.of(row.brand_color ?? BrandColor.DEFAULT.value),
    // Same boot-window fallback for service_themes (0007 migration). `of()`
    // recovers a null/undefined column to all-light, and a pre-migration row's
    // SELECT * simply lacks the column (pg returns undefined here) — both paths
    // reconstitute ServiceThemes.DEFAULT. Mirrors the brandColor fallback.
    serviceThemes: ServiceThemes.of(row.service_themes ?? undefined),
    // Same boot-window fallback for tv_panel_layout (0009 migration renamed
    // the old boolean-map column to this). `of()` recovers a null/undefined
    // column to the default layout, and a pre-migration row's SELECT * simply
    // lacks the column (pg returns undefined here) — both paths reconstitute
    // TvPanelLayout.DEFAULT. Mirrors the serviceThemes fallback.
    tvPanelLayout: TvPanelLayout.of(row.tv_panel_layout ?? undefined),
    // Same boot-window fallback for edge_routing_layout (0011 migration). `of()`
    // recovers a null/undefined column to the empty default map (all-default
    // routing), and a pre-migration row's SELECT * simply lacks the column (pg
    // returns undefined here) — both paths reconstitute
    // EdgeRoutingLayout.DEFAULT. Mirrors the tvPanelLayout fallback.
    edgeRoutingLayout: EdgeRoutingLayout.of(row.edge_routing_layout ?? undefined),
    // Same boot-window fallback for node_positions (0012 migration). `of()`
    // recovers a null/undefined column to the empty default map (autoLayout),
    // and a pre-migration row's SELECT * simply lacks the column (pg returns
    // undefined here) — both paths reconstitute NodePositions.DEFAULT. Mirrors
    // the edgeRoutingLayout fallback.
    nodePositions: NodePositions.of(row.node_positions ?? undefined),
    // Same boot-window fallback for node_actions (0014 migration). `of()`
    // recovers a null/undefined column to the empty default map (no node-level
    // actions), and a pre-migration row's SELECT * simply lacks the column (pg
    // returns undefined here) — both paths reconstitute NodeActions.DEFAULT.
    // Mirrors the nodePositions fallback.
    nodeActions: NodeActions.of(row.node_actions ?? undefined),
    // Same boot-window fallback for terminal_nodes (0015 migration). `of()`
    // recovers a null/undefined column to the auto/auto default (markers
    // render at derived positions), and a pre-migration row's SELECT * simply
    // lacks the column (pg returns undefined here) — both paths reconstitute
    // TerminalNodes.DEFAULT. Mirrors the nodeActions fallback. NO state-
    // membership cross-check (terminal ids are not state names).
    terminalNodes: TerminalNodes.of(row.terminal_nodes ?? undefined),
    // Same boot-window fallback for end_sources (0016 migration). `of()`
    // recovers a null/undefined column to the empty default array (no end
    // sources recorded), and a pre-migration row's SELECT * simply lacks the column (pg
    // returns undefined here) — both paths reconstitute EndSources.DEFAULT.
    // Mirrors the terminalNodes fallback. State-membership cross-check runs in
    // the save use case (the VO stays free of a StateMachine dependency).
    endSources: EndSources.of(row.end_sources ?? undefined),
    // Same boot-window fallback for start_sources (0018 migration). `of()`
    // recovers a null/undefined column to the empty default array (no start
    // sources recorded), and a pre-migration row's SELECT * simply lacks the column (pg
    // returns undefined here) — both paths reconstitute StartSources.DEFAULT.
    // Mirrors the endSources fallback. State-membership cross-check runs in
    // the save use case (the VO stays free of a StateMachine dependency).
    startSources: StartSources.of(row.start_sources ?? undefined),
    // Same boot-window fallback for printer_configuration (0013 migration).
    // `of()` recovers a null/undefined column to the chrome default (zero
    // behavior change — the kiosk keeps using Chrome's print dialog), and a
    // pre-migration row's SELECT * simply lacks the column (pg returns
    // undefined here) — both paths reconstitute PrinterConfiguration.DEFAULT.
    // Mirrors the nodePositions fallback.
    printerConfiguration: PrinterConfiguration.of(row.printer_configuration ?? undefined),
  });
}

function deserializePolicy(props: DailyResetPolicyProps) {
  // Defensive `timezone` pass-through for old rows pre-QUE-42: the JSONB
  // column carries no `timezone` key on stores saved before the feature, so
  // `props.timezone` is `undefined`. The VO's `of(...)` defaults an absent /
  // empty timezone to the server's local IANA zone (`DEFAULT_TIMEZONE`), so
  // passing `undefined` here rehydrates a pre-feature row to the same
  // operational behavior the host had before (cron fired in host local time).
  // No SQL migration is needed — the JSONB column is flexible, and the new key
  // appears lazily on the next save (mirrors the `brandColor` `?? DEFAULT`
  // fallback for the boot window between a code deploy and a migration). On
  // the next save the new `timezone` key is written alongside the others.
  return DailyResetPolicy.of(
    props.mode as DailyResetMode,
    props.cronExpression,
    props.resetTicketNumberTo,
    props.archivePreviousDayData,
    props.timezone ?? undefined,
  );
}
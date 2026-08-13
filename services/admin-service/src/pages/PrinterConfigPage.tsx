import { useEffect, useMemo, useRef, useState } from 'react';
import type { IAdminApi } from '../api/admin-api';
import {
  DEFAULT_PRINTER_PORT,
  PRINTER_CUT_MODES,
  PRINTER_MODES,
  PRINTER_PAPER_WIDTHS,
  coercePrinterConfiguration,
  validatePrinterConfiguration,
} from '../lib/printer';
import type { PrinterCutMode, PrinterPaperWidth, PrinterConfigurationDto } from '../api/types';
import { PRINTER_BAUD_RATES, PRINTER_CUT_MODE_LABELS, PRINTER_MODE_LABELS, PRINTER_PAPER_WIDTH_LABELS } from '../lib/labels';
import { useSystemConfigContext } from '../config/system-config-context';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../toast/useToast';
import { toForm } from './admin-config/form';
import { toEdgeRoutingLayoutDto, toEndSourcesDto, toNodeActionsDto, toNodePositionsDto, toStateMachineDto, toTerminalNodesDto } from '../lib/state-machine';

/**
 * AC6 — wire a field error message to its input via `aria-describedby` +
 * `aria-invalid`. Returns a spreadable props object (empty when there is no
 * error) so the happy-path markup stays clean. Duplicated from WizardPage /
 * AdminPanel rather than shared: the repo has no shared UI lib and the error
 * shapes are heterogeneous (mirrors the `theme.ts` duplication precedent).
 */
function describedBy(
  errorId: string,
  hasError: boolean,
): { 'aria-describedby': string; 'aria-invalid': boolean } | Record<string, never> {
  return hasError ? { 'aria-describedby': errorId, 'aria-invalid': true } : {};
}

/**
 * The printer-configuration page — a standalone `/printer-config` route
 * (sibling to `/tv-layout`) where the manager chooses how the kiosk produces a
 * thermal-printer receipt.
 *
 * Three modes (FR feedback: "pilih printer mana yang dipakai (default Chrome)
 * atau printer ESC/POS jaringan"):
 *  - **`chrome`** (default) — the kiosk prints via the browser's print dialog.
 *    Zero setup; uses the operator's Chrome print settings (paper size, etc.).
 *    `host` / `port` / `cutMode` are irrelevant here (host/port hidden, cutMode
 *    kept for a non-destructive mode switch back but unused by the printer).
 *  - **`network-escpos`** — the kiosk streams raw ESC/POS bytes over TCP to a
 *    thermal printer on the local network. The core-api proxies the print so
 *    the kiosk never opens a raw socket itself (NFR-SEC-01). Requires a
 *    non-empty `host` (no whitespace) + an integer `port` 1..65535.
 *  - **`usb-serial`** — a USB thermal printer cabled to the kiosk box. USB is
 *    kiosk-local, so core-api cannot proxy it (unlike network-escpos): the
 *    kiosk composes ESC/POS client-side and writes it directly over Web Serial
 *    (`navigator.serial`). Pairing is a one-time operator action on the kiosk
 *    (`/sambung-printer` — `requestPort()` needs a user gesture). The manager
 *    sets the serial `baudRate` here; no `host`/`port`.
 *
 * `paperWidth` (58 / 80mm) applies to all three modes: chrome uses it for the
 * `@page` size, the ESC/POS providers (network + usb) use it for the column
 * count. `cutMode` applies to both ESC/POS modes (network + usb).
 *
 * The page is a thin editor over the existing config save surface (mirrors
 * `/tv-layout`): it reads the full config (`GET /api/system/config` via the
 * shared `SystemConfigProvider`), lets the manager edit ONLY
 * `printerConfiguration`, and PUTs the full payload back
 * (`PUT /api/system/config`) — passthrough of every other field (storeName,
 * stateMachine, edgeRoutingLayout, nodePositions, dailyReset, categories,
 * routingRules, brandColor, serviceThemes, tvPanelLayout) unchanged, mirroring
 * the AdminPanel full-save pattern (DRY — one atomic, audited save use case).
 * On success it toasts "Konfigurasi Printer disimpan." and calls the shared
 * `refresh()` so every consumer sees the new printer config. Category ids are
 * preserved across the save (the shared `toForm` mapper carries them), and the
 * client-only `rowKey` is stripped at the boundary.
 *
 * The printer form validates client-side, mirroring the core-api
 * `PrinterConfiguration` VO invariants (mode / paperWidth / cutMode enums, port
 * 1..65535 integer, host non-empty + whitespace-free when network). Chrome mode
 * is always valid (host/port are irrelevant). The save button is disabled until
 * the form is valid; an inline error list surfaces what is wrong.
 */
export function PrinterConfigPage({ api }: { api: IAdminApi }) {
  const toast = useToast();
  const { config, refresh } = useSystemConfigContext();
  // The local printer draft — initialized from the resolved config (coerced —
  // a corrupt GET projection never breaks the editor). `config` is `null` until
  // the shared probe resolves; the page renders a loading state until then. The
  // draft is re-initialized when the config identity changes (a refresh after a
  // save resolves a new object), so the editor reflects the persisted state.
  const [draft, setDraft] = useState<PrinterConfigurationDto | null>(null);
  const [saving, setSaving] = useState(false);
  // Synchronous in-flight guard — `disabled` only takes effect after a
  // re-render, so two clicks in the same tick both pass a state guard (mirrors
  // the kiosk double-tap guard + TvLayoutPage's `savingRef`).
  const savingRef = useRef(false);

  useEffect(() => {
    if (config === null) return;
    setDraft(coercePrinterConfiguration(config.printerConfiguration));
  }, [config]);

  // The full editable form is rebuilt from the config so the passthrough fields
  // (categories with ids, routing codes, state-machine strip) map exactly as
  // AdminPanel does — no duplicated mapping logic. Memoized on the config
  // identity so it re-derives only when the resolved config changes.
  const form = useMemo(() => (config !== null ? toForm(config) : null), [config]);

  const errors = draft !== null ? validatePrinterConfiguration(draft) : [];
  const valid = draft !== null && errors.length === 0;

  async function save() {
    if (savingRef.current) return;
    if (draft === null || !valid || form === null) return;
    savingRef.current = true;
    setSaving(true);
    try {
      try {
        await api.saveSystemConfig({
          storeName: form.storeName,
          // Strip the client-only `mode` preset — never on the wire — via the
          // same shared mapper AdminPanel uses. Sides travel in the separate
          // sparse `edgeRoutingLayout` map and node positions in `nodePositions`
          // (this page edits neither, so both are whatever `toForm` merged from
          // the GET — passthrough).
          stateMachine: toStateMachineDto(form.stateMachine),
          edgeRoutingLayout: toEdgeRoutingLayoutDto(form.stateMachine),
          nodePositions: toNodePositionsDto(form.stateMachine),
          // Node actions — payload-only passthrough (this page edits neither node
          // actions nor the graph); mirrors `nodePositions`.
          nodeActions: toNodeActionsDto(form.stateMachine),
          // Terminal markers — payload-only passthrough (this page edits neither
          // terminal markers nor the graph); mirrors `nodeActions`.
          terminalNodes: toTerminalNodesDto(form.stateMachine),
          // Explicit End connections — payload-only passthrough (this page
          // edits neither End connections nor the graph); mirrors
          // `terminalNodes`.
          endSources: toEndSourcesDto(form.stateMachine),
          brandColor: form.brandColor,
          serviceThemes: form.serviceThemes,
          // Passthrough — the TV-layout editor lives on `/tv-layout`; the full
          // PUT must still carry the field so the required wire field is sent.
          tvPanelLayout: form.tvPanelLayout,
          // The one field this page edits.
          printerConfiguration: draft,
          dailyReset: {
            mode: form.dailyReset.mode,
            cronExpression:
              form.dailyReset.mode === 'AUTOMATIC_CRON' ? form.dailyReset.cronExpression : null,
            resetTicketNumberTo: form.dailyReset.resetTicketNumberTo,
            archivePreviousDayData: form.dailyReset.archivePreviousDayData,
            timezone: form.dailyReset.timezone,
          },
          // Preserve `id` on existing categories; omit it for rows the manager
          // added (the backend mints fresh ids). Mirrors AdminPanel.
          categories: form.categories.map((c) =>
            c.id ? { id: c.id, code: c.code, name: c.name } : { code: c.code, name: c.name },
          ),
          // Strip the client-only `rowKey` (a React key) at the boundary.
          routingRules: form.routingRules.map(({ rowKey, ...rest }) => rest),
        });
      } catch (err) {
        // The `Gagal menyimpan: ` prefix is load-bearing — existing assertions
        // match a backend validation message inside it.
        toast.error(`Gagal menyimpan: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      toast.success('Konfigurasi Printer disimpan.');
      // Re-read the shared snapshot so every consumer (the kiosk on its next
      // boot, the app chrome) sees the new printer configuration.
      await refresh();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (draft === null || config === null) {
    return (
      <div className="page printer-config-page printer-config-page--loading">
        <p className="printer-config-page__loading">Memuat konfigurasi printer…</p>
      </div>
    );
  }

  const isNetwork = draft.mode === 'network-escpos';
  const isUsb = draft.mode === 'usb-serial';
  // Both network-escpos and usb-serial send ESC/POS bytes (over TCP vs. Web
  // Serial), so the cut command applies to either; chrome prints HTML and the
  // operator tears the paper (no cut command).
  const isEscpos = isNetwork || isUsb;
  const hostError = errors.find((e) => e.includes('Host'));
  const portError = errors.find((e) => e.includes('Port'));
  const baudError = errors.find((e) => e.includes('Baud'));

  return (
    <div className="page printer-config-page">
      <PageHeader
        title="Konfigurasi Printer"
        subtitle="Pilih printer untuk cetak tiket di kiosk. Perubahan diterapkan saat kiosk dimuat ulang."
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={save}
            disabled={saving || !valid}
            data-testid="printer-save"
          >
            {saving ? 'Menyimpan…' : 'Simpan'}
          </button>
        }
      />

      {/* Mode selection — ARIA-state-as-selector radio (mirrors the wizard's
          categoriesMode radio: the `checked` state is the visual selector). */}
      <section className="config-card" data-testid="printer-mode-section">
        <h2 className="config-card__title">Mode Printer</h2>
        <fieldset className="radio-group" data-testid="printer-mode">
          <legend className="sr-only">Mode printer</legend>
          {PRINTER_MODES.map((mode) => (
            <label className="radio-group__item" key={mode}>
              <input
                type="radio"
                name="printer-mode"
                value={mode}
                checked={draft.mode === mode}
                onChange={() => setDraft({ ...draft, mode })}
                data-testid={`printer-mode--${mode}`}
              />
              {PRINTER_MODE_LABELS[mode]}
            </label>
          ))}
        </fieldset>
        {draft.mode === 'chrome' && (
          <p className="admin-panel__hint">
            Tiket dicetak melalui dialog cetak browser. Pastikan printer thermal sudah dipasang di
            pengaturan Chrome kiosk.
          </p>
        )}
        {draft.mode === 'network-escpos' && (
          <p className="admin-panel__hint">
            Tiket dikirim langsung ke printer thermal melalui jaringan lokal (ESC/POS atas TCP).
            core-api memproksi pencetakan agar kiosk tidak membuka soket sendiri.
          </p>
        )}
        {draft.mode === 'usb-serial' && (
          <p className="admin-panel__hint">
            Tiket dikirim langsung ke printer thermal USB yang dicolokkan ke perangkat kiosk (ESC/POS
            atas Web Serial). Sambungkan printer di perangkat kiosk melalui halaman pemasangan —
            core-api tidak memproksi USB.
          </p>
        )}
      </section>

      {/* Paper width — applies to BOTH modes (chrome @page size, ESC/POS cols). */}
      <section className="config-card" data-testid="printer-paper-section">
        <h2 className="config-card__title">Lebar Kertas</h2>
        <fieldset className="radio-group" data-testid="printer-paper-width">
          <legend className="sr-only">Lebar kertas</legend>
          {PRINTER_PAPER_WIDTHS.map((width) => (
            <label className="radio-group__item" key={width}>
              <input
                type="radio"
                name="printer-paper-width"
                value={width}
                checked={draft.paperWidth === width}
                onChange={() => setDraft({ ...draft, paperWidth: width as PrinterPaperWidth })}
                data-testid={`printer-paper-width--${width}`}
              />
              {PRINTER_PAPER_WIDTH_LABELS[width]}
            </label>
          ))}
        </fieldset>
      </section>

      {/* Network ESC/POS settings — only when mode is network-escpos (real
          conditional render so the fields are absent, not just hidden, for
          chrome — AT never reaches an irrelevant field). */}
      {isNetwork && (
        <section className="config-card" data-testid="printer-network-section">
          <h2 className="config-card__title">Pengaturan Jaringan ESC/POS</h2>
          <div className="printer-config-page__network" role="group" aria-label="Pengaturan jaringan ESC/POS">
            <label className="field" htmlFor="printer-host">
              <span className="field__label">
                Host printer<span aria-hidden="true"> *</span>
              </span>
              <input
                id="printer-host"
                className="field__input"
                type="text"
                value={draft.host}
                onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                placeholder="192.168.1.50"
                required
                aria-required="true"
                autoComplete="off"
                spellCheck={false}
                data-testid="printer-host"
                {...describedBy('printer-host-error', hostError !== undefined)}
              />
              {hostError !== undefined && (
                <span className="field__error" id="printer-host-error" data-testid="printer-host-error">
                  {hostError}
                </span>
              )}
            </label>

            <label className="field" htmlFor="printer-port">
              <span className="field__label">Port</span>
              <input
                id="printer-port"
                className="field__input"
                type="number"
                min={1}
                max={65535}
                step={1}
                value={draft.port}
                onChange={(e) => {
                  const raw = e.target.value === '' ? DEFAULT_PRINTER_PORT : Number(e.target.value);
                  setDraft({ ...draft, port: Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_PRINTER_PORT });
                }}
                placeholder={String(DEFAULT_PRINTER_PORT)}
                inputMode="numeric"
                data-testid="printer-port"
                {...describedBy('printer-port-error', portError !== undefined)}
              />
              {portError !== undefined && (
                <span className="field__error" id="printer-port-error" data-testid="printer-port-error">
                  {portError}
                </span>
              )}
            </label>
          </div>

          <p className="admin-panel__warning" data-testid="printer-network-note">
            Pastikan printer thermal berada di jaringan lokal yang sama dengan server. core-api
            memproksi pencetakan atas TCP — kiosk tidak perlu mengakses printer secara langsung.
          </p>
        </section>
      )}

      {/* Cut mode — applies to every ESC/POS mode (network-escpos over TCP and
          usb-serial over Web Serial both send the cut command). Chrome prints
          HTML and the operator tears the paper, so the cut radios are absent
          for chrome (real conditional render — AT never reaches an irrelevant
          field). Kept as its own section so it is not duplicated per transport. */}
      {isEscpos && (
        <section className="config-card" data-testid="printer-cut-section">
          <h2 className="config-card__title">Mode Gunting</h2>
          <fieldset className="radio-group" data-testid="printer-cut-mode">
            <legend className="sr-only">Mode gunting</legend>
            {PRINTER_CUT_MODES.map((cut) => (
              <label className="radio-group__item" key={cut}>
                <input
                  type="radio"
                  name="printer-cut-mode"
                  value={cut}
                  checked={draft.cutMode === cut}
                  onChange={() => setDraft({ ...draft, cutMode: cut as PrinterCutMode })}
                  data-testid={`printer-cut-mode--${cut}`}
                />
                {PRINTER_CUT_MODE_LABELS[cut]}
              </label>
            ))}
          </fieldset>
        </section>
      )}

      {/* USB Serial settings — only when mode is usb-serial (the printer is
          cabled to the kiosk box; the kiosk pairs it once on-device via a setup
          overlay — the admin only sets the serial speed here). */}
      {isUsb && (
        <section className="config-card" data-testid="printer-usb-section">
          <h2 className="config-card__title">Pengaturan USB Serial</h2>
          <div className="printer-config-page__network" role="group" aria-label="Pengaturan USB serial">
            <label className="field" htmlFor="printer-baud-rate">
              <span className="field__label">Baud rate</span>
              <select
                id="printer-baud-rate"
                className="field__input"
                value={draft.baudRate}
                onChange={(e) => setDraft({ ...draft, baudRate: Number(e.target.value) })}
                data-testid="printer-baud-rate"
                {...describedBy('printer-baud-rate-error', baudError !== undefined)}
              >
                {PRINTER_BAUD_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}
                  </option>
                ))}
              </select>
              {baudError !== undefined && (
                <span className="field__error" id="printer-baud-rate-error" data-testid="printer-baud-rate-error">
                  {baudError}
                </span>
              )}
            </label>
          </div>
          <p className="admin-panel__warning" data-testid="printer-usb-note">
            Printer USB dicolokkan langsung ke perangkat kiosk. Sambungkan printer di kiosk melalui
            halaman pemasangan — core-api tidak memproksi pencetakan USB.
          </p>
        </section>
      )}

      {errors.length > 0 && (
        <ul className="wizard__errors" data-testid="printer-errors">
          {errors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
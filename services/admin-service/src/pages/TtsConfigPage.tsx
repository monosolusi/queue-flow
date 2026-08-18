import { useEffect, useMemo, useRef, useState } from 'react';
import type { IAdminApi } from '../api/admin-api';
import {
  MAX_TTS_PAUSE_MS,
  MAX_TTS_SPEED,
  MAX_TTS_VOLUME,
  MIN_TTS_PAUSE_MS,
  MIN_TTS_SPEED,
  MIN_TTS_VOLUME,
  TTS_PAUSE_STEP_MS,
  TTS_SPEED_STEP,
  TTS_VOLUME_STEP,
  coerceTtsConfiguration,
  ttsPreviewUrl,
  validateTtsConfiguration,
} from '../lib/tts';
import type { TtsConfigurationDto } from '../api/types';
import { DEFAULT_TTS_CONFIGURATION } from '../api/types';
import { useSystemConfigContext } from '../config/system-config-context';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../toast/useToast';
import { toForm } from './admin-config/form';
import {
  toEdgeRoutingLayoutDto,
  toEndSourcesDto,
  toNodeActionsDto,
  toNodePositionsDto,
  toStartSourcesDto,
  toStateMachineDto,
  toTerminalNodesDto,
} from '../lib/state-machine';

/**
 * AC6 — wire a field error message to its input via `aria-describedby` +
 * `aria-invalid`. Duplicated from `PrinterConfigPage` / WizardPage / AdminPanel
 * rather than shared: the repo has no shared UI lib and the error shapes are
 * heterogeneous (mirrors the `theme.ts` duplication precedent).
 */
function describedBy(
  errorId: string,
  hasError: boolean,
): { 'aria-describedby': string; 'aria-invalid': boolean } | Record<string, never> {
  return hasError ? { 'aria-describedby': errorId, 'aria-invalid': true } : {};
}

/** `1.05` rather than `1.0500000000000003` — a range input's float arithmetic
 *  is not something the manager should have to read. */
function formatMultiplier(value: number): string {
  return value.toFixed(2);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * The announcement-delivery page — a standalone `/tts-config` route (sibling to
 * `/printer-config` and `/tv-layout`) where the manager tunes how the TV board
 * reads a called ticket out loud.
 *
 * Manager feedback: the announcement runs together, and the numbers — the only
 * part a visitor actually has to catch — go by too fast to register. So there
 * are two knobs that matter and one that is merely useful:
 *
 *  - **Kecepatan** — a speaking-rate multiplier. `tts-service` maps it onto the
 *    voice's own length scale, so it changes the pace without changing pitch.
 *  - **Jeda** — silence inserted at each seam in the sentence. The seams sit in
 *    front of each number ("nomor antrian" ⏸ "a lima" ⏸ "silakan ke loket" ⏸
 *    "dua"), which is exactly where a listener needs a beat. `0` reads the line
 *    as one continuous utterance — what the board did before this page existed,
 *    and therefore the default.
 *  - **Volume** — a playback multiplier, for a hall that is louder or quieter
 *    than the one the voice was recorded in.
 *
 * Where the words come from is NOT configurable here, on purpose: the Indonesian
 * phrasing lives in `tts-service` and nowhere else, which is why "Tes Suara"
 * asks that service for a sample rather than sending it a sentence to read.
 *
 * The page is a thin editor over the shared config save surface (mirrors
 * `/printer-config`): it reads the full config from the shared provider, edits
 * one field, and PUTs the whole payload back with every other field passed
 * through unchanged.
 */
export function TtsConfigPage({ api }: { api: IAdminApi }) {
  const toast = useToast();
  const { config, refresh } = useSystemConfigContext();
  // The local delivery draft — initialized from the resolved config (coerced, so
  // a corrupt GET projection never breaks the editor). `config` is `null` until
  // the shared probe resolves; the page renders a loading state until then.
  const [draft, setDraft] = useState<TtsConfigurationDto | null>(null);
  const [saving, setSaving] = useState(false);
  // Synchronous in-flight guard — `disabled` only takes effect after a
  // re-render, so two clicks in the same tick both pass a state guard (mirrors
  // PrinterConfigPage / TvLayoutPage).
  const savingRef = useRef(false);
  // The audition clip. Held so a second "Tes Suara" can stop the first: two
  // announcements talking over each other is worse than no preview at all, and
  // is exactly what a manager dragging a slider would otherwise produce.
  //
  // Replacing rather than blocking is deliberate. Tuning by ear means drag,
  // listen, drag, listen -- and the moment the manager has heard enough of a
  // clip is the moment they want the next one, so a button that locks for the
  // length of the announcement would be fighting the task. The label still
  // changes, so "is it playing?" stays answerable.
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (config === null) return;
    setDraft(coerceTtsConfiguration(config.ttsConfiguration));
  }, [config]);

  // Stop any in-flight audition when the page goes away, or the clip keeps
  // playing over whatever the manager navigated to.
  useEffect(() => {
    return () => {
      previewRef.current?.pause();
      previewRef.current = null;
    };
  }, []);

  // The full editable form is rebuilt from the config so every passthrough field
  // maps exactly as AdminPanel does — no duplicated mapping logic.
  const form = useMemo(() => (config !== null ? toForm(config) : null), [config]);

  const errors = draft !== null ? validateTtsConfiguration(draft) : [];
  const valid = draft !== null && errors.length === 0;

  function playPreview() {
    if (draft === null || !valid) return;
    previewRef.current?.pause();
    const audio = new Audio(ttsPreviewUrl(draft));
    previewRef.current = audio;
    setPreviewing(true);
    const done = () => {
      // Only clear the flag if THIS clip is still the current one. A replay
      // pauses the previous clip, and a paused clip can still settle afterwards
      // — without this check its `ended` would report "not playing" while the
      // clip that replaced it is mid-announcement.
      if (previewRef.current === audio) {
        previewRef.current = null;
        setPreviewing(false);
      }
    };
    audio.addEventListener('ended', done);
    audio.addEventListener('error', () => {
      done();
      toast.error('Gagal memutar contoh suara. Pastikan layanan suara berjalan.');
    });
    void audio.play().catch(() => {
      // A browser that refuses autoplay rejects here and fires neither `ended`
      // nor `error`, so without this the label would stay stuck on "Memutar…"
      // forever (the same failure mode the TV board's audio provider guards).
      done();
      toast.error('Browser memblokir pemutaran suara. Klik sekali di halaman ini lalu coba lagi.');
    });
  }

  function reset() {
    setDraft({ ...DEFAULT_TTS_CONFIGURATION });
  }

  async function save() {
    if (savingRef.current) return;
    if (draft === null || !valid || form === null) return;
    savingRef.current = true;
    setSaving(true);
    try {
      try {
        await api.saveSystemConfig({
          storeName: form.storeName,
          // Every field below is payload-only passthrough — this page edits one
          // field, but the PUT is a FULL save, so anything not sent would be
          // reset to its default.
          stateMachine: toStateMachineDto(form.stateMachine),
          edgeRoutingLayout: toEdgeRoutingLayoutDto(form.stateMachine),
          nodePositions: toNodePositionsDto(form.stateMachine),
          nodeActions: toNodeActionsDto(form.stateMachine),
          terminalNodes: toTerminalNodesDto(form.stateMachine),
          endSources: toEndSourcesDto(form.stateMachine),
          startSources: toStartSourcesDto(form.stateMachine),
          brandColor: form.brandColor,
          serviceThemes: form.serviceThemes,
          tvPanelLayout: form.tvPanelLayout,
          printerConfiguration: form.printerConfiguration,
          // The one field this page edits.
          ttsConfiguration: draft,
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
      toast.success('Konfigurasi Suara disimpan.');
      await refresh();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (draft === null || config === null) {
    return (
      <div className="page tts-config-page tts-config-page--loading">
        <p className="tts-config-page__loading">Memuat konfigurasi suara…</p>
      </div>
    );
  }

  const speedError = errors.find((e) => e.includes('Kecepatan'));
  const volumeError = errors.find((e) => e.includes('Volume'));
  const pauseError = errors.find((e) => e.includes('Jeda'));

  return (
    <div className="page tts-config-page">
      <PageHeader
        title="Suara Pengumuman"
        subtitle="Atur kecepatan dan jeda saat papan TV membacakan nomor antrian. Perubahan berlaku dalam waktu 30 detik."
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={save}
            disabled={saving || !valid}
            data-testid="tts-save"
          >
            {saving ? 'Menyimpan…' : 'Simpan'}
          </button>
        }
      />

      <section className="config-card" data-testid="tts-delivery-section">
        <h2 className="config-card__title">Cara Membaca</h2>

        <label className="field" htmlFor="tts-speed">
          <span className="field__label">Kecepatan bicara</span>
          <div className="tts-config-page__slider">
            <input
              id="tts-speed"
              className="field__range"
              type="range"
              min={MIN_TTS_SPEED}
              max={MAX_TTS_SPEED}
              step={TTS_SPEED_STEP}
              value={draft.speed}
              onChange={(e) => setDraft({ ...draft, speed: Number(e.target.value) })}
              aria-valuetext={`${formatMultiplier(draft.speed)} kali kecepatan normal`}
              data-testid="tts-speed"
              {...describedBy('tts-speed-error', speedError !== undefined)}
            />
            <output className="tts-config-page__readout" htmlFor="tts-speed" data-testid="tts-speed-value">
              {formatMultiplier(draft.speed)}×
            </output>
          </div>
          <span className="field__hint">
            1,00× adalah kecepatan asli suara. Lebih kecil = lebih lambat.
          </span>
          {speedError !== undefined && (
            <span className="field__error" id="tts-speed-error" data-testid="tts-speed-error">
              {speedError}
            </span>
          )}
        </label>

        <label className="field" htmlFor="tts-pause">
          <span className="field__label">Jeda antar bagian (milidetik)</span>
          <input
            id="tts-pause"
            className="field__input"
            type="number"
            min={MIN_TTS_PAUSE_MS}
            max={MAX_TTS_PAUSE_MS}
            step={TTS_PAUSE_STEP_MS}
            value={draft.pauseMs}
            onChange={(e) => {
              // An empty input must not become NaN — the manager is mid-typing,
              // not asking for an invalid pause.
              const raw = e.target.value === '' ? MIN_TTS_PAUSE_MS : Number(e.target.value);
              setDraft({
                ...draft,
                pauseMs: Number.isFinite(raw) ? Math.trunc(raw) : MIN_TTS_PAUSE_MS,
              });
            }}
            inputMode="numeric"
            data-testid="tts-pause"
            {...describedBy('tts-pause-error', pauseError !== undefined)}
          />
          <span className="field__hint">
            Jeda disisipkan tepat sebelum tiap angka: “nomor antrian … A-001 … silakan ke loket …
            1”. Isi 0 untuk membaca menyatu tanpa jeda (seperti sebelumnya).
          </span>
          {pauseError !== undefined && (
            <span className="field__error" id="tts-pause-error" data-testid="tts-pause-error">
              {pauseError}
            </span>
          )}
        </label>
      </section>

      <section className="config-card" data-testid="tts-volume-section">
        <h2 className="config-card__title">Volume</h2>
        <label className="field" htmlFor="tts-volume">
          <span className="field__label">Volume pengumuman</span>
          <div className="tts-config-page__slider">
            <input
              id="tts-volume"
              className="field__range"
              type="range"
              min={MIN_TTS_VOLUME}
              max={MAX_TTS_VOLUME}
              step={TTS_VOLUME_STEP}
              value={draft.volume}
              onChange={(e) => setDraft({ ...draft, volume: Number(e.target.value) })}
              aria-valuetext={`${formatPercent(draft.volume)} dari volume normal`}
              data-testid="tts-volume"
              {...describedBy('tts-volume-error', volumeError !== undefined)}
            />
            <output className="tts-config-page__readout" htmlFor="tts-volume" data-testid="tts-volume-value">
              {formatPercent(draft.volume)}
            </output>
          </div>
          {volumeError !== undefined && (
            <span className="field__error" id="tts-volume-error" data-testid="tts-volume-error">
              {volumeError}
            </span>
          )}
        </label>
        {draft.volume === 0 && (
          <p className="admin-panel__warning" data-testid="tts-muted-warning">
            Volume 0% membuat papan TV membisu — pengunjung hanya melihat nomor, tidak mendengarnya.
          </p>
        )}
      </section>

      <section className="config-card" data-testid="tts-preview-section">
        <h2 className="config-card__title">Tes Suara</h2>
        <p className="admin-panel__hint">
          Dengarkan contoh pengumuman dengan pengaturan di atas sebelum menyimpannya.
        </p>
        <div className="tts-config-page__actions">
          <button
            type="button"
            className="btn"
            onClick={playPreview}
            disabled={!valid}
            data-testid="tts-preview"
          >
            {previewing ? 'Memutar…' : 'Putar Contoh'}
          </button>
          <button type="button" className="btn" onClick={reset} data-testid="tts-reset">
            Kembalikan ke Bawaan
          </button>
        </div>
      </section>

      {errors.length > 0 && (
        <ul className="wizard__errors" data-testid="tts-errors">
          {errors.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

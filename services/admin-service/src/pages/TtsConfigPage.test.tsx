import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TtsConfigPage } from './TtsConfigPage';
import { SystemConfigProvider } from '../config/system-config-context';
import { ToastProvider } from '../toast/toast-context';
import type { IAdminApi, ISystemConfigApi } from '../api/admin-api';
import {
  DEFAULT_BRAND_COLOR,
  DEFAULT_PRINTER_CONFIGURATION,
  DEFAULT_SERVICE_THEMES,
  DEFAULT_STATE_MACHINE,
  DEFAULT_TTS_CONFIGURATION,
  DEFAULT_TV_GRID_LAYOUT,
  type SaveSystemConfigurationPayload,
  type SaveSystemConfigurationResult,
  type SystemConfigurationDto,
} from '../api/types';

/**
 * A configured store. Mirrors the PrinterConfigPage / TvLayoutPage fixtures so
 * the full-payload passthrough on save maps cleanly (categories with ids,
 * routing id→code).
 */
function configuredStore(
  overrides: Partial<SystemConfigurationDto> = {},
): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: true,
    storeName: 'Apotek Sehat',
    stateMachine: DEFAULT_STATE_MACHINE,
    dailyResetPolicy: {
      mode: 'AUTOMATIC_CRON',
      cronExpression: '0 0 * * *',
      resetTicketNumberTo: 1,
      archivePreviousDayData: true,
      timezone: 'Asia/Jakarta',
    },
    categories: [
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Farmasi' },
    ],
    routingRules: [
      { counterId: 1, counterName: 'Counter 1', assignedCategoryIds: ['cat-a'], priorityPolicy: 'FIFO_GLOBAL' },
    ],
    brandColor: DEFAULT_BRAND_COLOR,
    serviceThemes: { ...DEFAULT_SERVICE_THEMES },
    tvPanelLayout: DEFAULT_TV_GRID_LAYOUT.map((w) => ({ ...w })),
    edgeRoutingLayout: {},
    nodePositions: {}, nodeActions: {}, endSources: [], startSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
    printerConfiguration: { ...DEFAULT_PRINTER_CONFIGURATION },
    ttsConfiguration: { ...DEFAULT_TTS_CONFIGURATION },
    ...overrides,
  };
}

function makeApi(
  config: SystemConfigurationDto = configuredStore(),
  saveImpl?: (payload: SaveSystemConfigurationPayload) => Promise<SaveSystemConfigurationResult>,
) {
  const save = vi.fn(
    saveImpl ??
      ((payload: SaveSystemConfigurationPayload) =>
        Promise.resolve({
          isInitialSetupCompleted: true,
          storeName: payload.storeName,
          brandColor: payload.brandColor,
          serviceThemes: payload.serviceThemes,
          tvPanelLayout: payload.tvPanelLayout,
          edgeRoutingLayout: {},
          nodePositions: {}, nodeActions: {}, endSources: [], startSources: [], terminalNodes: { start: 'auto', end: 'auto' } as const,
          printerConfiguration: payload.printerConfiguration, ttsConfiguration: payload.ttsConfiguration,
        })),
  );
  const getConfig = vi.fn(() => Promise.resolve(config));
  const api: IAdminApi = {
    getSystemConfig: getConfig,
    saveSystemConfig: save,
    getActiveStateMachine: vi.fn(() => Promise.resolve(config.stateMachine)),
    getDailyReport: vi.fn(),
    getCounterPerformance: vi.fn(),
    getRangeReport: vi.fn(),
    getQueueBoard: vi.fn(),
    getCounters: vi.fn(),
    getAuditLog: vi.fn(),
    triggerManualReset: vi.fn(),
    cleanupTransactionLogs: vi.fn(),
  };
  const providerApi: ISystemConfigApi = { getSystemConfig: getConfig };
  return { api, save, getConfig, providerApi };
}

function renderPage(api: IAdminApi, providerApi: ISystemConfigApi) {
  return render(
    <MemoryRouter initialEntries={['/tts-config']}>
      <SystemConfigProvider api={providerApi}>
        <ToastProvider>
          <TtsConfigPage api={api} />
        </ToastProvider>
      </SystemConfigProvider>
    </MemoryRouter>,
  );
}

/**
 * jsdom implements neither `Audio` nor `HTMLMediaElement.play`, so "Tes Suara"
 * needs a stub. Recording the constructed src is also how the override→URL
 * wiring is asserted without a network.
 */
function stubAudio() {
  const created: { src: string; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }[] = [];
  class FakeAudio {
    src: string;
    play = vi.fn(() => Promise.resolve());
    pause = vi.fn();
    private listeners: Record<string, (() => void)[]> = {};
    constructor(src: string) {
      this.src = src;
      created.push(this as unknown as (typeof created)[number]);
    }
    addEventListener(event: string, handler: () => void) {
      (this.listeners[event] ??= []).push(handler);
    }
    emit(event: string) {
      for (const handler of this.listeners[event] ?? []) handler();
    }
  }
  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
  return { created: created as unknown as (FakeAudio & { emit: (e: string) => void })[] };
}

describe('TtsConfigPage', () => {
  beforeEach(() => {
    stubAudio();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prefills the stored delivery into the controls', async () => {
    const { api, providerApi } = makeApi(
      configuredStore({ ttsConfiguration: { speed: 0.9, volume: 1.2, pauseMs: 400 } }),
    );
    renderPage(api, providerApi);

    const speed = (await screen.findByTestId('tts-speed')) as HTMLInputElement;
    expect(speed.value).toBe('0.9');
    expect((screen.getByTestId('tts-pause') as HTMLInputElement).value).toBe('400');
    expect((screen.getByTestId('tts-volume') as HTMLInputElement).value).toBe('1.2');
    expect(screen.getByTestId('tts-speed-value').textContent).toBe('0.90×');
    expect(screen.getByTestId('tts-volume-value').textContent).toBe('120%');
  });

  it('save sends the edited delivery plus passthrough of every other field', async () => {
    const { api, save, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tts-speed');

    fireEvent.change(screen.getByTestId('tts-speed'), { target: { value: '0.85' } });
    fireEvent.change(screen.getByTestId('tts-pause'), { target: { value: '400' } });
    fireEvent.click(screen.getByTestId('tts-save'));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = save.mock.calls[0][0] as SaveSystemConfigurationPayload;
    expect(payload.ttsConfiguration).toEqual({ speed: 0.85, volume: 1, pauseMs: 400 });
    // The PUT is a FULL save: a field this page does not edit but also does not
    // send would be silently reset to its default on the server.
    expect(payload.storeName).toBe('Apotek Sehat');
    expect(payload.brandColor).toBe(DEFAULT_BRAND_COLOR);
    expect(payload.serviceThemes).toEqual({ ...DEFAULT_SERVICE_THEMES });
    expect(payload.tvPanelLayout).toEqual(DEFAULT_TV_GRID_LAYOUT.map((w) => ({ ...w })));
    expect(payload.printerConfiguration).toEqual({ ...DEFAULT_PRINTER_CONFIGURATION });
    expect(payload.categories).toEqual([
      { id: 'cat-a', code: 'A', name: 'Customer Service' },
      { id: 'cat-b', code: 'B', name: 'Farmasi' },
    ]);
    expect(payload.routingRules).toEqual([
      { counterId: 1, counterName: 'Counter 1', assignedCategoryCodes: ['A'], priorityPolicy: 'FIFO_GLOBAL' },
    ]);
    expect(screen.getByText('Konfigurasi Suara disimpan.')).toBeTruthy();
  });

  it('surfaces a backend rejection with the load-bearing error prefix', async () => {
    const { api, providerApi } = makeApi(configuredStore(), () =>
      Promise.reject(new Error('tts configuration.speed must be a number 0.5..2')),
    );
    renderPage(api, providerApi);
    await screen.findByTestId('tts-speed');

    fireEvent.click(screen.getByTestId('tts-save'));

    expect(
      await screen.findByText(/Gagal menyimpan: tts configuration.speed must be a number/),
    ).toBeTruthy();
  });

  it('blocks save on an out-of-range pause, then re-enables once corrected', async () => {
    const { api, save, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tts-pause');

    fireEvent.change(screen.getByTestId('tts-pause'), { target: { value: '9999' } });
    expect((screen.getByTestId('tts-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('tts-pause-error')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tts-save'));
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('tts-pause'), { target: { value: '500' } });
    expect((screen.getByTestId('tts-save') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('tts-pause-error')).toBeNull();
  });

  it('coerces a corrupt GET projection to the default (defense-in-depth)', async () => {
    const { api, providerApi } = makeApi(
      configuredStore({
        ttsConfiguration: { speed: 99, volume: -1, pauseMs: 12.5 } as SystemConfigurationDto['ttsConfiguration'],
      }),
    );
    renderPage(api, providerApi);

    const speed = (await screen.findByTestId('tts-speed')) as HTMLInputElement;
    expect(speed.value).toBe('1');
    expect((screen.getByTestId('tts-volume') as HTMLInputElement).value).toBe('1');
    expect((screen.getByTestId('tts-pause') as HTMLInputElement).value).toBe('0');
  });

  it('warns when the volume is set to zero (a silent board looks broken)', async () => {
    const { api, providerApi } = makeApi();
    renderPage(api, providerApi);
    await screen.findByTestId('tts-volume');

    expect(screen.queryByTestId('tts-muted-warning')).toBeNull();
    fireEvent.change(screen.getByTestId('tts-volume'), { target: { value: '0' } });
    expect(screen.getByTestId('tts-muted-warning')).toBeTruthy();
  });

  it('"Kembalikan ke Bawaan" restores the zero-behavior-change delivery', async () => {
    const { api, providerApi } = makeApi(
      configuredStore({ ttsConfiguration: { speed: 0.6, volume: 1.8, pauseMs: 900 } }),
    );
    renderPage(api, providerApi);
    await screen.findByTestId('tts-reset');

    fireEvent.click(screen.getByTestId('tts-reset'));

    expect((screen.getByTestId('tts-speed') as HTMLInputElement).value).toBe('1');
    expect((screen.getByTestId('tts-volume') as HTMLInputElement).value).toBe('1');
    expect((screen.getByTestId('tts-pause') as HTMLInputElement).value).toBe('0');
  });

  describe('Tes Suara', () => {
    it('auditions the DRAFT values, not the saved ones', async () => {
      // The whole point: a setting whose only acceptance test is "does it sound
      // right" must be audible before it is committed.
      const { api, save, providerApi } = makeApi();
      const audio = stubAudio();
      renderPage(api, providerApi);
      await screen.findByTestId('tts-speed');

      fireEvent.change(screen.getByTestId('tts-speed'), { target: { value: '0.75' } });
      fireEvent.change(screen.getByTestId('tts-pause'), { target: { value: '350' } });
      fireEvent.click(screen.getByTestId('tts-preview'));

      expect(audio.created).toHaveLength(1);
      const url = new URL(audio.created[0].src, 'http://localhost');
      expect(url.pathname).toBe('/tts/preview');
      expect(url.searchParams.get('speed')).toBe('0.75');
      expect(url.searchParams.get('pauseMs')).toBe('350');
      expect(url.searchParams.get('volume')).toBe('1');
      // Auditioning must not write anything.
      expect(save).not.toHaveBeenCalled();
    });

    it('sends no text, so the admin panel holds no Indonesian queue phrasing', async () => {
      const { api, providerApi } = makeApi();
      const audio = stubAudio();
      renderPage(api, providerApi);
      await screen.findByTestId('tts-preview');

      fireEvent.click(screen.getByTestId('tts-preview'));

      const url = new URL(audio.created[0].src, 'http://localhost');
      expect(url.searchParams.has('text')).toBe(false);
    });

    it('stops the previous clip so two auditions never overlap', async () => {
      const { api, providerApi } = makeApi();
      const audio = stubAudio();
      renderPage(api, providerApi);
      await screen.findByTestId('tts-preview');

      // No `ended` in between: replaying mid-clip is exactly what tuning by ear
      // looks like, and it is the case where two clips could talk over one
      // another.
      fireEvent.click(screen.getByTestId('tts-preview'));
      fireEvent.click(screen.getByTestId('tts-preview'));

      expect(audio.created).toHaveLength(2);
      expect(audio.created[0].pause).toHaveBeenCalled();
    });

    it('shows the clip is playing, and stops showing it when the clip ends', async () => {
      const { api, providerApi } = makeApi();
      const audio = stubAudio();
      renderPage(api, providerApi);
      await screen.findByTestId('tts-preview');

      fireEvent.click(screen.getByTestId('tts-preview'));
      expect(screen.getByTestId('tts-preview').textContent).toBe('Memutar…');

      audio.created[0].emit('ended');
      await waitFor(() =>
        expect(screen.getByTestId('tts-preview').textContent).toBe('Putar Contoh'),
      );
    });

    it('clears the playing state when the browser refuses to autoplay', async () => {
      // A refused `play()` rejects and fires NEITHER `ended` nor `error`, so
      // without the catch the button would stay stuck on "Memutar…" forever —
      // the same failure mode that once muted the TV board permanently.
      const { api, providerApi } = makeApi();
      const created: { play: ReturnType<typeof vi.fn> }[] = [];
      class RefusingAudio {
        play = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
        pause = vi.fn();
        constructor(public src: string) {
          created.push(this);
        }
        addEventListener() {}
      }
      vi.stubGlobal('Audio', RefusingAudio as unknown as typeof Audio);
      renderPage(api, providerApi);
      await screen.findByTestId('tts-preview');

      fireEvent.click(screen.getByTestId('tts-preview'));

      await waitFor(() =>
        expect(screen.getByTestId('tts-preview').textContent).toBe('Putar Contoh'),
      );
      expect(await screen.findByText(/Browser memblokir pemutaran suara/)).toBeTruthy();
    });
  });
});

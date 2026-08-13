import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SystemConfigProvider, useSystemConfigContext } from './system-config-context';
import type { ISystemConfigApi } from '../api/admin-api';
import type { SystemConfigurationDto } from '../api/types';
import { DEFAULT_SERVICE_THEMES, DEFAULT_TV_GRID_LAYOUT } from '../api/types';

function storeNamed(storeName: string): SystemConfigurationDto {
  return {
    isInitialSetupCompleted: true,
    storeName,
    stateMachine: { states: [], transitions: [] },
    dailyResetPolicy: { mode: 'MANUAL', cronExpression: null, resetTicketNumberTo: 1, archivePreviousDayData: true, timezone: 'Asia/Jakarta' },
    categories: [],
    routingRules: [],
    brandColor: '#2563eb',
    serviceThemes: { ...DEFAULT_SERVICE_THEMES },
    tvPanelLayout: DEFAULT_TV_GRID_LAYOUT,
    edgeRoutingLayout: {},
  };
}

/** A consumer that projects the whole context state into the DOM. */
function Probe({ label = 'a' }: { label?: string }) {
  const { config, loading, error, refresh } = useSystemConfigContext();
  return (
    <div>
      <span data-testid={`store-${label}`}>{config ? config.storeName : '—'}</span>
      <span data-testid={`loading-${label}`}>{String(loading)}</span>
      <span data-testid={`error-${label}`}>{String(error)}</span>
      <button type="button" onClick={() => void refresh()} data-testid={`refresh-${label}`}>
        refresh
      </button>
    </div>
  );
}

function renderProvider(api: ISystemConfigApi, children = <Probe />) {
  return render(<SystemConfigProvider api={api}>{children}</SystemConfigProvider>);
}

describe('SystemConfigProvider', () => {
  it('probes GET /api/system/config once and shares one snapshot with every consumer', async () => {
    const api: ISystemConfigApi = { getSystemConfig: vi.fn(() => Promise.resolve(storeNamed('Apotek Sehat'))) };
    renderProvider(
      api,
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );

    expect(await screen.findAllByText('Apotek Sehat')).toHaveLength(2);
    // Both consumers read the SAME resolved snapshot from ONE probe — the whole
    // point of the provider (four independent fetches previously produced four
    // divergent copies, so a post-setup save left some consumers stale).
    expect(screen.getByTestId('store-a')).toHaveTextContent('Apotek Sehat');
    expect(screen.getByTestId('store-b')).toHaveTextContent('Apotek Sehat');
    expect(api.getSystemConfig).toHaveBeenCalledTimes(1);
  });

  it('flags an error on a rejected probe and recovers on refresh', async () => {
    let calls = 0;
    const api: ISystemConfigApi = {
      getSystemConfig: vi.fn(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve(storeNamed('Apotek Sehat'));
      }),
    };
    renderProvider(api);

    expect(await screen.findByText('true')).toBeInTheDocument();
    expect(screen.getByTestId('error-a')).toHaveTextContent('true');
    expect(screen.getByTestId('store-a')).toHaveTextContent('—');

    fireEvent.click(screen.getByTestId('refresh-a'));
    expect(await screen.findByText('Apotek Sehat')).toBeInTheDocument();
    expect(screen.getByTestId('error-a')).toHaveTextContent('false');
  });

  it('keeps the resolved config visible while a refresh is in flight (no loading flash)', async () => {
    let resolveSecond: ((c: SystemConfigurationDto) => void) | undefined;
    let calls = 0;
    const api: ISystemConfigApi = {
      getSystemConfig: vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve(storeNamed('Toko Lama'));
        return new Promise<SystemConfigurationDto>((resolve) => {
          resolveSecond = resolve;
        });
      }),
    };
    renderProvider(api);
    expect(await screen.findByText('Toko Lama')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('refresh-a'));
    // Stale-while-revalidate: `loading` flips but the previous config stays put,
    // so the route guards (which branch on `config !== null` first) never flash
    // their loading banner and unmount the page mid-save.
    expect(screen.getByTestId('loading-a')).toHaveTextContent('true');
    expect(screen.getByTestId('store-a')).toHaveTextContent('Toko Lama');

    resolveSecond?.(storeNamed('Toko Baru'));
    expect(await screen.findByText('Toko Baru')).toBeInTheDocument();
  });

  it('drops a superseded in-flight load so a slow first probe cannot clobber a newer one', async () => {
    // The cancellation guard tracks EVERY load, not just the mount probe: a
    // `let cancelled` closure registered as the effect's first cleanup would
    // leave the retry path unprotected (the effect never re-runs), so a slow
    // earlier request could land after — and overwrite — a newer result.
    let resolveFirst: ((c: SystemConfigurationDto) => void) | undefined;
    let calls = 0;
    const api: ISystemConfigApi = {
      getSystemConfig: vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return new Promise<SystemConfigurationDto>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(storeNamed('Toko Baru'));
      }),
    };
    renderProvider(api);
    expect(screen.getByTestId('store-a')).toHaveTextContent('—');

    // Supersede the still-pending mount probe with a second load that resolves first.
    fireEvent.click(screen.getByTestId('refresh-a'));
    expect(await screen.findByText('Toko Baru')).toBeInTheDocument();

    // The stale first probe now lands — and must be discarded. The `act` flush is
    // load-bearing: a React 18 concurrent-root update scheduled from a promise
    // continuation is delivered through the Scheduler's MessageChannel (a
    // MACROtask), so a bare `await Promise.resolve()` (one microtask) returns
    // before the stale re-render could flush — the assertion would then pass
    // whether or not the generation guard exists, i.e. it would detect nothing.
    // `act` drains both queues, so an unguarded stale result really would land
    // here (verified: neutering the generation check in `useSystemConfig` makes
    // this assertion fail on 'Toko Lama').
    await act(async () => {
      resolveFirst?.(storeNamed('Toko Lama'));
    });
    expect(screen.getByTestId('store-a')).toHaveTextContent('Toko Baru');
    expect(screen.getByTestId('loading-a')).toHaveTextContent('false');
  });
});

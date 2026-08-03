import { useEffect, useState } from 'react';
import type { CounterDto } from '../api/types';
import type { ICallerApi } from '../api/caller-api';

export interface CounterSelectPageProps {
  readonly api: ICallerApi;
  readonly onChoose: (counter: CounterDto) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; counters: readonly CounterDto[] }
  | { status: 'error'; message: string };

/**
 * Shown when no counter is bound. Large touch targets; selecting a counter
 * binds it (persisted by the parent hook) — the router then redirects to
 * /workspace. (FR-CLR-01 counter binding.)
 */
export function CounterSelectPage({ api, onChoose }: CounterSelectPageProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .listCounters()
      .then((counters) => {
        if (!cancelled) setState({ status: 'loaded', counters });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : 'Gagal memuat daftar loket' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <main className="counter-select">
      <h1 className="counter-select__title">Pilih Loket</h1>
      {state.status === 'loading' && (
        <div className="counter-select__list" role="status" aria-busy="true" data-testid="counter-select-loading">
          <span className="sr-only">Memuat daftar loket…</span>
          <div className="skeleton skeleton--row" aria-hidden="true" />
          <div className="skeleton skeleton--row" aria-hidden="true" />
          <div className="skeleton skeleton--row" aria-hidden="true" />
        </div>
      )}
      {state.status === 'error' && (
        <p className="counter-select__hint counter-select__hint--error">{state.message}</p>
      )}
      {state.status === 'loaded' && state.counters.length === 0 && (
        <p className="counter-select__hint">Belum ada loket yang dikonfigurasi.</p>
      )}
      {state.status === 'loaded' && state.counters.length > 0 && (
        <ul className="counter-select__list">
          {state.counters.map((c) => (
            <li key={c.counterId}>
              <button type="button" className="counter-card pressable" onClick={() => onChoose(c)}>
                <span className="counter-card__name">{c.counterName}</span>
                <span className="counter-card__categories">
                  {c.assignedCategories.map((cat) => cat.name).join(' · ') || 'Tanpa kategori'}
                </span>
                <span className="counter-card__policy">{policyLabel(c.priorityPolicy)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function policyLabel(policy: CounterDto['priorityPolicy']): string {
  return policy === 'CATEGORY_PRIORITY' ? 'Prioritas Kategori' : 'FIFO Global';
}
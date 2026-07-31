import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type { SystemConfigurationDto } from '../api/types';

type PanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; config: SystemConfigurationDto };

/**
 * Read-only view of the current system configuration (FR-WZD-06 — operational
 * access after setup). The manager can re-open the wizard via the "Ubah
 * Konfigurasi" link. Mutation lives only in the wizard; this panel never writes
 * (SRP — it is a status/dashboard surface, not an editor).
 */
export function AdminPanel({ api }: { api: IAdminApi }) {
  const [state, setState] = useState<PanelState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .getSystemConfig()
      .then((config) => {
        if (!cancelled) setState({ status: 'ready', config });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (state.status === 'loading') {
    return <div className="admin-panel admin-panel--loading">Memuat konfigurasi…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="admin-panel">
        <p className="admin-panel__error">Gagal memuat konfigurasi: {state.message}</p>
        <Link className="btn btn--primary" to="/wizard">
          Buka Wizard
        </Link>
      </div>
    );
  }

  const { config } = state;
  return (
    <div className="admin-panel">
      <header className="admin-panel__header">
        <div>
          <h1 className="admin-panel__title">{config.storeName || 'QMS Admin'}</h1>
          <p className="admin-panel__subtitle">Konfigurasi Sistem</p>
        </div>
        <Link className="btn btn--primary" to="/wizard">
          Ubah Konfigurasi
        </Link>
      </header>

      <section className="config-card">
        <h2 className="config-card__title">Kategori</h2>
        <ul className="config-list">
          {config.categories.map((c) => (
            <li key={c.id} className="config-list__item">
              <span className="config-list__code">{c.code}</span>
              <span className="config-list__name">{c.name}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="config-card">
        <h2 className="config-card__title">Counter &amp; Routing</h2>
        <ul className="config-list">
          {config.routingRules.map((r) => (
            <li key={r.counterId} className="config-list__item config-list__item--routing">
              <span className="config-list__counter">Counter {r.counterId} — {r.counterName}</span>
              <span className="config-list__policy">{r.priorityPolicy}</span>
              <span className="config-list__cats">
                {r.assignedCategoryIds.length} kategori
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="config-card">
        <h2 className="config-card__title">State Machine</h2>
        <ul className="transition-list">
          {config.stateMachine.transitions.map((t, i) => (
            <li key={i} className="transition-list__item">
              <span className="transition-list__state">{t.from}</span>
              <span className="transition-list__arrow">→</span>
              <span className="transition-list__state">{t.to}</span>
              <span className="transition-list__label">{t.actionLabel}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="config-card">
        <h2 className="config-card__title">Daily Reset</h2>
        <dl className="kv">
          <dt>Mode</dt>
          <dd>{config.dailyResetPolicy.mode}</dd>
          <dt>Cron</dt>
          <dd>{config.dailyResetPolicy.cronExpression ?? '—'}</dd>
          <dt>Reset ke nomor</dt>
          <dd>{config.dailyResetPolicy.resetTicketNumberTo}</dd>
          <dt>Arsip hari sebelumnya</dt>
          <dd>{config.dailyResetPolicy.archivePreviousDayData ? 'Ya' : 'Tidak'}</dd>
        </dl>
      </section>
    </div>
  );
}
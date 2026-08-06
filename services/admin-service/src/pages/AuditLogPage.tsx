import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type { AuditLogEntryDto } from '../api/types';
import { labelForAuditAction } from '../lib/labels';

/**
 * The dedicated audit-log page (QUE-45). Promotes the audit trail — previously
 * a section buried inside the Analitik page — to its own route (`/audit`) so
 * the grouped left-menu "Audit" group resolves to a real destination.
 *
 * Frontend-only: reuses the existing `GET /api/audit/log` read
 * ({@link IAdminApi.getAuditLog}), which returns the full trail oldest-first
 * with no date parameter (the previous in-Analitik section already showed all
 * entries, so this is behavior-identical for the audit portion). The only new
 * affordance is a client-side date filter on the already-fetched log (the API
 * does not support server-side date filtering).
 *
 * The page consumes only the audit read-side slice of {@link IAdminApi} (SRP /
 * ISP) and owns no realtime/WS surface. State machine mirrors
 * `AnalyticsPage` / `DashboardPage` (loading / error / ready / empty) so the
 * manager sees a consistent shape across read pages.
 */
type AuditState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: readonly AuditLogEntryDto[] }
  | { status: 'empty' };

/** Renders an opaque audit snapshot as a compact JSON string (or `—` when null). */
function formatSnapshot(snap: AuditLogEntryDto['before']): string {
  return snap === null ? '—' : JSON.stringify(snap);
}

/** Local `YYYY-MM-DD` for an epoch-ms timestamp (single on-premise box, NFR-SEC-01). */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function AuditLogPage({ api }: { api: IAdminApi }) {
  const [state, setState] = useState<AuditState>({ status: 'loading' });
  // Client-side date filter — empty means "show all entries". The API returns
  // the whole trail, so filtering is purely on the fetched set.
  const [filterDate, setFilterDate] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .getAuditLog()
      .then((entries) => {
        if (cancelled) return;
        setState(entries.length === 0 ? { status: 'empty' } : { status: 'ready', entries });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Most-recent-first is the natural read order for a manager scanning recent
  // actions; the API returns oldest-first, so reverse for display.
  const visible = useMemo(() => {
    if (state.status !== 'ready') return [];
    const ordered = [...state.entries].reverse();
    return filterDate === ''
      ? ordered
      : ordered.filter((e) => localDayKey(e.occurredAt) === filterDate);
  }, [state, filterDate]);

  if (state.status === 'loading') {
    return (
      <div className="analytics analytics--loading">
        {/* The header renders the <h1> so the page owns its heading on every
            view — the AppShell topbar title is intentionally a non-heading
            <span> and relies on the routed page providing the <h1>. */}
        <AuditHeader filterDate={filterDate} onFilterDateChange={setFilterDate} />
        <p className="analytics__status" role="status" aria-live="polite">
          Memuat log audit…
        </p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="analytics">
        <AuditHeader filterDate={filterDate} onFilterDateChange={setFilterDate} />
        <p className="admin-panel__error">Gagal memuat log audit: {state.message}</p>
        <Link className="btn btn--primary" to="/">
          Kembali ke Dashboard
        </Link>
      </div>
    );
  }
  if (state.status === 'empty' || visible.length === 0) {
    return (
      <div className="analytics">
        <AuditHeader filterDate={filterDate} onFilterDateChange={setFilterDate} />
        <p className="analytics__empty" data-testid="audit-empty">
          {filterDate !== ''
            ? `Tidak ada entri audit pada ${filterDate}.`
            : 'Belum ada entri audit.'}
        </p>
      </div>
    );
  }

  return (
    <div className="analytics">
      <AuditHeader filterDate={filterDate} onFilterDateChange={setFilterDate} />

      {/* AC4 — the 5-column audit table overflows on narrow viewports; wrap it
          in a horizontal-scroll container (same pattern the Analitik page used). */}
      <div className="data-table-scroll">
        <table className="data-table data-table--audit">
          <thead>
            <tr>
              <th>Waktu</th>
              <th>Aktor</th>
              <th>Aksi</th>
              <th>Sebelum</th>
              <th>Sesudah</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.occurredAt).toLocaleString()}</td>
                <td>{a.actor}</td>
                <td>{labelForAuditAction(a.action)}</td>
                <td className="data-table__snapshot">{formatSnapshot(a.before)}</td>
                <td className="data-table__snapshot">{formatSnapshot(a.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuditHeader({
  filterDate,
  onFilterDateChange,
}: {
  filterDate: string;
  onFilterDateChange: (d: string) => void;
}) {
  return (
    <header className="analytics__header">
      <div>
        <h1 className="analytics__title">Log Audit</h1>
        <p className="analytics__subtitle">Riwayat tindakan sensitif</p>
      </div>
      <div className="analytics__controls">
        <label className="field">
          <span className="field__label">Filter tanggal</span>
          <input
            className="field__input"
            type="date"
            value={filterDate}
            onChange={(e) => onFilterDateChange(e.target.value)}
            aria-label="Filter tanggal audit"
            data-testid="audit-filter-date"
          />
        </label>
      </div>
    </header>
  );
}
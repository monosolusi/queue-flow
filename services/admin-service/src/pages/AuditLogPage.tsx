import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type { AuditLogEntryDto } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { isDateKey, localDayKey } from '../lib/date';
import { labelForAuditAction } from '../lib/labels';
import { DateField } from '../components/DateField';

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
/** Id of the filter-validation message, wired to the field's `aria-describedby`. */
const FILTER_ERROR_ID = 'audit-filter-error';

type AuditState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: readonly AuditLogEntryDto[] }
  | { status: 'empty' };

/** Renders an opaque audit snapshot as a compact JSON string (or `—` when null). */
function formatSnapshot(snap: AuditLogEntryDto['before']): string {
  return snap === null ? '—' : JSON.stringify(snap);
}

export function AuditLogPage({ api }: { api: IAdminApi }) {
  const [state, setState] = useState<AuditState>({ status: 'loading' });
  // Client-side date filter — empty means "show all entries". The API returns
  // the whole trail, so filtering is purely on the fetched set.
  const [filterDate, setFilterDate] = useState<string>('');
  // The filter is a text input now (DateField), so it accepts a partial or
  // impossible key where `type="date"` coerced to ''. A malformed value is an
  // INPUT error, not a data statement: filtering on `2026-0` would match nothing
  // and the empty state would report "Tidak ada entri audit pada 2026-0.", which
  // reads as a fact about the log. So a malformed value simply does not filter
  // (the trail stays fully visible) and the field says why — the same
  // treat-it-as-input-error stance `AnalyticsPage` takes on its range.
  const filterApplied = isDateKey(filterDate);

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
    return filterApplied ? ordered.filter((e) => localDayKey(e.occurredAt) === filterDate) : ordered;
  }, [state, filterDate, filterApplied]);

  if (state.status === 'loading') {
    return (
      <div className="page analytics">
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
      <div className="page analytics">
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
      <div className="page analytics">
        <AuditHeader filterDate={filterDate} onFilterDateChange={setFilterDate} />
        <p className="analytics__empty" data-testid="audit-empty">
          {/* Only claim "nothing on that date" when a real date is filtering;
              a malformed value is reported by the field, not as a data fact. */}
          {filterApplied
            ? `Tidak ada entri audit pada ${filterDate}.`
            : 'Belum ada entri audit.'}
        </p>
      </div>
    );
  }

  return (
    <div className="page analytics">
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

/**
 * The header owns the filter field, so it also owns that field's validation
 * message — every page branch renders this header, so the message follows the
 * field everywhere with no duplication. `''` is valid (it means "tampilkan
 * semua"); only a non-empty non-date is an error.
 */
function AuditHeader({
  filterDate,
  onFilterDateChange,
}: {
  filterDate: string;
  onFilterDateChange: (d: string) => void;
}) {
  const invalid = filterDate !== '' && !isDateKey(filterDate);
  // `clearable` only here: '' is this field's meaningful "tampilkan semua"
  // state, and the native date input used to give Chrome users a clear
  // affordance that a plain text input does not.
  return (
    <PageHeader
      title="Log Audit"
      subtitle="Riwayat tindakan sensitif"
      actionsAlign="end"
      actions={
        <DateField
          label="Filter tanggal"
          value={filterDate}
          onChange={onFilterDateChange}
          ariaLabel="Filter tanggal audit"
          testId="audit-filter-date"
          clearable
          invalid={invalid}
          describedById={invalid ? FILTER_ERROR_ID : undefined}
        >
          {invalid && (
            <span
              className="field__error"
              id={FILTER_ERROR_ID}
              data-testid="audit-filter-invalid"
            >
              Isi tanggal dengan format YYYY-MM-DD, atau kosongkan untuk menampilkan semua.
            </span>
          )}
        </DateField>
      }
    />
  );
}
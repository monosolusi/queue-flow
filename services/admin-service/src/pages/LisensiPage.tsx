import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ILicenseApi } from '../api/admin-api';
import type { LicenseHistoryEntryDto, LicenseStatusDto } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import {
  LICENSE_ISSUE_ACTIONS,
  LICENSE_STATE_LABELS,
  LICENSE_TYPE_LABELS,
  formatLicenseDate,
  licenseTone,
} from '../lib/license-labels';

/**
 * The licence status screen (`/lisensi`).
 *
 * Read-only by design. Replacing a licence goes through `/aktivasi`, which
 * already owns the copy-the-request / paste-the-file flow and is the page a
 * manager is sent to when something is wrong — duplicating the upload form here
 * would mean two places to keep correct for one action.
 *
 * The host-binding block exists for one support conversation in particular:
 * "why does it say my hardware changed?". Naming which claim changed and which
 * could not be read is the difference between a five-minute fix (a bind-mount
 * dropped during maintenance) and an accusation.
 */
export function LisensiPage({ api }: { api: ILicenseApi }) {
  const [status, setStatus] = useState<LicenseStatusDto | null>(null);
  const [history, setHistory] = useState<readonly LicenseHistoryEntryDto[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await api.getLicense();
        if (!cancelled) setStatus(current);
        // History is admin-only and secondary: a 403 or a failure here must not
        // hide the status the manager actually came for.
        try {
          const rows = await api.getLicenseHistory();
          if (!cancelled) setHistory(rows);
        } catch {
          /* leave history empty */
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (failed) {
    return (
      <>
        <PageHeader title="Lisensi" />
        <div className="guard-error" role="alert">
          <p>Tidak dapat memuat status lisensi. Pastikan server aktif.</p>
        </div>
      </>
    );
  }
  if (status === null) {
    return (
      <>
        <PageHeader title="Lisensi" />
        <div className="guard-loading">Memuat status lisensi…</div>
      </>
    );
  }

  const action = LICENSE_ISSUE_ACTIONS[status.issue];

  return (
    <>
      <PageHeader title="Lisensi" />

      <section className="config-card" aria-labelledby="status-lisensi">
        <h2 id="status-lisensi">Status</h2>

        <p className={`license-status license-status--${licenseTone(status.state)}`}>
          <strong>{LICENSE_STATE_LABELS[status.state]}</strong>
        </p>
        {action !== '' && <p className="license-status__action">{action}</p>}

        <dl className="license-facts">
          <dt>Terdaftar atas nama</dt>
          <dd>{status.customerName ?? '—'}</dd>

          <dt>Jenis lisensi</dt>
          <dd>{status.type === null ? '—' : (LICENSE_TYPE_LABELS[status.type] ?? status.type)}</dd>

          <dt>Berlaku sampai</dt>
          {/* A perpetual licence has no end date, and saying so plainly is the
              point of the tier — "—" would read as missing data. */}
          <dd>{status.expiresAt === null ? 'Tanpa batas waktu' : formatLicenseDate(status.expiresAt)}</dd>

          <dt>Masa dukungan &amp; pembaruan</dt>
          <dd>
            {status.supportUntil === null
              ? '—'
              : `${formatLicenseDate(status.supportUntil)}${status.supportActive ? '' : ' (sudah berakhir)'}`}
          </dd>

          <dt>Batas loket</dt>
          <dd>{status.entitlements.maxCounters ?? 'Tanpa batas'}</dd>

          <dt>Batas kategori</dt>
          <dd>{status.entitlements.maxCategories ?? 'Tanpa batas'}</dd>
        </dl>

        {/* Advisory, never a restriction: a perpetual licence keeps running at
            full function past its support window — what lapses is the right to
            upgrade to the next major version. Saying that here stops it being
            read as a fault. */}
        {!status.supportActive && (
          <p className="license-note">
            Masa dukungan sudah berakhir. Sistem <strong>tetap berjalan penuh</strong> — yang tidak
            lagi termasuk hanyalah hak pembaruan ke versi besar berikutnya.
          </p>
        )}
        {!status.versionCovered && (
          <p className="license-note">
            Versi sistem yang berjalan lebih baru daripada yang tercakup lisensi ini. Sistem tetap
            berjalan penuh; hubungi penyedia sistem untuk menyesuaikan lisensi.
          </p>
        )}
      </section>

      {status.host !== null && (
        <section className="config-card" aria-labelledby="perangkat">
          <h2 id="perangkat">Perangkat</h2>
          {status.host.outcome === 'MATCH' && <p>Lisensi cocok dengan perangkat ini.</p>}
          {status.host.outcome === 'UNAVAILABLE' && (
            <p>
              Identitas perangkat tidak dapat dibaca, jadi pencocokan perangkat tidak diberlakukan.
              Ini normal saat pengembangan; di mini PC produksi biasanya berarti mount identitas
              perangkat belum dipasang.
            </p>
          )}
          {status.host.outcome === 'MISMATCH' && (
            <>
              <p>Lisensi ini diaktivasi di perangkat yang berbeda.</p>
              <ul>
                {status.host.changed.length > 0 && (
                  <li>Berubah: {status.host.changed.join(', ')}</li>
                )}
                {status.host.unreadable.length > 0 && (
                  <li>Tidak terbaca: {status.host.unreadable.join(', ')}</li>
                )}
              </ul>
            </>
          )}
        </section>
      )}

      {history.length > 0 && (
        <section className="config-card" aria-labelledby="riwayat">
          <h2 id="riwayat">Riwayat aktivasi</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Tanggal</th>
                <th scope="col">Dipasang oleh</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td>{formatLicenseDate(row.installedAt)}</td>
                  <td>{row.installedBy}</td>
                  <td>{row.isActive ? 'Aktif' : 'Diganti'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="license-cta">
        <Link className="btn btn--primary" to="/aktivasi">
          Pasang / Ganti Lisensi
        </Link>
      </p>
    </>
  );
}

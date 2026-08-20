import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LicenseRejectedError, type ILicenseApi } from '../api/admin-api';
import type { ActivationRequestDto, LicenseStatusDto } from '../api/types';
import { useSystemConfigContext } from '../config/system-config-context';
import {
  LICENSE_ISSUE_ACTIONS,
  LICENSE_REJECTION_LABELS,
} from '../lib/license-labels';
import { useToast } from '../toast/useToast';

/** Guards against a paste that is clearly not a licence before a round trip. */
const ARMOR_BEGIN = '-----BEGIN QMS LICENSE-----';

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly request: ActivationRequestDto; readonly status: LicenseStatusDto }
  | { readonly kind: 'error' };

/**
 * The activation screen — the only page an unlicensed store can reach.
 *
 * Chromeless (like `/wizard` and `/login`): the sidebar links to pages the
 * store cannot use yet, and offering them would be a dead end.
 *
 * The flow it has to support is a person standing in a shop with a phone, no
 * internet on the mini PC, and no shell access:
 *
 *   1. copy ONE string (the activation request),
 *   2. send it to the vendor over WhatsApp,
 *   3. paste back — or upload — the `.lic` that comes in reply.
 *
 * That is why the request is a single prefixed blob rather than an installation
 * id plus a table of hashes: two things to copy is two things to get wrong, and
 * a mistyped id is only discovered after the licence has been issued.
 */
export function AktivasiPage({ api }: { api: ILicenseApi }) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const [copied, setCopied] = useState<'request' | 'installation' | null>(null);

  const { refresh: refreshConfig } = useSystemConfigContext();
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [request, status] = await Promise.all([api.getActivationRequest(), api.getLicense()]);
        if (!cancelled) setLoad({ kind: 'ready', request, status });
      } catch {
        if (!cancelled) setLoad({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const copy = useCallback(async (value: string, which: 'request' | 'installation') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      // Not a toast: the confirmation belongs next to the button that was
      // pressed, and a manager copying twice should see it twice.
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error('Tidak dapat menyalin otomatis. Silakan pilih teksnya dan salin manual.');
    }
  }, [toast]);

  const readFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => setToken(String(reader.result ?? ''));
    reader.onerror = () => toast.error('Gagal membaca file. Coba pilih ulang.');
    reader.readAsText(file);
  }, [toast]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setRejection(null);

    const trimmed = token.trim();
    if (!trimmed.includes(ARMOR_BEGIN)) {
      // Caught here rather than at the server so the manager gets the answer
      // immediately, and so an accidental screenshot or empty paste does not
      // land in the audit log as a rejected activation attempt.
      setRejection(LICENSE_REJECTION_LABELS.MALFORMED);
      return;
    }

    setSubmitting(true);
    try {
      await api.activateLicense(trimmed);
      // Refresh the shared snapshot BEFORE navigating, or LicenseGuard would
      // still hold the RESTRICTED verdict and bounce straight back here.
      await refreshConfig();
      toast.success('Lisensi berhasil diaktifkan.');
      navigate('/', { replace: true });
    } catch (error) {
      setRejection(
        error instanceof LicenseRejectedError && error.reason !== null
          ? LICENSE_REJECTION_LABELS[error.reason]
          : 'Aktivasi gagal. Pastikan server aktif, lalu coba lagi.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (load.kind === 'loading') {
    return <div className="guard-loading">Memuat data aktivasi…</div>;
  }
  if (load.kind === 'error') {
    return (
      <div className="guard-error" role="alert">
        <p>Tidak dapat memuat data aktivasi. Pastikan server aktif.</p>
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Coba Lagi
        </button>
      </div>
    );
  }

  const { request, status } = load;

  return (
    <div className="aktivasi">
      <h1>Aktivasi Sistem Antrean</h1>

      <p className="aktivasi__reason" role="status">
        {LICENSE_ISSUE_ACTIONS[status.issue] || 'Perangkat ini memerlukan lisensi yang aktif.'}
      </p>

      <section className="aktivasi__step" aria-labelledby="langkah-1">
        <h2 id="langkah-1">Langkah 1 — Kirim kode ini ke penyedia sistem</h2>
        <p>
          Salin <strong>Kode Permintaan Aktivasi</strong> di bawah dan kirim lewat WhatsApp atau email.
          Kode ini hanya berisi identitas perangkat — tidak ada data pelanggan atau data antrean di dalamnya.
        </p>

        <label className="aktivasi__field">
          <span>Kode Permintaan Aktivasi</span>
          <textarea
            readOnly
            rows={4}
            className="aktivasi__blob"
            value={request.blob}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <button type="button" className="btn btn--primary" onClick={() => void copy(request.blob, 'request')}>
          {copied === 'request' ? 'Tersalin ✓' : 'Salin Kode'}
        </button>

        <p className="aktivasi__installation">
          ID Perangkat: <code>{request.installationId}</code>{' '}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void copy(request.installationId, 'installation')}
          >
            {copied === 'installation' ? 'Tersalin ✓' : 'Salin'}
          </button>
        </p>
      </section>

      <section className="aktivasi__step" aria-labelledby="langkah-2">
        <h2 id="langkah-2">Langkah 2 — Pasang file lisensi yang diterima</h2>

        <form onSubmit={(e) => void submit(e)}>
          <div className="aktivasi__upload">
            <input
              type="file"
              id="lisensi-file"
              accept=".lic,text/plain"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (file) readFile(file);
              }}
            />
            <label htmlFor="lisensi-file">Pilih file .lic</label>
          </div>

          <label className="aktivasi__field">
            {/* The paste path is not a fallback — on a tablet it is often the
                easier one, because the licence arrives as chat text rather than
                as a file that has to be saved somewhere findable first. */}
            <span>…atau tempel isi lisensinya di sini</span>
            <textarea
              rows={8}
              className="aktivasi__token"
              value={token}
              placeholder={`${ARMOR_BEGIN}\n…\n-----END QMS LICENSE-----`}
              onChange={(e) => setToken(e.currentTarget.value)}
              aria-invalid={rejection !== null}
              aria-describedby={rejection !== null ? 'lisensi-error' : undefined}
            />
          </label>

          {rejection !== null && (
            <p className="aktivasi__error" id="lisensi-error" role="alert">
              {rejection}
            </p>
          )}

          <button type="submit" className="btn btn--primary" disabled={submitting || token.trim() === ''}>
            {submitting ? 'Memasang…' : 'Aktifkan'}
          </button>
        </form>
      </section>
    </div>
  );
}

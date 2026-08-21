import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LicenseRejectedError, type ILicenseApi } from '../api/admin-api';
import type { LicenseStatusDto } from '../api/types';
import { useSystemConfigContext } from '../config/system-config-context';
import {
  LICENSE_ISSUE_ACTIONS,
  LICENSE_REJECTION_LABELS,
} from '../lib/license-labels';
import {
  KEY_SYMBOLS,
  formatLicenseKey,
  isLicenseKeyComplete,
  isLicenseKeyValid,
} from '../lib/license-key';
import { useToast } from '../toast/useToast';

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: LicenseStatusDto }
  | { readonly kind: 'error' };

/**
 * The activation screen — the only page an unlicensed store can reach.
 *
 * Chromeless (like `/wizard` and `/login`): the sidebar links to pages the
 * store cannot use yet, and offering them would be a dead end.
 *
 * The flow it has to support is a person standing in a shop with the key the
 * vendor sent them: type it, press Aktifkan, done. There is no file to receive,
 * save and find again, and no code to copy back the other way — the device
 * identity travels inside the request the server never shows anyone.
 *
 * The one thing that flow needs and the old file-based one did not is the
 * INTERNET, once. That is stated at the top of the page rather than discovered
 * through a failure, because the person who has to act on it is usually
 * standing in the shop with a phone they could tether, and finding out after a
 * fifteen-second timeout is how a five-minute fix becomes a second visit.
 */
export function AktivasiPage({ api }: { api: ILicenseApi }) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { refresh: refreshConfig } = useSystemConfigContext();
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.getLicense();
        if (!cancelled) setLoad({ kind: 'ready', status });
      } catch {
        if (!cancelled) setLoad({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const copyInstallationId = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        // Not a toast: the confirmation belongs next to the button that was
        // pressed, and a manager copying twice should see it twice.
        window.setTimeout(() => setCopied(false), 2000);
      } catch {
        toast.error('Tidak dapat menyalin otomatis. Silakan pilih teksnya dan salin manual.');
      }
    },
    [toast],
  );

  /**
   * Reformats as the manager types: upper-cases, resolves the O/0 and I/1
   * look-alikes, and re-groups. Typing, pasting a hyphen-less key and pasting
   * one wrapped across two lines in an email all converge on the same value,
   * so nobody has to know which form is "right".
   */
  function onKeyChange(raw: string) {
    setKey(formatLicenseKey(raw));
    setRejection(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setRejection(null);

    if (!isLicenseKeyValid(key)) {
      // Caught here rather than at the server so the manager gets the answer
      // immediately — and so a typo never reaches the activation server as a
      // failed redemption against a key that was fine.
      setRejection(LICENSE_REJECTION_LABELS.KEY_MALFORMED);
      return;
    }

    setSubmitting(true);
    try {
      await api.activateWithKey(key);
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

  const { status } = load;
  // Only gates the button. The full check runs on submit, so a manager who
  // pastes a complete-but-mistyped key still gets the specific reason rather
  // than a button that silently refuses to work.
  const ready = isLicenseKeyComplete(key);

  return (
    <div className="aktivasi">
      <h1>Aktivasi Sistem Antrean</h1>

      <p className="aktivasi__reason" role="status">
        {LICENSE_ISSUE_ACTIONS[status.issue] || 'Perangkat ini memerlukan lisensi yang aktif.'}
      </p>

      <p className="aktivasi__online" role="note">
        <strong>Aktivasi memerlukan koneksi internet — satu kali saja.</strong> Setelah aktif,
        sistem antrean berjalan sepenuhnya tanpa internet dan tidak pernah menghubungi server lagi.
      </p>

      <form onSubmit={(e) => void submit(e)}>
        <label className="aktivasi__field">
          <span>Kunci Aktivasi</span>
          <input
            type="text"
            className="aktivasi__key"
            value={key}
            onChange={(e) => onKeyChange(e.currentTarget.value)}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            /* 4 groups of 5 plus 3 hyphens. Typing past the end is silently
               dropped by the formatter, so a double-paste cannot corrupt it. */
            maxLength={KEY_SYMBOLS + 3}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            aria-invalid={rejection !== null}
            aria-describedby={rejection !== null ? 'lisensi-error' : 'lisensi-bantuan'}
          />
        </label>
        <p className="aktivasi__hint" id="lisensi-bantuan">
          Kunci ini dikirim oleh penyedia sistem, berbentuk 20 huruf dan angka. Huruf besar-kecil
          tidak masalah.
        </p>

        {rejection !== null && (
          <p className="aktivasi__error" id="lisensi-error" role="alert">
            {rejection}
          </p>
        )}

        <button type="submit" className="btn btn--primary" disabled={submitting || !ready}>
          {submitting ? 'Mengaktifkan…' : 'Aktifkan'}
        </button>
      </form>

      {status.installationId !== null && (
        <p className="aktivasi__installation">
          {/* No longer part of the activation flow — kept because it is the
              first thing the vendor asks for when a key will not redeem. */}
          ID Perangkat: <code>{status.installationId}</code>{' '}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void copyInstallationId(status.installationId as string)}
          >
            {copied ? 'Tersalin ✓' : 'Salin'}
          </button>
        </p>
      )}
    </div>
  );
}

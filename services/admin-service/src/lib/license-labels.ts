import type {
  LicenseIssueName,
  LicenseRejectionReason,
  LicenseStateName,
  LicenseSummaryDto,
} from '../api/types';

/**
 * Friendly Bahasa Indonesia copy for every licensing enum the server sends.
 *
 * The DTO's `detail` field is deliberately NOT shown to managers: it is an
 * English diagnostic aimed at whoever is supporting the install ("license is
 * for installation 1111…, this one is 9999…"). Rendering raw server strings —
 * or raw enum names — in the manager UI is the thing the friendly-label rule
 * exists to prevent. `detail` still reaches support through the audit log.
 */
export const LICENSE_STATE_LABELS: Record<LicenseStateName, string> = {
  VALID: 'Aktif',
  EXPIRING_SOON: 'Akan berakhir',
  GRACE: 'Masa tenggang',
  MISMATCH_GRACE: 'Perangkat berbeda',
  RESTRICTED: 'Terbatas',
};

export const LICENSE_TYPE_LABELS: Record<string, string> = {
  perpetual: 'Permanen',
  trial: 'Uji coba',
  free: 'Gratis / internal',
};

/** What the manager should actually DO, per reason. One sentence, no jargon. */
export const LICENSE_ISSUE_ACTIONS: Record<LicenseIssueName, string> = {
  NONE: '',
  ABSENT:
    'Perangkat ini belum diaktivasi. Kirim Kode Permintaan Aktivasi di bawah ke penyedia sistem, lalu unggah file lisensi yang dikirim balik.',
  INVALID:
    'File lisensi yang terpasang tidak dapat dibaca — kemungkinan rusak atau sudah diubah. Unggah ulang file asli dari penyedia sistem.',
  WRONG_INSTALLATION:
    'Lisensi ini diterbitkan untuk perangkat lain. Kirim Kode Permintaan Aktivasi perangkat INI ke penyedia sistem untuk mendapat lisensi yang sesuai.',
  EXPIRED:
    'Masa berlaku lisensi sudah habis. Hubungi penyedia sistem untuk perpanjangan.',
  HOST_MISMATCH:
    'Lisensi ini diaktivasi di perangkat lain. Kalau Anda baru mengganti mini PC atau menginstal ulang sistem operasi, hubungi penyedia sistem untuk lisensi pengganti.',
};

/** Why an uploaded file was refused, in the manager's terms. */
export const LICENSE_REJECTION_LABELS: Record<LicenseRejectionReason, string> = {
  MALFORMED: 'File ini bukan file lisensi yang valid, atau isinya rusak. Pastikan Anda mengunggah file .lic yang dikirim penyedia sistem, apa adanya.',
  UNTRUSTED: 'File ini tidak diterbitkan oleh penyedia sistem, atau isinya sudah diubah setelah diterbitkan.',
  WRONG_INSTALLATION: 'Lisensi ini untuk perangkat lain. Kirim Kode Permintaan Aktivasi perangkat ini ke penyedia sistem.',
  WRONG_PRODUCT: 'Lisensi ini untuk produk lain, bukan sistem antrean ini.',
};

/** Severity for banner styling. Never a raw state name in a class. */
export type LicenseTone = 'ok' | 'info' | 'warn' | 'danger';

export function licenseTone(state: LicenseStateName): LicenseTone {
  switch (state) {
    case 'VALID':
      return 'ok';
    case 'EXPIRING_SOON':
      return 'info';
    case 'GRACE':
    case 'MISMATCH_GRACE':
      return 'warn';
    case 'RESTRICTED':
      return 'danger';
  }
}

/** `2027-08-18T23:59:59.999Z` → `18 Agustus 2027`. */
export function formatLicenseDate(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/**
 * The one-line banner message for a non-VALID licence. Returns `null` when
 * there is nothing to say, so a caller can render nothing without branching on
 * the state itself.
 */
export function licenseBannerMessage(license: LicenseSummaryDto): string | null {
  switch (license.state) {
    case 'VALID':
      return null;
    case 'EXPIRING_SOON':
      return `Lisensi akan berakhir pada ${formatLicenseDate(license.expiresAt)}. Hubungi penyedia sistem untuk perpanjangan.`;
    case 'GRACE':
      return `Masa berlaku lisensi sudah habis. Sistem masih berjalan penuh sampai ${formatLicenseDate(license.graceEndsAt)}, setelah itu kiosk berhenti mencetak tiket baru.`;
    case 'MISMATCH_GRACE':
      return license.graceEndsAt === null
        ? 'Lisensi ini terdaftar di perangkat lain. Segera hubungi penyedia sistem — kalau dibiarkan, kiosk akan berhenti mencetak tiket baru.'
        : `Lisensi ini terdaftar di perangkat lain. Sistem masih berjalan penuh sampai ${formatLicenseDate(license.graceEndsAt)}, setelah itu kiosk berhenti mencetak tiket baru.`;
    case 'RESTRICTED':
      return 'Sistem dalam mode terbatas: kiosk tidak dapat mencetak tiket baru. Antrean yang sudah ada tetap bisa dilayani sampai habis.';
  }
}

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
    'Perangkat ini belum diaktivasi. Masukkan Kunci Aktivasi dari penyedia sistem di bawah ini.',
  INVALID:
    'Lisensi yang terpasang tidak dapat dibaca — kemungkinan rusak. Aktivasi ulang dengan Kunci Aktivasi Anda.',
  WRONG_INSTALLATION:
    'Lisensi ini diterbitkan untuk perangkat lain. Hubungi penyedia sistem agar kunci Anda dilepas dari perangkat lama, lalu aktivasi ulang.',
  EXPIRED:
    'Masa berlaku lisensi sudah habis. Hubungi penyedia sistem untuk perpanjangan.',
  HOST_MISMATCH:
    'Lisensi ini diaktivasi di perangkat lain. Kalau Anda baru mengganti mini PC atau menginstal ulang sistem operasi, hubungi penyedia sistem untuk aktivasi ulang.',
};

/**
 * Why an activation was refused, in the manager's terms.
 *
 * Each of these leads somewhere different, which is the entire reason the
 * server sends a code instead of a sentence. `OFFLINE` sends someone to find a
 * signal; `KEY_ALREADY_USED` sends them to the phone; `KEY_MALFORMED` sends
 * them back to the keyboard. Collapsing any two of them into "aktivasi gagal"
 * costs a technician an afternoon.
 *
 * None of them says "hubungi teknisi" and stops there — every line names the
 * next physical action.
 */
export const LICENSE_REJECTION_LABELS: Record<LicenseRejectionReason, string> = {
  KEY_MALFORMED:
    'Kunci Aktivasi ini tidak lengkap atau ada karakter yang salah ketik. Periksa lagi huruf dan angkanya, lalu coba lagi.',
  OFFLINE:
    'Tidak ada koneksi internet. Aktivasi hanya perlu internet sekali, saat pemasangan — sambungkan kabel LAN ke internet atau nyalakan hotspot HP, lalu coba lagi. Setelah aktif, sistem berjalan tanpa internet.',
  TIMEOUT:
    'Server penyedia sistem tidak menjawab tepat waktu. Koneksinya ada, tapi lambat — tunggu sebentar lalu tekan Aktifkan lagi.',
  SERVER_ERROR:
    'Server penyedia sistem sedang bermasalah. Coba lagi beberapa saat lagi; kalau tetap gagal, hubungi penyedia sistem.',
  KEY_UNKNOWN:
    'Kunci Aktivasi ini tidak dikenali. Pastikan Anda memasukkan kunci yang benar dari penyedia sistem.',
  KEY_ALREADY_USED:
    'Kunci Aktivasi ini sudah dipakai di perangkat lain. Kalau Anda mengganti atau memindahkan perangkat, hubungi penyedia sistem untuk melepas kunci dari perangkat lama.',
  KEY_REVOKED:
    'Kunci Aktivasi ini sudah dinonaktifkan oleh penyedia sistem. Hubungi penyedia sistem untuk kunci penggantinya.',
  KEY_EXPIRED:
    'Masa pakai Kunci Aktivasi ini sudah lewat. Hubungi penyedia sistem untuk kunci yang baru.',
  MALFORMED:
    'Jawaban dari server penyedia sistem tidak dapat dibaca. Coba lagi; kalau tetap gagal, hubungi penyedia sistem.',
  UNTRUSTED:
    'Lisensi yang diterima tidak diterbitkan oleh penyedia sistem ini. Hubungi penyedia sistem — jangan lanjutkan.',
  WRONG_INSTALLATION:
    'Lisensi yang diterima ternyata untuk perangkat lain. Hubungi penyedia sistem.',
  WRONG_PRODUCT: 'Kunci ini untuk produk lain, bukan sistem antrean ini.',
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

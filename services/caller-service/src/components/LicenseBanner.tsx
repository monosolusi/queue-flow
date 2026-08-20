import type { CallerLicenseSlice } from '../api/types';

/**
 * Licence warning for counter staff.
 *
 * The caller panel is the ONE non-admin surface that shows this, and the reason
 * is the audience: staff are the people a customer will ask when the kiosk stops
 * printing, so they need to know it is a licensing matter with a known fix
 * rather than a broken machine. The kiosk and the TV face customers, who can
 * neither act on it nor benefit from knowing, and deliberately show nothing.
 *
 * The panel keeps working in every state including RESTRICTED — that is the
 * whole point of the graded ladder: the queue that already exists must drain.
 * So this is a strip, never a block.
 */
export function LicenseBanner({ license }: { license: CallerLicenseSlice | null | undefined }) {
  // Absent (older core-api) or null (boot window) says nothing about validity.
  if (license == null || license.state === 'VALID') return null;

  const restricted = license.restrictsNewTickets;

  return (
    <div
      className={`caller-license-banner${restricted ? ' caller-license-banner--danger' : ''}`}
      role="status"
      data-license-state={license.state}
    >
      {restricted
        ? 'Kiosk sedang tidak bisa mencetak tiket baru karena masalah lisensi. Antrean yang sudah ada tetap bisa dilayani. Hubungi manajer toko.'
        : 'Ada masalah lisensi yang perlu ditindaklanjuti manajer toko. Panel ini tetap berfungsi normal.'}
    </div>
  );
}

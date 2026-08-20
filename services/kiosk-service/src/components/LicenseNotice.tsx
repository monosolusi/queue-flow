import type { KioskLicenseSlice } from '../api/types';

/**
 * What the kiosk tells a VISITOR about the store's licence.
 *
 * The audience is the load-bearing constraint. Someone walking up to take a
 * queue number has no idea what a licence is, cannot fix one, and should not be
 * shown an installation id or a grace date. So:
 *
 *  - `RESTRICTED` replaces the whole screen. The kiosk genuinely cannot issue a
 *    ticket (core-api refuses `POST /api/tickets`), and letting the visitor tap
 *    a category only to hit an opaque failure is worse than saying so up front.
 *    The wording points them at staff, which is the only action available to
 *    them, and deliberately avoids "licence" — that is the operator's problem,
 *    not the customer's.
 *  - Grace states show NOTHING here. The store is fully functional, the warning
 *    is aimed at the manager, and it already appears on every admin screen.
 *    Putting it on the visitor-facing kiosk would alarm customers about a
 *    commercial matter they are not party to.
 */
export function LicenseNotice({ license }: { license: KioskLicenseSlice | null }) {
  if (license === null || !license.restrictsNewTickets) return null;

  return (
    <div className="kiosk-license-block" role="alert">
      <h1>Maaf, pengambilan nomor antrean sedang tidak tersedia</h1>
      <p>Silakan menghubungi petugas kami untuk dibantu.</p>
    </div>
  );
}

import { Link } from 'react-router-dom';
import { useSystemConfigContext } from '../config/system-config-context';
import { licenseBannerMessage, licenseTone } from '../lib/license-labels';

/**
 * The persistent licence warning strip.
 *
 * Rendered above the routed page for every non-VALID state, because the whole
 * point of a graded ladder is that the store is told BEFORE anything is
 * withheld. A grace period nobody notices is just a delayed outage.
 *
 * Deliberately not dismissible: the manager cannot act on a warning they have
 * already hidden, and the window is measured in days, not sessions.
 *
 * `role="status"` rather than `role="alert"` — it is present from page load
 * rather than raised in response to an action, and `alert` would interrupt a
 * screen reader mid-sentence on every navigation. `RESTRICTED` is the exception:
 * something IS being withheld right now, so it is assertive.
 */
export function LicenseBanner() {
  const { config } = useSystemConfigContext();
  const license = config?.license;

  // Absent (older core-api) or null (boot window) says nothing about validity,
  // so there is nothing to warn about — the same rule LicenseGuard follows.
  if (license == null) return null;

  const message = licenseBannerMessage(license);
  if (message === null) return null;

  const tone = licenseTone(license.state);

  return (
    <div
      className={`license-banner license-banner--${tone}`}
      role={license.state === 'RESTRICTED' ? 'alert' : 'status'}
      data-license-state={license.state}
    >
      <span className="license-banner__text">{message}</span>
      <Link className="license-banner__action" to="/lisensi">
        Lihat Lisensi
      </Link>
    </div>
  );
}

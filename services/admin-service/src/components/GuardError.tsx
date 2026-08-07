/**
 * The shared outage state for the two config route guards ({@link SetupGuard} +
 * {@link WizardGuard}). A `GET /api/system/config` rejection is a REAL outage —
 * the read returns a default DTO on a clean store, so it never throws "not
 * configured" — and neither guard may redirect on it: SetupGuard would misroute
 * a logged-in admin to `/wizard` and WizardGuard would bounce them straight
 * back, a confusing loop. Both keep the user on the route and offer a retry.
 *
 * Presentational only (the retry action belongs to the shared config provider's
 * `refresh`), extracted so the identical copy + markup lives in one place while
 * the two guards stay separate, single-purpose components at the call site.
 */
export function GuardError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="guard-error" role="alert">
      <p>Tidak dapat memuat konfigurasi sistem. Pastikan server aktif.</p>
      <button type="button" className="btn btn--primary" onClick={onRetry}>
        Coba Lagi
      </button>
    </div>
  );
}

import type { Toast, ToastVariant } from './useToastStack';

/**
 * The toast surface — pure presentational (SRP): it renders the list it is
 * handed and calls back on dismiss. It owns no timers and no state, so
 * {@link useToastStack} stays the single source of truth for the stack.
 *
 * **The two live-region wrappers mount unconditionally, even when empty.** A
 * live region has to exist in the accessibility tree *before* content is
 * inserted into it — a region that appears together with its first message is
 * announced unreliably (notably by NVDA/JAWS with `aria-live="polite"`). So the
 * viewport always renders both wrappers and only their children come and go.
 *
 * Errors go to `role="alert"` / `aria-live="assertive"` (a failed write
 * interrupts), everything else to `role="status"` / `aria-live="polite"`.
 * `aria-atomic="false"` so a second toast announces only the added item rather
 * than re-reading the whole stack. The individual `.toast` items carry **no**
 * role — the wrapper is the region, and a nested `role="status"` would make AT
 * announce the same message twice.
 *
 * There is deliberately **no exit animation**: a two-phase unmount would give
 * every fake-timer test in the app a second timing dimension to advance, for a
 * cosmetic gain on a control the manager sees for five seconds.
 */
const ICONS: Record<ToastVariant, string> = {
  success: '✓',
  error: '!',
  info: 'i',
};

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: readonly Toast[];
  onDismiss: (id: string) => void;
}) {
  const errors = toasts.filter((t) => t.variant === 'error');
  const others = toasts.filter((t) => t.variant !== 'error');

  return (
    <div className="toast-viewport" role="region" aria-label="Notifikasi">
      <div className="toast-viewport__live" role="alert" aria-live="assertive" aria-atomic="false">
        {errors.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
      <div className="toast-viewport__live" role="status" aria-live="polite" aria-atomic="false">
        {others.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  return (
    <div className={`toast toast--${toast.variant}`} data-testid={`toast-${toast.variant}`}>
      <span className="toast__icon" aria-hidden="true">
        {ICONS[toast.variant]}
      </span>
      <span className="toast__message">{toast.message}</span>
      <button
        type="button"
        className="toast__dismiss"
        aria-label="Tutup notifikasi"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

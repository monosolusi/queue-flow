import { useMemo } from 'react';
import { useToastContext } from './toast-context';
import type { ToastVariant } from './useToastStack';

/**
 * The consumer-facing toast API, narrowed to the **write** surface (ISP).
 *
 * Pages announce; they do not own the stack. Hiding `toasts` and `clear()`
 * behind {@link useToastContext} means a page cannot read the queue to render
 * its own copy of the notifications (which would double-announce against the
 * provider's viewport) and cannot wipe notifications another page raised. The
 * exact same slicing rationale as `ICallerApi` on the backend boundary: a
 * consumer gets the operations it needs, not the whole surface.
 */
export interface ToastApi {
  show(message: string, opts?: { variant?: ToastVariant; durationMs?: number }): string;
  success(message: string): string;
  error(message: string): string;
  info(message: string): string;
  dismiss(id: string): void;
}

export function useToast(): ToastApi {
  const { show, success, error, info, dismiss } = useToastContext();
  return useMemo(
    () => ({ show, success, error, info, dismiss }),
    [show, success, error, info, dismiss],
  );
}

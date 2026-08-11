import { createContext, useContext, type ReactNode } from 'react';
import { ToastViewport } from './ToastViewport';
import { useToastStack, type ToastStackState } from './useToastStack';

/**
 * The app-wide toast channel — the notification sibling of `AuthProvider` and
 * `SystemConfigProvider`. One {@link ToastProvider} near the router root owns
 * the single {@link useToastStack} instance so every admin write (config save,
 * user create/delete, manual reset, log cleanup, export, logout failure)
 * reports through one surface instead of each page inventing its own inline
 * paragraph.
 *
 * **The provider renders the viewport itself.** Mounting is not a consumer's
 * responsibility: a page that calls `toast.success(...)` without a viewport in
 * the tree would silently show nothing, and that failure mode is invisible in
 * review. Owning the viewport here makes "provider present" the only thing a
 * consumer can get wrong, and the no-op default below covers even that.
 *
 * The default value is a fully NO-OP stack (`toasts: []`, every method a no-op;
 * the id-returning ones return `''`). That is load-bearing, not cosmetic:
 * `AppShell.test.tsx`'s `renderShell` mounts the shell — which fires an error
 * toast on a failed logout — with **no** provider, precisely to prove the shell
 * renders standalone, so a throwing "must be inside a ToastProvider" default
 * would break it. Firing a toast with no provider is a dropped notification,
 * never a crash — the same forgiving-default reasoning as {@link AuthContext}
 * (null user + no-op handlers) and {@link SystemConfigContext} (unresolved
 * snapshot). The page suites that assert toast copy (`AdminPanel`, `UsersPage`,
 * `AnalyticsPage`) do wrap their render in a real provider, since they need the
 * viewport's live regions to assert against.
 */
const ToastContext = createContext<ToastStackState>({
  toasts: [],
  show: () => '',
  success: () => '',
  error: () => '',
  info: () => '',
  dismiss: () => {},
  clear: () => {},
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const state = useToastStack();
  return (
    <ToastContext.Provider value={state}>
      {children}
      <ToastViewport toasts={state.toasts} onDismiss={state.dismiss} />
    </ToastContext.Provider>
  );
}

/**
 * The full toast stack — read (`toasts`) **and** write. Only the provider's own
 * viewport needs the read side; pages should use the narrowed `useToast()`
 * instead (ISP).
 */
export function useToastContext(): ToastStackState {
  return useContext(ToastContext);
}

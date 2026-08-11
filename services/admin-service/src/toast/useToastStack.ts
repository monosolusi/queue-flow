import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The toast state machine — pure state, no DOM and no context (SRP). It owns
 * ids, the auto-dismiss timer map, and FIFO eviction; {@link ToastProvider}
 * adapts it to React context and {@link ToastViewport} renders it. Splitting
 * the three keeps each testable on its own: this hook is exercised through
 * `renderHook` with fake timers, the viewport through plain props.
 *
 * The admin panel previously signalled a successful write with an inline
 * paragraph that was set and never cleared ("Konfigurasi tersimpan." lingered
 * indefinitely) and signalled nothing at all on `/admin/users`. A single
 * auto-dismissing stack is the structural fix: success/info expire on their
 * own, so no page has to remember to clear anything.
 */
export type ToastVariant = 'success' | 'error' | 'info';

export interface Toast {
  readonly id: string;
  readonly variant: ToastVariant;
  readonly message: string;
  /** Auto-dismiss delay in ms; `0` means sticky (dismissed only by the ✕ or eviction). */
  readonly durationMs: number;
}

export interface ToastStackState {
  readonly toasts: readonly Toast[];
  /** Pushes a toast and returns its id (so a caller can dismiss it early). */
  show(message: string, opts?: { variant?: ToastVariant; durationMs?: number }): string;
  success(message: string): string;
  error(message: string): string;
  info(message: string): string;
  dismiss(id: string): void;
  clear(): void;
}

/** A confirmation is transient — the manager saw the action they just took. */
export const SUCCESS_DURATION_MS = 5000;
/** Neutral notices expire like confirmations. */
export const INFO_DURATION_MS = 5000;
/**
 * Errors are **sticky** (`0` = no timer). A manager who looked away must still
 * be able to read *why* a write failed; it leaves via the ✕ or FIFO eviction.
 */
export const ERROR_DURATION_MS = 0;
/** Newest-last stack cap; the oldest is evicted (with its timer cleared). */
export const MAX_TOASTS = 3;

export function useToastStack(): ToastStackState {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  // Monotonic id counter — NOT Date.now()/Math.random(), so ids are
  // deterministic in tests and stable as React keys.
  const nextId = useRef(0);
  // One pending auto-dismiss timer per non-sticky toast. Tracked in a ref (not
  // state) because clearing a timer must not re-render, and because the unmount
  // cleanup below has to reach every live timer — a leaked timer firing after
  // unmount is the classic "update not wrapped in act" warning under fake
  // timers.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const handle = timers.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const clear = useCallback(() => {
    timers.current.forEach((handle) => clearTimeout(handle));
    timers.current.clear();
    setToasts([]);
  }, []);

  const show = useCallback(
    (message: string, opts?: { variant?: ToastVariant; durationMs?: number }): string => {
      const variant = opts?.variant ?? 'info';
      const durationMs =
        opts?.durationMs ??
        (variant === 'error'
          ? ERROR_DURATION_MS
          : variant === 'success'
            ? SUCCESS_DURATION_MS
            : INFO_DURATION_MS);
      nextId.current += 1;
      const id = `toast-${nextId.current}`;

      setToasts((prev) => {
        const next = [...prev, { id, variant, message, durationMs }];
        // FIFO: at capacity the OLDEST goes, so the newest notice is always
        // visible. Its timer is cleared here rather than left to fire against a
        // toast that is already gone.
        while (next.length > MAX_TOASTS) {
          const evicted = next.shift();
          if (evicted) clearTimer(evicted.id);
        }
        return next;
      });

      if (durationMs > 0) {
        timers.current.set(
          id,
          setTimeout(() => {
            timers.current.delete(id);
            setToasts((prev) => prev.filter((t) => t.id !== id));
          }, durationMs),
        );
      }
      return id;
    },
    [clearTimer],
  );

  const success = useCallback((message: string) => show(message, { variant: 'success' }), [show]);
  const error = useCallback((message: string) => show(message, { variant: 'error' }), [show]);
  const info = useCallback((message: string) => show(message, { variant: 'info' }), [show]);

  // Drop every pending timer on unmount so a late callback cannot set state on
  // an unmounted provider.
  useEffect(() => {
    const live = timers.current;
    return () => {
      live.forEach((handle) => clearTimeout(handle));
      live.clear();
    };
  }, []);

  // Memoized so consumers can safely put the whole object in a dep array (the
  // methods are already useCallback-stable, so this only changes when `toasts`
  // does).
  return useMemo(
    () => ({ toasts, show, success, error, info, dismiss, clear }),
    [toasts, show, success, error, info, dismiss, clear],
  );
}

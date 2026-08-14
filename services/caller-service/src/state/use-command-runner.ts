import { useCallback, useRef, useState } from 'react';

export interface CommandRunner {
  /** Key of the command currently in flight (see `actionRunKey`), or `null`. */
  readonly pending: string | null;
  /** Message from the last failed command, cleared when a new one starts. */
  readonly error: string | null;
  /** Set when a tap was turned away because another command was still in
   *  flight, and cleared as soon as that command settles. Not an error — the
   *  tap was simply too early — so it reads as a hint, not a failure. */
  readonly notice: string | null;
  /** Fire a command under the double-tap guard. */
  readonly run: (key: string, invoker: () => Promise<void>) => Promise<void>;
}

/** Shown when the guard turns a tap away. One runner serves every row of a
 *  list, so this must never be silent: an ignored tap with no feedback reads as
 *  a dead button on a touch panel. */
export const BUSY_NOTICE = 'Tunggu perintah sebelumnya selesai.';

/**
 * Runs one queue command at a time and exposes its pending/error state.
 *
 * The guard is a **ref flipped before the first `await`**, not the `pending`
 * state: `disabled` only takes effect after a re-render, so on a touch surface
 * two taps in the same tick both observe `pending === null` and both fire. The
 * ref blocks the second synchronously; `pending` remains the visible affordance.
 *
 * A blocked tap is reported, never swallowed. `pending` disables the buttons of
 * every surface this runner serves, which covers the common case; the residual
 * one — two *different* buttons tapped within a single tick, before that
 * disable renders — reaches the ref guard, and {@link CommandRunner.notice}
 * says so in plain Indonesian until the in-flight command settles.
 *
 * Commands are fire-and-forget — the resulting TICKET_CALLED / STATUS_UPDATED /
 * TICKET_TRANSFERRED event arrives over the WebSocket and updates the store.
 * Illegal transitions surface here as an inline error (core-api returns 409).
 */
export function useCommandRunner(): CommandRunner {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const run = useCallback(async (key: string, invoker: () => Promise<void>) => {
    if (inFlightRef.current) {
      setNotice(BUSY_NOTICE);
      return;
    }
    inFlightRef.current = true;
    setPending(key);
    setError(null);
    try {
      await invoker();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Perintah gagal');
    } finally {
      inFlightRef.current = false;
      setPending(null);
      // The notice explains a wait that is now over — clearing it with the
      // command that caused it keeps it brief without a timer.
      setNotice(null);
    }
  }, []);

  return { pending, error, notice, run };
}

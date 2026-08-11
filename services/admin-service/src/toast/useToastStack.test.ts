import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TOASTS,
  SUCCESS_DURATION_MS,
  useToastStack,
  type ToastStackState,
} from './useToastStack';

/**
 * Fake timers throughout — the whole point of the stack is *when* toasts leave.
 * State updates fired from a timer callback must be flushed inside
 * `act(async () => vi.advanceTimersByTimeAsync(n))`, and assertions after that
 * read the already-flushed value synchronously (a `waitFor` would poll via
 * `setTimeout` and never advance).
 */
describe('useToastStack', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function push(result: { current: ToastStackState }, fn: (s: ToastStackState) => string): string {
    let id = '';
    act(() => {
      id = fn(result.current);
    });
    return id;
  }

  it('mints deterministic monotonic ids (never Date.now()/Math.random())', () => {
    const { result } = renderHook(() => useToastStack());
    const first = push(result, (s) => s.success('a'));
    const second = push(result, (s) => s.error('b'));
    expect(first).toBe('toast-1');
    expect(second).toBe('toast-2');
  });

  it('appends newest last', () => {
    const { result } = renderHook(() => useToastStack());
    push(result, (s) => s.success('pertama'));
    push(result, (s) => s.success('kedua'));
    expect(result.current.toasts.map((t) => t.message)).toEqual(['pertama', 'kedua']);
  });

  it('auto-dismisses a success toast at exactly SUCCESS_DURATION_MS', async () => {
    const { result } = renderHook(() => useToastStack());
    push(result, (s) => s.success('tersimpan'));

    await advance(SUCCESS_DURATION_MS - 1);
    expect(result.current.toasts).toHaveLength(1);

    await advance(1);
    expect(result.current.toasts).toHaveLength(0);
  });

  it('keeps an error toast sticky — still present long after the success window', async () => {
    const { result } = renderHook(() => useToastStack());
    push(result, (s) => s.error('gagal menyimpan'));

    await advance(60_000);
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe('gagal menyimpan');
    expect(result.current.toasts[0].durationMs).toBe(0);
  });

  it('evicts the OLDEST toast once past MAX_TOASTS', () => {
    const { result } = renderHook(() => useToastStack());
    for (const m of ['satu', 'dua', 'tiga', 'empat']) push(result, (s) => s.error(m));

    expect(result.current.toasts).toHaveLength(MAX_TOASTS);
    expect(result.current.toasts.map((t) => t.message)).toEqual(['dua', 'tiga', 'empat']);
  });

  it('clears the evicted toast’s pending timer (no phantom removal later)', async () => {
    const { result } = renderHook(() => useToastStack());
    // "satu" is evicted at t=0 by the fourth push; its 5s timer must be gone, so
    // nothing disappears when the original deadline passes.
    for (const m of ['satu', 'dua', 'tiga', 'empat']) push(result, (s) => s.success(m));
    expect(result.current.toasts).toHaveLength(3);

    await advance(SUCCESS_DURATION_MS);
    expect(result.current.toasts).toHaveLength(0);
  });

  it('dismiss(id) removes just that toast and cancels its timer', async () => {
    const { result } = renderHook(() => useToastStack());
    const keep = push(result, (s) => s.success('simpan'));
    const drop = push(result, (s) => s.success('buang'));

    act(() => result.current.dismiss(drop));
    expect(result.current.toasts.map((t) => t.id)).toEqual([keep]);

    // The dismissed toast's timer must not fire against the surviving stack.
    await advance(SUCCESS_DURATION_MS);
    expect(result.current.toasts).toHaveLength(0);
  });

  it('clear() empties the stack and every pending timer', async () => {
    const { result } = renderHook(() => useToastStack());
    push(result, (s) => s.success('a'));
    push(result, (s) => s.info('b'));

    act(() => result.current.clear());
    expect(result.current.toasts).toHaveLength(0);

    await advance(SUCCESS_DURATION_MS);
    expect(result.current.toasts).toHaveLength(0);
  });

  it('show() honours an explicit variant + duration', async () => {
    const { result } = renderHook(() => useToastStack());
    push(result, (s) => s.show('cepat', { variant: 'info', durationMs: 100 }));
    expect(result.current.toasts[0].variant).toBe('info');

    await advance(100);
    expect(result.current.toasts).toHaveLength(0);
  });

  it('unmount clears pending timers (no act warning, no post-unmount setState)', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useToastStack());
    push(result, (s) => s.success('a'));
    push(result, (s) => s.info('b'));

    unmount();
    await advance(SUCCESS_DURATION_MS * 2);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps every method referentially stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useToastStack());
    const before = result.current;
    rerender();
    expect(result.current.show).toBe(before.show);
    expect(result.current.success).toBe(before.success);
    expect(result.current.error).toBe(before.error);
    expect(result.current.info).toBe(before.info);
    expect(result.current.dismiss).toBe(before.dismiss);
    expect(result.current.clear).toBe(before.clear);
    // Nothing changed, so the memoized object identity holds too.
    expect(result.current).toBe(before);
  });
});

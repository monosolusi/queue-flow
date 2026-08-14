import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BUSY_NOTICE, useCommandRunner } from './use-command-runner';

/** Probe exposing the runner through two buttons (a list row and its neighbour),
 *  so a tap is a real DOM event and a second command has somewhere to come
 *  from. */
function Probe({ invoker }: { invoker: () => Promise<void> }) {
  const { pending, error, notice, run } = useCommandRunner();
  return (
    <>
      <button type="button" onClick={() => void run('cmd', invoker)} disabled={pending === 'cmd'}>
        Jalankan
      </button>
      <button type="button" onClick={() => void run('other', invoker)}>
        Jalankan Lain
      </button>
      <p data-testid="pending">{pending ?? ''}</p>
      <p data-testid="error">{error ?? ''}</p>
      <p data-testid="notice">{notice ?? ''}</p>
    </>
  );
}

describe('useCommandRunner', () => {
  it('blocks a second tap fired in the SAME tick (the state guard cannot)', () => {
    // `disabled` only applies after a re-render, so on a touch surface two taps
    // in one tick both observe `pending === null`. The ref guard must stop the
    // second synchronously — this is why a state-only guard is not enough.
    const invoker = vi.fn(() => new Promise<void>(() => {}));
    render(<Probe invoker={invoker} />);
    const btn = screen.getByRole('button', { name: 'Jalankan' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(invoker).toHaveBeenCalledTimes(1);
  });

  it('never blocks a tap in silence — the turned-away tap gets a reason', async () => {
    // The guard also catches taps on OTHER buttons sharing the runner (a list
    // row while its neighbour is in flight). Returning early with no pending
    // state and no message made those buttons read as dead.
    let resolve: (() => void) | undefined;
    const invoker = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<Probe invoker={invoker} />);
    fireEvent.click(screen.getByRole('button', { name: 'Jalankan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jalankan Lain' }));
    expect(invoker).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('notice')).toHaveTextContent(BUSY_NOTICE);
    // It is a wait, not a failure — so it never lands in `error`…
    expect(screen.getByTestId('error')).toHaveTextContent('');
    // …and it clears with the command it was waiting on, without a timer.
    resolve!();
    await waitFor(() => expect(screen.getByTestId('notice')).toHaveTextContent(''));
  });

  it('shows the pending key while in flight and clears it when the command settles', async () => {
    let resolve: (() => void) | undefined;
    const invoker = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<Probe invoker={invoker} />);
    fireEvent.click(screen.getByRole('button', { name: 'Jalankan' }));
    expect(await screen.findByText('cmd')).toBeInTheDocument();
    resolve!();
    expect(await screen.findByRole('button', { name: 'Jalankan' })).not.toBeDisabled();
    expect(screen.getByTestId('pending')).toHaveTextContent('');
  });

  it('surfaces a failure and re-arms for the next command', async () => {
    const invoker = vi.fn(() => Promise.reject(new Error('transisi ilegal')));
    render(<Probe invoker={invoker} />);
    fireEvent.click(screen.getByRole('button', { name: 'Jalankan' }));
    expect(await screen.findByText('transisi ilegal')).toBeInTheDocument();
    // The in-flight ref is released in `finally`, so the next tap fires.
    fireEvent.click(screen.getByRole('button', { name: 'Jalankan' }));
    expect(invoker).toHaveBeenCalledTimes(2);
    // Let the second rejection settle inside the test.
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent(''));
  });
});

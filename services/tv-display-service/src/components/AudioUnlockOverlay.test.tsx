import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AudioUnlockOverlay } from './AudioUnlockOverlay';

describe('AudioUnlockOverlay', () => {
  it('is a single native button, so Enter and Space both count as a user gesture', () => {
    // The browser only lifts its autoplay block for a real user activation.
    // A native <button> gets keyboard activation for free; a clickable <div>
    // would need hand-rolled key handling and might not count as activation.
    render(<AudioUnlockOverlay onUnlock={() => {}} />);

    const button = screen.getByRole('button');
    expect(button.tagName).toBe('BUTTON');
    // Explicit type: inside any future <form> a bare button would submit.
    expect(button).toHaveAttribute('type', 'button');
  });

  it('tells the viewer in Indonesian what to do', () => {
    render(<AudioUnlockOverlay onUnlock={() => {}} />);

    expect(screen.getByRole('button')).toHaveAccessibleName(
      /Ketuk untuk mengaktifkan suara/,
    );
  });

  it('explains why the prompt is there, not just what to do', () => {
    // Staff seeing a bare "tap here" on a wall-mounted board have no idea what
    // broke; the hint names the browser as the cause.
    render(<AudioUnlockOverlay onUnlock={() => {}} />);

    expect(screen.getByText(/memblokir suara/)).toBeInTheDocument();
  });

  it('calls onUnlock when activated', () => {
    const onUnlock = vi.fn();
    render(<AudioUnlockOverlay onUnlock={onUnlock} />);

    screen.getByRole('button').click();

    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('takes focus on mount so a TV remote can activate it', () => {
    // A wall-mounted board has no pointer. Without focus the OK button on an
    // HDMI stick's remote has nothing to press.
    render(<AudioUnlockOverlay onUnlock={() => {}} />);

    expect(screen.getByRole('button')).toHaveFocus();
  });

  it('hides the decorative glyph from assistive tech', () => {
    // The button's own text is the accessible name; announcing "bell emoji"
    // ahead of it is noise.
    const { container } = render(<AudioUnlockOverlay onUnlock={() => {}} />);

    const icon = container.querySelector('.tv-audio-unlock__icon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    // And it must not leak into the accessible name.
    expect(screen.getByRole('button').getAttribute('aria-label')).toBeNull();
  });

  it('is not a modal dialog — the board stays in the accessibility tree', () => {
    // aria-modal would hide the board's role="status" aria-live="assertive"
    // now-serving announcement from screen readers, which is the one thing a
    // queue board must never take away. Nothing focusable opened this overlay,
    // so the repo's dialog convention (focus trap + return focus) does not apply.
    render(<AudioUnlockOverlay onUnlock={() => {}} />);

    const button = screen.getByRole('button');
    expect(button).not.toHaveAttribute('aria-modal');
    expect(button).not.toHaveAttribute('role', 'dialog');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RunningText } from './RunningText';

const DEFAULT_TEXT =
  'Nomor antrian tidak selalu berurutan — harap perhatikan panggilan nomor Anda dan loket yang dituju.';

describe('RunningText disclaimer marquee', () => {
  afterEach(cleanup);

  it('renders the disclaimer text + testid by default', () => {
    render(<RunningText />);
    const region = screen.getByTestId('running-text');
    expect(region).toHaveTextContent(DEFAULT_TEXT);
  });

  it('exposes the disclaimer via role="marquee" + aria-label for AT', () => {
    render(<RunningText />);
    const marquee = screen.getByRole('marquee');
    expect(marquee).toHaveAttribute('aria-label', DEFAULT_TEXT);
  });

  it('renders two track items (seamless loop), both hidden from AT (aria-label is the sole channel)', () => {
    const { container } = render(<RunningText />);
    const items = container.querySelectorAll('.running-text__item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(DEFAULT_TEXT);
    expect(items[1]).toHaveTextContent(DEFAULT_TEXT);
    // Both items are aria-hidden so the moving text is not exposed as
    // navigable content; the parent role="marquee" aria-label announces the
    // disclaimer once (no per-item duplication).
    expect(items[0]).toHaveAttribute('aria-hidden', 'true');
    expect(items[1]).toHaveAttribute('aria-hidden', 'true');
  });

  it('honors a custom text prop', () => {
    const custom = 'Custom disclaimer text';
    render(<RunningText text={custom} />);
    const region = screen.getByTestId('running-text');
    expect(region).toHaveAttribute('aria-label', custom);
    expect(region).toHaveTextContent(custom);
  });
});
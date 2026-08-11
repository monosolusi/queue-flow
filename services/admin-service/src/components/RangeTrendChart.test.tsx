import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RangeTrendChart } from './RangeTrendChart';
import type { DailyPointDto } from '../api/types';

function day(date: string, total: number): DailyPointDto {
  return { date, totalTickets: total, avgWaitTimeMs: 0, avgServiceTimeMs: 0, ticketsServed: 0 };
}

describe('RangeTrendChart (QUE-44)', () => {
  it('renders one bar per day with a per-bar testid + an accessible summary', () => {
    const { container } = render(
      <RangeTrendChart
        perDay={[day('2026-08-01', 3), day('2026-08-02', 5), day('2026-08-03', 0)]}
      />,
    );
    expect(screen.getByTestId('range-trend-chart')).toBeInTheDocument();
    expect(screen.getByTestId('range-trend-bar-0')).toBeInTheDocument();
    expect(screen.getByTestId('range-trend-bar-1')).toBeInTheDocument();
    expect(screen.getByTestId('range-trend-bar-2')).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /Total pengunjung per hari: 2026-08-01: 3, 2026-08-02: 5, 2026-08-03: 0/,
      }),
    ).toBeInTheDocument();
    // QUE-51 — three subtle gridlines at 25/50/75% of the plot height.
    expect(container.querySelectorAll('.range-trend__gridline').length).toBe(3);
  });

  it('each bar carries a <title> with the date + count (hover/a11y channel)', () => {
    render(<RangeTrendChart perDay={[day('2026-08-01', 4)]} />);
    const bar = screen.getByTestId('range-trend-bar-0');
    expect(bar.querySelector('title')?.textContent).toBe('2026-08-01: 4 pengunjung');
  });

  it('renders value labels above bars when there are <= 10 days', () => {
    const { container } = render(
      <RangeTrendChart perDay={[day('2026-08-01', 7), day('2026-08-02', 2)]} />,
    );
    // Value labels are <text> with class range-trend__value.
    const valueLabels = container.querySelectorAll('.range-trend__value');
    expect(valueLabels.length).toBe(2);
    expect(valueLabels[0].textContent).toBe('7');
  });

  it('omits value labels for long ranges (> 10 days) to avoid collision', () => {
    const perDay = Array.from({ length: 14 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, i + 1));
    const { container } = render(<RangeTrendChart perDay={perDay} />);
    expect(container.querySelectorAll('.range-trend__value').length).toBe(0);
  });

  it('renders nothing when the per-day series is empty', () => {
    const { container } = render(<RangeTrendChart perDay={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('range-trend-chart')).not.toBeInTheDocument();
  });

  it('sparsifies date tick labels for long ranges so they never overlap', () => {
    const perDay = Array.from({ length: 20 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, '0')}`, 1));
    const { container } = render(<RangeTrendChart perDay={perDay} />);
    const dateLabels = container.querySelectorAll('.range-trend__date');
    // 20 days / step=ceil(20/12)=2 → ~10 labels, strictly fewer than 20.
    expect(dateLabels.length).toBeLessThan(20);
    expect(dateLabels.length).toBeGreaterThan(0);
  });
});

describe('RangeTrendChart — bar/line mode toggle', () => {
  it('defaults to bar mode: bars exist, no polyline, the mode toggle is a labelled group', () => {
    const { container } = render(
      <RangeTrendChart perDay={[day('2026-08-01', 3), day('2026-08-02', 5)]} />,
    );
    expect(screen.getByTestId('range-trend-bar-0')).toBeInTheDocument();
    expect(screen.getByTestId('range-trend-bar-1')).toBeInTheDocument();
    // No line mark in bar mode.
    expect(container.querySelector('.range-trend__line')).toBeNull();
    expect(container.querySelector('.range-trend__point')).toBeNull();
    // The toggle is a labelled group with both buttons; bar is pressed by default.
    expect(screen.getByRole('group', { name: 'Mode grafik' })).toBeInTheDocument();
    expect(screen.getByTestId('range-trend-mode-bar')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('range-trend-mode-line')).toHaveAttribute('aria-pressed', 'false');
  });

  it('switching to line mode renders a polyline + points, and the per-bar testid lives on the circle', () => {
    const { container } = render(
      <RangeTrendChart perDay={[day('2026-08-01', 3), day('2026-08-02', 5), day('2026-08-03', 0)]} />,
    );

    fireEvent.click(screen.getByTestId('range-trend-mode-line'));

    expect(screen.getByTestId('range-trend-mode-line')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('range-trend-mode-bar')).toHaveAttribute('aria-pressed', 'false');
    // A polyline + a point per day now exist.
    expect(container.querySelector('.range-trend__line')).not.toBeNull();
    expect(container.querySelectorAll('.range-trend__point').length).toBe(3);
    // The historical per-bar testid now lives on each circle so existing tests
    // that query `range-trend-bar-N` keep passing in both modes.
    expect(screen.getByTestId('range-trend-bar-0')).toBeInTheDocument();
    expect(screen.getByTestId('range-trend-bar-1')).toBeInTheDocument();
    expect(screen.getByTestId('range-trend-bar-2')).toBeInTheDocument();
    // The bar <rect>s are gone in line mode.
    expect(container.querySelector('.range-trend__bar')).toBeNull();
  });

  it('each line-mode point carries a <title> with the date + count (same hover/a11y channel as bars)', () => {
    render(<RangeTrendChart perDay={[day('2026-08-01', 4)]} />);
    fireEvent.click(screen.getByTestId('range-trend-mode-line'));
    const point = screen.getByTestId('range-trend-bar-0');
    expect(point.tagName.toLowerCase()).toBe('circle');
    expect(point.querySelector('title')?.textContent).toBe('2026-08-01: 4 pengunjung');
  });

  it('switching back to bar mode removes the polyline + points and restores bars', () => {
    const { container } = render(
      <RangeTrendChart perDay={[day('2026-08-01', 3), day('2026-08-02', 5)]} />,
    );

    fireEvent.click(screen.getByTestId('range-trend-mode-line'));
    expect(container.querySelector('.range-trend__line')).not.toBeNull();

    fireEvent.click(screen.getByTestId('range-trend-mode-bar'));
    expect(screen.getByTestId('range-trend-mode-bar')).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.range-trend__line')).toBeNull();
    expect(container.querySelector('.range-trend__point')).toBeNull();
    expect(container.querySelector('.range-trend__bar')).not.toBeNull();
    // The per-bar testid resolves to the <rect> again.
    expect(screen.getByTestId('range-trend-bar-0').tagName.toLowerCase()).toBe('rect');
  });

  it('keeps the accessible summary identical across modes (it describes the data, not the mark type)', () => {
    render(<RangeTrendChart perDay={[day('2026-08-01', 3), day('2026-08-02', 5)]} />);
    const summary = screen.getByRole('img', {
      name: /Total pengunjung per hari: 2026-08-01: 3, 2026-08-02: 5/,
    });
    expect(summary).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('range-trend-mode-line'));
    // Same summary, same role — the aria-label did not change with the mode.
    expect(
      screen.getByRole('img', {
        name: /Total pengunjung per hari: 2026-08-01: 3, 2026-08-02: 5/,
      }),
    ).toBeInTheDocument();
  });

  it('renders value labels in line mode for short ranges (≤10 days)', () => {
    const { container } = render(
      <RangeTrendChart perDay={[day('2026-08-01', 7), day('2026-08-02', 2)]} />,
    );
    fireEvent.click(screen.getByTestId('range-trend-mode-line'));
    const valueLabels = container.querySelectorAll('.range-trend__value');
    expect(valueLabels.length).toBe(2);
    expect(valueLabels[0].textContent).toBe('7');
  });
});
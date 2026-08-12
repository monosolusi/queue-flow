import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RELATIVE_PRESETS, RelativeRangePicker } from './RelativeRangePicker';

describe('RelativeRangePicker (analytics relative-range presets)', () => {
  it('renders one button per preset, each with a stable testid + label', () => {
    render(<RelativeRangePicker activeDays={null} onSelect={() => {}} />);
    for (const p of RELATIVE_PRESETS) {
      const btn = screen.getByTestId(`relative-range-${p.days}`);
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveTextContent(p.label);
    }
    // The four PRD-aligned presets, in order. The "Kustom" toggle is gone —
    // the manual range is now always visible as a DateRangeField on the page.
    expect(RELATIVE_PRESETS.map((p) => p.days)).toEqual([7, 14, 30, 90]);
    expect(screen.queryByTestId('relative-range-custom')).not.toBeInTheDocument();
  });

  it('is a role="group" cluster labelled "Rentang relatif"', () => {
    render(<RelativeRangePicker activeDays={null} onSelect={() => {}} />);
    expect(screen.getByRole('group', { name: 'Rentang relatif' })).toBeInTheDocument();
  });

  it('reflects activeDays on the matching preset button via aria-pressed', () => {
    const { rerender } = render(
      <RelativeRangePicker activeDays={7} onSelect={() => {}} />,
    );
    expect(screen.getByTestId('relative-range-7')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('relative-range-14')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-30')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-90')).toHaveAttribute('aria-pressed', 'false');

    // Switching the active preset flips the single pressed preset button.
    rerender(<RelativeRangePicker activeDays={30} onSelect={() => {}} />);
    expect(screen.getByTestId('relative-range-7')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-30')).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks NO preset pressed when activeDays is null (hand-picked range, no preset matches)', () => {
    render(<RelativeRangePicker activeDays={null} onSelect={() => {}} />);
    for (const p of RELATIVE_PRESETS) {
      expect(screen.getByTestId(`relative-range-${p.days}`)).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
  });

  it('honestly shows a preset pressed when a hand-picked range matches it (no customMode override)', () => {
    // The manual range is always visible now (no reveal step, no customMode
    // flag). A hand-picked range that coincidentally lands on the 7-hari window
    // honestly shows 7-hari pressed — cleaner than the prior customMode
    // override that suppressed the match.
    render(<RelativeRangePicker activeDays={7} onSelect={() => {}} />);
    expect(screen.getByTestId('relative-range-7')).toHaveAttribute('aria-pressed', 'true');
  });

  it('fires onSelect with the preset days on a preset click', () => {
    const onSelect = vi.fn();
    render(<RelativeRangePicker activeDays={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('relative-range-30'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(30);
  });

  it('each button is a type="button" (no form submit)', () => {
    render(<RelativeRangePicker activeDays={null} onSelect={() => {}} />);
    for (const p of RELATIVE_PRESETS) {
      expect(screen.getByTestId(`relative-range-${p.days}`)).toHaveAttribute('type', 'button');
    }
  });
});
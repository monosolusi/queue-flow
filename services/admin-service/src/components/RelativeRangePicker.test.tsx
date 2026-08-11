import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RELATIVE_PRESETS, RelativeRangePicker } from './RelativeRangePicker';

describe('RelativeRangePicker (analytics relative-range presets)', () => {
  it('renders one button per preset with a stable testid + the preset label', () => {
    render(<RelativeRangePicker activeDays={null} onSelect={() => {}} />);
    for (const p of RELATIVE_PRESETS) {
      const btn = screen.getByTestId(`relative-range-${p.days}`);
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveTextContent(p.label);
    }
    // The four PRD-aligned presets, in order.
    expect(RELATIVE_PRESETS.map((p) => p.days)).toEqual([7, 14, 30, 90]);
  });

  it('is a role="group" cluster labelled "Rentang relatif"', () => {
    render(<RelativeRangePicker activeDays={null} onSelect={() => {}} />);
    expect(screen.getByRole('group', { name: 'Rentang relatif' })).toBeInTheDocument();
  });

  it('reflects activeDays on the matching button via aria-pressed', () => {
    const { rerender } = render(<RelativeRangePicker activeDays={7} onSelect={() => {}} />);
    expect(screen.getByTestId('relative-range-7')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('relative-range-14')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-30')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-90')).toHaveAttribute('aria-pressed', 'false');

    // Switching the active preset flips the single pressed button.
    rerender(<RelativeRangePicker activeDays={30} onSelect={() => {}} />);
    expect(screen.getByTestId('relative-range-7')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('relative-range-30')).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks NO button pressed when activeDays is null (custom range)', () => {
    render(<RelativeRangePicker activeDays={null} onSelect={() => {}} />);
    for (const p of RELATIVE_PRESETS) {
      expect(screen.getByTestId(`relative-range-${p.days}`)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('fires onSelect with the preset days on click', () => {
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
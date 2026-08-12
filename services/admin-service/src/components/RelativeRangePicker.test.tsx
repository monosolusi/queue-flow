import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RELATIVE_PRESETS, RelativeRangePicker } from './RelativeRangePicker';

describe('RelativeRangePicker (analytics relative-range presets)', () => {
  it('renders one button per preset + a "Kustom" toggle, each with a stable testid + label', () => {
    render(<RelativeRangePicker activeDays={null} onSelect={() => {}} />);
    for (const p of RELATIVE_PRESETS) {
      const btn = screen.getByTestId(`relative-range-${p.days}`);
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveTextContent(p.label);
    }
    // The four PRD-aligned presets, in order, followed by the "Kustom" toggle
    // that reveals the manual DateRangeField on the page (manager feedback: the
    // rentang tanggal was too wide and should only appear on custom).
    expect(RELATIVE_PRESETS.map((p) => p.days)).toEqual([7, 14, 30, 90]);
    const custom = screen.getByTestId('relative-range-custom');
    expect(custom).toBeInTheDocument();
    expect(custom).toHaveTextContent('Kustom');
    // customActive defaults to false → not pressed.
    expect(custom).toHaveAttribute('aria-pressed', 'false');
  });

  it('reflects customActive on the "Kustom" toggle via aria-pressed', () => {
    const onSelectCustom = vi.fn();
    const { rerender } = render(
      <RelativeRangePicker activeDays={null} onSelect={() => {}} onSelectCustom={onSelectCustom} />,
    );
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'false');
    rerender(
      <RelativeRangePicker
        activeDays={null}
        customActive
        onSelect={() => {}}
        onSelectCustom={onSelectCustom}
      />,
    );
    expect(screen.getByTestId('relative-range-custom')).toHaveAttribute('aria-pressed', 'true');
  });

  it('fires onSelectCustom when the "Kustom" toggle is clicked', () => {
    const onSelectCustom = vi.fn();
    render(
      <RelativeRangePicker activeDays={null} onSelect={() => {}} onSelectCustom={onSelectCustom} />,
    );
    fireEvent.click(screen.getByTestId('relative-range-custom'));
    expect(onSelectCustom).toHaveBeenCalledTimes(1);
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

  it('honestly shows a preset pressed when the active range matches it (the page, not the picker, owns the custom-mode override)', () => {
    // The picker is pure presentational: it reflects `activeDays` verbatim. The
    // custom-mode override (suppressing the match to `null` while "Kustom" is
    // pressed) lives on the PAGE, which passes `activeDays={null}` in custom
    // mode — so a hand-picked range that lands on the 7-hari window shows
    // "Kustom" pressed (and no preset) on the page, while the picker itself
    // never lies about a match it is told to show.
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
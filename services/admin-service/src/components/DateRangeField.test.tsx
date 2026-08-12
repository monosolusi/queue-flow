import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { DateRangeField } from './DateRangeField';

/**
 * The calendar's visible month + day-button names depend on `new Date()`
 * (the popover's `defaultMonth` falls back to `new Date()` when both `from`
 * and `to` are empty). Pin the system time to 20 July 2026 so the calendar opens
 * on July 2026 and day buttons are named e.g. "10 Juli 2026" deterministically.
 * `vi.setSystemTime` does NOT fake timers, so `waitFor` (setTimeout) still
 * works. The day-button accessible name is "Weekday, D Juli 2026" — the `, `
 * prefix disambiguates single-digit days (day 1 vs 11/21/31, day 7 vs 17/27).
 */
beforeAll(() => {
  vi.setSystemTime(new Date(2026, 6, 20));
});
afterAll(() => {
  vi.useRealTimers();
});

function renderField(overrides: Partial<React.ComponentProps<typeof DateRangeField>> = {}) {
  const onRangeChange = vi.fn();
  const utils = render(
    <DateRangeField
      from="2026-07-15"
      to="2026-07-20"
      onRangeChange={onRangeChange}
      {...overrides}
    />,
  );
  return { onRangeChange, ...utils };
}

describe('DateRangeField — grouped textbox (unified affordance)', () => {
  it('renders the group label and shows from – to when both are set', () => {
    renderField();
    const trigger = screen.getByTestId('analytics-range');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveTextContent('2026-07-15');
    expect(trigger).toHaveTextContent('2026-07-20');
    // The label is a sibling span, never a wrapping <label> (a wrapping label
    // would pull the day-button text into the accessible name).
    expect(screen.getByText('Rentang tanggal')).toBeInTheDocument();
  });

  it('shows "Dari" / "Sampai" placeholders (muted) when the range is empty', () => {
    renderField({ from: '', to: '' });
    const trigger = screen.getByTestId('analytics-range');
    expect(trigger).toHaveTextContent('Dari');
    expect(trigger).toHaveTextContent('Sampai');
    expect(trigger.querySelector('.date-range-field__from--placeholder')).not.toBeNull();
    expect(trigger.querySelector('.date-range-field__to--placeholder')).not.toBeNull();
  });

  it('trigger has aria-haspopup="dialog", aria-expanded="false" initially; no dialog', () => {
    renderField();
    const trigger = screen.getByTestId('analytics-range');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a non-modal dialog on trigger click (no aria-modal)', () => {
    renderField();
    fireEvent.click(screen.getByTestId('analytics-range'));
    const dialog = screen.getByRole('dialog', { name: 'Pilih Rentang tanggal' });
    expect(dialog).toBeInTheDocument();
    // Non-modal: no aria-modal (there is no focus trap to back it up).
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(screen.getByTestId('analytics-range')).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders the caption in Indonesian (locale={id} is actually wired)', () => {
    renderField();
    fireEvent.click(screen.getByTestId('analytics-range'));
    expect(within(screen.getByRole('dialog')).getByText(/Juli 2026/)).toBeInTheDocument();
  });

  it('opens on the month of the current `from` value', () => {
    renderField({ from: '2026-03-09', to: '2026-03-20' });
    fireEvent.click(screen.getByTestId('analytics-range'));
    expect(within(screen.getByRole('dialog')).getByText(/Maret 2026/)).toBeInTheDocument();
  });

  it('picking the FIRST day only keeps the popover open and does NOT fire onRangeChange (partial)', () => {
    // react-day-picker v10 commits a complete range on every single click, so
    // DateRangeField drives a controlled two-click flow: the first click only
    // records an anchor and shows a partial highlight — no commit.
    const { onRangeChange } = renderField({ from: '', to: '' });
    fireEvent.click(screen.getByTestId('analytics-range'));
    fireEvent.click(screen.getByRole('button', { name: /, 10 Juli 2026/ }));
    expect(onRangeChange).not.toHaveBeenCalled();
    // Popover stays open so the manager can pick the second day.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('picking TWO days fires onRangeChange once with in-order local keys, closes, and returns focus', () => {
    const { onRangeChange } = renderField({ from: '', to: '' });
    const trigger = screen.getByTestId('analytics-range');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /, 10 Juli 2026/ }));
    fireEvent.click(screen.getByRole('button', { name: /, 25 Juli 2026/ }));

    expect(onRangeChange).toHaveBeenCalledTimes(1);
    expect(onRangeChange).toHaveBeenCalledWith('2026-07-10', '2026-07-25');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('picking a day before the current `from` resets the range start (committed from is the earlier day)', () => {
    // Committed partial range {from: 15, to: undefined} — the manager picks an
    // earlier start (10) then a second day (12). The resulting committed `from`
    // must be the earlier day (10), NOT the original 15.
    const { onRangeChange } = renderField({ from: '2026-07-15', to: '' });
    fireEvent.click(screen.getByTestId('analytics-range'));
    fireEvent.click(screen.getByRole('button', { name: /, 10 Juli 2026/ }));
    fireEvent.click(screen.getByRole('button', { name: /, 12 Juli 2026/ }));
    expect(onRangeChange).toHaveBeenCalledWith('2026-07-10', '2026-07-12');
  });

  it('picking the same day twice commits a single-day range', () => {
    const { onRangeChange } = renderField({ from: '', to: '' });
    fireEvent.click(screen.getByTestId('analytics-range'));
    fireEvent.click(screen.getByRole('button', { name: /, 15 Juli 2026/ }));
    fireEvent.click(screen.getByRole('button', { name: /, 15 Juli 2026/ }));
    expect(onRangeChange).toHaveBeenCalledTimes(1);
    expect(onRangeChange).toHaveBeenCalledWith('2026-07-15', '2026-07-15');
  });

  it('closes on a second trigger click', () => {
    renderField();
    const trigger = screen.getByTestId('analytics-range');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderField();
    const trigger = screen.getByTestId('analytics-range');
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside mousedown', () => {
    renderField();
    fireEvent.click(screen.getByTestId('analytics-range'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays open on a mousedown inside the popover', () => {
    renderField();
    fireEvent.click(screen.getByTestId('analytics-range'));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('detaches its document listeners on unmount (no dangling global handlers)', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderField();
    fireEvent.click(screen.getByTestId('analytics-range'));
    unmount();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('mousedown', expect.any(Function));
    remove.mockRestore();
  });

  it('wires invalid → aria-invalid and describedById → aria-describedby on the trigger', () => {
    renderField({ invalid: true, describedById: 'range-error' });
    const trigger = screen.getByTestId('analytics-range');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    expect(trigger).toHaveAttribute('aria-describedby', 'range-error');
  });
});
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TimeField } from './TimeField';

function renderField(overrides: Partial<React.ComponentProps<typeof TimeField>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <TimeField
      label="Waktu reset harian"
      value="08:30"
      onChange={onChange}
      ariaLabel="Waktu reset harian"
      testId="reset-time"
      idPrefix="tf"
      {...overrides}
    />,
  );
  return { onChange, ...utils };
}

/** A genuinely controlled host, so a pick round-trips back into `value`. */
function ControlledHost({ initial = '', onEmit }: { initial?: string; onEmit: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <TimeField
      label="Waktu reset harian"
      value={value}
      testId="reset-time"
      idPrefix="tf"
      onChange={(v) => {
        onEmit(v);
        setValue(v);
      }}
    />
  );
}

function jamOptions() {
  return within(screen.getByRole('group', { name: 'Jam' }));
}
function menitOptions() {
  return within(screen.getByRole('group', { name: 'Menit' }));
}

describe('TimeField — buffered draft', () => {
  it('emits a complete HH:MM', () => {
    const { onChange } = renderField({ value: '' });
    fireEvent.change(screen.getByTestId('reset-time'), { target: { value: '08:30' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('08:30');
  });

  it('emits NOTHING for a mid-typed value but keeps it visible in the input', () => {
    // Without the draft the parent would round-trip '8:3' through timeToCron,
    // which falls back to midnight, and the field would snap to 00:00 mid-entry.
    const { onChange } = renderField({ value: '' });
    const input = screen.getByTestId('reset-time');
    for (const partial of ['0', '08', '08:', '08:3']) {
      fireEvent.change(input, { target: { value: partial } });
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('08:3');

    fireEvent.change(input, { target: { value: '08:30' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('08:30');
  });

  it('normalizes a one-digit hour before emitting', () => {
    const { onChange } = renderField({ value: '' });
    fireEvent.change(screen.getByTestId('reset-time'), { target: { value: '8:05' } });
    expect(onChange).toHaveBeenCalledWith('08:05');
  });

  it('snaps an uncommitted draft back to `value` on focus-out (never displays what the form does not hold)', () => {
    // Without this the field can render a value the parent does not hold: an
    // incomplete draft never fires `onChange`, so `value` never changes, so the
    // `value`→draft sync effect cannot re-fire. The manager would see a blank
    // required field, save, and silently get the old time back.
    const { onChange } = renderField({ value: '08:30' });
    const input = screen.getByTestId('reset-time');

    fireEvent.change(input, { target: { value: '08:' } });
    expect(input).toHaveValue('08:');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input, { relatedTarget: document.body });

    expect(input).toHaveValue('08:30');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('snaps back from a fully cleared field too (the reported blank-field case)', () => {
    const { onChange } = renderField({ value: '08:30' });
    const input = screen.getByTestId('reset-time');

    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('');

    fireEvent.blur(input, { relatedTarget: document.body });

    expect(input).toHaveValue('08:30');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a COMPLETE draft on focus-out (no spurious snap-back)', () => {
    const { onChange } = renderField({ value: '08:30' });
    const input = screen.getByTestId('reset-time');

    fireEvent.change(input, { target: { value: '22:15' } });
    expect(onChange).toHaveBeenCalledWith('22:15');

    // The parent here is a spy, so `value` stays '08:30'; a complete draft must
    // nevertheless survive the blur untouched.
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(input).toHaveValue('22:15');
  });

  it('does NOT reconcile while focus stays inside the field (e.g. moving to the toggle)', () => {
    renderField({ value: '08:30' });
    const input = screen.getByTestId('reset-time');
    const toggle = screen.getByTestId('reset-time-toggle');

    fireEvent.change(input, { target: { value: '08:' } });
    fireEvent.blur(input, { relatedTarget: toggle });

    // The manager is still mid-interaction with this field.
    expect(input).toHaveValue('08:');
  });

  it('re-syncs the draft when the parent changes `value` (config reload wins)', () => {
    const { rerender } = renderField({ value: '08:30' });
    const input = screen.getByTestId('reset-time');
    fireEvent.change(input, { target: { value: '08:3' } });
    expect(input).toHaveValue('08:3');

    rerender(
      <TimeField
        label="Waktu reset harian"
        value="22:15"
        onChange={() => {}}
        testId="reset-time"
        idPrefix="tf"
      />,
    );
    expect(screen.getByTestId('reset-time')).toHaveValue('22:15');
  });
});

describe('TimeField — markup contract', () => {
  it('puts testId + ariaLabel on the input and reflects `value`', () => {
    renderField();
    const input = screen.getByTestId('reset-time');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveValue('08:30');
    expect(screen.getByLabelText('Waktu reset harian')).toBe(input);
  });

  it('uses a SIBLING <label htmlFor>, never a wrapping one', () => {
    const { container } = renderField();
    const label = container.querySelector('label')!;
    expect(label).toHaveAttribute('for', 'tf-input');
    expect(label.contains(screen.getByTestId('reset-time'))).toBe(false);
  });

  it('marks the input required and adds an aria-hidden * marker', () => {
    const { container } = renderField({ required: true });
    expect(screen.getByTestId('reset-time')).toBeRequired();
    expect(container.querySelector('label span')).toHaveAttribute('aria-hidden', 'true');
  });

  it('wires aria-invalid + aria-describedby and renders the children slot', () => {
    renderField({
      invalid: true,
      describedById: 'cron-error',
      children: (
        <span className="field__error" id="cron-error" data-testid="cron-error">
          Format cron tidak valid
        </span>
      ),
    });
    const input = screen.getByTestId('reset-time');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'cron-error');
    expect(screen.getByTestId('cron-error')).toBeInTheDocument();
  });
});

describe('TimeField — Jam/Menit popover', () => {
  it('is closed initially and the toggle carries the popover a11y wiring', () => {
    renderField();
    const toggle = screen.getByTestId('reset-time-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-haspopup', 'dialog');
    expect(toggle).toHaveAttribute('aria-controls', 'tf-popover');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a non-modal dialog with a labelled group per column', () => {
    renderField();
    fireEvent.click(screen.getByTestId('reset-time-toggle'));
    const dialog = screen.getByRole('dialog', { name: 'Pilih Waktu reset harian' });
    expect(dialog).not.toHaveAttribute('aria-modal');
    // The visible "Jam"/"Menit" headings are aria-hidden, so the grouping
    // semantic has to come from role="group" + aria-label on the cells.
    expect(screen.getByRole('group', { name: 'Jam' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Menit' })).toBeInTheDocument();
  });

  it('renders NO role="option" cells (that would imply a listbox parent)', () => {
    renderField();
    fireEvent.click(screen.getByTestId('reset-time-toggle'));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('offers full granularity — 24 hours and 60 minutes', () => {
    renderField();
    fireEvent.click(screen.getByTestId('reset-time-toggle'));
    expect(jamOptions().getAllByRole('button')).toHaveLength(24);
    expect(menitOptions().getAllByRole('button')).toHaveLength(60);
  });

  it('marks the current hour and minute with aria-pressed', () => {
    renderField({ value: '08:30' });
    fireEvent.click(screen.getByTestId('reset-time-toggle'));
    expect(jamOptions().getByText('08')).toHaveAttribute('aria-pressed', 'true');
    expect(jamOptions().getByText('09')).toHaveAttribute('aria-pressed', 'false');
    expect(menitOptions().getByText('30')).toHaveAttribute('aria-pressed', 'true');
  });

  it('picking Jam then Menit emits 08:00 then 08:30 and keeps the popover open', () => {
    const onEmit = vi.fn();
    render(<ControlledHost onEmit={onEmit} />);
    fireEvent.click(screen.getByTestId('reset-time-toggle'));

    fireEvent.click(jamOptions().getByText('08'));
    expect(onEmit).toHaveBeenNthCalledWith(1, '08:00');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(menitOptions().getByText('30'));
    expect(onEmit).toHaveBeenNthCalledWith(2, '08:30');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('reset-time')).toHaveValue('08:30');
  });

  it('preserves the other half when only one column is picked', () => {
    const onEmit = vi.fn();
    render(<ControlledHost initial="08:30" onEmit={onEmit} />);
    fireEvent.click(screen.getByTestId('reset-time-toggle'));
    fireEvent.click(jamOptions().getByText('22'));
    expect(onEmit).toHaveBeenCalledWith('22:30');
  });

  it('closes on a second toggle click', () => {
    renderField();
    const toggle = screen.getByTestId('reset-time-toggle');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the toggle', () => {
    renderField();
    const toggle = screen.getByTestId('reset-time-toggle');
    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle);
  });

  it('closes on an outside mousedown', () => {
    renderField();
    fireEvent.click(screen.getByTestId('reset-time-toggle'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('survives jsdom’s missing scrollIntoView when opening', () => {
    // The scroll-to-selected effect must be optional-called — jsdom does not
    // implement Element.prototype.scrollIntoView.
    renderField({ value: '22:45' });
    expect(() => fireEvent.click(screen.getByTestId('reset-time-toggle'))).not.toThrow();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

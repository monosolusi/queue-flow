import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DateField } from './DateField';

function renderField(overrides: Partial<React.ComponentProps<typeof DateField>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <DateField
      label="Dari"
      value="2026-07-15"
      onChange={onChange}
      ariaLabel="Tanggal mulai"
      testId="analytics-from"
      idPrefix="df"
      {...overrides}
    />,
  );
  return { onChange, ...utils };
}

describe('DateField — text-input contract (what keeps the existing page tests green)', () => {
  it('fires onChange EXACTLY ONCE with the raw string', () => {
    const { onChange } = renderField();
    fireEvent.change(screen.getByTestId('analytics-from'), {
      target: { value: '2026-07-01' },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-07-01');
  });

  it('passes an incomplete/garbage string through unfiltered (validation lives on the page)', () => {
    const { onChange } = renderField();
    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-7' } });
    expect(onChange).toHaveBeenCalledWith('2026-7');
  });

  it('emits the empty string when the field is cleared by typing', () => {
    const { onChange } = renderField();
    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('puts testId and ariaLabel on the INPUT, and reflects `value`', () => {
    renderField();
    const input = screen.getByTestId('analytics-from');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveValue('2026-07-15');
    expect(screen.getByLabelText('Tanggal mulai')).toBe(input);
  });

  it('uses a SIBLING <label htmlFor>, never a wrapping one', () => {
    const { container } = renderField();
    const label = container.querySelector('label')!;
    const input = screen.getByTestId('analytics-from');
    expect(label).toHaveAttribute('for', 'df-input');
    expect(label.contains(input)).toBe(false);
  });

  it('wires aria-invalid + aria-describedby to the call site’s error node', () => {
    renderField({ invalid: true, describedById: 'range-error' });
    const input = screen.getByTestId('analytics-from');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'range-error');
  });

  it('renders the children slot after the control (call site keeps its own error node)', () => {
    renderField({
      children: (
        <span className="field__error" data-testid="range-error">
          Rentang tidak valid
        </span>
      ),
    });
    expect(screen.getByTestId('range-error')).toBeInTheDocument();
  });
});

describe('DateField — calendar popover', () => {
  it('is closed initially and the toggle carries the popover a11y wiring', () => {
    renderField();
    const toggle = screen.getByTestId('analytics-from-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-haspopup', 'dialog');
    expect(toggle).toHaveAttribute('aria-controls', 'df-popover');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does NOT open on input focus (that would fight typing)', () => {
    renderField();
    fireEvent.focus(screen.getByTestId('analytics-from'));
    fireEvent.change(screen.getByTestId('analytics-from'), { target: { value: '2026-07-02' } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a non-modal dialog on toggle click', () => {
    renderField();
    fireEvent.click(screen.getByTestId('analytics-from-toggle'));
    const dialog = screen.getByRole('dialog', { name: 'Pilih Dari' });
    expect(dialog).toBeInTheDocument();
    // Non-modal: no aria-modal (there is no focus trap to back it up).
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(screen.getByTestId('analytics-from-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders the caption in Indonesian (locale={id} is actually wired)', () => {
    renderField();
    fireEvent.click(screen.getByTestId('analytics-from-toggle'));
    expect(within(screen.getByRole('dialog')).getByText(/Juli 2026/)).toBeInTheDocument();
  });

  it('opens on the month of the current value', () => {
    renderField({ value: '2026-03-09' });
    fireEvent.click(screen.getByTestId('analytics-from-toggle'));
    expect(within(screen.getByRole('dialog')).getByText(/Maret 2026/)).toBeInTheDocument();
  });

  it('emits the picked day as a LOCAL YYYY-MM-DD, closes, and returns focus to the toggle', () => {
    const { onChange } = renderField();
    const toggle = screen.getByTestId('analytics-from-toggle');
    fireEvent.click(toggle);

    fireEvent.click(screen.getByRole('button', { name: /20 Juli 2026/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-07-20');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle);
  });

  it('closes on a second toggle click', () => {
    renderField();
    const toggle = screen.getByTestId('analytics-from-toggle');
    fireEvent.click(toggle);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape and returns focus to the toggle', () => {
    renderField();
    const toggle = screen.getByTestId('analytics-from-toggle');
    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle);
  });

  it('closes on an outside mousedown', () => {
    renderField();
    fireEvent.click(screen.getByTestId('analytics-from-toggle'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays open on a mousedown inside the popover', () => {
    renderField();
    fireEvent.click(screen.getByTestId('analytics-from-toggle'));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('detaches its document listeners on unmount (no dangling global handlers)', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderField();
    fireEvent.click(screen.getByTestId('analytics-from-toggle'));
    unmount();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('mousedown', expect.any(Function));
    remove.mockRestore();
  });
});

describe('DateField — clearable', () => {
  it('is absent by default', () => {
    renderField();
    expect(screen.queryByTestId('analytics-from-clear')).not.toBeInTheDocument();
  });

  it('renders only while the value is non-empty', () => {
    const { unmount } = renderField({ clearable: true });
    expect(screen.getByTestId('analytics-from-clear')).toBeInTheDocument();
    unmount();

    renderField({ clearable: true, value: '' });
    expect(screen.queryByTestId('analytics-from-clear')).not.toBeInTheDocument();
  });

  it('emits the empty string and refocuses the input', () => {
    const { onChange } = renderField({ clearable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Kosongkan Dari' }));
    expect(onChange).toHaveBeenCalledWith('');
    expect(document.activeElement).toBe(screen.getByTestId('analytics-from'));
  });
});

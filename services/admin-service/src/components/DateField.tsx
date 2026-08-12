import { useCallback, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { DayPicker } from 'react-day-picker';
import { id as idLocale } from 'react-day-picker/locale';
import { formatDateKey, parseDateKey } from '../lib/date';
import { usePopoverDismiss } from '../lib/use-popover-dismiss';
import { CalendarIcon } from './CalendarIcon';

/**
 * The admin panel's date control — a `YYYY-MM-DD` text input paired with a
 * branded `react-day-picker` calendar popover. Replaces the native
 * `<input type="date">`, whose picker chrome is browser-supplied: it ignored
 * the store's brand color and dark mode, and rendered differently on every
 * machine the manager might use.
 *
 * **The text input stays the source of truth and `onChange` is a raw,
 * unfiltered passthrough of `e.target.value`, fired exactly once per change.**
 * The calendar is an *additional* way to set the same string. That contract is
 * what lets every existing page keep its `fireEvent.change(...)`-driven tests
 * and its `''`-means-unset semantics unchanged, and it keeps validation on the
 * page (which owns the range rules) rather than smuggling it into the control.
 *
 * The popover opens from the **toggle button only** — never on input focus,
 * which would fight typing and pop a calendar open on every keystroke. It is
 * non-modal: `role="dialog"` **without** `aria-modal` and no focus trap, since
 * `aria-modal` without a real trap lies to AT about the rest of the page being
 * inert. Focus returns to the toggle when the popover closes by selection or
 * Escape (but not on an outside click, which is already moving focus itself).
 *
 * Deliberately not on the surface: `min` / `max` / `disabledDates`. No call
 * site constrains the range in the control — `AnalyticsPage` validates
 * `from <= to` at the page level and the backend rejects malformed keys — so
 * adding them would be a speculative port.
 */
export interface DateFieldProps {
  /** Visible field label (also the popover's accessible name: "Pilih {label}"). */
  label: string;
  /** Controlled `YYYY-MM-DD`; `''` means "no date". */
  value: string;
  /** Receives the raw input string, or the picked day's local `YYYY-MM-DD`. */
  onChange: (value: string) => void;
  /** Accessible name for the input, when it should differ from the visible label. */
  ariaLabel?: string;
  /** `data-testid` for the input; derived ids for the toggle/clear buttons. */
  testId?: string;
  /** Stable id prefix for the input + popover wiring (defaults to a `useId()`). */
  idPrefix?: string;
  /** Renders a "clear" button while the value is non-empty (`''` is meaningful). */
  clearable?: boolean;
  /** Marks the input `aria-invalid` (the page owns the validation rule). */
  invalid?: boolean;
  /** Id of the call site's error/hint node, wired as `aria-describedby`. */
  describedById?: string;
  /** Slot rendered after the control — the call site keeps its own error node. */
  children?: ReactNode;
}

export function DateField({
  label,
  value,
  onChange,
  ariaLabel,
  testId,
  idPrefix,
  clearable = false,
  invalid = false,
  describedById,
  children,
}: DateFieldProps) {
  const reactId = useId();
  const baseId = idPrefix ?? reactId;
  const inputId = `${baseId}-input`;
  const popoverId = `${baseId}-popover`;

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const selected = parseDateKey(value);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);
  const closeQuietly = useCallback(() => setOpen(false), []);

  usePopoverDismiss({
    open,
    rootRef,
    onEscape: closeAndRestoreFocus,
    onOutside: closeQuietly,
  });

  // Tabbing out of the whole field closes the popover. `relatedTarget === null`
  // (focus left to the body) counts as outside.
  function handleFocusOut(e: FocusEvent<HTMLDivElement>) {
    if (!open) return;
    const next = e.relatedTarget as Node | null;
    if (!next || !rootRef.current?.contains(next)) setOpen(false);
  }

  return (
    <div className="field datefield" ref={rootRef} onBlur={handleFocusOut}>
      {/* Sibling label, never wrapping: a wrapping <label> would pull the
          popover's day-button text into the field's accessible name. */}
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="datefield__control">
        <input
          id={inputId}
          ref={inputRef}
          className="field__input datefield__input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="YYYY-MM-DD"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={describedById}
          data-testid={testId}
        />
        {clearable && value !== '' && (
          <button
            type="button"
            className="datefield__clear"
            aria-label={`Kosongkan ${label}`}
            data-testid={testId ? `${testId}-clear` : undefined}
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
        <button
          type="button"
          ref={toggleRef}
          className="datefield__toggle"
          aria-label={`Buka kalender ${label}`}
          aria-expanded={open}
          aria-controls={popoverId}
          aria-haspopup="dialog"
          data-testid={testId ? `${testId}-toggle` : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <CalendarIcon />
        </button>
        {open && (
          <div
            id={popoverId}
            className="datefield__popover"
            role="dialog"
            aria-label={`Pilih ${label}`}
          >
            <DayPicker
              mode="single"
              // `required` keeps a second click on the selected day from
              // clearing the value: emptying the field is the clear button's
              // job, and a silent deselect would look like a no-op.
              required
              locale={idLocale}
              autoFocus
              selected={selected ?? undefined}
              defaultMonth={selected ?? new Date()}
              onSelect={(day) => {
                onChange(formatDateKey(day));
                closeAndRestoreFocus();
              }}
            />
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

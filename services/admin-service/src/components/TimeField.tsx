import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { normalizeTimeInput } from '../lib/time';
import { usePopoverDismiss } from '../lib/use-popover-dismiss';

/**
 * The admin panel's time-of-day control — an `HH:MM` text input paired with a
 * Jam/Menit picker popover. The date sibling of {@link DateField}; the two
 * share a prop shape on purpose so a call site reads the same either way.
 *
 * Hand-rolled rather than vendored: `react-day-picker` is a *date* picker, and
 * a two-column list of buttons is not worth a second dependency (the same
 * minimal-dependency reasoning as the hand-rolled charts and audio sequencer,
 * NFR-REL-01).
 *
 * **The buffered draft is load-bearing.** Unlike {@link DateField}, this field
 * does NOT pass typing straight through: it holds a `draft` and emits only when
 * {@link normalizeTimeInput} returns a complete value. The only call sites
 * round-trip through `timeToCron` (`lib/daily-reset.ts`), which falls back to
 * `'0 0 * * *'` on anything malformed — so a raw passthrough would rewrite the
 * value to `00:00` on every intermediate keystroke ("0", "08", "08:") and the
 * field would fight the manager mid-entry. Native `<input type="time">` never
 * had this problem because browsers only emit complete values; the draft
 * restores that contract. The draft re-syncs from `value` whenever the parent
 * changes it, so an external update (a config reload) still wins.
 *
 * The popover offers every hour and every minute — no 5-minute step, which
 * would silently narrow what the backend cron grammar accepts. Selecting a cell
 * emits immediately and **keeps the popover open**, since the manager almost
 * always sets both halves.
 */
export interface TimeFieldProps {
  /** Visible field label (also the popover's accessible name: "Pilih {label}"). */
  label: string;
  /** Controlled `HH:MM`. */
  value: string;
  /** Fires only with a complete, in-range `HH:MM`. */
  onChange: (value: string) => void;
  /** Accessible name for the input, when it should differ from the visible label. */
  ariaLabel?: string;
  /** `data-testid` for the input; derived ids for the toggle button. */
  testId?: string;
  /** Stable id prefix for the input + popover wiring (defaults to a `useId()`). */
  idPrefix?: string;
  /** Marks the input `required` and adds the conventional `*` marker. */
  required?: boolean;
  /** Marks the input `aria-invalid` (the page owns the validation rule). */
  invalid?: boolean;
  /** Id of the call site's error/hint node, wired as `aria-describedby`. */
  describedById?: string;
  /** Slot rendered after the control — the call site keeps its own error node. */
  children?: ReactNode;
}

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, '0'));

export function TimeField({
  label,
  value,
  onChange,
  ariaLabel,
  testId,
  idPrefix,
  required = false,
  invalid = false,
  describedById,
  children,
}: TimeFieldProps) {
  const reactId = useId();
  const baseId = idPrefix ?? reactId;
  const inputId = `${baseId}-input`;
  const popoverId = `${baseId}-popover`;

  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  // An external change (config reload, a sibling control rewriting the cron)
  // overwrites whatever the manager had half-typed — the parent is authoritative.
  useEffect(() => setDraft(value), [value]);

  const committed = normalizeTimeInput(value);
  const [currentHour, currentMinute] = (committed ?? '').split(':');

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

  // Bring the current selection into view when the popover opens — the minute
  // column is 60 rows tall, so an unscrolled list would hide most selections.
  // jsdom implements neither scrollIntoView nor layout, hence the optional call.
  useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelectorAll<HTMLElement>('.timefield__option[aria-pressed="true"]')
      .forEach((el) => el.scrollIntoView?.({ block: 'center' }));
  }, [open]);

  /**
   * Focus leaving the whole field closes the popover AND reconciles the draft.
   *
   * The reconcile is the important half, and it must run whether or not the
   * popover is open. A draft that never normalized was never committed, so
   * without it the input can display a value the parent does not hold: clear
   * `08:30` to `''` and no `onChange` fires (incomplete), `value` never changes
   * so the sync effect above cannot re-fire, and the field renders empty while
   * the form still holds `30 8 * * *`. `cronError` derives from the committed
   * cron, not the draft, so nothing blocks the save and the manager gets 08:30
   * back from a field that looked blank. Snapping back to `value` restores the
   * guarantee `<input type="time">` gave for free: what is displayed is what
   * will be submitted.
   */
  function handleFocusOut(e: FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    if (open) setOpen(false);
    if (normalizeTimeInput(draft) === null) setDraft(value);
  }

  /** Emits a new time built from the committed value, defaulting the other half to `00`. */
  function pick(part: 'hour' | 'minute', picked: string) {
    const [h, m] = (committed ?? '00:00').split(':');
    onChange(part === 'hour' ? `${picked}:${m}` : `${h}:${picked}`);
  }

  return (
    <div className="field timefield" ref={rootRef} onBlur={handleFocusOut}>
      <label className="field__label" htmlFor={inputId}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <div className="timefield__control">
        <input
          id={inputId}
          className="field__input timefield__input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="HH:MM"
          value={draft}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            const normalized = normalizeTimeInput(raw);
            if (normalized !== null) onChange(normalized);
          }}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={describedById}
          required={required || undefined}
          data-testid={testId}
        />
        <button
          type="button"
          ref={toggleRef}
          className="timefield__toggle"
          aria-label={`Buka pemilih jam ${label}`}
          aria-expanded={open}
          aria-controls={popoverId}
          aria-haspopup="dialog"
          data-testid={testId ? `${testId}-toggle` : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <ClockIcon />
        </button>
        {open && (
          <div
            id={popoverId}
            className="timefield__popover"
            role="dialog"
            aria-label={`Pilih ${label}`}
          >
            <TimeColumn
              heading="Jam"
              options={HOURS}
              selected={currentHour}
              onPick={(v) => pick('hour', v)}
            />
            <TimeColumn
              heading="Menit"
              options={MINUTES}
              selected={currentMinute}
              onPick={(v) => pick('minute', v)}
            />
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * One labelled column of time cells.
 *
 * The visible "Jam"/"Menit" heading is a non-heading `aria-hidden` div — a real
 * heading inside a popover would invert the page's heading outline — so the
 * grouping structure for AT has to come from `role="group"` + `aria-label` on
 * the cells container, otherwise screen-reader users hear one flat run of
 * numbers with no idea which column they are in.
 *
 * The cells are `<button aria-pressed>` and **never `role="option"`**:
 * `role="option"` implies a `listbox` parent with `aria-selected` semantics,
 * which is wrong for buttons that commit a value on click.
 */
function TimeColumn({
  heading,
  options,
  selected,
  onPick,
}: {
  heading: string;
  options: readonly string[];
  selected: string | undefined;
  onPick: (value: string) => void;
}) {
  return (
    <div className="timefield__column">
      <div className="timefield__column-label" aria-hidden="true">
        {heading}
      </div>
      <div className="timefield__options" role="group" aria-label={heading}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className="timefield__option"
            aria-pressed={o === selected}
            onClick={() => onPick(o)}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Decorative clock glyph — hand-rolled inline SVG, no icon library (NFR-REL-01). */
function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={12} cy={12} r={9} />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

import { useCallback, useId, useRef, useState, type FocusEvent } from 'react';
import { DayPicker } from 'react-day-picker';
import type { DateRange } from 'react-day-picker';
import { id as idLocale } from 'react-day-picker/locale';
import { formatDateKey, parseDateKey } from '../lib/date';
import { usePopoverDismiss } from '../lib/use-popover-dismiss';
import { CalendarIcon } from './CalendarIcon';

/**
 * The analytics range selector — ONE grouped textbox that opens a
 * `react-day-picker` **range** calendar. This is the unification the manager
 * asked for: `/admin/analytics` used to have three separate affordances — a
 * "Kustom" button, a calendar toggle button, and a text input — that the
 * manager had to discover and coordinate. Here the whole trigger is a single
 * grouped box showing `from – to` (or `Dari – Sampai` placeholders); clicking
 * it anywhere opens a two-month range calendar.
 *
 * Typing is intentionally NOT supported: the relative-range presets cover the
 * common windows (7 / 14 / 30 / 90 hari) and the calendar covers every
 * arbitrary window (including past dates via the month navigation). A text
 * input would re-introduce the malformed/inverted-range branches the calendar
 * structurally cannot produce — the calendar only ever emits a COMPLETE,
 * in-order pair of local `YYYY-MM-DD` keys, so the page's defensive
 * `rangeInvalid` guard is unreachable from this control (it stays as
 * defense-in-depth against future callers).
 *
 * **Controlled two-click selection (v10 adaptation).** react-day-picker v10's
 * native `mode="range"` commits a COMPLETE range on every single click — on an
 * empty range the first click yields `{from: d, to: d}`, and on an existing
 * range a click moves the nearest endpoint. That would close the popover on
 * the first click (wrong) and fire an intermediate single-day load. To give
 * the classic "click start, click end, done" flow and commit exactly once,
 * `DateRangeField` drives the selection itself via `triggerDate` (the 2nd arg
 * of `onSelect`): the first click records an `anchor` and shows a partial
 * `{from: anchor, to: undefined}` highlight WITHOUT committing; the second
 * click completes the range, fires `onRangeChange` once with an in-order pair,
 * and closes. Selecting a day before the anchor naturally resets the start
 * (the pair is reordered before commit). The `DayPicker` is kept
 * `selected={working}` so the partial start is highlighted between clicks.
 *
 * **Presentational + owns no committed range (SRP / DIP).** The page owns
 * `from`/`to`; this component owns only local UI state — `open`, the
 * `working` highlight, and the `anchor` that remembers the first click. The
 * page hears about a range only when both ends are picked: `onRangeChange`
 * fires exactly once per completed selection.
 *
 * Validation stays on the page (defense in depth): `invalid` /
 * `describedById` are pass-through wiring so the page can flag the trigger
 * against its own error node even though the calendar itself cannot produce an
 * invalid range.
 *
 * The popover mirrors `DateField`'s proven non-modal pattern: `role="dialog"`
 * **without** `aria-modal` and no focus trap (an unbacked `aria-modal` would
 * lie to AT about the rest of the page being inert). Focus returns to the
 * trigger when the popover closes by completion or Escape, but NOT on an
 * outside click (the browser is already moving focus there). A sibling
 * `<span className="field__label">` — never a wrapping `<label>` — so the
 * calendar's day-button text is not pulled into the field's accessible name
 * (same reason as `DateField`).
 */
export interface DateRangeFieldProps {
  /** Visible group label; also the popover's accessible name: "Pilih {label}".
   *  Defaults to "Rentang tanggal". */
  label?: string;
  /** Controlled `YYYY-MM-DD`; `''` means "no date". */
  from: string;
  /** Controlled `YYYY-MM-DD`; `''` means "no date". */
  to: string;
  /** Receives a COMPLETE, in-order pair of local `YYYY-MM-DD` keys. Fired
   *  exactly once per completed calendar selection (both ends picked). */
  onRangeChange: (from: string, to: string) => void;
  /** `data-testid` for the trigger button; derived ids for popover wiring.
   *  Defaults to "analytics-range". */
  testId?: string;
  /** Marks the trigger `aria-invalid` (the page owns the validation rule —
   *  defense in depth, since the calendar only emits valid in-order keys). */
  invalid?: boolean;
  /** Id of the call site's error/hint node, wired as `aria-describedby`. */
  describedById?: string;
}

export function DateRangeField({
  label = 'Rentang tanggal',
  from,
  to,
  onRangeChange,
  testId = 'analytics-range',
  invalid = false,
  describedById,
}: DateRangeFieldProps) {
  const reactId = useId();
  const popoverId = `${reactId}-popover`;

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // The first click of a two-click selection. `null` before the first click
  // and after a completed selection (so a reopen restarts cleanly).
  const [anchor, setAnchor] = useState<Date | null>(null);
  // The controlled highlight shown by DayPicker. Seeded from the committed
  // `from`/`to` when the popover opens; updated to `{from: anchor, to:
  // undefined}` after the first click so the partial start is visible.
  const [working, setWorking] = useState<DateRange | undefined>(undefined);

  const committedFrom = parseDateKey(from);
  const committedTo = parseDateKey(to);
  const committedRange: DateRange | undefined =
    committedFrom || committedTo
      ? { from: committedFrom ?? undefined, to: committedTo ?? undefined }
      : undefined;

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    setAnchor(null);
    setWorking(undefined);
    triggerRef.current?.focus();
  }, []);
  const closeQuietly = useCallback(() => {
    setOpen(false);
    setAnchor(null);
    setWorking(undefined);
  }, []);

  usePopoverDismiss({
    open,
    rootRef,
    onEscape: closeAndRestoreFocus,
    onOutside: closeQuietly,
  });

  // Tabbing out of the whole field closes the popover. `relatedTarget === null`
  // (focus left to the body) counts as outside. Mirrors DateField.
  function handleFocusOut(e: FocusEvent<HTMLDivElement>) {
    if (!open) return;
    const next = e.relatedTarget as Node | null;
    if (!next || !rootRef.current?.contains(next)) {
      setOpen(false);
      setAnchor(null);
      setWorking(undefined);
    }
  }

  /** Opens the popover, resetting any stale partial selection so the calendar
   *  re-seeds its highlight from the page's committed `from`/`to`. */
  function openPopover() {
    setAnchor(null);
    setWorking(committedRange);
    setOpen(true);
  }

  return (
    <div className="field date-range-field" ref={rootRef} onBlur={handleFocusOut}>
      {/* Sibling label, never wrapping: a wrapping <label> would pull the
          popover's day-button text into the field's accessible name. */}
      <span className="field__label">{label}</span>
      <button
        type="button"
        ref={triggerRef}
        className="date-range-field__trigger"
        aria-label={`Buka kalender ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-invalid={invalid || undefined}
        aria-describedby={describedById}
        data-testid={testId}
        onClick={() => (open ? closeQuietly() : openPopover())}
      >
        <span className={`date-range-field__from${from ? '' : ' date-range-field__from--placeholder'}`}>
          {from || 'Dari'}
        </span>
        <span className="date-range-field__sep" aria-hidden="true">–</span>
        <span className={`date-range-field__to${to ? '' : ' date-range-field__to--placeholder'}`}>
          {to || 'Sampai'}
        </span>
        {/* The glyph is INSIDE the trigger, NOT a separate button — this is the
            whole point: no separate calendar button, no separate "Kustom"
            button. The grouped textbox is the single affordance. */}
        <CalendarIcon />
      </button>
      {open && (
        <div
          id={popoverId}
          className="date-range-field__popover"
          role="dialog"
          aria-label={`Pilih ${label}`}
        >
          <DayPicker
            mode="range"
            numberOfMonths={2}
            locale={idLocale}
            autoFocus
            selected={working}
            defaultMonth={committedFrom ?? committedTo ?? new Date()}
            // v10's native range mode commits a complete range on every single
            // click (empty→{d,d}, existing→moves nearest endpoint). To give the
            // classic two-click flow and commit exactly once, drive the
            // selection via `triggerDate`: the first click records an anchor
            // and shows a partial highlight WITHOUT committing; the second
            // click reorders the pair, commits, and closes.
            onSelect={(_range, triggerDate) => {
              if (!anchor) {
                setAnchor(triggerDate);
                setWorking({ from: triggerDate, to: undefined });
                return;
              }
              const [f, t] =
                triggerDate < anchor ? [triggerDate, anchor] : [anchor, triggerDate];
              onRangeChange(formatDateKey(f), formatDateKey(t));
              closeAndRestoreFocus();
            }}
          />
        </div>
      )}
    </div>
  );
}
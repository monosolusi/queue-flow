import { useEffect, useId, useRef, useState } from 'react';
import type { TransferCandidate } from '../lib/workflow-actions';

export interface TransferActionProps {
  /** The fixed button label — "Pindah Kategori" (FR-CLR-03), a standalone panel
   *  action not derived from the flow. */
  readonly actionLabel: string;
  /** Destination categories (the counter's, minus the ticket's own). */
  readonly candidates: readonly TransferCandidate[];
  /** True while this ticket's transfer is in flight. */
  readonly busy: boolean;
  /** True while a *different* command from the same runner is in flight: the
   *  transfer must not start a second one, but this button is not the one
   *  running, so it keeps its label instead of showing the busy ellipsis. */
  readonly disabled?: boolean;
  readonly onTransfer: (targetCategoryId: string) => void;
  /** Test-id stem: the toggle uses it verbatim, the chooser and each
   *  destination option derive from it (one transfer per ticket, so the stem is
   *  unique across the workspace). */
  readonly idPrefix: string;
}

/**
 * The standalone "Pindah Kategori" button and its destination chooser
 * (FR-CLR-03), used only by the active-ticket action panel. It is no longer a
 * flow edge, so its label is a fixed string rather than a transition's
 * `actionLabel`. The destination rules:
 *
 * - exactly one other category on this counter → a direct button (nothing to
 *   choose);
 * - two or more → an inline chooser so staff pick by name.
 *
 * (No-destination is handled by the caller: the cluster is not rendered when the
 * counter serves only the ticket's own category, so a perpetually-disabled
 * button never appears.)
 *
 * Collapsing the chooser when the ticket changes is the caller's job: render
 * this with a `key` that includes the ticket id and React remounts it.
 */
export function TransferAction({
  actionLabel,
  candidates,
  busy,
  disabled = false,
  onTransfer,
  idPrefix,
}: TransferActionProps) {
  const [open, setOpen] = useState(false);
  // Stable id linking the toggle (`aria-controls`) to its chooser, so AT can
  // associate the expanded options with the toggle (QUE-40 AC4).
  const chooserId = useId();
  // The queue lists are capped scroll containers (styles.css), so a row near the
  // bottom can expand its chooser below the cut: on a touch panel the tap would
  // read as a dead button. `block: 'nearest'` scrolls only when it has to, and
  // only the nearest scrollable ancestor — the panel's own copy of this control
  // sits in no scroller and stays put.
  const chooserRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    chooserRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  if (candidates.length === 0) {
    return (
      <button
        type="button"
        className="btn btn--secondary transfer-action__btn transfer-action__btn--unavailable"
        data-testid={idPrefix}
        disabled
        title="Tidak ada kategori lain untuk dituju"
      >
        {actionLabel} (tidak ada kategori lain)
      </button>
    );
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    return (
      <button
        type="button"
        className="btn btn--secondary transfer-action__btn"
        data-testid={idPrefix}
        onClick={() => onTransfer(only.id)}
        disabled={busy || disabled}
      >
        {busy ? '…' : actionLabel}
      </button>
    );
  }

  return (
    <div className="transfer-action">
      <button
        type="button"
        className="btn btn--secondary transfer-action__btn"
        data-testid={idPrefix}
        aria-expanded={open}
        aria-controls={chooserId}
        onClick={() => setOpen((o) => !o)}
        disabled={busy || disabled}
      >
        {busy ? '…' : actionLabel}
      </button>
      {open && (
        <div
          ref={chooserRef}
          id={chooserId}
          className="transfer-action__chooser"
          data-testid={`${idPrefix}-chooser`}
          role="group"
          aria-label="Kategori tujuan"
        >
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn transfer-action__option"
              data-testid={`${idPrefix}-target-${c.id}`}
              onClick={() => {
                onTransfer(c.id);
                setOpen(false);
              }}
              disabled={busy || disabled}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

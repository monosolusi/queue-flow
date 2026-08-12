/**
 * A running-text (marquee) disclaimer strip (manager feedback: customers
 * didn't realize their ticket was called — the disclaimer reminds them
 * numbers may not be in order).
 *
 * Rendered as a TV-grid widget (placed by the manager via `tvPanelLayout`),
 * filling its grid cell. Pure presentational (SRP — no state, no effect, no
 * store wiring). The message is a UI constant; it is NOT wired to
 * `SystemConfiguration` or any store, mirroring the "audio is a pure client
 * concern / no speculative ports" precedent. An optional `text` prop
 * overrides the default for tests.
 *
 * Distinct from the removed promo standby overlay (FR-TV-03): no media
 * assets, no crossfade, no ticket-count conditionality, reduced-motion
 * guarded. The `.running-text` viewport fills its grid widget wrapper
 * (width:100%, height:100%) — the wrapper provides the cell.
 */
const DEFAULT_TEXT =
  'Nomor antrian tidak selalu berurutan — harap perhatikan panggilan nomor Anda dan counter yang dituju.';

export function RunningText({ text = DEFAULT_TEXT }: { text?: string } = {}) {
  return (
    <div
      className="running-text"
      role="marquee"
      aria-label={text}
      data-testid="running-text"
    >
      <div className="running-text__track">
        {/* The two identical items make the translateX(-50%) loop seamless.
            Both are hidden from the a11y tree (aria-hidden="true") so the
            moving text is not exposed as navigable content; the parent
            `aria-label` is the sole AT channel — the disclaimer is announced
            once, not duplicated per item. */}
        <span className="running-text__item" aria-hidden="true">
          {text}
        </span>
        <span className="running-text__item" aria-hidden="true">
          {text}
        </span>
      </div>
    </div>
  );
}
import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * A store brand color, persisted on {@link SystemConfiguration} and consumed by
 * the frontends to theme `--accent` (the FE foundation ticket derives the
 * accent + brand-tinted neutrals from it at load). PRD §7 `SystemConfiguration`
 * gains this field so a store's UI carries its own identity instead of the
 * shared default blue.
 *
 * Two grammars are accepted (AC1: "validasi hex/OKLCH"):
 *  - hex: `#rgb`, `#rrggbb`, `#rrggbbaa` (case-insensitive, normalized lowercase).
 *    This is what the wizard/admin native `<input type="color">` emits and what
 *    `--accent` consumes.
 *  - oklch: `oklch(L C H)` / `oklch(L C H / A)` — a *structural* shape check
 *    (numeric / percent / degree components). The VO rejects garbage; the CSS
 *    engine (the `--accent` consumer) is the final arbiter of gamut validity, not
 *    the VO. OKLCH is reachable only via a direct API call — the UI picker emits
 *    hex — so over-validating it adds cost without benefit.
 *
 * Construction failures throw `InvalidValueObjectException` (a `DomainError`),
 * which `DomainExceptionFilter` maps to HTTP 400 — the QUE-31 precedent: a
 * value-object *format* rejection is an `InvalidValueObjectException`, never a
 * bare `Error`/`InvalidArgumentException`. Equality is *textual* (the normalized
 * stored string), not semantic color equality; two different strings naming the
 * same color are not `equals`. `brandColor` is not change-gated today, so this
 * only matters if a future ticket adds brand-color diff-audit.
 */

/** Hex: `#rgb`, `#rrggbb`, `#rrggbbaa` (case-insensitive). */
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// oklch(L C H) | oklch(L C H / A). Component grammar (permissive): a number,
// a percentage, or a number with a `deg`/`%`/`turn`/`rad` unit. We do not enforce
// gamut ranges — only the structural shape. Declared BEFORE the class so the
// `static DEFAULT` initializer (which calls `BrandColor.of` during class init)
// can read them — a `const` below the class would be in the temporal dead zone
// at static-init time and throw `Cannot access 'HEX_RE' before initialization`.
const COMPONENT = /(-?\d*\.?\d+(?:%|deg|turn|rad)?)/;
const OKLCH_RE = new RegExp(
  `^oklch\\s*\\(\\s*${COMPONENT.source}\\s+${COMPONENT.source}\\s+${COMPONENT.source}(?:\\s*\\/\\s*${COMPONENT.source})?\\s*\\)$`,
  'i',
);

/**
 * Structural `oklch(...)` shape: `oklch(L C H)` or `oklch(L C H / A)` where each
 * component is a number, a percentage (`C`/`A`), or `L`/`H` may carry `deg`/`%`.
 * Permissive by design — CSS is the final arbiter. Returns a canonical form
 * rebuilt from the matched components (`oklch(L C H)` / `oklch(L C H / A)`,
 * keyword lowercased, single spaces, no inner-parens padding), or `null` if the
 * shape is wrong.
 */
function normalizeOklch(input: string): string | null {
  const match = input.match(OKLCH_RE);
  if (!match) {
    return null;
  }
  // match[1..3] = L C H; match[4] = optional alpha. Lowercase the keyword and
  // rebuild with single spaces so `OKLCH(  0.7   0.15   200 )` -> `oklch(0.7 0.15 200)`.
  const [, l, c, h, a] = match;
  return a !== undefined
    ? `oklch(${l} ${c} ${h} / ${a})`
    : `oklch(${l} ${c} ${h})`;
}

export class BrandColor extends ValueObject<string> {
  private constructor(value: string) {
    super(value);
  }

  public static of(raw: string): BrandColor {
    if (typeof raw !== 'string') {
      throw new InvalidValueObjectException(`brand color must be a string, got '${String(raw)}'`);
    }
    const trimmed = raw.trim();
    if (HEX_RE.test(trimmed)) {
      return new BrandColor(trimmed.toLowerCase());
    }
    const oklch = normalizeOklch(trimmed);
    if (oklch !== null) {
      return new BrandColor(oklch);
    }
    throw new InvalidValueObjectException(
      `brand color must be a valid hex (#rgb | #rrggbb | #rrggbbaa) or oklch(...) color, got '${raw}'`,
    );
  }

  /** Matches the hardcoded `--accent: #2563eb` across all four frontends, so a
   * store that never sets a brand color keeps the existing look — "default yang
   * masuk akal" (AC1). */
  public static DEFAULT: BrandColor = BrandColor.of('#2563eb');

  public get value(): string {
    return this.props;
  }

  public toString(): string {
    return this.value;
  }
}
/**
 * Pure cron-expression format validation (QUE-32 / NFR-SEC-02). Mirrors the
 * client-side `admin-service/src/lib/cron.ts` (`validateCronExpression`) so the
 * backend `DailyResetPolicy` value object rejects, at construction, any
 * expression the boot-time / re-arm `CronJob` would reject — defense-in-depth
 * so a direct API call that bypasses the client guard cannot persist a cron
 * that crashes the scheduler. Both checks accept the **same strict subset** of
 * the `cron` library's grammar on purpose (see below).
 *
 * This is a pure domain helper: no framework, regex-only, no I/O — domain
 * purity (NFR-MNT-01) holds. The helper returns a boolean; the value object
 * that calls it throws `InvalidValueObjectException` on a `false` result (it is
 * not this helper's job to raise or to format UI messages — the client helper
 * owns the Indonesian UI strings, this one owns the yes/no domain decision).
 * Localized duplication of `admin-service/src/lib/cron.ts` is intentional: the
 * two packages are separate build trees (backend domain vs frontend bundle) on
 * either side of a TS/runtime boundary, and sharing a single validator across
 * that boundary would cross-couple them for one small pure function — the
 * mirror framing (and the failing-test drift signal) is preferred over a shared
 * package. The two grammars MUST stay in lock-step; a divergence is a bug.
 *
 * Validates the standard 5-field expression (minute hour day-of-month month
 * day-of-week). Each field accepts star, plain numbers, comma lists, ranges
 * (`a-b`), and steps (star-slash-n, `a-b/n`, `a/n`). Named months/days are
 * intentionally not supported — the PRD §7 default is numeric (`0 0 * * *`) and
 * keeping the grammar strict avoids accepting an expression the scheduler
 * interprets differently than the validator (e.g. `@daily`, `L`, `W`, `#`).
 */

interface FieldRange {
  readonly min: number;
  readonly max: number;
}

// day-of-week: 0 and 7 both denote Sunday (the `cron` library accepts both).
const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day-of-week (0 and 7 = Sunday)
];

function validField(field: string, min: number, max: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    if (part === '') return false;
    let base = part;
    let step = 1;
    const stepIdx = part.indexOf('/');
    if (stepIdx !== -1) {
      base = part.slice(0, stepIdx);
      const stepStr = part.slice(stepIdx + 1);
      if (!/^\d+$/.test(stepStr)) return false;
      step = Number(stepStr);
      if (step < 1) return false;
    }
    if (base === '*') continue; // `*/n`
    const dashIdx = base.indexOf('-');
    if (dashIdx !== -1) {
      const loStr = base.slice(0, dashIdx);
      const hiStr = base.slice(dashIdx + 1);
      if (!/^\d+$/.test(loStr) || !/^\d+$/.test(hiStr)) return false;
      const lo = Number(loStr);
      const hi = Number(hiStr);
      if (lo < min || hi > max || lo > hi) return false;
    } else {
      if (!/^\d+$/.test(base)) return false;
      const v = Number(base);
      if (v < min || v > max) return false;
    }
  }
  return true;
}

/**
 * @returns `true` when `expr` is a valid 5-field cron expression (per the
 *   strict grammar above), `false` otherwise. Empty / whitespace-only input is
 *   invalid here — the `DailyResetPolicy` factory guards non-emptiness for the
 *   `AUTOMATIC_CRON` mode separately (so the non-empty message stays specific).
 */
export function isValidCronExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed === '') return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  for (let i = 0; i < 5; i++) {
    const { min, max } = FIELD_RANGES[i];
    if (!validField(fields[i], min, max)) return false;
  }
  return true;
}
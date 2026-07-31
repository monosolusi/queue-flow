/**
 * Client-side cron expression validation (FR-WZD-05 / QUE-16). Mirrors what the
 * `cron` library's `CronJob` accepts at boot so the wizard / admin panel never
 * submits an expression the scheduler would reject. The backend
 * `DailyResetPolicy` value object only checks the string is **non-empty** when
 * `mode === AUTOMATIC_CRON`; backend cron-*format* enforcement is deferred to
 * the Hardening milestone (it pairs with scheduler re-arm, where an invalid cron
 * surfaces as a boot error). Until then this client check is what keeps an
 * invalid cron unconstructable — following the CLAUDE.md rule: mirror the VO
 * invariant in client validation AND use a constrained check so invalid states
 * cannot be submitted, rather than relying on a backend 400 round-trip.
 *
 * Validates the standard 5-field expression (minute hour day-of-month month
 * day-of-week). Each field accepts star, plain numbers, comma lists, ranges
 * (`a-b`), and steps (star-slash-n, `a-b/n`, `a/n`). Named months/days are
 * intentionally not supported — the PRD §7 default is numeric (`0 0 * * *`) and
 * keeping the grammar strict avoids accepting an expression the boot-time
 * scheduler interprets differently.
 *
 * @returns an Indonesian error string when invalid, or `null` when valid.
 */

interface FieldRange {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

// day-of-week: 0 and 7 both denote Sunday (the `cron` library accepts both).
const FIELD_RANGES: readonly FieldRange[] = [
  { name: 'menit', min: 0, max: 59 },
  { name: 'jam', min: 0, max: 23 },
  { name: 'tanggal', min: 1, max: 31 },
  { name: 'bulan', min: 1, max: 12 },
  { name: 'hari', min: 0, max: 7 },
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

export function validateCronExpression(expr: string): string | null {
  const trimmed = expr.trim();
  if (trimmed === '') return 'Cron expression tidak boleh kosong.';
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return 'Cron expression harus memiliki 5 field (menit jam tanggal bulan hari).';
  }
  for (let i = 0; i < 5; i++) {
    const { name, min, max } = FIELD_RANGES[i];
    if (!validField(fields[i], min, max)) {
      return `Field ${name} ('${fields[i]}') tidak valid.`;
    }
  }
  return null;
}
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * jsdom runs with `css: false` (vite.config), so stylesheets are NOT applied and
 * layout/overflow is not observable from a rendered test. CSS-driven behaviour is
 * therefore guarded statically here, mirroring tv-display-service's harness: read
 * styles.css (co-located via import.meta.url — ESM-safe, no `__dirname`),
 * collapse whitespace, and assert against the DECLARATION BLOCK of a selector.
 * Asserting on the extracted block rather than the whole file matters: a bare
 * `toContain` over the file would happily match the prose in a comment.
 *
 * `node:fs` and not a Vite `?raw` import: `css: false` stubs CSS modules out to
 * an empty string, and the `?raw` query does not escape that — the stylesheet
 * arrives blank and every guard here would pass vacuously. Reading from disk is
 * what makes these assertions real (hence the `node` entry in tsconfig types,
 * mirroring tv-display-service and admin-service).
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, 'styles.css'), 'utf8').replace(/\s+/g, ' ');

/**
 * EVERY declaration block written for a selector, joined. Every block, not the
 * first: a later `@media (max-height: …) { .skipped-queue__list { overflow:
 * hidden } }` would slip past a first-match guard — which is exactly the
 * reachability regression these tests exist to stop.
 */
function rule(sel: string): string {
  const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `(^|[\s,{}])` keeps `.skipped-queue__list` from also matching
  // `.skipped-queue__list--actionable`'s block.
  const re = new RegExp(`(?:^|[\\s,{}])${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const blocks = [...css.matchAll(re)].map((m) => m[1]);
  if (blocks.length === 0) throw new Error(`selector not found: ${sel}`);
  return blocks.join(' ');
}

/** The `max-height` cap of a list rule, in rem. */
function capRem(sel: string): number {
  const m = rule(sel).match(/max-height:\s*([\d.]+)rem/);
  expect(m, `${sel} must declare a rem max-height`).not.toBeNull();
  return parseFloat(m![1]);
}

const QUEUE_LISTS = ['.waiting-queue__list', '.skipped-queue__list'] as const;

describe('caller queue lists are capped and scrollable', () => {
  // Manager feedback: "pada /caller ketika tiket dilewati banyak tampilan jadi
  // semakin kebawah". Unbounded lists grew the page, pushing the action panel
  // off screen. Each list now scrolls inside its own card.
  it.each(QUEUE_LISTS)('%s caps its height to about three actionable row bands', (sel) => {
    // ~8rem per actionable band (padding + number line + gap + action button),
    // so the cap must stay at or under 24rem to keep the page from growing.
    const cap = capRem(sel);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(24);
  });

  it('both lists share one cap (a taller waiting list would push the skipped one down again)', () => {
    expect(capRem('.waiting-queue__list')).toBe(capRem('.skipped-queue__list'));
  });

  it.each(QUEUE_LISTS)('%s scrolls rather than clipping (reachability is the invariant)', (sel) => {
    const list = rule(sel);
    expect(list).toContain('overflow-y: auto');
    // Never `hidden` in any form: a capped list that clips hides rows the staff
    // can then never tap ("kenapa jadi tidak bisa scroll ya?").
    expect(list).not.toMatch(/overflow(-[xy])?:\s*(hidden|clip)/);
  });

  it.each(QUEUE_LISTS)('%s caps with max-height only — never a fixed height', (sel) => {
    // A fixed `height` would stretch a short list into dead space and, worse,
    // stop the cap from being a cap. `(^|[\s;])` keeps `max-height:` out of it.
    expect(rule(sel)).not.toMatch(/(^|[\s;])height:/);
  });
});

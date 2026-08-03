import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * jsdom runs with `css: false` (vitest.config), so stylesheets are NOT applied
 * and computed visibility/opacity/contrast are not testable. CSS-driven ACs are
 * guarded statically here: read styles.css (co-located via import.meta.url —
 * ESM-safe, no `__dirname`), collapse whitespace, and regex-assert the rules.
 * (postcss is not a direct dependency, so a normalized-regex guard is the
 * pragmatic choice; contrast can't be computed from CSS strings so AC2/AC5
 * assert the token usage that QUE-37 established.)
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, 'styles.css'), 'utf8').replace(/\s+/g, ' ');

/** Extracts the declaration block of a selector (greedy to the closing brace). */
function rule(sel: string): string {
  const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`selector not found: ${sel}`);
  return m[1];
}

describe('styles.css AC guards', () => {
  it('AC2: now-serving counter uses --accent-on-dark (QUE-37 regression)', () => {
    expect(rule('.now-serving__counter')).toContain('color: var(--accent-on-dark)');
  });

  it('AC5: connection closed uses --danger-on-dark (QUE-37 regression)', () => {
    expect(rule('.connection-status--closed')).toContain('color: var(--danger-on-dark)');
  });

  it('AC3: now-serving number is fluid clamp(8rem,22vw,22rem) + a 4K media tier', () => {
    expect(rule('.now-serving__number')).toContain('clamp(8rem, 22vw, 22rem)');
    expect(css).toMatch(/@media\s*\(min-width:\s*2560px\)/);
    // The 4K tier bumps the number into the 4-figure rem range.
    const tierMatch = css.match(
      /@media\s*\(min-width:\s*2560px\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/,
    );
    expect(tierMatch?.[1]).toContain('clamp(14rem, 22vw, 44rem)');
  });

  it('AC3: grid-cell containment — now-serving + call-history allow shrinking', () => {
    expect(rule('.now-serving')).toContain('min-width: 0');
    expect(rule('.call-history')).toContain('min-width: 0');
  });

  it('AC4: call-history items use a hairline divider, not nested card backgrounds', () => {
    const item = rule('.call-history__item');
    expect(item).toContain('border-bottom: 1px solid var(--text-muted)');
    expect(item).not.toContain('background:');
    expect(item).not.toContain('border-radius:');
    // list gap cleared — padding+border carry spacing, gap+border would double up.
    expect(rule('.call-history__list')).toContain('gap: 0');
    // last child drops the divider (no orphan rule under the final item).
    expect(css).toContain('.call-history__item:last-child');
  });

  it('AC6: both layers overlay the main area + a --hidden modifier + reduced-motion', () => {
    expect(rule('.tv-board__main')).toContain('position: relative');
    const active = rule('.tv-board__active, .standby');
    expect(active).toContain('position: absolute');
    expect(active).toContain('inset: 0');
    expect(active).toContain('transition: opacity 0.3s ease');
    const hidden = rule('.tv-board__active--hidden, .standby--hidden');
    expect(hidden).toContain('opacity: 0');
    expect(hidden).toContain('visibility: hidden');
    expect(hidden).toContain('pointer-events: none');
    // Reduced motion snaps the layers instantly (no opacity fade).
    expect(css).toMatch(/prefers-reduced-motion/);
    expect(css).not.toContain('@keyframes standby-fade-in');
  });

  it('AC7: marquee translates -50% (seamless two-copy loop), padding-left:100% removed', () => {
    expect(css).toMatch(/translateX\(-50%\)/);
    expect(css).not.toContain('padding-left: 100%');
    // The dup copy + a gap between copies so the loop reads as continuous.
    expect(css).toContain('.marquee__dup');
    expect(rule('.marquee__track span')).toContain('padding-right');
    // Reduced motion disables the animation + the dup copy.
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*\.marquee__dup\s*\{[^}]*display: none/);
  });

  it('AC8: now-serving eyebrow letter-spacing ≤ 0.08em', () => {
    const r = rule('.now-serving__label');
    const ls = r.match(/letter-spacing:\s*([\d.]+)em/);
    expect(ls, 'letter-spacing must be set').not.toBeNull();
    expect(parseFloat(ls![1])).toBeLessThanOrEqual(0.08);
  });
});
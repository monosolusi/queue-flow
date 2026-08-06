import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * jsdom runs with `css: false` (vitest.config), so stylesheets are NOT applied
 * and computed visibility/opacity/contrast are not testable. CSS-driven ACs are
 * guarded statically here: read styles.css (co-located via import.meta.url —
 * admin-service is `"type": "module"`, so `__dirname` is NOT defined at runtime,
 * ESM-safe via `import.meta.url`), collapse whitespace, and regex-assert the
 * rules. (postcss is not a direct dependency, so a normalized-regex guard is
 * the pragmatic choice.)
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

/** Extracts the body of a named at-rule block (e.g. `@media (max-width: 900px)`).
 *  The block may contain nested `{}` (CSS rules), so match balanced braces. */
function atRuleBlock(prelude: string): string {
  const escaped = prelude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = css.search(new RegExp(`${escaped}\\s*\\{`));
  if (start === -1) throw new Error(`at-rule not found: ${prelude}`);
  let depth = 0;
  let bodyStart = -1;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth++;
    } else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(bodyStart, i);
    }
  }
  throw new Error(`unbalanced braces in at-rule: ${prelude}`);
}

describe('styles.css AC guards', () => {
  it('wizard hint inside .field resets margin-top so it does not overlap the input above', () => {
    expect(rule('.field .wizard__hint')).toContain('margin-top: 0');
  });

  it('standalone wizard hints keep the intentional negative top margin', () => {
    expect(rule('.wizard__hint')).toContain('margin-top: -0.5rem');
  });

  it('now-serving number uses the accent token (re-themes with the store brand color)', () => {
    expect(rule('.now-serving__number')).toContain('color: var(--accent)');
  });

  it('counter-status active badge uses the success token (semantic "busy")', () => {
    expect(rule('.counter-status__badge--active')).toContain('var(--success)');
  });

  it('counter-status idle badge uses muted surface (semantic "ready, not busy")', () => {
    const idle = rule('.counter-status__badge--idle');
    expect(idle).toContain('var(--surface-2)');
    expect(idle).toContain('var(--text-muted)');
  });

  it('skeleton shimmer is a pure opacity pulse (no background-position gradient)', () => {
    expect(rule('@keyframes skeleton-pulse')).toContain('opacity:');
    // The skeleton keyframes must not animate background-position (the
    // CLAUDE.md recipe is an opacity pulse, not a sliding gradient).
    expect(rule('@keyframes skeleton-pulse')).not.toContain('background-position');
  });

  it('skeleton animation is disabled under prefers-reduced-motion', () => {
    // The reduced-motion block collapses `.skeleton { animation: none }`. The
    // `@media (...)` parenthetical sits between `reduce` and the block brace, so
    // the matcher tolerates a `)` before `{`.
    const reduced = css.match(/prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.skeleton\s*\{([^}]*)\}/);
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toContain('animation: none');
  });

  it('sr-only clips the label to a 1px AT-only box', () => {
    const sr = rule('.sr-only');
    expect(sr).toContain('clip: rect(0, 0, 0, 0)');
    expect(sr).toContain('position: absolute');
    expect(sr).toContain('width: 1px');
  });

  it('QUE-45 — grouped nav: .nav-group and .nav-group__label rules exist', () => {
    expect(rule('.nav-group')).toContain('flex-direction: column');
    expect(rule('.nav-group__label')).toContain('text-transform: uppercase');
  });

  it('QUE-45 — .nav-link is a flex row with a ≥44px touch target (AC5)', () => {
    expect(rule('.nav-link')).toContain('display: flex');
    expect(rule('.nav-link')).toContain('min-height: 2.75rem');
  });

  it('QUE-45 — nav icon slot sizes the inline svg', () => {
    expect(rule('.nav-icon')).toContain('display: inline-flex');
    expect(rule('.nav-icon svg')).toContain('width: 1.25rem');
  });

  it('QUE-45 — responsive ≤900px collapses grouped nav: labels hidden, groups inline', () => {
    const media = atRuleBlock('@media (max-width: 900px)');
    // Group labels drop in the horizontal row (the row is too short for them).
    const labelMatch = media.match(/\.nav-group__label\s*\{([^}]*)\}/);
    expect(labelMatch).not.toBeNull();
    expect(labelMatch![1]).toContain('display: none');
    // Groups flow inline.
    const groupMatch = media.match(/\.nav-group\s*\{([^}]*)\}/);
    expect(groupMatch).not.toBeNull();
    expect(groupMatch![1]).toContain('flex-direction: row');
  });
});
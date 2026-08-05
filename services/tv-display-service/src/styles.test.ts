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

  it('AC3: now-serving number is a one-line container-query clamp (cqw) + nowrap + a 4K media tier', () => {
    // The card is an inline-size container so the number sizes to the 2fr
    // column, not the viewport — the one-line guarantee.
    expect(rule('.now-serving')).toContain('container-type: inline-size');
    const number = rule('.now-serving__number');
    expect(number).toContain('clamp(5rem, 18cqw, 22rem)');
    expect(number).toContain('white-space: nowrap');
    expect(css).toMatch(/@media\s*\(min-width:\s*2560px\)/);
    // The 4K tier also sizes to the (now wider) column and stays one line.
    const tierMatch = css.match(
      /@media\s*\(min-width:\s*2560px\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/,
    );
    expect(tierMatch?.[1]).toContain('clamp(10rem, 18cqw, 40rem)');
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

  it('waiting-queue mirrors call-history: surface card + hairline dividers + containment', () => {
    // Surface card via per-service tokens (no new shared token minted).
    const panel = rule('.waiting-queue');
    expect(panel).toContain('background: var(--surface)');
    expect(panel).toContain('border-radius: var(--radius)');
    expect(panel).toContain('min-width: 0'); // grid-cell containment (AC3)
    expect(panel).toContain('overflow: hidden');
    // Hairline divider between rows, no nested card background.
    const item = rule('.waiting-queue__item');
    expect(item).toContain('border-bottom: 1px solid var(--text-muted)');
    expect(item).not.toContain('background:');
    expect(item).not.toContain('border-radius:');
    expect(rule('.waiting-queue__list')).toContain('gap: 0');
    expect(css).toContain('.waiting-queue__item:last-child');
    // Position column uses --text-muted and a fixed min-width so numbers align.
    expect(rule('.waiting-queue__position')).toContain('color: var(--text-muted)');
    // 4K media tier scales the waiting-queue typography up (mirror of call-history).
    expect(css).toMatch(/@media\s*\(min-width:\s*2560px\)[\s\S]*\.waiting-queue__number\s*\{[^}]*clamp/);
  });

  it('waiting-queue scales rows to the panel height (cqh) + scrollable list (no clip)', () => {
    // The panel is a size container so children can scale to its height via cqh
    // units — all VISIBLE_LIMIT items always fit the panel regardless of its
    // height (responsive). The panel height is determinate because the active
    // grid uses grid-template-rows: minmax(0, 1fr) and the active side column
    // resolves it via flex.
    const panel = rule('.waiting-queue');
    expect(panel).toContain('container-type: size');
    expect(panel).toContain('display: flex');
    expect(panel).toContain('flex-direction: column');
    // The list is scrollable (safety-net) — never clipped/invisible.
    const list = rule('.waiting-queue__list');
    expect(list).toContain('overflow-y: auto');
    expect(list).toContain('flex: 1 1 auto');
    expect(list).toContain('min-height: 0');
    // Item font/padding scale to the panel height via cqh clamps.
    expect(rule('.waiting-queue__number')).toContain('clamp(');
    expect(rule('.waiting-queue__number')).toMatch(/cqh/);
    expect(rule('.waiting-queue__item')).toMatch(/cqh/);
  });

  it('active grid defines a determinate row height (minmax(0, 1fr))', () => {
    expect(rule('.tv-board__active-grid')).toContain('grid-template-rows: minmax(0, 1fr)');
  });

  it('AC6: the active board is the single always-visible layer (no standby/crossfade)', () => {
    // The standby/promosi panel was removed (it flickered on the crossfade);
    // the active board is now a plain flex column filling the main area — no
    // overlay, no --hidden modifier, no crossfade.
    expect(css).not.toContain('.standby');
    expect(css).not.toContain('--hidden');
    expect(css).not.toContain('position: absolute');
    expect(css).not.toContain('transition: opacity');
    const active = rule('.tv-board__active');
    expect(active).toContain('display: flex');
    expect(active).toContain('flex-direction: column');
    expect(active).toContain('height: 100%');
    expect(active).toContain('min-height: 0');
    // No marquee/standby keyframes remain.
    expect(css).not.toContain('@keyframes marquee');
    expect(css).not.toMatch(/prefers-reduced-motion/);
  });

  it('AC8: now-serving eyebrow letter-spacing ≤ 0.08em', () => {
    const r = rule('.now-serving__label');
    const ls = r.match(/letter-spacing:\s*([\d.]+)em/);
    expect(ls, 'letter-spacing must be set').not.toBeNull();
    expect(parseFloat(ls![1])).toBeLessThanOrEqual(0.08);
  });
});
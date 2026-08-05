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

describe('styles.css AC guards', () => {
  it('wizard hint inside .field resets margin-top so it does not overlap the input above', () => {
    expect(rule('.field .wizard__hint')).toContain('margin-top: 0');
  });

  it('standalone wizard hints keep the intentional negative top margin', () => {
    expect(rule('.wizard__hint')).toContain('margin-top: -0.5rem');
  });
});
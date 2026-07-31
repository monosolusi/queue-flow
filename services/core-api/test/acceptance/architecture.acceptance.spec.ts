import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';

/**
 * DoD-1 — Architecture Verification (NFR-MNT-01).
 *
 * The PRD §8 Definition-of-Done bullet 1 requires the core-api Domain layer be
 * proven free of ORM / HTTP-framework / I-O library dependencies by static code
 * analysis. This elevates `dependency-cruiser` (run via `npm run arch:check`)
 * from a lint-time convenience to an **acceptance gate**: the suite fails if the
 * architecture check exits non-zero, and it asserts the layering rules that
 * encode Clean Architecture / SOLID / DDD are actually declared in the config
 * (a green run with an empty rule set would prove nothing).
 *
 * This spec is the one acceptance test that needs no app boot, no DB, and no
 * network — it is pure static analysis. It runs in-process under the
 * `test:acceptance` jest match (see `package.json`).
 */

const ROOT = resolve(__dirname, '..', '..');
const CRUISER_CONFIG_PATH = join(ROOT, '.dependency-cruiser.cjs');

/** The layering rules that encode NFR-MNT-01 + the bounded-context boundaries.
 * Each must be declared in the dep-cruiser config for the architecture to be
 * considered enforced. */
const REQUIRED_RULES = [
  // NFR-MNT-01: Domain layer has no ORM/HTTP/IO imports.
  'domain-no-framework-imports',
  // Domain only depends on itself + node built-ins (Clean Architecture).
  'domain-isolation',
  // Bounded-context anti-corruption: Queue must not import Store Config.
  'queue-no-store-config',
  // No circular imports within the domain.
  'domain-no-circular',
  // DIP: application layer depends on ports, never infrastructure concretions.
  'application-no-infrastructure',
  // NFR-MNT-01 mirrored on the application layer (no pg/@nestjs/* in use cases).
  'application-no-framework-imports',
] as const;

describe('DoD-1 — Architecture Verification (NFR-MNT-01)', () => {
  it('declares every required Clean-Architecture / SOLID / DDD layering rule', () => {
    const config = readFileSync(CRUISER_CONFIG_PATH, 'utf8');
    for (const rule of REQUIRED_RULES) {
      // The config declares rules as `name: '<rule>'` entries.
      expect(config).toContain(`name: '${rule}'`);
    }
  });

  it('passes `npm run arch:check` (dep-cruiser) with exit code 0', () => {
    // Run the real architecture gate. Inheriting stdio surfaces dep-cruiser's
    // output on failure for diagnosis; on success it prints a clean summary.
    const exit = () =>
      execFileSync('npm', ['run', 'arch:check'], { cwd: ROOT, stdio: 'pipe' });
    // Asserting it does not throw is asserting exit 0.
    expect(exit).not.toThrow();
  });

  it('the Domain layer imports no framework / ORM / IO library (sampled)', () => {
    // A cheap direct sanity check on top of dep-cruiser: scan the domain tree
    // for any banned import. dep-cruiser is the authoritative gate; this is a
    // fast, readable second line of defense that fails loudly with the file.
    const banned = /(@nestjs\/|typeorm|@prisma\/|^import .*['"]pg['"]|from ['"]express['"]|from ['"]ws['"]|reflect-metadata|mikro-orm|knex|sequelize|mongoose|from ['"]fastify['"])/;
    const scan = (dir: string): string[] => {
      // Recursive walk without importing fs/promises helpers — keep it sync.
      const { readdirSync, statSync } = require('node:fs');
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...scan(full));
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          const src = readFileSync(full, 'utf8');
          // Only flag real import statements (not comments mentioning the lib).
          const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
          for (const line of importLines) {
            if (banned.test(line)) out.push(`${full}: ${line.trim()}`);
          }
        }
      }
      return out;
    };
    const offenders = scan(join(ROOT, 'src', 'domain'));
    expect(offenders).toEqual([]);
  });
});
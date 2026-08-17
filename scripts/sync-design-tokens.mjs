#!/usr/bin/env node
/*
 * scripts/sync-design-tokens.mjs — vendors the canonical shared design tokens
 * (shared/design-tokens/*.css) into each frontend service as generated files
 * under src/styles/. The canonical files are the single source of truth; the
 * per-service copies are committed so each standalone container builds with no
 * cross-service or repo-root dependency (NFR-MNT-02). A drift gate in
 * run-verify.mjs runs this script and fails on a non-empty `git diff` of the
 * generated files, so a direct edit of a copy (or a forgotten re-sync after
 * editing the source) cannot land.
 *
 * tv-display is display-only (no interactive elements) and receives tokens
 * only — no interactions.css.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'shared/design-tokens');
const tokensSrc = resolve(srcDir, 'tokens.css');
const interactionsSrc = resolve(srcDir, 'interactions.css');

// service -> which generated files it receives.
const targets = [
  { service: 'kiosk-service',        interactions: true },
  { service: 'tv-display-service',   interactions: true },
  { service: 'caller-service',       interactions: true },
  { service: 'admin-service',        interactions: true },
];

for (const { service, interactions } of targets) {
  const outDir = resolve(root, 'services', service, 'src/styles');
  mkdirSync(outDir, { recursive: true });
  const tokensDst = resolve(outDir, '_tokens.css');
  copyFileSync(tokensSrc, tokensDst);
  process.stdout.write(`▶ ${service}: _tokens.css\n`);
  if (interactions) {
    const interactionsDst = resolve(outDir, '_interactions.css');
    copyFileSync(interactionsSrc, interactionsDst);
    process.stdout.write(`▶ ${service}: _interactions.css\n`);
  }
}
process.stdout.write('design tokens synced.\n');
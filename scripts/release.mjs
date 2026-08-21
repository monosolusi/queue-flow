#!/usr/bin/env node
// Builds and publishes the store images. Vendor-only — a customer never runs
// this, and a store machine only ever pulls what it produces.
//
//   npm run release                 build + push, tagged from .env
//   npm run release -- --no-push    build and tag locally only
//
// Zero dependencies, like every other scripts/*.mjs.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { SIGNING_KEY_MISSING_MESSAGE, isSigningKeyConfigured } from './lib/signing-key-gate.mjs';

const root = new URL('..', import.meta.url).pathname;
const push = !process.argv.includes('--no-push');

/**
 * Compose reads `.env` itself, but this script has to report the tag it is
 * about to publish, and printing the wrong one is worse than not printing it.
 * Deliberately minimal: `KEY=value`, no quotes, no interpolation — matching
 * what `.env.example` actually contains.
 */
function readDotEnv() {
  const path = `${root}/.env`;
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

const env = readDotEnv();
const registry = process.env.QMS_REGISTRY ?? env.QMS_REGISTRY ?? 'qms';
const version = process.env.QMS_VERSION ?? env.QMS_VERSION ?? 'latest';

// Unconditional here, unlike in run-verify.mjs. Publishing an un-keyed image is
// the exact mistake this whole gate exists to prevent: it looks perfectly
// healthy until a customer is standing in front of an activation screen that
// refuses their key and blames them for it.
if (!isSigningKeyConfigured(root)) {
  process.stderr.write(`\n✖ refusing to release: ${SIGNING_KEY_MISSING_MESSAGE}\n`);
  process.exit(1);
}

if (version === 'latest') {
  // Not fatal — a nightly is a legitimate thing to push. But a store pinned to
  // `latest` gets an unannounced upgrade on its next install.sh, so say so.
  process.stdout.write(
    '\n⚠ QMS_VERSION is "latest". Stores pulling it will upgrade unannounced.\n' +
      '  Pin a real version in .env for anything a customer runs.\n',
  );
}

process.stdout.write(`\n▶ Building ${registry}/*:${version}\n`);
const shell = { cwd: root, stdio: 'inherit', env: { ...process.env, QMS_REGISTRY: registry, QMS_VERSION: version } };

// Base compose only. The prod overlay adds a host bind-mount that has nothing
// to do with building, and would fail on any machine without /sys.
execSync('docker compose -f docker-compose.yml build', shell);

if (push) {
  process.stdout.write(`\n▶ Pushing ${registry}/*:${version}\n`);
  execSync('docker compose -f docker-compose.yml push', shell);
  process.stdout.write(`\n✓ Published ${registry}/*:${version}\n`);
} else {
  process.stdout.write(`\n✓ Built ${registry}/*:${version} (not pushed)\n`);
}

#!/usr/bin/env node
/**
 * qms-license — issue and inspect QMS licence files.
 *
 * VENDOR-ONLY TOOL. It never ships to a customer: `tools/` sits outside every
 * service's Docker build context (`context: ./services/<svc>`), so it cannot be
 * copied into an image even by accident. What must never leave your machine is
 * the signing key — the tool's source is harmless on its own, since Ed25519
 * rests entirely on the key and not on the secrecy of the code.
 *
 * Zero dependencies (node: builtins only), matching scripts/*.mjs — no install
 * step, runs anywhere Node does.
 *
 *   qms-license keygen  [--out DIR] [--force]
 *   qms-license issue   --request QMSREQ1-… --customer NAME --type TYPE […]
 *   qms-license inspect FILE [--public-key B64 | --key PEM]
 *   qms-license list    [--key-dir DIR]
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';

import {
  encodeToken,
  generateSigningKeyPair,
  keyIdFor,
  parseToken,
  verifyToken,
} from '../src/token.mjs';
import {
  DEFAULT_GRACE,
  LICENSE_TYPES,
  buildPayload,
  decodeActivationRequest,
} from '../src/payload.mjs';
import { readRegistry, recordIssue, registryPathFor } from '../src/registry.mjs';

const DEFAULT_KEY_DIR = join(homedir(), '.qms-license');
const PRIVATE_KEY_FILE = 'signing-key.pem';
const PUBLIC_KEY_FILE = 'public-key.txt';

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name.startsWith('no-')) {
      flags[name.slice(3)] = false;
      continue;
    }
    let value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = true;
    }
    // Repeated flags collect, so --feature can be passed more than once.
    if (Object.hasOwn(flags, name)) {
      flags[name] = Array.isArray(flags[name]) ? [...flags[name], value] : [flags[name], value];
    } else {
      flags[name] = value;
    }
  }
  return { flags, positional };
}

function requireString(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function optionalInt(flags, name) {
  if (!Object.hasOwn(flags, name)) return null;
  const value = Number(flags[name]);
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer, got '${flags[name]}'`);
  return value;
}

function asList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** `@path` reads from a file, anything else is the literal value. */
function inlineOrFile(value) {
  const text = String(value);
  return text.startsWith('@') ? readFileSync(resolve(text.slice(1)), 'utf8') : text;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'license';
}

// ------------------------------------------------------------------- commands

function cmdKeygen(flags) {
  const dir = resolve(String(flags.out ?? DEFAULT_KEY_DIR));
  const privatePath = join(dir, PRIVATE_KEY_FILE);

  // Overwriting a signing key silently orphans every licence already in the
  // field — they would all fail with "unknown signing key" and every customer
  // would need a re-issue. Never do it without --force.
  if (existsSync(privatePath) && flags.force !== true) {
    throw new Error(
      `${privatePath} already exists. Overwriting it would invalidate every license already ` +
        'issued with it. Pass --force only if you are certain, and back up the old key first.',
    );
  }

  const { privateKeyPem, publicKeyDerB64, keyId } = generateSigningKeyPair();
  mkdirSync(dir, { recursive: true });
  writeFileSync(privatePath, privateKeyPem, { mode: 0o600 });
  chmodSync(privatePath, 0o600);
  writeFileSync(join(dir, PUBLIC_KEY_FILE), `${keyId} ${publicKeyDerB64}\n`, { mode: 0o644 });

  process.stdout.write(
    [
      `Signing key written to ${privatePath} (mode 0600).`,
      '',
      'BACK THIS FILE UP OFFLINE. Losing it means you can never issue a license',
      'for an existing installation again.',
      '',
      'Add this entry to the trusted-key table in core-api',
      '(services/core-api/src/infrastructure/licensing/trusted-keys.ts):',
      '',
      `  { keyId: '${keyId}', publicKeyDerB64: '${publicKeyDerB64}' },`,
      '',
    ].join('\n'),
  );
}

function loadPrivateKey(flags) {
  const path = resolve(
    String(flags.key ?? process.env.QMS_LICENSE_SIGNING_KEY ?? join(DEFAULT_KEY_DIR, PRIVATE_KEY_FILE)),
  );
  if (!existsSync(path)) {
    throw new Error(`signing key not found at ${path} — run 'qms-license keygen' first`);
  }
  const pem = readFileSync(path, 'utf8');
  const privateKey = createPrivateKey(pem);
  const publicKeyDerB64 = createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  return { privateKey, publicKeyDerB64, keyId: keyIdFor(publicKeyDerB64), keyDir: dirname(path) };
}

function cmdIssue(flags) {
  const { privateKey, publicKeyDerB64, keyId, keyDir } = loadPrivateKey(flags);

  let installationId;
  let claims = {};
  let majorVersion = 1;
  if (Object.hasOwn(flags, 'request')) {
    const request = decodeActivationRequest(inlineOrFile(flags.request));
    ({ installationId, claims, majorVersion } = request);
  } else {
    installationId = requireString(flags, 'installation-id');
  }
  if (Object.hasOwn(flags, 'major-version')) {
    majorVersion = optionalInt(flags, 'major-version');
  }

  const type = requireString(flags, 'type');
  const customerName = requireString(flags, 'customer');

  const payload = buildPayload({
    installationId,
    claims,
    customerName,
    customerRef: Object.hasOwn(flags, 'ref') ? String(flags.ref) : null,
    type,
    majorVersion,
    expiresOn: Object.hasOwn(flags, 'expires') ? String(flags.expires) : null,
    supportUntilOn: Object.hasOwn(flags, 'support-until') ? String(flags['support-until']) : null,
    bindHost: flags['bind-host'] !== false,
    maxCounters: optionalInt(flags, 'max-counters'),
    maxCategories: optionalInt(flags, 'max-categories'),
    features: asList(flags.feature).map(String),
    grace: {
      expiryDays: optionalInt(flags, 'grace-expiry-days') ?? DEFAULT_GRACE.expiryDays,
      mismatchDays: optionalInt(flags, 'grace-mismatch-days') ?? DEFAULT_GRACE.mismatchDays,
    },
  });

  const armored = encodeToken({ payload, privateKey, keyId });

  const outPath = resolve(
    String(flags.out ?? `${slugify(customerName)}-${payload.licenseId.slice(0, 8)}.lic`),
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, armored, 'utf8');

  // Verify what we just wrote, from disk, before telling anyone it worked. A
  // licence that fails at the store is unfixable without another trip.
  const check = verifyToken(readFileSync(outPath, 'utf8'), [{ keyId, publicKeyDerB64 }]);
  if (!check.valid) {
    throw new Error(`internal error: freshly issued license did not verify (${check.reason})`);
  }

  recordIssue(registryPathFor(keyDir), {
    licenseId: payload.licenseId,
    issuedAt: payload.issuedAt,
    customer: payload.customer,
    type: payload.type,
    installationId: payload.installationId,
    majorVersion: payload.product.majorVersion,
    expiresAt: payload.expiresAt,
    supportUntil: payload.supportUntil,
    hostBound: payload.host.bind,
    claimNames: Object.keys(payload.host.claims),
    keyId,
    file: basename(outPath),
  });

  process.stdout.write(`${outPath}\n`);
  printPayload(payload, { valid: true, header: { kid: keyId } });
}

function trustedKeysFor(flags) {
  if (Object.hasOwn(flags, 'public-key')) {
    const der = String(flags['public-key']).trim();
    return [{ keyId: keyIdFor(der), publicKeyDerB64: der }];
  }
  if (Object.hasOwn(flags, 'key')) {
    const { keyId, publicKeyDerB64 } = loadPrivateKey(flags);
    return [{ keyId, publicKeyDerB64 }];
  }
  const publicPath = join(resolve(String(flags['key-dir'] ?? DEFAULT_KEY_DIR)), PUBLIC_KEY_FILE);
  if (existsSync(publicPath)) {
    const [keyId, der] = readFileSync(publicPath, 'utf8').trim().split(/\s+/);
    return [{ keyId, publicKeyDerB64: der }];
  }
  throw new Error(
    `no trusted key available: ${publicPath} not found. Pass --public-key or --key.`,
  );
}

function cmdInspect(flags, positional) {
  const file = positional[0];
  if (file === undefined) throw new Error('usage: qms-license inspect FILE');
  const text = readFileSync(resolve(file), 'utf8');

  const result = verifyToken(text, trustedKeysFor(flags));
  // Show the contents either way. When a customer reports a problem, what the
  // file *claims* is the first useful thing to see, verified or not.
  const { payload } = result.valid ? result : parseToken(text);
  printPayload(payload, result);
  if (!result.valid) {
    process.exitCode = 1;
  }
}

function cmdList(flags) {
  const keyDir = resolve(String(flags['key-dir'] ?? DEFAULT_KEY_DIR));
  const entries = readRegistry(registryPathFor(keyDir));
  if (entries.length === 0) {
    process.stdout.write(`No licenses recorded in ${registryPathFor(keyDir)}\n`);
    return;
  }
  for (const entry of entries) {
    const window = entry.expiresAt
      ? `expires ${entry.expiresAt.slice(0, 10)}`
      : entry.supportUntil
        ? `support until ${entry.supportUntil.slice(0, 10)}`
        : 'no end date';
    process.stdout.write(
      `${entry.issuedAt.slice(0, 10)}  ${entry.type.padEnd(9)}  ${String(entry.customer?.name ?? '').padEnd(28)}  ${entry.installationId}  ${window}\n`,
    );
  }
}

function printPayload(payload, result) {
  const lines = [
    '',
    result.valid ? '  SIGNATURE: VALID' : `  SIGNATURE: INVALID — ${result.reason}`,
    `  License ID     : ${payload.licenseId}`,
    `  Customer       : ${payload.customer?.name}${payload.customer?.ref ? ` (${payload.customer.ref})` : ''}`,
    `  Type           : ${payload.type}`,
    `  Product        : ${payload.product?.id} major v${payload.product?.majorVersion}`,
    `  Installation ID: ${payload.installationId}`,
    `  Issued at      : ${payload.issuedAt}`,
    `  Expires at     : ${payload.expiresAt ?? '— (never)'}`,
    `  Support until  : ${payload.supportUntil ?? '— (n/a)'}`,
    `  Host binding   : ${payload.host?.bind ? `on — ${Object.keys(payload.host.claims).join(', ') || 'no claims'}` : 'off'}`,
    `  Entitlements   : counters=${payload.entitlements?.maxCounters ?? '∞'} categories=${payload.entitlements?.maxCategories ?? '∞'} features=[${(payload.entitlements?.features ?? []).join(', ')}]`,
    `  Grace          : expiry ${payload.grace?.expiryDays}d, host mismatch ${payload.grace?.mismatchDays}d`,
    `  Signing key    : ${result.header?.kid ?? '?'}`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

const USAGE = `qms-license — issue and inspect QMS license files (vendor tool, never shipped)

  keygen  [--out DIR] [--force]
          Generate an Ed25519 signing key. Refuses to overwrite an existing one.

  issue   --customer NAME --type ${LICENSE_TYPES.join('|')}
          (--request QMSREQ1-… | --installation-id UUID)
          [--ref INVOICE] [--major-version N] [--out FILE]
          [--expires YYYY-MM-DD]        trial only
          [--support-until YYYY-MM-DD]  perpetual only
          [--no-bind-host] [--max-counters N] [--max-categories N] [--feature X]
          [--grace-expiry-days N] [--grace-mismatch-days N] [--key PEM]

  inspect FILE [--public-key B64 | --key PEM | --key-dir DIR]
          Verify and print. Exit code 1 if the signature does not verify.

  list    [--key-dir DIR]
          Every license issued from this machine.
`;

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  switch (command) {
    case 'keygen':
      return cmdKeygen(flags);
    case 'issue':
      return cmdIssue(flags);
    case 'inspect':
      return cmdInspect(flags, positional);
    case 'list':
      return cmdList(flags);
    default:
      process.stdout.write(USAGE);
      process.exitCode = command === undefined || command === '--help' ? 0 : 1;
      return undefined;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`qms-license: ${error.message}\n`);
  process.exitCode = 1;
}

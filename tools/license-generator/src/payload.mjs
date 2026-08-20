/**
 * Activation requests in, validated license payloads out.
 *
 * Every rule that decides what a well-formed licence looks like lives here, so
 * `issue` cannot mint a token that core-api will later refuse. A licence that
 * fails at the customer's site is expensive — there is no network to fix it
 * over — so this module is deliberately strict and fails loudly at issue time.
 */

import { randomUUID } from 'node:crypto';

export const LICENSE_TYPES = ['perpetual', 'trial', 'free'];

export const PRODUCT_ID = 'qms';

/**
 * Relative trust in each host claim. Carried inside the signed payload rather
 * than hardcoded in core-api, so tolerance is a per-licence decision the vendor
 * can loosen for one troublesome customer without shipping a release.
 *
 * boardUuid outweighs machineId because it is the one that survives an OS
 * reinstall (legitimate maintenance) while still differing on a genuinely
 * different mini PC (the clone we care about), and because a fleet deployed
 * from a single golden disk image shares one machineId until the installer
 * regenerates it.
 */
export const DEFAULT_CLAIM_WEIGHTS = Object.freeze({ boardUuid: 2, machineId: 1 });

export const DEFAULT_GRACE = Object.freeze({
  expiryDays: 14,
  // Deliberately longer than expiryDays. With no subscription tier, a host
  // mismatch is the ONLY thing that can restrict a paying perpetual customer,
  // so a false positive here bills straight to support. 30 days is enough for
  // a hardware swap to be noticed and a replacement licence to be issued.
  mismatchDays: 30,
});

export const ACTIVATION_REQUEST_PREFIX = 'QMSREQ1-';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// UUID **v4** specifically, matching core-api's `Identifier.isValid`. A looser
// shape would let this tool mint a license whose installationId core-api then
// refuses to parse — a failure that surfaces only at the customer's site.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * An end date names a whole day, and the store should keep working through all
 * of it. Resolving to the last instant of that day in UTC lands at 07:00 the
 * next morning in WIB — erring toward the customer, which is the right
 * direction for a boundary nobody can renegotiate offline.
 */
export function endOfDayUtc(dateOnly) {
  if (!ISO_DATE.test(dateOnly)) {
    throw new Error(`expected a YYYY-MM-DD date, got '${dateOnly}'`);
  }
  const instant = new Date(`${dateOnly}T23:59:59.999Z`);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`'${dateOnly}' is not a real calendar date`);
  }
  // Date rolls impossible days over instead of rejecting them: '2027-02-30'
  // becomes March 2, and '2026-02-29' becomes March 1 in a non-leap year. A
  // mistyped end date would then mint a license expiring on a day nobody chose,
  // and nobody would notice until it lapsed. Round-trip to catch the rollover.
  const iso = instant.toISOString();
  if (iso.slice(0, 10) !== dateOnly) {
    throw new Error(`'${dateOnly}' is not a real calendar date (it would roll over to ${iso.slice(0, 10)})`);
  }
  return iso;
}

/**
 * Decode the blob the customer copies off the activation page.
 *
 * One blob rather than "send me your Installation ID, and also this JSON of
 * hashes": both halves have to arrive intact through WhatsApp, and a single
 * prefixed string can be validated as a unit instead of failing halfway
 * through with a mistyped UUID.
 */
export function decodeActivationRequest(raw) {
  const trimmed = String(raw).trim().replace(/\s+/g, '');
  if (!trimmed.startsWith(ACTIVATION_REQUEST_PREFIX)) {
    throw new Error(`activation request must start with '${ACTIVATION_REQUEST_PREFIX}'`);
  }
  let decoded;
  try {
    decoded = JSON.parse(
      Buffer.from(trimmed.slice(ACTIVATION_REQUEST_PREFIX.length), 'base64url').toString('utf8'),
    );
  } catch {
    throw new Error('activation request is corrupt — ask the customer to copy it again');
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('activation request is not an object');
  }
  if (!UUID.test(String(decoded.installationId ?? ''))) {
    throw new Error('activation request carries no valid installationId');
  }
  return {
    installationId: String(decoded.installationId).toLowerCase(),
    claims: normalizeClaims(decoded.claims),
    majorVersion: Number.isInteger(decoded.majorVersion) ? decoded.majorVersion : 1,
  };
}

export function encodeActivationRequest({ installationId, claims, majorVersion }) {
  const body = JSON.stringify({ v: 1, installationId, claims, majorVersion });
  return ACTIVATION_REQUEST_PREFIX + Buffer.from(body, 'utf8').toString('base64url');
}

/**
 * Claims arrive already hashed by core-api (sha256("name:value")) so the file
 * never carries the customer's raw hardware identifiers. Anything that is not a
 * sha256 hex digest is dropped rather than trusted — a claim core-api could not
 * read must reach the payload as absent, never as a placeholder that would
 * later "match" every other machine reporting the same placeholder.
 */
export function normalizeClaims(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const claims = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' && SHA256_HEX.test(value)) {
      claims[name] = value.toLowerCase();
    }
  }
  return claims;
}

function weightsFor(claims) {
  const weights = {};
  for (const name of Object.keys(claims)) {
    weights[name] = DEFAULT_CLAIM_WEIGHTS[name] ?? 1;
  }
  return weights;
}

/**
 * @returns the signed-payload object. Throws on anything that would produce a
 * licence core-api cannot honour.
 */
export function buildPayload({
  installationId,
  claims = {},
  customerName,
  customerRef = null,
  type,
  majorVersion = 1,
  expiresOn = null,
  supportUntilOn = null,
  bindHost = true,
  maxCounters = null,
  maxCategories = null,
  features = [],
  grace = DEFAULT_GRACE,
  issuedAt = new Date().toISOString(),
  licenseId = randomUUID(),
}) {
  if (!UUID.test(String(installationId ?? ''))) {
    throw new Error(`installationId must be a UUID, got '${installationId}'`);
  }
  if (typeof customerName !== 'string' || customerName.trim().length === 0) {
    throw new Error('customer name is required');
  }
  if (!LICENSE_TYPES.includes(type)) {
    throw new Error(`type must be one of ${LICENSE_TYPES.join(' | ')}, got '${type}'`);
  }
  if (!Number.isInteger(majorVersion) || majorVersion < 1) {
    throw new Error(`majorVersion must be a positive integer, got '${majorVersion}'`);
  }

  // Per-type window rules. A perpetual licence must never carry an expiry —
  // that is the whole promise of the tier — and a trial must never lack one.
  if (type === 'perpetual') {
    if (expiresOn !== null) {
      throw new Error('a perpetual license must not have --expires; it never expires');
    }
    if (supportUntilOn === null) {
      throw new Error('a perpetual license requires --support-until (the maintenance window)');
    }
  }
  if (type === 'trial') {
    if (expiresOn === null) {
      throw new Error('a trial license requires --expires');
    }
    if (supportUntilOn !== null) {
      throw new Error('a trial license must not have --support-until');
    }
  }
  if (type === 'free') {
    if (supportUntilOn !== null) {
      throw new Error('a free license must not have --support-until');
    }
    // A free tier with an end date is a trial wearing the wrong label, and
    // core-api's `License.fromPayload` rejects the combination outright.
    if (expiresOn !== null) {
      throw new Error('a free license must not have --expires; issue a trial instead');
    }
    if (maxCounters === null && maxCategories === null) {
      throw new Error(
        'a free license needs at least one entitlement cap (--max-counters / --max-categories), ' +
          'otherwise it is an unlimited perpetual license with no support window',
      );
    }
  }

  // Resolve the dates here, before the remaining checks, so a mistyped date
  // reports itself as a date problem instead of being masked by whichever
  // guard happens to run first.
  const expiresAt = expiresOn === null ? null : endOfDayUtc(expiresOn);
  const supportUntil = supportUntilOn === null ? null : endOfDayUtc(supportUntilOn);

  for (const [flag, cap] of [['--max-counters', maxCounters], ['--max-categories', maxCategories]]) {
    if (cap !== null && (!Number.isInteger(cap) || cap < 1)) {
      throw new Error(`${flag} must be a positive integer, got '${cap}'`);
    }
  }

  const normalizedClaims = normalizeClaims(claims);
  if (bindHost && Object.keys(normalizedClaims).length === 0) {
    throw new Error(
      'host binding was requested but the activation request carried no usable host claims. ' +
        'Either the fingerprint mounts are missing on the customer machine, or its firmware ' +
        'reports only placeholder identifiers. Re-issue with --no-bind-host to skip host binding.',
    );
  }

  return {
    licenseId,
    issuedAt,
    customer: { name: customerName.trim(), ref: customerRef },
    product: { id: PRODUCT_ID, majorVersion },
    type,
    installationId: String(installationId).toLowerCase(),
    expiresAt,
    supportUntil,
    host: {
      bind: bindHost,
      claims: normalizedClaims,
      weights: weightsFor(normalizedClaims),
    },
    entitlements: {
      maxCounters,
      maxCategories,
      features: [...features],
    },
    grace: { expiryDays: grace.expiryDays, mismatchDays: grace.mismatchDays },
  };
}

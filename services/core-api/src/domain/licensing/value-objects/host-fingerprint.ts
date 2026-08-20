import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/** A claim digest is sha256(`<name>:<rawValue>`), lowercase hex. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Firmware strings that identify a MODEL rather than a MACHINE.
 *
 * Cheap mini PCs — the exact hardware this product ships on — routinely report
 * these instead of a real serial, and `03000200-…-000700080009` is an SMBIOS
 * UUID duplicated across a very large number of boards. Accepting any of them
 * would make every unit of a given model "match" every other unit: the
 * fingerprint would not merely fail to detect a clone, it would actively
 * certify one. Treating them as ABSENT is the only safe reading.
 *
 * Compared lowercased and trimmed.
 */
export const PLACEHOLDER_CLAIM_VALUES: ReadonlySet<string> = new Set([
  'default string',
  'to be filled by o.e.m.',
  'to be filled by o.e.m',
  'to be filled by oem',
  'system serial number',
  'system uuid',
  'not specified',
  'not applicable',
  'not available',
  'unknown',
  'none',
  'null',
  'invalid',
  'o.e.m.',
  'oem',
  'chassis serial number',
  'base board serial number',
  'default',
  '03000200-0400-0500-0006-000700080009',
]);

/** Below this, a value carries too little entropy to identify a machine. */
const MIN_CLAIM_LENGTH = 8;

/**
 * Whether a RAW host identifier is worth recording.
 *
 * Lives in the domain, not in the reader, because "what counts as a real
 * machine identifier" is policy. It has to run on the raw value — a digest of
 * `"Default string"` looks exactly like a digest of a real serial — so the
 * infrastructure reader calls this BEFORE hashing, and hashing (which needs
 * `node:crypto`) stays on its side of the port. Pure string logic, no IO.
 */
export function isUsableClaimValue(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value.length < MIN_CLAIM_LENGTH) return false;
  if (PLACEHOLDER_CLAIM_VALUES.has(value)) return false;

  // All-zero / all-F / all-dash values, with separators ignored, are the other
  // common way firmware says "no value" (00000000-0000-0000-0000-000000000000).
  const bare = value.replace(/[\s:._-]/g, '');
  if (bare.length === 0) return false;
  if (/^(.)\1*$/.test(bare)) return false;

  return true;
}

export enum FingerprintOutcome {
  /** Enough recorded claims still match: this is the machine the licence was issued to. */
  MATCH = 'MATCH',
  /** Claims were readable but too few matched — a different machine. */
  MISMATCH = 'MISMATCH',
  /**
   * Nothing could be read at all (dev laptop, missing bind-mounts, non-systemd
   * host). Explicitly NOT a mismatch: absence of evidence is not evidence of a
   * clone, and blocking a store because a mount was forgotten would be the
   * worst possible failure mode for a paying customer.
   */
  UNAVAILABLE = 'UNAVAILABLE',
}

export interface FingerprintVerdict {
  readonly outcome: FingerprintOutcome;
  readonly matchedWeight: number;
  readonly recordedWeight: number;
  /** Weight that had to match for a MATCH — reported so the admin UI can explain the verdict. */
  readonly requiredWeight: number;
  readonly matched: readonly string[];
  /** Read, but different from what the licence recorded. */
  readonly changed: readonly string[];
  /** Recorded but not readable here — a missing mount, or hardware that stopped reporting it. */
  readonly unreadable: readonly string[];
}

export interface HostFingerprintProps {
  readonly bind: boolean;
  readonly claims: Readonly<Record<string, string>>;
  readonly weights: Readonly<Record<string, number>>;
}

export interface HostFingerprintDto {
  bind: boolean;
  claims: Record<string, string>;
  weights: Record<string, number>;
}

/**
 * The soft binding: which physical machine a licence was activated on.
 *
 * **A weighted claim set with a threshold, not one combined hash.** A single
 * digest over every identifier concatenated is all-or-nothing — swapping an SSD
 * would break it exactly as hard as moving to a different mini PC, and that
 * indiscriminacy is what makes home-grown node-locking hated. Scoring each
 * claim separately lets the policy distinguish "one component changed"
 * (legitimate maintenance, keep working) from "nothing matches" (a clone).
 *
 * With the shipped claims — `boardUuid` weight 2, `machineId` weight 1 — the
 * threshold `ceil(3 / 2) = 2` yields:
 *
 * | Scenario                          | Matched | Outcome  |
 * |-----------------------------------|---------|----------|
 * | Same machine                      | 3       | MATCH    |
 * | OS reinstalled (machineId is new) | 2       | MATCH    |
 * | Motherboard replaced, disk kept   | 1       | MISMATCH |
 * | `pgdata` copied to another mini PC| 0       | MISMATCH |
 *
 * `claims` is an open map rather than fixed fields, so a future claim (a disk
 * serial, say) needs no change to the licence format or to this class — the
 * same reason the config JSONB sub-keys carry new fields without a migration.
 */
export class HostFingerprint extends ValueObject<HostFingerprintProps> {
  private constructor(props: HostFingerprintProps) {
    super(props);
  }

  /**
   * Absent (a licence issued before host binding existed, or a JSON null)
   * degrades to "not bound" rather than throwing — an old licence must keep
   * working. Present-but-malformed throws, because that is a corrupt licence.
   */
  public static of(raw: unknown): HostFingerprint {
    if (raw === undefined || raw === null) {
      return HostFingerprint.UNBOUND;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `license host binding must be a plain object, got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;

    const bind = incoming.bind === undefined ? true : incoming.bind === true;
    const claims = readClaims(incoming.claims);
    const weights = readWeights(incoming.weights, claims);

    return new HostFingerprint({ bind, claims, weights });
  }

  /** Host binding switched off — the licence rests on the installation id alone. */
  public static readonly UNBOUND: HostFingerprint = new HostFingerprint({
    bind: false,
    claims: {},
    weights: {},
  });

  public get bind(): boolean {
    return this.props.bind;
  }

  public get claimNames(): readonly string[] {
    return Object.keys(this.props.claims);
  }

  /**
   * @param observed claim digests read from THIS host, already filtered by
   *   {@link isUsableClaimValue} and hashed the same way the licence's were.
   */
  public match(observed: Readonly<Record<string, string>>): FingerprintVerdict {
    const recorded = Object.keys(this.props.claims);

    // Binding off, or a licence that recorded nothing: there is no claim to
    // contradict, so there is nothing to fail.
    if (!this.props.bind || recorded.length === 0) {
      return verdict(FingerprintOutcome.UNAVAILABLE, 0, 0, 0, [], [], []);
    }

    const matched: string[] = [];
    const changed: string[] = [];
    const unreadable: string[] = [];
    for (const name of recorded) {
      const seen = observed[name];
      if (seen === undefined) unreadable.push(name);
      else if (seen === this.props.claims[name]) matched.push(name);
      else changed.push(name);
    }

    const weightOf = (names: readonly string[]) =>
      names.reduce((sum, name) => sum + (this.props.weights[name] ?? 1), 0);
    const recordedWeight = weightOf(recorded);
    const matchedWeight = weightOf(matched);
    const requiredWeight = Math.ceil(recordedWeight / 2);

    // Total blindness — every recorded claim is unreadable here. Almost always
    // a missing bind-mount or a non-Linux host, never a clone (a clone would
    // read its own values and CHANGE them, not hide them). Do not block.
    if (unreadable.length === recorded.length) {
      return verdict(
        FingerprintOutcome.UNAVAILABLE,
        0, recordedWeight, requiredWeight, [], [], unreadable,
      );
    }

    return verdict(
      matchedWeight >= requiredWeight ? FingerprintOutcome.MATCH : FingerprintOutcome.MISMATCH,
      matchedWeight, recordedWeight, requiredWeight, matched, changed, unreadable,
    );
  }

  public toDto(): HostFingerprintDto {
    return {
      bind: this.props.bind,
      claims: { ...this.props.claims },
      weights: { ...this.props.weights },
    };
  }
}

function verdict(
  outcome: FingerprintOutcome,
  matchedWeight: number,
  recordedWeight: number,
  requiredWeight: number,
  matched: readonly string[],
  changed: readonly string[],
  unreadable: readonly string[],
): FingerprintVerdict {
  return { outcome, matchedWeight, recordedWeight, requiredWeight, matched, changed, unreadable };
}

function readClaims(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidValueObjectException(
      `license host claims must be a plain object, got '${String(raw)}'`,
    );
  }
  const claims: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
      throw new InvalidValueObjectException(
        `license host claim '${name}' must be a sha256 hex digest, got '${String(value)}'`,
      );
    }
    claims[name] = value;
  }
  return claims;
}

function readWeights(raw: unknown, claims: Record<string, string>): Record<string, number> {
  const supplied =
    raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const weights: Record<string, number> = {};
  for (const name of Object.keys(claims)) {
    const value = supplied[name];
    // A claim with no declared weight counts as 1 rather than 0. Zero would let
    // a licence record a claim that can never affect the verdict, which reads
    // as "bound" while behaving as "unbound".
    if (value === undefined) {
      weights[name] = 1;
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new InvalidValueObjectException(
        `license host weight '${name}' must be a positive integer, got '${String(value)}'`,
      );
    }
    weights[name] = value;
  }
  return weights;
}

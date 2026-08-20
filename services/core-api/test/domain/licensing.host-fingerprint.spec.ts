import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  FingerprintOutcome,
  HostFingerprint,
  isUsableClaimValue,
} from '../../src/domain/licensing/value-objects/host-fingerprint';

const BOARD = 'a'.repeat(64);
const MACHINE = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

function bound(claims: Record<string, string>, weights?: Record<string, number>): HostFingerprint {
  return HostFingerprint.of({
    bind: true,
    claims,
    weights: weights ?? { boardUuid: 2, machineId: 1 },
  });
}

describe('isUsableClaimValue — the mini-PC placeholder filter', () => {
  it('accepts a real identifier', () => {
    expect(isUsableClaimValue('4c4c4544-0037-5a10-8054-b7c04f4d5632')).toBe(true);
    expect(isUsableClaimValue('d9f1a0c4b7e2436fa1c8e5d3b60947fe')).toBe(true);
  });

  // These are what cheap mini PCs actually report. Accepting even one would
  // make every unit of that model match every other one — the fingerprint
  // would certify a clone rather than catch it.
  it.each([
    ['Default string'],
    ['default string'],
    ['  Default String  '],
    ['To be filled by O.E.M.'],
    ['To Be Filled By O.E.M'],
    ['System Serial Number'],
    ['Not Specified'],
    ['None'],
    ['Unknown'],
    // The SMBIOS UUID duplicated across a very large number of boards.
    ['03000200-0400-0500-0006-000700080009'],
  ])('rejects the firmware placeholder %p', (value) => {
    expect(isUsableClaimValue(value)).toBe(false);
  });

  it('rejects all-zero / all-F / all-same values regardless of separators', () => {
    expect(isUsableClaimValue('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(isUsableClaimValue('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF')).toBe(false);
    expect(isUsableClaimValue('00:00:00:00:00:00')).toBe(false);
    expect(isUsableClaimValue('----------')).toBe(false);
  });

  it('rejects empty and too-short values', () => {
    expect(isUsableClaimValue('')).toBe(false);
    expect(isUsableClaimValue('   \n ')).toBe(false);
    expect(isUsableClaimValue('abc123')).toBe(false);
  });
});

describe('HostFingerprint.match — weighted claim set with a threshold', () => {
  const fingerprint = bound({ boardUuid: BOARD, machineId: MACHINE });

  it('MATCHes the machine it was activated on', () => {
    const verdict = fingerprint.match({ boardUuid: BOARD, machineId: MACHINE });
    expect(verdict.outcome).toBe(FingerprintOutcome.MATCH);
    expect(verdict.matchedWeight).toBe(3);
    expect(verdict.requiredWeight).toBe(2);
  });

  // The case a single combined hash gets wrong: legitimate maintenance must not
  // read as a clone. boardUuid (weight 2) survives an OS reinstall on its own.
  it('MATCHes after an OS reinstall, where only machineId changed', () => {
    const verdict = fingerprint.match({ boardUuid: BOARD, machineId: OTHER });
    expect(verdict.outcome).toBe(FingerprintOutcome.MATCH);
    expect(verdict.matchedWeight).toBe(2);
    expect(verdict.changed).toEqual(['machineId']);
  });

  it('MISMATCHes when the motherboard changed but the disk was kept', () => {
    const verdict = fingerprint.match({ boardUuid: OTHER, machineId: MACHINE });
    expect(verdict.outcome).toBe(FingerprintOutcome.MISMATCH);
    expect(verdict.matchedWeight).toBe(1);
  });

  // The scenario the whole mechanism exists for: the pgdata volume (and the
  // installation id inside it) copied to a second mini PC.
  it('MISMATCHes when nothing matches — a volume copied to another machine', () => {
    const verdict = fingerprint.match({ boardUuid: OTHER, machineId: OTHER });
    expect(verdict.outcome).toBe(FingerprintOutcome.MISMATCH);
    expect(verdict.matchedWeight).toBe(0);
    expect(verdict.changed).toEqual(['boardUuid', 'machineId']);
  });

  it('reports UNAVAILABLE, never MISMATCH, when no claim can be read at all', () => {
    const verdict = fingerprint.match({});
    expect(verdict.outcome).toBe(FingerprintOutcome.UNAVAILABLE);
    expect(verdict.unreadable).toEqual(['boardUuid', 'machineId']);
  });

  // Partial blindness is NOT total blindness. Hiding the heavier claim is
  // exactly how someone would try to pass a clone off as the original, so a
  // readable-but-insufficient set still has to fail.
  it('MISMATCHes when the heavier claim is unreadable and only the lighter one matches', () => {
    const verdict = fingerprint.match({ machineId: MACHINE });
    expect(verdict.outcome).toBe(FingerprintOutcome.MISMATCH);
    expect(verdict.unreadable).toEqual(['boardUuid']);
    expect(verdict.matched).toEqual(['machineId']);
  });

  it('treats an unbound licence as UNAVAILABLE rather than matching or failing', () => {
    const verdict = HostFingerprint.of({ bind: false, claims: {}, weights: {} }).match({
      boardUuid: OTHER,
    });
    expect(verdict.outcome).toBe(FingerprintOutcome.UNAVAILABLE);
  });

  it('defaults a claim with no declared weight to 1 rather than 0', () => {
    // Weight 0 would let a licence look bound while behaving as unbound.
    const verdict = bound({ diskSerial: BOARD }, {}).match({ diskSerial: OTHER });
    expect(verdict.outcome).toBe(FingerprintOutcome.MISMATCH);
    expect(verdict.recordedWeight).toBe(1);
  });
});

describe('HostFingerprint.of', () => {
  it('degrades an absent binding to UNBOUND so an older licence keeps working', () => {
    expect(HostFingerprint.of(undefined).bind).toBe(false);
    expect(HostFingerprint.of(null).bind).toBe(false);
  });

  it('rejects a claim that is not a sha256 digest', () => {
    // A placeholder must arrive ABSENT, never as some other string that would
    // then compare equal to the same placeholder on another machine.
    expect(() => bound({ boardUuid: 'Default string' })).toThrow(InvalidValueObjectException);
  });

  it('rejects a malformed shape and a non-positive weight', () => {
    expect(() => HostFingerprint.of('nope')).toThrow(InvalidValueObjectException);
    expect(() => bound({ boardUuid: BOARD }, { boardUuid: 0 })).toThrow(InvalidValueObjectException);
  });
});

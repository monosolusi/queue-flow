import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import { LicenseKey } from '../../src/domain/licensing/value-objects/license-key';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Mints a well-formed key from a 19-symbol payload, computing the check symbol
 * the way the activation server will. Written independently of the VO's own
 * private helper on purpose — a test that reuses the implementation to build
 * its fixtures cannot detect a wrong implementation.
 */
function mint(payload: string): string {
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) {
    sum += ALPHABET.indexOf(payload[i]) * (2 * i + 1);
  }
  const full = payload + ALPHABET[sum % 32];
  return `${full.slice(0, 5)}-${full.slice(5, 10)}-${full.slice(10, 15)}-${full.slice(15)}`;
}

const VALID = mint('7K3M9QRSTVWXYZ0123A');

describe('LicenseKey — construction', () => {
  it('accepts a well-formed key and round-trips it in canonical grouped form', () => {
    expect(LicenseKey.of(VALID).toString()).toBe(VALID);
    expect(VALID).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  });

  it('normalises how the key survived the trip to the shop', () => {
    const compact = VALID.replace(/-/g, '');
    // Lower-case from an email client, hyphens dropped, spaces from a chat app,
    // and a line wrap — all the same key.
    expect(LicenseKey.of(compact.toLowerCase()).toString()).toBe(VALID);
    expect(LicenseKey.of(`  ${VALID}  `).toString()).toBe(VALID);
    expect(LicenseKey.of(compact.replace(/(.{4})/g, '$1 ')).toString()).toBe(VALID);
    expect(LicenseKey.of(`${VALID.slice(0, 11)}\n${VALID.slice(11)}`).toString()).toBe(VALID);
  });

  it('resolves the look-alikes a person dictating over the phone produces', () => {
    // I and L are heard as 1; O is heard as 0. Crockford's aliases exist
    // precisely because a key gets read aloud down a bad line.
    const spoken = mint('III00QRSTVWXYZ0123A'.replace(/I/g, '1').replace(/O/g, '0'));
    const asHeard = spoken.replace(/1/g, 'I').replace(/0/g, 'O');
    expect(LicenseKey.of(asHeard).toString()).toBe(spoken);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => LicenseKey.of(VALID.slice(0, -1))).toThrow(InvalidValueObjectException);
    expect(() => LicenseKey.of(`${VALID}7`)).toThrow(InvalidValueObjectException);
    expect(() => LicenseKey.of('')).toThrow(InvalidValueObjectException);
  });

  it('rejects U, which the alphabet deliberately omits', () => {
    // U is not aliased to anything, so it survives normalisation and must be
    // reported as an invalid symbol rather than silently becoming something else.
    expect(() => LicenseKey.of(`U${VALID.slice(1)}`)).toThrow(/not a valid key symbol/);
  });

  it('rejects a non-string', () => {
    for (const raw of [null, undefined, 42, {}, ['A']]) {
      expect(() => LicenseKey.of(raw)).toThrow(InvalidValueObjectException);
    }
  });
});

describe('LicenseKey — the check symbol', () => {
  it('rejects a mistyped key with a message aimed at the person holding it', () => {
    const wrongCheck = VALID.slice(0, -1) + (VALID.endsWith('0') ? '1' : '0');
    expect(() => LicenseKey.of(wrongCheck)).toThrow(/mistyped/);
  });

  it('catches EVERY single-symbol substitution', () => {
    // This is the property the odd weights (2i+1) buy, and the reason the
    // weights are not (i+1): odd numbers are invertible mod 32. If someone
    // "simplifies" the weights later, this test is what fails.
    const compact = VALID.replace(/-/g, '');
    let checked = 0;
    for (let i = 0; i < compact.length; i += 1) {
      for (const symbol of ALPHABET) {
        if (symbol === compact[i]) continue;
        const typo = compact.slice(0, i) + symbol + compact.slice(i + 1);
        expect(LicenseKey.isValid(typo)).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBe(20 * 31);
  });

  it('catches adjacent transpositions except the documented delta-16 pairs', () => {
    // The known gap, asserted rather than hidden: a swap of two symbols whose
    // values differ by exactly 16 shifts the sum by 32 and vanishes mod 32.
    const compact = VALID.replace(/-/g, '');
    const missed: string[] = [];
    for (let i = 0; i < compact.length - 1; i += 1) {
      if (compact[i] === compact[i + 1]) continue;
      const swapped =
        compact.slice(0, i) + compact[i + 1] + compact[i] + compact.slice(i + 2);
      if (LicenseKey.isValid(swapped)) {
        const delta = Math.abs(ALPHABET.indexOf(compact[i]) - ALPHABET.indexOf(compact[i + 1]));
        missed.push(`${i}:${delta}`);
      }
    }
    // Whatever slips through must slip through for the documented reason only.
    for (const entry of missed) {
      expect(entry.split(':')[1]).toBe('16');
    }
  });

  it('isValid never throws, whatever it is handed', () => {
    for (const raw of [null, undefined, 42, {}, '', 'nonsense', VALID]) {
      expect(() => LicenseKey.isValid(raw)).not.toThrow();
    }
    expect(LicenseKey.isValid(VALID)).toBe(true);
  });
});

describe('LicenseKey — lock-step with admin-service', () => {
  it('agrees with the browser copy on pinned vectors', () => {
    // These exact strings are asserted by
    // services/admin-service/src/lib/license-key.test.ts too. They are the
    // drift gate: that file is a deliberate duplicate of this value object,
    // because neither service may import the other, and a change made to one
    // copy and not the other fails here.
    const vectors: [string, boolean][] = [
      ['7K3M9-QRSTV-WXYZ0-123A9', true],
      ['00000-00000-00000-00000', true],
      ['ZZZZZ-ZZZZZ-ZZZZZ-ZZZZQ', true],
      ['7K3M9-QRSTV-WXYZ0-123AH', false],
      ['ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', false],
    ];
    for (const [key, expected] of vectors) {
      expect([key, LicenseKey.isValid(key)]).toEqual([key, expected]);
    }
  });
});

describe('LicenseKey — value semantics', () => {
  it('compares by value, not identity, across differently-written forms', () => {
    expect(LicenseKey.of(VALID).equals(LicenseKey.of(VALID.replace(/-/g, '').toLowerCase()))).toBe(
      true,
    );
    expect(LicenseKey.of(VALID).equals(LicenseKey.of(mint('7K3M9QRSTVWXYZ0123B')))).toBe(false);
  });
});

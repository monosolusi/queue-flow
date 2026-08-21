import { describe, expect, it } from 'vitest';
import {
  KEY_SYMBOLS,
  formatLicenseKey,
  isLicenseKeyComplete,
  isLicenseKeyValid,
  normalizeLicenseKey,
} from './license-key';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Independent of the module under test — see the note in the core-api spec. */
function mint(payload: string): string {
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) sum += ALPHABET.indexOf(payload[i]) * (2 * i + 1);
  const full = payload + ALPHABET[sum % 32];
  return `${full.slice(0, 5)}-${full.slice(5, 10)}-${full.slice(10, 15)}-${full.slice(15)}`;
}

const KEY = mint('7K3M9QRSTVWXYZ0123A');

describe('normalizeLicenseKey', () => {
  it('survives every shape a key arrives in', () => {
    const compact = KEY.replace(/-/g, '');
    expect(normalizeLicenseKey(KEY)).toBe(compact);
    expect(normalizeLicenseKey(compact.toLowerCase())).toBe(compact);
    expect(normalizeLicenseKey(`  ${KEY}  `)).toBe(compact);
    expect(normalizeLicenseKey(`${KEY.slice(0, 11)}\n${KEY.slice(11)}`)).toBe(compact);
  });

  it('resolves the look-alikes a person produces reading a key aloud', () => {
    const spoken = mint('III00QRSTVWXYZ0123A'.replace(/I/g, '1').replace(/O/g, '0'));
    expect(normalizeLicenseKey(spoken.replace(/1/g, 'I').replace(/0/g, 'O'))).toBe(
      spoken.replace(/-/g, ''),
    );
  });
});

describe('formatLicenseKey', () => {
  it('groups in fives and drops anything typed past the end', () => {
    expect(formatLicenseKey(KEY.replace(/-/g, ''))).toBe(KEY);
    // A double paste must not corrupt the field.
    expect(formatLicenseKey(KEY + KEY)).toBe(KEY);
  });

  it('groups a partial key as it is being typed', () => {
    expect(formatLicenseKey('7k3m9qr')).toBe('7K3M9-QR');
  });
});

describe('isLicenseKeyValid', () => {
  it('accepts a well-formed key', () => {
    expect(isLicenseKeyValid(KEY)).toBe(true);
    expect(isLicenseKeyValid(KEY.replace(/-/g, '').toLowerCase())).toBe(true);
  });

  it('catches EVERY single-symbol substitution', () => {
    // The property the odd weights buy. If the weights are ever "simplified"
    // to (i + 1), this fails — on this side AND in core-api's own spec, which
    // is what keeps the two copies honest.
    const compact = KEY.replace(/-/g, '');
    for (let i = 0; i < compact.length; i += 1) {
      for (const symbol of ALPHABET) {
        if (symbol === compact[i]) continue;
        expect(isLicenseKeyValid(compact.slice(0, i) + symbol + compact.slice(i + 1))).toBe(false);
      }
    }
  });

  it('rejects the wrong length, and U, which the alphabet omits', () => {
    expect(isLicenseKeyValid(KEY.slice(0, -1))).toBe(false);
    expect(isLicenseKeyValid('')).toBe(false);
    expect(isLicenseKeyValid(`U${KEY.replace(/-/g, '').slice(1)}`)).toBe(false);
  });
});

describe('isLicenseKeyComplete', () => {
  it('turns true exactly when the whole key has been typed', () => {
    const compact = KEY.replace(/-/g, '');
    expect(isLicenseKeyComplete(compact.slice(0, KEY_SYMBOLS - 1))).toBe(false);
    expect(isLicenseKeyComplete(compact)).toBe(true);
  });

  it('is true for a complete but mistyped key, so submit can explain why', () => {
    const mistyped = KEY.slice(0, -1) + (KEY.endsWith('0') ? '1' : '0');
    expect(isLicenseKeyComplete(mistyped)).toBe(true);
    expect(isLicenseKeyValid(mistyped)).toBe(false);
  });
});

describe('lock-step with core-api', () => {
  it('agrees with the value object on pinned vectors', () => {
    // These exact strings are asserted by core-api's LicenseKey spec too. They
    // are the drift gate: this file and
    // services/core-api/src/domain/licensing/value-objects/license-key.ts are
    // deliberate duplicates (neither service may import the other), and a
    // change to one that is not made to the other fails here.
    const vectors: [string, boolean][] = [
      ['7K3M9-QRSTV-WXYZ0-123A9', true],
      ['00000-00000-00000-00000', true],
      ['ZZZZZ-ZZZZZ-ZZZZZ-ZZZZQ', true],
      ['7K3M9-QRSTV-WXYZ0-123AH', false],
      ['ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', false],
    ];
    for (const [key, expected] of vectors) {
      expect([key, isLicenseKeyValid(key)]).toEqual([key, expected]);
    }
  });
});

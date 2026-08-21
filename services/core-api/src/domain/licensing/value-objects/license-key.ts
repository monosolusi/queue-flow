import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * Crockford base32. `I`, `L`, `O` and `U` are absent on purpose: the first
 * three are the classic misreadings of `1`/`0` when a key is dictated over the
 * phone, and `U` is excluded so no key can spell an obscenity by accident.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford's decode aliases — what a human writes vs what they meant. */
const ALIASES: Readonly<Record<string, string>> = { I: '1', L: '1', O: '0' };

const PAYLOAD_SYMBOLS = 19;
const TOTAL_SYMBOLS = PAYLOAD_SYMBOLS + 1;
const GROUP_SIZE = 5;

/**
 * The activation key a customer types into `/aktivasi`.
 *
 * Deliberately carries NO product prefix. The licence product that mints these
 * serves every product we ship, and the product is identified by the token that
 * comes back from the activation server, not by the key that asked for it. A
 * `QMS-` prefix would be four symbols of decoration that have to stay in sync
 * across two codebases for no benefit.
 *
 * ## The check symbol
 *
 * The last symbol is a weighted checksum over the other 19:
 * `sum(value(s[i]) * (2i + 1)) mod 32`.
 *
 * It exists to catch a typo BEFORE the request leaves the building — an offline
 * store gets an instant "salah ketik" instead of a fifteen-second timeout, and
 * the activation server never records a failed redemption that was really a
 * slipped finger. It is emphatically NOT a security control: the server is the
 * only authority on whether a key is real, and forging this checksum is
 * arithmetic anyone can do.
 *
 * The weights are all ODD, which is the whole reason they are `2i + 1` rather
 * than `i + 1`. Odd numbers are invertible modulo 32, so `delta * weight ≡ 0`
 * forces `delta ≡ 0` and **every single-symbol substitution is detected**.
 * Adjacent transpositions shift the sum by `(v[i] - v[i+1]) * 2`, so the pairs
 * that differ by exactly 16 slip through — a knowingly accepted gap, since
 * substitution is the typo that actually happens when someone reads a key aloud.
 *
 * `admin-service` carries a duplicate of the normalise-and-check logic so the
 * browser can reject a mistyped key without a round trip. That is the same
 * lock-step duplication as the ESC/POS command builders, and for the same
 * reason: a shared package would be the only thing either side imports, and
 * neither side is allowed to depend on the other.
 */
export class LicenseKey extends ValueObject<{ readonly symbols: string }> {
  private constructor(symbols: string) {
    super({ symbols });
  }

  public static of(raw: unknown): LicenseKey {
    if (typeof raw !== 'string') {
      throw new InvalidValueObjectException(
        `license key must be a string, got '${String(raw)}'`,
      );
    }

    const symbols = normalize(raw);

    if (symbols.length !== TOTAL_SYMBOLS) {
      throw new InvalidValueObjectException(
        `license key must be ${TOTAL_SYMBOLS} symbols, got ${symbols.length}`,
      );
    }
    for (const symbol of symbols) {
      if (!ALPHABET.includes(symbol)) {
        throw new InvalidValueObjectException(
          `license key contains '${symbol}', which is not a valid key symbol`,
        );
      }
    }
    if (symbols[PAYLOAD_SYMBOLS] !== checkSymbol(symbols.slice(0, PAYLOAD_SYMBOLS))) {
      // Worded for the person holding the key, not for the developer: the
      // overwhelmingly likely cause is a mistyped character, not a fake key.
      throw new InvalidValueObjectException(
        'license key checksum does not match — it looks mistyped',
      );
    }

    return new LicenseKey(symbols);
  }

  /** True when {@link of} would succeed. For callers that want no exception. */
  public static isValid(raw: unknown): boolean {
    try {
      LicenseKey.of(raw);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The single canonical form, used for BOTH display and the wire. Grouping is
   * not cosmetic here: one form means the activation server and this client can
   * never disagree about what "the key" is when a support ticket quotes it.
   */
  public toString(): string {
    return group(this.props.symbols);
  }
}

/**
 * Uppercase, resolve Crockford's look-alike aliases, and drop anything that is
 * not a symbol — so a key survives being pasted with its hyphens, with stray
 * spaces from a chat client, or wrapped across two lines in an email.
 */
function normalize(raw: string): string {
  let out = '';
  for (const char of raw.toUpperCase()) {
    if (char in ALIASES) {
      out += ALIASES[char];
    } else if (/[0-9A-Z]/.test(char)) {
      out += char;
    }
  }
  return out;
}

function checkSymbol(payload: string): string {
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) {
    sum += ALPHABET.indexOf(payload[i]) * (2 * i + 1);
  }
  return ALPHABET[sum % ALPHABET.length];
}

function group(symbols: string): string {
  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += GROUP_SIZE) {
    groups.push(symbols.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

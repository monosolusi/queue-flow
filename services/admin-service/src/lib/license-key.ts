/**
 * Activation-key normalisation and typo checking, in the browser.
 *
 * A deliberate DUPLICATE of core-api's `LicenseKey` value object, kept in
 * lock-step by the test vectors both suites assert — the same arrangement the
 * ESC/POS command builders use, and for the same reason: neither service is
 * allowed to import from the other, and a shared package for forty lines of
 * arithmetic would be more machinery than the machinery is worth.
 *
 * The server re-checks everything this does. Nothing here is a security
 * boundary; it exists so a mistyped key fails instantly, in the shop, instead
 * of after a fifteen-second round trip — and so a slipped finger never reaches
 * the activation server as a failed redemption.
 *
 * If the format ever changes, both copies change together or the shared
 * vectors fail. That failure is the point.
 */

/** Crockford base32. No I/L/O (misread as 1/0) and no U (avoids accidents). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** What a person writes vs what they meant, when a key is read down a phone. */
const ALIASES: Readonly<Record<string, string>> = { I: '1', L: '1', O: '0' };

const PAYLOAD_SYMBOLS = 19;
export const KEY_SYMBOLS = PAYLOAD_SYMBOLS + 1;
export const GROUP_SIZE = 5;

/**
 * Uppercase, resolve the look-alikes, drop everything else — so a key survives
 * being pasted with its hyphens, with stray spaces from a chat client, or
 * wrapped across two lines in an email.
 */
export function normalizeLicenseKey(raw: string): string {
  let out = '';
  for (const char of raw.toUpperCase()) {
    if (char in ALIASES) out += ALIASES[char];
    else if (/[0-9A-Z]/.test(char)) out += char;
  }
  return out;
}

/** `XXXXX-XXXXX-XXXXX-XXXXX` — the one canonical form, for display and wire. */
export function formatLicenseKey(raw: string): string {
  const symbols = normalizeLicenseKey(raw).slice(0, KEY_SYMBOLS);
  const groups: string[] = [];
  for (let i = 0; i < symbols.length; i += GROUP_SIZE) {
    groups.push(symbols.slice(i, i + GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * Weighted checksum over the first 19 symbols. The weights are all ODD, which
 * makes them invertible modulo 32 and so catches EVERY single-symbol
 * substitution — the typo that actually happens when a key is dictated.
 */
function checkSymbol(payload: string): string {
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) {
    sum += ALPHABET.indexOf(payload[i]) * (2 * i + 1);
  }
  return ALPHABET[sum % ALPHABET.length];
}

/** True when the key is complete and its check symbol agrees. */
export function isLicenseKeyValid(raw: string): boolean {
  const symbols = normalizeLicenseKey(raw);
  if (symbols.length !== KEY_SYMBOLS) return false;
  for (const symbol of symbols) {
    if (!ALPHABET.includes(symbol)) return false;
  }
  return symbols[PAYLOAD_SYMBOLS] === checkSymbol(symbols.slice(0, PAYLOAD_SYMBOLS));
}

/** True once the manager has typed enough symbols to judge the key at all. */
export function isLicenseKeyComplete(raw: string): boolean {
  return normalizeLicenseKey(raw).length >= KEY_SYMBOLS;
}

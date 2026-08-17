"""Indonesian number and letter pronunciation — pure, no IO.

This module is the reason `tts-service` exists as its own service: the grammar of
*what gets said* belongs next to the synthesizer, not inside the TV board that
merely plays the result.

Because the engine contract is sentence-level (`TtsEngine.synthesize(text)`), this
module emits **text**, not a list of audio-fragment ids. That removes the upper
bound the old TV-side fragment sequencer needed: a fragment plan could only speak
numbers it had committed MP3s for, so it capped at 9999 and degraded to
digit-by-digit above that. Text has no such cap, so `number_to_words` is total for
every non-negative int and no fallback branch is required.
"""

from __future__ import annotations

# 0-9 do double duty: bare digits and the unit words inside larger numbers.
_UNITS = (
    "nol",
    "satu",
    "dua",
    "tiga",
    "empat",
    "lima",
    "enam",
    "tujuh",
    "delapan",
    "sembilan",
)

_SCALES = (
    # (value, singular form used when the multiplier is exactly 1, plural form)
    (1_000_000_000, "semiliar", "miliar"),
    (1_000_000, "sejuta", "juta"),
    (1_000, "seribu", "ribu"),
    (100, "seratus", "ratus"),
)

# Indonesian letter NAMES. A category code is spoken letter by letter, and the
# name cannot be derived from the character: "Z" is "zet", not "z". Sending the
# bare character to the synthesizer is a real defect, not a nicety -- the voice
# phonemizes with espeak-ng, which happily reads "Q" as the English "kyu".
_LETTER_NAMES = {
    "A": "a",
    "B": "be",
    "C": "ce",
    "D": "de",
    "E": "e",
    "F": "ef",
    "G": "ge",
    "H": "ha",
    "I": "i",
    "J": "je",
    "K": "ka",
    "L": "el",
    "M": "em",
    "N": "en",
    "O": "o",
    "P": "pe",
    "Q": "ki",
    "R": "er",
    "S": "es",
    "T": "te",
    "U": "u",
    "V": "fe",
    "W": "we",
    "X": "eks",
    "Y": "ye",
    "Z": "zet",
}


def number_to_words(value: int) -> str:
    """Spell `value` in Indonesian.

    Total for every non-negative int (negatives raise -- no queue number or
    counter id is ever negative, so silently speaking one would hide a bug
    upstream rather than degrade gracefully).

    >>> number_to_words(5)
    'lima'
    >>> number_to_words(11)
    'sebelas'
    >>> number_to_words(123)
    'seratus dua puluh tiga'
    >>> number_to_words(1000)
    'seribu'
    """
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"number_to_words expects an int, got {type(value).__name__}")
    if value < 0:
        raise ValueError(f"number_to_words expects a non-negative int, got {value}")

    if value < 10:
        return _UNITS[value]
    if value == 10:
        return "sepuluh"
    if value == 11:
        return "sebelas"
    if value < 20:
        # 12..19 -- "<unit> belas". Note 11 is the irregular "sebelas", handled above.
        return f"{_UNITS[value - 10]} belas"
    if value < 100:
        tens, unit = divmod(value, 10)
        head = f"{_UNITS[tens]} puluh"
        return head if unit == 0 else f"{head} {_UNITS[unit]}"

    for scale, singular, plural in _SCALES:
        if value >= scale:
            count, remainder = divmod(value, scale)
            # A leading multiplier of exactly 1 contracts: 100 -> "seratus" (never
            # "satu ratus"), 1000 -> "seribu". Higher multipliers stay analytic.
            head = singular if count == 1 else f"{number_to_words(count)} {plural}"
            return head if remainder == 0 else f"{head} {number_to_words(remainder)}"

    raise AssertionError(f"unreachable: {value} matched no scale")  # pragma: no cover


def letters_to_words(code: str) -> str:
    """Spell a category code letter by letter using Indonesian letter names.

    Case-insensitive; characters with no letter name are dropped rather than
    passed through, so a stray separator can never reach the synthesizer as a
    literal.

    >>> letters_to_words('A')
    'a'
    >>> letters_to_words('CS')
    'ce es'
    """
    return " ".join(_LETTER_NAMES[ch] for ch in code.upper() if ch in _LETTER_NAMES)

"""Indonesian number and letter pronunciation."""

from __future__ import annotations

import pytest

from app.domain.indonesian_number import letters_to_words, number_to_words


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0, "nol"),
        (1, "satu"),
        (5, "lima"),
        (9, "sembilan"),
        # The two irregular forms -- the usual source of "sepuluh satu" bugs.
        (10, "sepuluh"),
        (11, "sebelas"),
        (12, "dua belas"),
        (15, "lima belas"),
        (19, "sembilan belas"),
        (20, "dua puluh"),
        (21, "dua puluh satu"),
        (99, "sembilan puluh sembilan"),
        # 100 contracts to "seratus", never "satu ratus".
        (100, "seratus"),
        (105, "seratus lima"),
        (111, "seratus sebelas"),
        (115, "seratus lima belas"),
        (123, "seratus dua puluh tiga"),
        (200, "dua ratus"),
        (999, "sembilan ratus sembilan puluh sembilan"),
        # 1000 contracts to "seribu", never "satu ribu".
        (1000, "seribu"),
        (1001, "seribu satu"),
        (1234, "seribu dua ratus tiga puluh empat"),
        (2000, "dua ribu"),
        (2500, "dua ribu lima ratus"),
    ],
)
def test_speaks_numbers_with_indonesian_morphology(value: int, expected: str) -> None:
    assert number_to_words(value) == expected


def test_speaks_numbers_beyond_the_old_fragment_ceiling() -> None:
    """The old TV-side fragment sequencer capped at 9999 and fell back to digits.

    Sentence-level synthesis has no asset vocabulary to run out of, so large values
    stay grammatical instead of degrading to "satu dua tiga empat lima".
    """
    assert number_to_words(10_000) == "sepuluh ribu"
    assert number_to_words(12_345) == "dua belas ribu tiga ratus empat puluh lima"
    assert number_to_words(1_000_000) == "sejuta"


def test_rejects_values_that_signal_an_upstream_bug() -> None:
    """A negative ticket number or counter id is never legitimate.

    Speaking it anyway would mask the real defect somewhere upstream, so this
    raises rather than degrading.
    """
    with pytest.raises(ValueError):
        number_to_words(-1)
    with pytest.raises(TypeError):
        number_to_words(1.5)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        # bool is an int subclass; accepting it would speak True as "satu".
        number_to_words(True)  # type: ignore[arg-type]


def test_spells_letters_with_indonesian_names_not_the_bare_character() -> None:
    """Letter NAMES cannot be derived from the character.

    Passing the bare glyph to the synthesizer makes espeak read "Q" as the English
    "kyu" and "Z" as "zed"/"zee" -- audible to every visitor in category Q or Z.
    """
    assert letters_to_words("A") == "a"
    assert letters_to_words("C") == "ce"
    assert letters_to_words("Q") == "ki"
    assert letters_to_words("X") == "eks"
    assert letters_to_words("Z") == "zet"


def test_spells_a_multi_letter_category_code_letter_by_letter() -> None:
    """core-api's TicketNumber allows `^[A-Z]+$`, so `CS-004` is a legal ticket."""
    assert letters_to_words("CS") == "ce es"


def test_normalises_case_and_drops_unpronounceable_characters() -> None:
    assert letters_to_words("cs") == "ce es"
    assert letters_to_words("A1-") == "a"
    assert letters_to_words("123") == ""

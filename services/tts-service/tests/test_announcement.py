"""Announcement script composition — the words the board actually says."""

from __future__ import annotations

import pytest

from app.domain.announcement import (
    AnnouncementRequest,
    AnnouncementScript,
    InvalidAnnouncementError,
    build_script,
)


def script_for(ticket_number: str, counter_id: int) -> str:
    return build_script(
        AnnouncementRequest(ticket_number=ticket_number, counter_id=counter_id)
    ).text


def test_says_the_full_indonesian_announcement() -> None:
    assert script_for("A-005", 2) == "nomor antrian a lima, silakan ke loket dua"


def test_drops_leading_zeros_rather_than_reading_them() -> None:
    """`A-005` displays as A-005 but nobody says "nol nol lima"."""
    assert "nol" not in script_for("A-005", 1)


def test_speaks_a_three_digit_sequence_as_number_words() -> None:
    assert (
        script_for("A-123", 12)
        == "nomor antrian a seratus dua puluh tiga, silakan ke loket dua belas"
    )


def test_says_loket_not_counter() -> None:
    """The store's signage and the PRD are Indonesian; "counter" would be jarring."""
    text = script_for("A-001", 1)
    assert "loket" in text
    assert "counter" not in text


def test_spells_a_multi_letter_category_code() -> None:
    assert script_for("CS-004", 7) == "nomor antrian ce es empat, silakan ke loket tujuh"


def test_separates_the_number_from_the_destination_with_a_comma() -> None:
    """The comma is the only cue the phonemizer turns into a pause.

    Without it the whole line runs together as one breath, which is the difference
    between an announcement and a mumble.
    """
    assert ", silakan ke loket" in script_for("A-001", 1)


def test_announces_a_ticket_number_with_no_sequence_part() -> None:
    """Category alone still announces -- better than silence for a malformed frame."""
    assert script_for("A", 3) == "nomor antrian a, silakan ke loket tiga"


def test_ignores_a_non_numeric_sequence_part() -> None:
    assert script_for("A-XX", 1) == "nomor antrian a, silakan ke loket satu"


def test_rejects_a_ticket_number_with_no_pronounceable_letters() -> None:
    with pytest.raises(InvalidAnnouncementError):
        script_for("123", 1)


@pytest.mark.parametrize("counter_id", [0, -1])
def test_rejects_a_counter_id_below_one(counter_id: int) -> None:
    """core-api guarantees positive counter ids; a 0 here means a forged frame."""
    with pytest.raises(InvalidAnnouncementError):
        AnnouncementRequest(ticket_number="A-001", counter_id=counter_id)


def test_rejects_an_empty_ticket_number() -> None:
    with pytest.raises(InvalidAnnouncementError):
        AnnouncementRequest(ticket_number="   ", counter_id=1)


def test_rejects_a_non_integer_counter_id() -> None:
    with pytest.raises(InvalidAnnouncementError):
        AnnouncementRequest(ticket_number="A-001", counter_id="2")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Segments: where a configured pause is allowed to land. Splitting is a domain
# decision (it depends on Indonesian phrasing); how long the silence is, and how
# it is rendered, is not decided here.
# ---------------------------------------------------------------------------


def segments_for(ticket_number: str, counter_id: int) -> tuple[str, ...]:
    return build_script(
        AnnouncementRequest(ticket_number=ticket_number, counter_id=counter_id)
    ).segments


def test_segments_put_a_seam_in_front_of_each_number() -> None:
    """"nomor antrian" then "a lima" then "silakan ke loket" then "dua" -- the two
    seams a listener needs are before the ticket id and before the counter."""
    assert segments_for("A-005", 2) == (
        "nomor antrian",
        "a lima",
        "silakan ke loket",
        "dua",
    )


def test_the_ticket_id_is_never_split_across_segments() -> None:
    """A seam between "a" and "lima" would put a pause inside the very number the
    pause exists to make catchable."""
    assert "a lima" in segments_for("A-005", 2)
    assert "a" not in segments_for("A-005", 2)


def test_a_multi_letter_category_stays_whole_too() -> None:
    assert segments_for("CS-004", 7) == (
        "nomor antrian",
        "ce es empat",
        "silakan ke loket",
        "tujuh",
    )


def test_a_ticket_with_no_sequence_still_segments_into_four() -> None:
    """Segment count is not derived from the presence of a number, so the
    degenerate ticket number does not produce a shorter list the joiner would
    then have to special-case."""
    assert segments_for("A", 3) == ("nomor antrian", "a", "silakan ke loket", "tiga")


def test_joining_the_segments_yields_the_same_words_as_the_sentence() -> None:
    """The two granularities must be one announcement. Punctuation aside, a word
    present in one and missing from the other is a drift bug."""
    script = build_script(AnnouncementRequest(ticket_number="A-123", counter_id=12))
    assert " ".join(script.segments).split() == script.text.replace(",", "").split()


def test_a_script_whose_segments_do_not_spell_out_the_sentence_is_rejected() -> None:
    """`build_script` cannot produce a mismatch, but the type is public and the
    application layer constructs one directly for free-form preview text."""
    with pytest.raises(InvalidAnnouncementError):
        AnnouncementScript(text="nomor antrian a satu", segments=("nomor antrian",))


def test_free_form_single_segment_text_keeps_its_own_punctuation() -> None:
    """Punctuation is normalised on BOTH sides — stripping only `text` would
    reject the one-segment script a preview builds from arbitrary words."""
    script = AnnouncementScript(text="halo, ini tes", segments=("halo, ini tes",))
    assert script.segments == ("halo, ini tes",)

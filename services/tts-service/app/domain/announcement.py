"""The announcement aggregate: what the board says when a ticket is called.

Pure domain -- no FastAPI, no filesystem, no subprocess. This is the piece that
moved OUT of `tv-display-service`: the TV used to own `buildCallFragments`, which
put Indonesian grammar inside a rendering service. Now the TV asks for one audio
URL and this module decides the words.
"""

from __future__ import annotations

from dataclasses import dataclass

from .indonesian_number import letters_to_words, number_to_words


class InvalidAnnouncementError(ValueError):
    """A request that cannot be turned into a sayable script."""


@dataclass(frozen=True)
class AnnouncementRequest:
    """A `TICKET_CALLED` event reduced to just what determines the audio.

    `ticket_number` mirrors core-api's `TicketNumber`, whose pattern is
    `^[A-Z]+-\\d+$` with an unbounded sequence -- so a MULTI-letter category code
    (`CS-004`) is legal, and `A-1000` is a real ticket once a category passes 999.
    Both are handled; neither is an edge case we may reject.
    """

    ticket_number: str
    counter_id: int

    def __post_init__(self) -> None:
        if not isinstance(self.ticket_number, str) or not self.ticket_number.strip():
            raise InvalidAnnouncementError("ticket_number must be a non-empty string")
        if not isinstance(self.counter_id, int) or isinstance(self.counter_id, bool):
            raise InvalidAnnouncementError("counter_id must be an int")
        if self.counter_id < 1:
            raise InvalidAnnouncementError(
                f"counter_id must be >= 1, got {self.counter_id}"
            )


@dataclass(frozen=True)
class AnnouncementScript:
    """The final Indonesian sentence, ready to hand to any `TtsEngine`.

    A type rather than a bare `str` so the thing that crossed the language boundary
    is named. Cache identity is deliberately NOT here: what identifies a clip also
    depends on the engine, voice and delivery knobs, which is application policy
    (`SynthesizeAnnouncementUseCase._cache_key`), not a property of the sentence.

    Carries the sentence TWICE, at two granularities, and both are load-bearing:

    - `text` is the whole line. It is what gets synthesized when no pause is
      configured, and it stays the cache-key input and the `X-Announcement-Text`
      debug header regardless of pausing -- the announcement is the same
      announcement however it was cut up.
    - `segments` is the same words split at the points a pause belongs. Splitting
      is a DOMAIN decision: it depends on where the numbers fall in Indonesian
      phrasing, which is exactly the knowledge this module exists to hold. How
      long the silence is, and how it is produced, is not decided here.

    Deriving one from the other at the seam was rejected: re-joining `segments`
    would have to re-invent the punctuation, and re-splitting `text` would put a
    parser downstream of the thing that already knew the answer.
    """

    text: str
    segments: tuple[str, ...]

    def __post_init__(self) -> None:
        """Both forms must be the same announcement.

        `build_script` assembles them from shared tokens so they cannot drift
        there -- but this is a public frozen dataclass with two independently
        settable fields, and the application layer constructs one directly for
        free-form preview text. Checking here means the invariant holds at every
        construction site rather than only the one a test covers. Punctuation is
        ignored on BOTH sides: it is what distinguishes the forms, not what they
        disagree on -- and free-form preview text is one segment that keeps its
        own commas, so stripping only `text` would reject it.
        """
        if _words(" ".join(self.segments)) != _words(self.text):
            raise InvalidAnnouncementError(
                f"script segments {self.segments!r} do not spell out {self.text!r}"
            )


def build_script(request: AnnouncementRequest) -> AnnouncementScript:
    """Compose the spoken sentence for a called ticket.

    "A-005" at counter 2 -> "nomor antrian a lima, silakan ke loket dua"
    "A-123" at counter 12 -> "nomor antrian a seratus dua puluh tiga, silakan ke
    loket dua belas"

    Leading zeros are dropped: the ticket is displayed as `A-005` but a human
    would never read it as "nol nol lima".

    The comma is deliberate -- it is the one piece of punctuation the phonemizer
    turns into the short pause that separates the number from the destination.
    Without it the whole line runs together.

    `segments` splits the same words before each NUMBER, because that is what a
    listener has to catch: "nomor antrian" / "a lima" / "silakan ke loket" /
    "dua". A configured pause is inserted at each of those seams. With no pause
    configured the segments are unused and `text` is spoken as one utterance, so
    the default delivery is byte-for-byte what it was before segmentation
    existed.
    """
    code, _, sequence_part = request.ticket_number.partition("-")

    spoken_code = letters_to_words(code)
    if not spoken_code:
        raise InvalidAnnouncementError(
            f"ticket_number {request.ticket_number!r} has no pronounceable "
            "category letters"
        )

    # A ticket number with no dash (or a non-numeric tail) still announces -- the
    # category alone is better than silence. Callers never construct these, but a
    # hand-crafted WS frame or a future numbering scheme might.
    ticket_words = spoken_code
    if sequence_part.isdigit():
        ticket_words = f"{spoken_code} {number_to_words(int(sequence_part))}"

    # Both forms are assembled from the SAME tokens rather than written out
    # twice: the whole point of carrying `text` and `segments` together is that
    # they are one sentence at two granularities, and two independent f-strings
    # would let them drift into two different announcements.
    lead = "nomor antrian"
    tail = "silakan ke loket"
    counter_words = number_to_words(request.counter_id)
    return AnnouncementScript(
        text=f"{lead} {ticket_words}, {tail} {counter_words}",
        # The ticket id stays whole. A seam between "a" and "lima" would put a
        # pause INSIDE the number the listener is trying to catch, which is the
        # opposite of what pausing is for -- the seams belong in front of each
        # number, not through one.
        segments=(lead, ticket_words, tail, counter_words),
    )


def _words(phrase: str) -> list[str]:
    """The spoken words of a phrase, with punctuation and spacing normalised away."""
    return phrase.replace(",", " ").split()

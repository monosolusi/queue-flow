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
    """

    text: str


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
    """
    code, _, sequence_part = request.ticket_number.partition("-")

    spoken_code = letters_to_words(code)
    if not spoken_code:
        raise InvalidAnnouncementError(
            f"ticket_number {request.ticket_number!r} has no pronounceable "
            "category letters"
        )

    parts = ["nomor antrian", spoken_code]

    # A ticket number with no dash (or a non-numeric tail) still announces -- the
    # category alone is better than silence. Callers never construct these, but a
    # hand-crafted WS frame or a future numbering scheme might.
    if sequence_part.isdigit():
        parts.append(number_to_words(int(sequence_part)))

    head = " ".join(parts)
    return AnnouncementScript(
        text=f"{head}, silakan ke loket {number_to_words(request.counter_id)}"
    )

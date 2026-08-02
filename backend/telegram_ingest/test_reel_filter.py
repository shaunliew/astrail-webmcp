"""reel_filter — the security boundary. Pure unit tests, no mocks, no network.

Two literals are load-bearing across this file:
  - `CANARY-SECRET` / `token=abc` stand in for untrusted chat content and a secret-bearing
    URL, so the leak assertions are greppable;
  - every `url` entity's offset/length is computed with `_utf16_len`, never hand-counted,
    so the fixtures cannot drift away from Telegram's UTF-16 code-unit contract.
"""
from __future__ import annotations

import dataclasses
import logging
import re
import traceback

import pytest

from telegram_ingest import reel_filter
from telegram_ingest.reel_filter import FilterResult, extract_reel_urls

# The contract every string that leaves this module must satisfy.
OUTPUT_CONTRACT = re.compile(r"^https://www\.instagram\.com/reel/[A-Za-z0-9_-]+$")


def _utf16_len(text: str) -> int:
    """Length of `text` in UTF-16 code units — Telegram's offset/length unit."""
    return len(text.encode("utf-16-le")) // 2


def _url_message(*urls: str, lead: str = "", field: str = "text") -> dict:
    """One message whose `url` entities point at `urls`, offsets in UTF-16 units."""
    key = "entities" if field == "text" else "caption_entities"
    body = lead
    entities: list[dict] = []
    for url in urls:
        entities.append(
            {"type": "url", "offset": _utf16_len(body), "length": _utf16_len(url)}
        )
        body = f"{body}{url} "
    return {field: body, key: entities}


def _reel(code: str) -> str:
    return f"https://www.instagram.com/reel/{code}/"


# --------------------------------------------------------------------------------------
# 1. THE UTF-16 TEST — the highest-value test in this task.
# --------------------------------------------------------------------------------------


def test_url_entity_is_sliced_in_utf16_code_units_not_python_characters():
    prefix = "\U0001F1EF\U0001F1F5\U0001F525 look "  # 🇯🇵 (4 units) + 🔥 (2 units) + " look "
    url = "https://www.instagram.com/reel/ABC123/"
    message = {
        "text": prefix + url,
        "entities": [
            {"type": "url", "offset": _utf16_len(prefix), "length": _utf16_len(url)}
        ],
    }

    result = extract_reel_urls(message)

    # The fixture only proves anything if the two unit systems actually diverge here.
    assert _utf16_len(prefix) - len(prefix) == 3
    assert result == FilterResult(("https://www.instagram.com/reel/ABC123",), (), False)


# --------------------------------------------------------------------------------------
# 2-6. Entity kinds, host strictness, rejected shapes.
# --------------------------------------------------------------------------------------


def test_text_link_entity_uses_its_url_field_not_the_visible_text():
    message = {
        "text": "this place",
        "entities": [
            {
                "type": "text_link",
                "offset": 0,
                "length": _utf16_len("this place"),
                "url": _reel("TL0001"),
            }
        ],
    }

    result = extract_reel_urls(message)

    assert result.urls == ("https://www.instagram.com/reel/TL0001",)
    assert "this place" not in repr(result)


@pytest.mark.parametrize(
    "hostile",
    ["https://instagram.com.evil.com/reel/A", "https://notinstagram.com/reel/A"],
)
def test_lookalike_hosts_are_ordinary_chat_not_instagram(hostile: str):
    result = extract_reel_urls(_url_message(hostile))

    # Not merely un-captured: they must not even be *rejections*, or the substring form
    # of the host test would leak "/reel/…" shapes for every lookalike domain.
    assert result == FilterResult((), (), False)


def test_share_reel_url_is_rejected_as_a_shape_and_never_leaks_its_code():
    result = extract_reel_urls(_url_message("https://www.instagram.com/share/reel/SH99/"))

    assert result.urls == ()
    assert result.rejected_shapes == ("/share/reel/…",)
    assert "SH99" not in repr(result)


def test_a_rejected_shape_is_reported_even_when_the_message_also_has_a_valid_reel():
    result = extract_reel_urls(
        _url_message(_reel("ABC123"), "https://www.instagram.com/share/reel/XYZ/")
    )

    assert result.urls == ("https://www.instagram.com/reel/ABC123",)
    assert result.rejected_shapes == ("/share/reel/…",)
    assert "XYZ" not in repr(result)


def test_subdomain_is_instagram_looking_and_query_and_fragment_never_reach_the_shape():
    result = extract_reel_urls(_url_message("https://m.instagram.com/p/POST1/?igsh=abc#x"))

    assert result.urls == ()
    assert result.rejected_shapes == ("/p/…",)
    assert "POST1" not in repr(result)
    assert "igsh" not in repr(result)


@pytest.mark.parametrize(
    ("url", "shape"),
    [
        ("https://www.instagram.com/share/reel/SH99/", "/share/reel/…"),
        ("https://www.instagram.com/p/ABC123/", "/p/…"),
        ("https://www.instagram.com/tv/XYZ/", "/tv/…"),
        ("https://www.instagram.com/reel/", "/reel"),
        ("https://www.instagram.com/stories/someone/123/", "/stories/…"),
        ("https://www.instagram.com/", "/"),
        ("https://www.instagram.com", "/"),
        # The 4-segment cap, and it applies AFTER the `…` collapse.
        ("https://www.instagram.com/p/a/reel/b/tv/c/s/d/", "/p/…/reel/…"),
        ("https://www.instagram.com/a/b/c/d/e/reel/f/", "/…/reel/…"),
    ],
)
def test_shape_sanitization_worked_examples(url: str, shape: str):
    assert extract_reel_urls(_url_message(url)).rejected_shapes == (shape,)


# --------------------------------------------------------------------------------------
# 7-9. Dedupe, caps, truncation.
# --------------------------------------------------------------------------------------


def test_urls_are_deduped_preserving_first_seen_order():
    # First-seen order is deliberately the reverse of sorted order: a fixture already in
    # the asserted order would prove nothing about ordering.
    result = extract_reel_urls(
        _url_message(_reel("ZZZ111"), _reel("AAA222"), _reel("ZZZ111"), _reel("ZZZ111"))
    )

    assert result.urls == (
        "https://www.instagram.com/reel/ZZZ111",
        "https://www.instagram.com/reel/AAA222",
    )
    assert result.truncated is False


def test_ten_urls_are_not_truncated():
    result = extract_reel_urls(_url_message(*(_reel(f"CODE{i:02d}") for i in range(10))))

    assert len(result.urls) == 10
    assert result.truncated is False


def test_eleven_urls_keep_the_first_ten_and_flag_truncated():
    urls = [_reel(f"CODE{i:02d}") for i in range(11)]

    result = extract_reel_urls(_url_message(*urls))

    assert result.urls == tuple(
        f"https://www.instagram.com/reel/CODE{i:02d}" for i in range(10)
    )
    assert result.truncated is True


def test_repeated_share_shapes_collapse_to_one_entry():
    result = extract_reel_urls(
        _url_message(
            "https://www.instagram.com/share/reel/AAA/",
            "https://www.instagram.com/share/reel/BBB/",
            "https://www.instagram.com/share/reel/CCC/",
        )
    )

    assert result.rejected_shapes == ("/share/reel/…",)


def test_rejected_shapes_are_capped_at_ten_entries():
    # Distinctness has to come from the keyword vocabulary: any run of unknown segments
    # collapses to a single "/…", so "12 different codes" would be one shape, not twelve.
    paths = [
        "/p/x/", "/tv/x/", "/s/x/", "/share/x/", "/stories/x/", "/reel/x/y/",
        "/reels/x/y/", "/foo/bar/", "/p/x/reel/y/", "/tv/x/p/y/", "/share/reel/z/",
        "/s/x/tv/y/",
    ]
    urls = [f"https://www.instagram.com{path}" for path in paths]

    result = extract_reel_urls(_url_message(*urls))

    assert result.rejected_shapes == (
        "/p/…", "/tv/…", "/s/…", "/share/…", "/stories/…", "/reel/…", "/reels/…", "/…",
        "/p/…/reel/…", "/tv/…/p/…",
    )
    assert len(result.rejected_shapes) == 10  # the last two shapes were dropped


# --------------------------------------------------------------------------------------
# 10-14. Budget, caption path, ignored types, malformed input, empty input.
# --------------------------------------------------------------------------------------


def test_entity_budget_is_the_sum_of_both_lists_not_either_one_alone():
    # 51 + 50 = 101: neither list alone exceeds 100, so a per-list check would let this
    # through and return the reel.
    message = {
        "text": _reel("BUDGET"),
        "entities": [{"type": "bold", "offset": 0, "length": 1}] * 50,
        "caption": _reel("BUDGET"),
        "caption_entities": [{"type": "bold", "offset": 0, "length": 1}] * 50,
    }
    message["entities"] = message["entities"] + [
        {"type": "url", "offset": 0, "length": _utf16_len(_reel("BUDGET"))}
    ]

    assert len(message["entities"]) + len(message["caption_entities"]) == 101
    assert extract_reel_urls(message) == FilterResult((), (), False)


def test_exactly_one_hundred_entities_is_within_budget():
    message = {
        "text": _reel("BUDGET"),
        "entities": [{"type": "url", "offset": 0, "length": _utf16_len(_reel("BUDGET"))}]
        + [{"type": "bold", "offset": 0, "length": 1}] * 49,
        "caption": "",
        "caption_entities": [{"type": "bold", "offset": 0, "length": 1}] * 50,
    }

    assert len(message["entities"]) + len(message["caption_entities"]) == 100
    assert extract_reel_urls(message).urls == ("https://www.instagram.com/reel/BUDGET",)


def test_caption_only_message_is_read():
    result = extract_reel_urls(
        _url_message(_reel("CAP001"), lead="\U0001F4CD ", field="caption")
    )

    assert result.urls == ("https://www.instagram.com/reel/CAP001",)


def test_text_and_caption_are_both_read_in_order():
    message = _url_message(_reel("TEXT01"))
    message |= _url_message(_reel("CAPT01"), field="caption")

    result = extract_reel_urls(message)

    assert result.urls == (
        "https://www.instagram.com/reel/TEXT01",
        "https://www.instagram.com/reel/CAPT01",
    )


@pytest.mark.parametrize("kind", ["bold", "mention", "hashtag", "pre", "custom_emoji"])
def test_non_url_entity_types_contribute_nothing(kind: str):
    # The entity spans a genuine reel URL: only the type check keeps it out.
    url = _reel("IGNORE")
    message = {
        "text": url,
        "entities": [{"type": kind, "offset": 0, "length": _utf16_len(url)}],
    }

    assert extract_reel_urls(message) == FilterResult((), (), False)


@pytest.mark.parametrize(
    "entity",
    [
        {"type": "url", "length": 10},  # no offset
        {"type": "url", "offset": 0},  # no length
        {"type": "url", "offset": 0, "length": 5000},  # length past the end
        {"type": "url", "offset": -5, "length": 10},  # negative offset
        {"type": "url", "offset": "0", "length": "10"},  # non-integer offsets
        {"type": "url", "offset": 1, "length": 40},  # lands mid surrogate pair
        {"type": "text_link", "offset": 0, "length": 2},  # no url key
        {"type": "text_link", "offset": 0, "length": 2, "url": None},  # url not a str
        {"offset": 0, "length": 2},  # no type
        "not-a-dict",
    ],
)
def test_malformed_entities_contribute_nothing_and_never_raise(entity: object):
    message = {"text": "\U0001F525 hi", "entities": [entity]}

    assert extract_reel_urls(message) == FilterResult((), (), False)


@pytest.mark.parametrize(
    "message",
    [
        {},
        {"text": ""},
        {"text": "hi", "entities": []},
        {"entities": None, "caption_entities": None},
        {"text": None, "entities": [{"type": "url", "offset": 0, "length": 3}]},
        {"entities": "not-a-list", "caption_entities": 7},
        {"text": "no links here at all"},
    ],
)
def test_empty_and_absent_fields_return_an_empty_result(message: dict):
    assert extract_reel_urls(message) == FilterResult((), (), False)


# --------------------------------------------------------------------------------------
# 15-17. The canary, the output contract, immutability.
# --------------------------------------------------------------------------------------


def test_caplog_canary_no_message_content_reaches_any_log_record(caplog):
    message = {
        "text": "CANARY-SECRET look at this",
        "entities": [
            {"type": "text_link", "offset": 0, "length": 13, "url": "https://x/?token=abc"}
        ],
    }

    with caplog.at_level(logging.DEBUG):
        result = extract_reel_urls(message)

    # The module must not log AT ALL — the strongest form of "it cannot leak".
    assert caplog.records == []
    emitted = "\n".join(record.getMessage() for record in caplog.records)
    assert "CANARY-SECRET" not in emitted
    assert "token=abc" not in emitted
    assert "CANARY-SECRET" not in repr(result)
    assert "token=abc" not in repr(result)
    assert result == FilterResult((), (), False)


def test_an_unparseable_candidate_never_raises_out_of_this_module():
    """The exception this module must never let escape carries the chat content itself.

    Verified, not assumed: `normalize_reel_url` raises
    `ValueError("not an Instagram reel URL: 'https://…'")` — the message IS the candidate.
    We swallow it, but anything that raises INSIDE that handler gets it attached as
    implicit `__context__`, and a caller's `logger.exception(...)` prints the whole chain.
    `https://[::1/…` is the live trigger: `urlparse` raises `ValueError: Invalid IPv6 URL`
    on it, from inside the very handler that is holding the leaky exception.
    """
    message = _url_message("https://[::1/reel/CANARY-SECRET", "https://[")

    try:
        result = extract_reel_urls(message)
    except BaseException as exc:  # noqa: BLE001 — the raise itself is the defect
        raise AssertionError(
            "extract_reel_urls raised; a caller's traceback would carry chat content:\n"
            + "".join(traceback.format_exception(exc))
        ) from None

    assert result == FilterResult((), (), False)


@pytest.mark.parametrize(
    ("candidate", "shapes"),
    [
        ("https://instagram.com:notaport/p/CANARY-SECRET/", ("/p/…",)),
        ("https://instagram.com:99999/p/CANARY-SECRET/", ("/p/…",)),
        ("javascript:alert(1)//instagram.com/reel/CANARY-SECRET", ()),
        ("https://[::1/reel/CANARY-SECRET", ()),
    ],
)
def test_hostile_candidates_yield_no_url_and_leak_nothing(candidate: str, shapes: tuple):
    result = extract_reel_urls(_url_message(candidate))

    assert result.urls == ()
    assert result.rejected_shapes == shapes
    assert "CANARY-SECRET" not in repr(result)


def test_module_does_not_import_logging():
    """Structural twin of the canary: no logger binding exists to be misused later."""
    assert "logging" not in vars(reel_filter)
    assert "logger" not in vars(reel_filter)


def test_every_returned_url_matches_the_output_contract():
    messages = [
        _url_message(_reel("ABC123"), "https://www.instagram.com/share/reel/SH99/"),
        _url_message("https://www.instagram.com/reel/QQQ777/?igsh=abcd&x=1#frag"),
        _url_message("http://instagram.com/reels/PLURAL9/"),
        _url_message(*(_reel(f"CODE{i:02d}") for i in range(11))),
        {
            "caption": "\U0001F4CD trip",
            "caption_entities": [
                {"type": "text_link", "offset": 0, "length": 2, "url": _reel("T_L-99")}
            ],
        },
    ]

    returned = [url for message in messages for url in extract_reel_urls(message).urls]

    assert len(returned) == 14
    assert all(OUTPUT_CONTRACT.fullmatch(url) for url in returned)
    assert "https://www.instagram.com/reel/QQQ777" in returned
    assert "https://www.instagram.com/reel/PLURAL9" in returned


def test_filter_result_is_immutable_and_tuple_valued():
    result = extract_reel_urls(_url_message(_reel("ABC123")))

    with pytest.raises(dataclasses.FrozenInstanceError):
        result.urls = ()  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.truncated = True  # type: ignore[misc]

    assert isinstance(result.urls, tuple)
    assert isinstance(result.rejected_shapes, tuple)
    assert isinstance(result.truncated, bool)

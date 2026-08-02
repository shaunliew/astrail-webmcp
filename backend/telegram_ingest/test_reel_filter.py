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


# An unpaired UTF-16 surrogate. `str.encode("utf-16-le")` refuses it, and stdlib
# `json.loads` does NOT validate surrogate pairing on `\uXXXX` escapes — verified:
# `json.loads(r'{"text": "a \ud800 b"}')` returns the lone surrogate intact. A hostile group
# member therefore controls this byte sequence exactly, straight out of the Bot API response.
LONE_SURROGATE = "\ud800"


def _utf16_len(text: str) -> int:
    """Length of `text` in UTF-16 code units — Telegram's offset/length unit."""
    return len(text.encode("utf-16-le")) // 2


def _utf16_len_unsafe(text: str) -> int:
    """`_utf16_len` that tolerates unpaired surrogates. FIXTURES ONLY.

    Telegram counts a lone surrogate as one code unit, so this is the offset the Bot API
    would really send. `surrogatepass` here is a property of the *test fixture*, never of
    the production slice — the module under test must cope with the raw `.encode` failing.
    """
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def _formatted(exc: BaseException) -> str:
    """The full traceback text a caller's `logger.exception(...)` would emit."""
    return "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))


def _must_not_raise(message: dict) -> FilterResult:
    """Call the module and turn any escape into a failure that shows the leaked traceback.

    `UnicodeEncodeError`/`UnicodeDecodeError`/`ValueError` messages all quote the offending
    content, so an exception crossing this boundary is a guardrail #11 leak, not just a bug.
    """
    try:
        return extract_reel_urls(message)
    except BaseException as exc:  # noqa: BLE001 — the escape itself is the defect
        raise AssertionError(
            "extract_reel_urls raised; a caller's logger.exception(...) would emit:\n"
            + _formatted(exc)
        ) from None


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
        # A kept keyword is emitted lowercased, never with the author's casing.
        ("https://www.instagram.com/ShArE/ReEl/CODE/", "/share/reel/…"),
    ],
)
def test_shape_sanitization_worked_examples(url: str, shape: str):
    assert extract_reel_urls(_url_message(url)).rejected_shapes == (shape,)


def test_case_variants_of_one_keyword_collapse_to_a_single_shape():
    """Casing is attacker-controlled, so echoing it is a guardrail #11 leak.

    `/rEeL/` and `/reel/` as distinct shapes would give a message author a channel into
    T4's ERROR log AND a way to fill the 10-shape cap with variants of a single keyword,
    pushing genuine shapes out. `_PATH_KEYWORDS` is a closed 7-word set, so lowercasing
    the kept segment loses exactly zero information.
    """
    result = extract_reel_urls(
        _url_message(
            "https://www.instagram.com/ShArE/x/",
            "https://www.instagram.com/SHARE/y/",
            "https://www.instagram.com/sHaRe/z/",
        )
    )

    assert result.rejected_shapes == ("/share/…",)


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
    result = _must_not_raise(_url_message("https://[::1/reel/CANARY-SECRET", "https://["))

    assert result == FilterResult((), (), False)


# --------------------------------------------------------------------------------------
# Unpaired surrogates — the encode side of the same exception family.
# --------------------------------------------------------------------------------------


def test_lone_surrogate_in_text_with_a_url_entity_never_raises():
    """A plain `src.encode("utf-16-le")` raises `UnicodeEncodeError` on an unpaired
    surrogate, and `_candidate_url` is called from `extract_reel_urls` with no try/except
    around it — so an unguarded encode propagates straight out of the module, and
    `UnicodeEncodeError`'s message quotes the offending character, leaking content as well
    as crashing the caller's loop.

    `surrogatepass` also makes the surrogate irrelevant to a candidate that does not
    contain it, so the reel here is captured rather than collateral damage.
    """
    prefix = f"hello {LONE_SURROGATE} world "
    url = _reel("ABC123")
    message = {
        "text": prefix + url,
        "entities": [
            {
                "type": "url",
                "offset": _utf16_len_unsafe(prefix),
                "length": _utf16_len_unsafe(url),
            }
        ],
    }

    result = _must_not_raise(message)

    assert result.urls == ("https://www.instagram.com/reel/ABC123",)
    assert LONE_SURROGATE not in repr(result)


def test_lone_surrogate_in_caption_with_a_caption_url_entity_never_raises():
    prefix = f"\U0001F4CD {LONE_SURROGATE} trip "
    url = _reel("CAP001")
    message = {
        "caption": prefix + url,
        "caption_entities": [
            {
                "type": "url",
                "offset": _utf16_len_unsafe(prefix),
                "length": _utf16_len_unsafe(url),
            }
        ],
    }

    result = _must_not_raise(message)

    assert result.urls == ("https://www.instagram.com/reel/CAP001",)
    assert LONE_SURROGATE not in repr(result)


def test_the_surrogate_guard_is_scoped_to_the_slice_not_a_blanket_swallow():
    """A `text_link` carries its URL out of band and never calls `_slice_utf16`, so a
    surrogate in the visible text is irrelevant to it. Red if the fix were a blanket
    try/except around the whole function body returning an empty result."""
    message = {
        "text": f"look {LONE_SURROGATE} here",
        "entities": [
            {"type": "text_link", "offset": 0, "length": 4, "url": _reel("TL0001")}
        ],
    }

    result = _must_not_raise(message)

    assert result.urls == ("https://www.instagram.com/reel/TL0001",)


def test_a_surrogate_in_text_costs_neither_its_own_field_nor_the_caption():
    """Containment across both axes at once: the poisoned field keeps its own clean reel
    AND the untouched caption keeps its reel. Pre-`surrogatepass` the text's reel was lost
    (per-field void); pre-guard the whole call raised."""
    in_text = _reel("TEXT01")
    prefix = f"bad {LONE_SURROGATE} "
    in_caption = _reel("CAP002")
    message = {
        "text": prefix + in_text,
        "entities": [
            {
                "type": "url",
                "offset": _utf16_len_unsafe(prefix),
                "length": _utf16_len_unsafe(in_text),
            }
        ],
        "caption": in_caption,
        "caption_entities": [
            {"type": "url", "offset": 0, "length": _utf16_len(in_caption)}
        ],
    }

    result = _must_not_raise(message)

    assert result.urls == (
        "https://www.instagram.com/reel/TEXT01",
        "https://www.instagram.com/reel/CAP002",
    )


def test_a_poison_candidate_does_not_cost_ITS_OWN_FIELD_a_valid_reel():
    """Containment is per-CANDIDATE, not per-field. The test that matters.

    A `url` offset is defined over the whole field, so the whole field is encoded to
    resolve any one entity — with a plain `.encode` one unpaired surrogate anywhere voids
    every `url` entity in that field, including entities whose own bytes are spotless.
    `errors="surrogatepass"` keeps the encode total and offsets exact, so a surrogate only
    reaches the candidates whose own slice contains it.

    Silent, too: T4 returns without logging when `urls` and `rejected_shapes` are both
    empty, so the pre-fix behaviour discarded good reels with no record anywhere —
    guardrail #12's silent drop, and a one-character denial of extraction.
    """
    poison = f"hello {LONE_SURROGATE} world "
    good = _reel("GOOD01")
    message = {
        "text": poison + good,
        "entities": [
            {"type": "url", "offset": 0, "length": _utf16_len_unsafe(poison)},
            {
                "type": "url",
                "offset": _utf16_len_unsafe(poison),
                "length": _utf16_len_unsafe(good),
            },
        ],
    }

    result = _must_not_raise(message)

    assert result.urls == ("https://www.instagram.com/reel/GOOD01",)
    assert LONE_SURROGATE not in repr(result)


def test_a_poison_candidate_does_not_cost_its_caption_a_valid_reel():
    poison = f"trip {LONE_SURROGATE} notes "
    good = _reel("CAP001")
    message = {
        "caption": poison + good,
        "caption_entities": [
            {"type": "url", "offset": 0, "length": _utf16_len_unsafe(poison)},
            {
                "type": "url",
                "offset": _utf16_len_unsafe(poison),
                "length": _utf16_len_unsafe(good),
            },
        ],
    }

    result = _must_not_raise(message)

    assert result.urls == ("https://www.instagram.com/reel/CAP001",)


def test_two_valid_reels_both_survive_a_poison_candidate_between_them():
    """The motivating case: one hostile character must not discard a whole share."""
    lead = f"{LONE_SURROGATE} "
    first, second = _reel("AAA111"), _reel("BBB222")
    message = {
        "text": f"{lead}{first} {second}",
        "entities": [
            {"type": "url", "offset": 0, "length": _utf16_len_unsafe(lead)},
            {
                "type": "url",
                "offset": _utf16_len_unsafe(lead),
                "length": _utf16_len_unsafe(first),
            },
            {
                "type": "url",
                "offset": _utf16_len_unsafe(f"{lead}{first} "),
                "length": _utf16_len_unsafe(second),
            },
        ],
    }

    result = _must_not_raise(message)

    assert result.urls == (
        "https://www.instagram.com/reel/AAA111",
        "https://www.instagram.com/reel/BBB222",
    )


def test_a_surrogate_bearing_instagram_url_is_still_reported_loudly_as_a_shape():
    """The DECODE-side `surrogatepass` earns its place here, separately from the encode.

    Without it the slice raises `UnicodeDecodeError`, the candidate becomes None, and an
    Instagram URL vanishes with no shape and therefore no T4 log line — silent, which is
    the failure mode §3.1 spent a review round eliminating. With it the candidate reaches
    `normalize_reel_url`, is rejected, and is reported as a shape like any other.

    Also answers: the shape is surrogate-FREE, because a non-keyword segment is always
    replaced by `…` — the surrogate is in the code, never in the vocabulary.
    """
    poison_ig = f"https://www.instagram.com/p/{LONE_SURROGATE}CODE/"
    message = {
        "text": poison_ig,
        "entities": [
            {"type": "url", "offset": 0, "length": _utf16_len_unsafe(poison_ig)}
        ],
    }

    result = _must_not_raise(message)

    assert result.urls == ()
    assert result.rejected_shapes == ("/p/…",)
    assert LONE_SURROGATE not in repr(result)


def test_a_text_link_url_holding_a_surrogate_takes_the_unsliced_path_unchanged():
    """`text_link` never calls `_slice_utf16`, so neither codec flag applies to it. Its
    surrogate-bearing URL still parses, still fails `normalize_reel_url`, and is still
    reported as a surrogate-free shape."""
    message = {
        "text": "look here",
        "entities": [
            {
                "type": "text_link",
                "offset": 0,
                "length": 4,
                "url": f"https://www.instagram.com/p/{LONE_SURROGATE}X/",
            }
        ],
    }

    result = _must_not_raise(message)

    assert result.urls == ()
    assert result.rejected_shapes == ("/p/…",)
    assert LONE_SURROGATE not in repr(result)


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

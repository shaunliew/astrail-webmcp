"""Unit tests for the restaurant details enricher.

Credential-free (guardrail #16): the runner is injected everywhere, so no key is read, no Agent is
built and no search is made. The properties under test are the STRUCTURAL ones — grounding by
index, evidence discipline, and output validation — because those are what make it safe to give
this agent a tool at all (see the module docstring).
"""
from __future__ import annotations

import pytest

from genagents.restaurant_details import (
    MAX_HOURS_CHARS,
    build_detail_input,
    fetch_restaurant_details,
    keep_grounded_details,
)
from models.enrichment import RestaurantDetail, RestaurantDetailSet

POIS = [
    {"name": "駒すし", "address": "1-2-3 Nukata, Higashiosaka"},
    {"name": "グリーンガーデンひらおか", "address": "4-5-6 Hiraoka, Higashiosaka"},
]

SOURCE = "https://example.jp/koma"


def detail(**over) -> RestaurantDetail:
    base = {"poi_index": 0, "opening_hours": "Mon-Sat 11:30-22:00",
            "website": "https://koma.example.jp", "source_url": SOURCE}
    return RestaurantDetail(**{**base, **over})


# --- grounding: a detail cannot attach to a venue we never searched -------------------------------

def test_index_out_of_range_is_dropped():
    assert keep_grounded_details([detail(poi_index=7)], POIS) == {}


def test_negative_index_is_dropped():
    assert keep_grounded_details([detail(poi_index=-1)], POIS) == {}


def test_duplicate_index_keeps_only_the_first():
    kept = keep_grounded_details(
        [detail(opening_hours="Daily 09:00-17:00"), detail(opening_hours="Daily 00:00-23:59")], POIS,
    )
    assert kept[0]["opening_hours"] == "Daily 09:00-17:00"
    assert len(kept) == 1


# --- evidence discipline: hours are a claim about the world ---------------------------------------

def test_hours_without_a_source_are_discarded():
    """Guardrail #1. An unattributed opening time is a confident-looking assertion with nothing
    behind it, and a map popup is where it would look most authoritative."""
    assert keep_grounded_details([detail(source_url=None)], POIS) == {}


def test_a_source_alone_is_not_worth_keeping():
    assert keep_grounded_details([detail(opening_hours=None, website=None)], POIS) == {}


def test_a_website_alone_is_kept():
    kept = keep_grounded_details([detail(opening_hours=None)], POIS)
    assert kept[0] == {"source_url": SOURCE, "website": "https://koma.example.jp"}


# --- output validation: the model's strings are untrusted output -----------------------------------

@pytest.mark.parametrize("bad", ["javascript:alert(1)", "data:text/html,x", "not a url", "", "ftp://x.jp/a"])
def test_non_http_source_is_rejected(bad):
    """source_url and website are rendered as anchors in the popup, so scheme validation happens
    here rather than being left to the renderer."""
    assert keep_grounded_details([detail(source_url=bad)], POIS) == {}


def test_non_http_website_is_dropped_but_hours_survive():
    kept = keep_grounded_details([detail(website="javascript:alert(1)")], POIS)
    assert kept[0] == {"source_url": SOURCE, "opening_hours": "Mon-Sat 11:30-22:00"}


def test_multiline_hours_are_collapsed_to_one_line():
    kept = keep_grounded_details([detail(opening_hours="Mon-Fri 11:00-14:00\n  Sat 17:00-22:00")], POIS)
    assert kept[0]["opening_hours"] == "Mon-Fri 11:00-14:00 Sat 17:00-22:00"


def test_a_pasted_hours_table_is_dropped_rather_than_truncated():
    """Over the cap it is a scraped weekly table, not this venue's hours in a form anyone reads on
    a 300px card. Truncating would leave a fragment that looks like a real, wrong answer.

    The rest of the entry survives: a usable website is not made worthless by unusable hours, and
    dropping the whole detail would throw away a good field to punish a bad one."""
    kept = keep_grounded_details([detail(opening_hours="x" * (MAX_HOURS_CHARS + 1))], POIS)
    assert "opening_hours" not in kept[0]
    assert kept[0]["website"] == "https://koma.example.jp"

    # With nothing else to keep, the detail goes entirely.
    only_hours = keep_grounded_details(
        [detail(opening_hours="x" * (MAX_HOURS_CHARS + 1), website=None)], POIS,
    )
    assert only_hours == {}


# --- prompt input: Mapbox-sourced only -------------------------------------------------------------

def test_input_carries_only_the_mapbox_name_and_address():
    """The whole reason this agent may hold a tool is that its input is not attacker-controlled.
    Anything derived from reel text must never appear here."""
    text = build_detail_input(POIS, city="Osaka")
    assert "駒すし" in text and "1-2-3 Nukata" in text and "Osaka" in text
    assert "0." in text and "1." in text          # indices the model answers with


def test_missing_address_still_produces_a_numbered_line():
    text = build_detail_input([{"name": "Somewhere"}])
    assert "0. Somewhere — address unknown" in text


# --- best-effort: never fails the trip -------------------------------------------------------------

@pytest.mark.asyncio
async def test_no_pois_short_circuits_without_running_anything():
    async def runner(*_a, **_k):
        raise AssertionError("must not run for an empty list")

    assert await fetch_restaurant_details([], runner=runner) == {}


@pytest.mark.asyncio
async def test_a_failed_run_yields_no_details_rather_than_raising():
    """Guardrail #3: an itinerary must render without garnish. A search outage cannot be allowed
    to fail a trip the user already waited 60-180s for."""
    async def runner(*_a, **_k):
        raise RuntimeError("search backend down")

    assert await fetch_restaurant_details(POIS, runner=runner) == {}


@pytest.mark.asyncio
async def test_a_successful_run_returns_validated_entries():
    class Result:
        final_output = RestaurantDetailSet(details=[detail(), detail(poi_index=1, source_url="nope")])

    async def runner(*_a, **_k):
        return Result()

    kept = await fetch_restaurant_details(POIS, city="Osaka", runner=runner)
    assert set(kept) == {0}                      # index 1 had an unusable source and was dropped
    assert kept[0]["opening_hours"] == "Mon-Sat 11:30-22:00"


@pytest.mark.asyncio
async def test_an_empty_result_is_a_normal_outcome():
    """Small local venues publish nothing. Reporting that honestly is the point."""
    class Result:
        final_output = RestaurantDetailSet(details=[])

    async def runner(*_a, **_k):
        return Result()

    assert await fetch_restaurant_details(POIS, runner=runner) == {}

"""Unit tests for the restaurant details enricher.

Credential-free (guardrail #16): the runner is injected everywhere, so no key is read, no Agent is
built and no search is made. The properties under test are the STRUCTURAL ones — grounding by
index, evidence discipline, and output validation — because those are what make it safe to give
this agent a tool at all (see the module docstring).
"""
from __future__ import annotations

import asyncio
import re

import pytest

import genagents.restaurant_details as rd
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


# --- bounded: a stuck search cannot hold a day open ------------------------------------------------

@pytest.mark.asyncio
async def test_a_hung_search_is_bounded_rather_than_stalling_the_day(monkeypatch):
    """weather.py and transport.py both bound their outbound call; this one had NO ceiling, so a
    hosted web search that never returned held its day open indefinitely — and the trip with it,
    back when the days ran in series.

    Fault-injected with a runner that never completes. The outer wait_for is what makes the
    missing-bound case FAIL rather than hang the suite."""
    monkeypatch.setattr(rd, "DETAIL_TIMEOUT_S", 0.01)
    started = asyncio.Event()

    async def runner(*_a, **_k):
        started.set()
        await asyncio.sleep(3600)

    kept = await asyncio.wait_for(fetch_restaurant_details(POIS, runner=runner), timeout=5)
    assert kept == {}                 # guardrail #3: garnish is best-effort, never a trip failure
    assert started.is_set()           # the search really was attempted, not short-circuited


@pytest.mark.asyncio
async def test_a_timed_out_search_is_not_retried_on_the_fallback_model(monkeypatch):
    """The budget is already spent when the bound fires, so falling back to gpt-4o here would
    double exactly the wait the bound exists to cap. The typed-model fallback answers a model
    being unavailable, which a timeout is not evidence of."""
    monkeypatch.setattr(rd, "DETAIL_TIMEOUT_S", 0.01)
    runs = 0

    async def runner(*_a, **_k):
        nonlocal runs
        runs += 1
        await asyncio.sleep(3600)

    assert await asyncio.wait_for(fetch_restaurant_details(POIS, runner=runner), timeout=5) == {}
    assert runs == 1


def test_a_model_timeout_is_classified_fallback_worthy():
    """Why the ceiling has to be SHARED rather than per-attempt. `APITimeoutError` is in the
    fallback set, so the one error most likely to have consumed the whole budget is also the one
    that buys a second attempt. Pinned explicitly because the test below injects `RuntimeError`
    as its model error (house style — credential-free, no openai import in the hot path), and
    would otherwise be exercising a scenario that could quietly stop existing."""
    from openai import APITimeoutError

    assert APITimeoutError in rd._model_errors()


@pytest.mark.asyncio
async def test_the_fallback_shares_the_primary_budget_instead_of_getting_a_fresh_one(monkeypatch):
    """DETAIL_TIMEOUT_S is documented as the ceiling on ONE day's search, and a per-attempt bound
    was not that: a primary that burned nearly all of its budget and then reported a model problem
    handed the fallback a SECOND full budget — up to ~180s for one day against a 90s bound, on
    exactly the tail a user sits through waiting for their trip.

    Fault injection: give each attempt its own `asyncio.timeout(DETAIL_TIMEOUT_S)` again and the
    measured window roughly doubles, from one budget to one-and-most-of-another."""
    monkeypatch.setattr(rd, "DETAIL_TIMEOUT_S", 0.4)
    monkeypatch.setattr(rd, "_model_errors", lambda: (RuntimeError,))
    # Warm the lazy Agents-SDK import OUT of the measured window: `build_detail_agent` is called
    # inside the bound, so a cold import on this test's first attempt would spend budget that
    # belongs to the search and make the assertion below depend on import speed.
    rd.build_detail_agent(rd.FALLBACK_MODEL)
    attempts: list[float] = []

    async def runner(_agent, _user_input):
        attempts.append(asyncio.get_running_loop().time())
        if len(attempts) == 1:
            await asyncio.sleep(0.3)              # most of the budget...
            raise RuntimeError("model unavailable")   # ...then a fallback-worthy failure
        await asyncio.sleep(3600)                 # the fallback hangs

    kept = await asyncio.wait_for(fetch_restaurant_details(POIS, runner=runner), timeout=10)
    end = asyncio.get_running_loop().time()

    assert kept == {}                 # guardrail #3: garnish is best-effort, never a trip failure
    assert len(attempts) == 2, "the fallback never ran — this assertion would pass vacuously"
    # ONE budget, measured from the first attempt's own start so the agent construction ahead of
    # it cannot inflate the window. Two budgets would be ~0.7s here.
    assert end - attempts[0] < 0.6, f"the fallback bought a second budget: {end - attempts[0]:.2f}s"


# --- the diagnostic line: what a live run has to be able to answer afterwards ---------------------

# `_run_shape` identifies the SDK's items by class NAME so that reading them never drags the Agents
# SDK into module scope (guardrail #9), so these stand in by name alone.
_ToolCallItem = type("ToolCallItem", (), {})
_MessageOutputItem = type("MessageOutputItem", (), {})


def _result(*, turns: int, searches: int):
    class Result:
        final_output = RestaurantDetailSet(details=[detail()])
        raw_responses = [object()] * turns
        new_items = [_ToolCallItem() for _ in range(searches)] + [_MessageOutputItem()]
    return Result()


@pytest.mark.asyncio
async def test_the_diagnostic_line_reports_elapsed_turns_and_searches(capsys):
    """The three things a run has to settle, none of which a fitted estimate could: how long THIS
    call takes on its own (`suggest` is not inside it), and — via turns against searches — whether
    the per-venue searches ran concurrently or one per turn."""
    async def runner(*_a, **_k):
        return _result(turns=2, searches=2)

    await fetch_restaurant_details(POIS, runner=runner)
    line = capsys.readouterr().err.strip()

    # House style keeps the two-space indent; `.strip()` here is only trimming the trailing newline.
    assert line.startswith("[restaurant-details] pois=2 enriched=1")
    # The whole shape, so the format stays parseable by whoever reads the log after a run.
    assert re.fullmatch(
        r"\[restaurant-details\] pois=2 enriched=1 elapsed=\d+\.\d+s turns=2 searches=2", line)


@pytest.mark.asyncio
async def test_the_diagnostic_line_distinguishes_parallel_from_serial_searches(capsys):
    """The decisive shape. Two venues searched in ONE model turn means the tool calls ran in
    parallel; two venues taking a turn each means they serialized. Both are reported by the same
    two fields, so the reader can tell which regime a real run was in."""
    async def parallel(*_a, **_k):
        return _result(turns=2, searches=2)        # both searches inside one turn

    async def serial(*_a, **_k):
        return _result(turns=3, searches=2)        # a turn per search

    await fetch_restaurant_details(POIS, runner=parallel)
    assert "turns=2 searches=2" in capsys.readouterr().err

    await fetch_restaurant_details(POIS, runner=serial)
    assert "turns=3 searches=2" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_a_timed_out_search_reports_that_it_hit_the_bound(capsys, monkeypatch):
    """Whether 90s is ever approached is the third question, and a silent `{}` cannot answer it —
    a timeout has to be distinguishable in the log from a venue that simply publishes nothing."""
    monkeypatch.setattr(rd, "DETAIL_TIMEOUT_S", 0.01)

    async def runner(*_a, **_k):
        await asyncio.sleep(3600)

    assert await asyncio.wait_for(fetch_restaurant_details(POIS, runner=runner), timeout=5) == {}
    line = capsys.readouterr().err
    assert "skipped=timeout" in line and "pois=2" in line and "elapsed=" in line


@pytest.mark.asyncio
async def test_an_unreadable_run_shape_degrades_to_marks_rather_than_failing(capsys):
    """The diagnostic is garnish on garnish. A result object without the SDK's shapes — every
    injected test runner, and any future SDK rename — must still yield the details and a line,
    not an AttributeError that costs the day its enrichment (guardrail #3)."""
    class Bare:
        final_output = RestaurantDetailSet(details=[detail()])

    async def runner(*_a, **_k):
        return Bare()

    kept = await fetch_restaurant_details(POIS, runner=runner)
    assert set(kept) == {0}                        # the lookup still succeeded
    assert "turns=? searches=?" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_the_diagnostic_line_leaks_no_venue_name_or_url(capsys):
    """House style is counts and nothing else (`[restaurants] pois=15 labeled=3`). This line ships,
    so a venue name, an address or a source URL in it would be third-party data written to a log
    for the life of the feature."""
    async def runner(*_a, **_k):
        return _result(turns=2, searches=2)

    await fetch_restaurant_details(POIS, city="Osaka", runner=runner)
    line = capsys.readouterr().err

    for poi in POIS:
        assert poi["name"] not in line and poi["address"] not in line
    assert "Osaka" not in line
    assert SOURCE not in line and "http" not in line

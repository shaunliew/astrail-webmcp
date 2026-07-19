"""Contract tests for the organizer per-item helpers extracted from `run_organize_job`.

These pin the helper boundary so the leasing, user-scoping and coordinate-cache work
that follows can target `_ground_and_persist` directly. The fake client and the
`PlaceResult` builder are reused from the existing organizer test module.
"""
from __future__ import annotations

from organizer import (
    _ItemContext,
    _ground_and_persist,
    _process_item,
    get_organize_status,
    run_organize_job,
)
from test_saved_reels_organize import _Client, _place


def _ctx(client, *, ground=None, scrape=None, extract=None) -> _ItemContext:
    """Build the per-job context the organizer item loop threads through."""
    return _ItemContext(
        client=client, job_id="job-1", user_id="u1",
        scrape=scrape, extract=extract, ground=ground,
    )


async def test_ground_and_persist_empty_grounded_is_location_not_found():
    client = _Client({})

    async def ground(_place_result):
        return None

    terminal, count = await _ground_and_persist(
        _ctx(client, ground=ground), {"id": "r1"}, "cache-1", [_place()]
    )

    assert (terminal, count) == ("location_not_found", 0)
    assert client.db.get("places", []) == []
    assert client.db.get("reel_place_mentions", []) == []


async def test_ground_and_persist_persists_place_and_mention():
    client = _Client({})
    place = _place()

    async def ground(place_result):
        return {"place": place_result, "country_code": "JP", "country_name": "Japan"}

    terminal, count = await _ground_and_persist(
        _ctx(client, ground=ground), {"id": "r1"}, "cache-1", [place]
    )

    assert (terminal, count) == ("organized", 1)
    assert client.db["places"][-1]["name"] == place.name
    assert client.db["places"][-1]["country_code"] == "JP"
    mention = client.db["reel_place_mentions"][-1]
    assert mention["reel_cache_id"] == "cache-1"
    assert mention["place_id"] == client.db["places"][-1]["id"]
    assert mention["verification_version"] == "mapbox-country-v1"


async def test_ground_and_persist_reports_database_phase_for_persist_failures():
    """A2/A3 will edit this block; keep the on-call signal honest.

    `_ground_and_persist` spans TWO phases. The grounding call is "mapbox", but the
    mention delete and the persist loop under it are "database". The first extraction
    tagged the whole unit "mapbox", so a Supabase write failure logged
    `phase=mapbox` and pointed an on-call engineer at Mapbox health. Pin both.
    """
    seen: list[str] = []
    client = _Client({})

    async def ground(place_result):
        seen.append("PHASE-AT-GROUND")
        return {"place": place_result, "country_code": "JP", "country_name": "Japan"}

    phases: list[str] = []
    await _ground_and_persist(
        _ctx(client, ground=ground), {"id": "r1"}, "cache-1", [_place()],
        set_phase=phases.append,
    )

    # grounding reported first, persistence reported as database — in that order
    assert phases == ["mapbox", "database"]


async def test_process_item_skips_counts_when_saved_reel_is_gone():
    """Orphaned item (its `saved_reels` row was deleted) must be SKIPPED.

    Pre-refactor this was a bare `continue`, which skipped the item AND the trailing
    `_update_job_counts`. The extraction turned it into a `return`, so counts ran for
    orphans — no committed value changes (counts recompute from live status columns),
    but a transient DB error there propagates to the JOB-level handler and fails the
    whole job for a case that previously never reached that line.
    """
    client = _Client({"saved_reels": []})     # the item's reel row is gone

    processed = await _process_item(
        _ctx(client), {"id": "item-1", "saved_reel_id": "missing"},
    )

    assert processed is False, "an orphaned item must report skipped, not processed"


async def test_failed_item_still_updates_job_counts(monkeypatch):
    """A genuinely FAILED item must still reach `_update_job_counts`.

    `_process_item` returns False only for an ORPHANED item (its `saved_reels` row is
    gone); a real failure must return True so the caller updates counts. This is not a
    counting nicety: `run_organize_job` derives `final_status` from
    `organize_jobs.failed_count`, a column ONLY `_update_job_counts` writes. If a failed
    item were misread as skipped, the job would report **"succeeded" with 0 failed items**
    while its `organize_job_items` row sits at `status=failed` — a false positive that is
    worse than the orphan bug this return value was introduced to fix.

    No other test in the suite asserts on the count columns or on
    `get_organize_status()`'s numeric fields after a run, so nothing else pins this.
    """
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "reel_cache_id": "cache-1", "analysis_status": "queued",
        }],
    })

    async def _reserve(*_a, **_kw):
        return True

    async def _refund(*_a, **_kw):
        return None

    async def _scrape(*_a, **_kw):
        raise RuntimeError("source down")      # a real failure, NOT an orphaned row

    monkeypatch.setattr("organizer.reserve_organize_item_analysis", _reserve)
    monkeypatch.setattr("organizer.refund_organize_item_analysis", _refund)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_a, **_kw: None)

    await run_organize_job("job-1", "user-a", client=client, scrape=_scrape, extract=None)

    assert client.db["organize_job_items"][0]["status"] == "failed"
    job = client.db["organize_jobs"][0]
    assert job["failed_count"] == 1, "counts must reflect a failed item, not skip it"
    assert job["processed_count"] == 1
    assert job["status"] == "failed", "a job whose only item failed must not read 'succeeded'"

    status = await get_organize_status(client, "job-1", "user-a")
    assert (status["failed_items"], status["organized_items"]) == (1, 0)

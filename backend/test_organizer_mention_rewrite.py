"""User-scoped mention rewrite: an organize run replaces ONE owner's set, never another's.

The Major these pin: `reel_place_mentions` was keyed `(reel_cache_id, place_id)` with no
owner dimension, and `_ground_and_persist` deleted by `reel_cache_id` alone — *before* it knew
whether anything had grounded. So a flaky Mapbox run for user B destroyed user A's verified
evidence, and `authorize_place_ids` then rejected places A legitimately used. The table is the
Saved Reels trust boundary and the backend is `service_role`, so RLS could not scope it.

The fake RPC (`_ReplaceReelPlaceMentionsRpc`) mirrors the SQL function. It cannot reproduce
Postgres's "ON CONFLICT DO UPDATE command cannot affect row a second time", so
`test_two_entries_resolving_to_the_same_place_id_do_not_fail_the_rpc` pins the CALL SHAPE only;
the `distinct on (place_id)` that makes it survive a real database is pinned in
`supabase/tests/007_saved_reels_organize.sql`.
"""
from __future__ import annotations

import pytest

from organizer import (
    LOCATION_VERIFICATION_VERSION,
    _ItemContext,
    _ground_and_persist,
    authorize_place_ids,
)
from test_saved_reels_organize import _Client, _Table, _place


def _ctx(client, *, user_id="uB", ground=None) -> _ItemContext:
    """Per-job context for the item loop. `user_id` is the owner the rewrite is scoped to."""
    return _ItemContext(
        client=client, job_id="job-1", user_id=user_id,
        scrape=None, extract=None, ground=ground, lease_token="lease-1",
    )


async def _grounds_everything(place_result):
    return {"place": place_result, "country_code": "JP", "country_name": "Japan"}


def _seed_mentions(client, *, user_id, cache_id, place_ids):
    rows = client.db.setdefault("reel_place_mentions", [])
    for place_id in place_ids:
        rows.append({
            "id": f"seed-{user_id}-{place_id}",
            "user_id": user_id, "reel_cache_id": cache_id, "place_id": place_id,
            "evidence_quote": f"seed {place_id}", "source_url": None, "confidence": 0.5,
            "verification_version": LOCATION_VERIFICATION_VERSION,
        })


def _mention_place_ids(client, user_id, cache_id) -> set[str]:
    return {row["place_id"] for row in client.db.get("reel_place_mentions", [])
            if row.get("user_id") == user_id and row.get("reel_cache_id") == cache_id}


def _canonical_place(place_id, name="Tokyo Tower"):
    """A `places` row `_persist_place` will dedup onto, so it returns a known id."""
    return {"id": place_id, "name": name, "country_code": "JP", "country_name": "Japan",
            "lat": 35.6, "lng": 139.7}


class _FailingInsertTable(_Table):
    """Fail once the insert budget for this table is spent — a crash mid-persist-loop."""

    def __init__(self, name, db, budget):
        super().__init__(name, db)
        self._budget = budget

    async def execute(self):
        if isinstance(self.op, tuple) and self.op[0] == "insert":
            if self._budget["remaining"] <= 0:
                raise RuntimeError("supabase insert failed")
            self._budget["remaining"] -= 1
        return await super().execute()


class _FailingInsertClient(_Client):
    def __init__(self, db=None, *, fail_table, after):
        super().__init__(db)
        self._fail_table, self._budget = fail_table, {"remaining": after}

    def table(self, name):
        if name != self._fail_table:
            return super().table(name)
        return _FailingInsertTable(name, self.db, self._budget)


async def test_failed_grounding_preserves_existing_mentions():
    """Guardrail #3: a Mapbox brownout is a partial failure, not a data-loss event.

    Nothing grounds, so nothing is written — and critically nothing is DELETED either. The
    pre-fix code deleted by `reel_cache_id` before checking `grounded`, so this run wiped
    every user's verified evidence for the Reel and returned `location_not_found`.
    """
    client = _Client({})
    _seed_mentions(client, user_id="uA", cache_id="c1", place_ids=["p1", "p2", "p3"])

    async def ground(_place_result):
        return None                                   # brownout: nothing grounds

    terminal, count = await _ground_and_persist(
        _ctx(client, ground=ground), {"id": "rB"}, "c1", [_place()]
    )

    assert (terminal, count) == ("location_not_found", 0)
    assert _mention_place_ids(client, "uA", "c1") == {"p1", "p2", "p3"}
    assert client.rpc_calls == [], "an empty grounding must not call the rewrite RPC at all"


async def test_rewrite_never_touches_another_users_mentions():
    """THE Major. A organized the same Reel and got p1,p2,p3. B's run yields only p1 —
    A's set must be byte-identical afterwards and B's stale p9 must be pruned."""
    client = _Client({"places": [_canonical_place("p1")]})
    _seed_mentions(client, user_id="uA", cache_id="c1", place_ids=["p1", "p2", "p3"])
    _seed_mentions(client, user_id="uB", cache_id="c1", place_ids=["p1", "p9"])

    terminal, count = await _ground_and_persist(
        _ctx(client, ground=_grounds_everything), {"id": "rB"}, "c1", [_place()]
    )

    assert (terminal, count) == ("organized", 1)
    assert _mention_place_ids(client, "uA", "c1") == {"p1", "p2", "p3"}
    assert _mention_place_ids(client, "uB", "c1") == {"p1"}


async def test_crash_mid_persist_leaves_old_mentions_intact():
    """The rewrite is the LAST write, so a crash inside the persist loop changes nothing.

    Ordering, not luck: `_persist_place` runs for every grounded place before the single
    RPC call. Move that call above the loop and this goes red.
    """
    client = _FailingInsertClient(
        {"places": [_canonical_place("p1")]}, fail_table="places", after=0,
    )
    _seed_mentions(client, user_id="uB", cache_id="c1", place_ids=["p1", "p2"])

    with pytest.raises(RuntimeError):
        await _ground_and_persist(
            _ctx(client, ground=_grounds_everything), {"id": "rB"}, "c1",
            [_place(), _place("Shibuya Crossing")],      # the 2nd needs an insert, which fails
        )

    assert _mention_place_ids(client, "uB", "c1") == {"p1", "p2"}, "the RPC must never have run"


async def test_authorize_place_ids_rejects_another_users_mention():
    """The trust boundary is now the owner column, not the shared cache row.

    B saved and organized the same Reel, which is all the pre-fix check required. The mention
    belongs to A, so B must not be able to build a trip from it.
    """
    client = _Client({
        "reel_place_mentions": [{
            "user_id": "uA", "place_id": "p1", "reel_cache_id": "c1",
            "evidence_quote": "proof", "source_url": None, "confidence": 0.9,
            "verification_version": LOCATION_VERIFICATION_VERSION,
        }],
        "saved_reels": [{
            "id": "rB", "user_id": "uB", "reel_cache_id": "c1",
            "analysis_status": "organized",
        }],
        "places": [_canonical_place("p1")],
    })

    with pytest.raises(PermissionError):
        await authorize_place_ids(client, "uB", ["p1"])


async def test_authorize_place_ids_accepts_the_owners_own_mention():
    """The negative above must not pass because authorize rejects everything."""
    client = _Client({
        "reel_place_mentions": [{
            "user_id": "uB", "place_id": "p1", "reel_cache_id": "c1",
            "evidence_quote": "proof", "source_url": None, "confidence": 0.9,
            "verification_version": LOCATION_VERIFICATION_VERSION,
        }],
        "saved_reels": [{
            "id": "rB", "user_id": "uB", "reel_cache_id": "c1",
            "analysis_status": "organized",
        }],
        "places": [_canonical_place("p1")],
    })

    assert [row["id"] for row in await authorize_place_ids(client, "uB", ["p1"])] == ["p1"]


async def test_two_entries_resolving_to_the_same_place_id_do_not_fail_the_rpc():
    """A Reel can name one venue twice; `_persist_place` then returns the SAME canonical id
    for both (the extractor does not dedupe — genagents/place_extractor.py).

    Against a real database, a single INSERT ... ON CONFLICT DO UPDATE touching that row twice
    is rejected outright and every organize of that Reel breaks; the RPC's `distinct on
    (place_id)` is what prevents it. The fake cannot reproduce that rejection, so THIS test
    proves only that the payload is passed through undeduped and the surviving set is one row.
    The constraint behaviour is pinned in pgTAP.
    """
    client = _Client({"places": [_canonical_place("p1", name="Ichiran")]})

    terminal, count = await _ground_and_persist(
        _ctx(client, ground=_grounds_everything), {"id": "rB"}, "c1",
        [_place("Ichiran"), _place("Ichiran")],
    )

    assert (terminal, count) == ("organized", 2), "the grounding count is unchanged by dedupe"
    assert _mention_place_ids(client, "uB", "c1") == {"p1"}
    payload = next(params for name, params in client.rpc_calls
                   if name == "replace_reel_place_mentions")["p_mentions"]
    assert [mention["place_id"] for mention in payload] == ["p1", "p1"], (
        "duplicates stay in the payload on purpose — the RPC's DISTINCT ON is the only dedupe"
    )

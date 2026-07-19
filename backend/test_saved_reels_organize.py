from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json

import pytest

from api.schemas import GenerateTripRequest, OrganizeJobStatus, OrganizeSavedReelsRequest
from api.streaming import DONE, format_sse, stream_organize_events, stream_organize_status
from models.place import PlaceResult
from organizer import (
    ActiveOrganizeConflict,
    _ground_place,
    _persist_place,
    authorize_place_ids,
    create_organize_job,
    get_organize_status,
    recover_organize_jobs,
    run_organize_job,
)
from usage import refund_organize_item_analysis, reserve_organize_item_analysis


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, name, db):
        self.name, self.db = name, db
        self.op = None
        self.filters = {}
        self.gt_filters = {}
        self.lt_filters = {}
        self.in_filters = {}
        self.single = False

    def select(self, *_args): self.op = "select"; return self
    def insert(self, row): self.op = ("insert", row); return self
    def update(self, row): self.op = ("update", row); return self
    def delete(self): self.op = "delete"; return self
    def eq(self, key, value): self.filters[key] = value; return self
    def gt(self, key, value): self.gt_filters[key] = value; return self
    def lt(self, key, value): self.lt_filters[key] = value; return self
    def in_(self, key, values): self.in_filters[key] = set(values); return self
    def order(self, *_args, **_kwargs): return self
    def maybe_single(self): self.single = True; return self

    def _matches(self, row):
        return all(row.get(k) == v for k, v in self.filters.items()) and all(
            row.get(k) in values for k, values in self.in_filters.items()
        ) and all(row.get(k, 0) > v for k, v in self.gt_filters.items()) and all(
            row.get(k) < v for k, v in self.lt_filters.items()
        )

    async def execute(self):
        rows = self.db.setdefault(self.name, [])
        if isinstance(self.op, tuple) and self.op[0] == "insert":
            row = {"id": f"{self.name}-{len(rows) + 1}", **self.op[1]}
            rows.append(row)
            return _Result([row])
        if isinstance(self.op, tuple) and self.op[0] == "update":
            matched = [row for row in rows if self._matches(row)]
            for row in matched:
                row.update(self.op[1])
            return _Result(matched)
        if self.op == "delete":
            matched = [row for row in rows if self._matches(row)]
            self.db[self.name] = [row for row in rows if row not in matched]
            if self.name == "organize_jobs":
                job_ids = {row["id"] for row in matched}
                for child_table in ("organize_job_items", "organize_events"):
                    self.db[child_table] = [
                        row for row in self.db.get(child_table, [])
                        if row.get("job_id") not in job_ids
                    ]
            return _Result(matched)
        matched = [row for row in rows if self._matches(row)]
        return _Result(matched[0] if self.single and matched else (None if self.single else matched))


class _Client:
    def __init__(self, db=None):
        self.db = db or {}
        self.rpc_calls = []

    def table(self, name): return _Table(name, self.db)
    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        if name == "create_saved_reels_organize_job":
            return _CreateOrganizeJobRpc(self, params)
        return _Rpc(self, name)


class _Rpc:
    def __init__(self, client, name): self.client, self.name = client, name
    async def execute(self): return _Result(self.client.db.get(f"rpc:{self.name}"))


class _CreateOrganizeJobRpc:
    def __init__(self, client, params): self.client, self.params = client, params

    async def execute(self):
        from postgrest.exceptions import APIError

        user_id = self.params["p_user_id"]
        ids = self.params["p_saved_reel_ids"]
        key = self.params["p_idempotency_key"]
        active = next((row for row in self.client.db.get("organize_jobs", [])
                       if row.get("user_id") == user_id
                       and row.get("idempotency_key") == key
                       and row.get("status") in {"initializing", "pending", "processing"}), None)
        if active:
            return _Result(active["id"])
        saved = [row for row in self.client.db.get("saved_reels", [])
                 if row.get("user_id") == user_id and row.get("id") in ids]
        if len(saved) != len(ids):
            raise APIError({"code": "P0001", "message": "Saved Reel not found", "details": None, "hint": None})
        active_item = next((item for item in self.client.db.get("organize_job_items", [])
                            if item.get("saved_reel_id") in ids
                            and any(job.get("id") == item.get("job_id")
                                    and job.get("user_id") == user_id
                                    and job.get("status") in {"initializing", "pending", "processing"}
                                    for job in self.client.db.get("organize_jobs", []))), None)
        if active_item:
            raise APIError({
                "code": "P0001",
                "message": "Saved Reel is already being organized",
                "details": None,
                "hint": None,
            })
        job = {
            "id": f"organize_jobs-{len(self.client.db.get('organize_jobs', [])) + 1}",
            "user_id": user_id,
            "idempotency_key": key,
            "request_json": {"saved_reel_ids": ids},
            "status": "pending",
            "status_message": "Queued",
            "total_count": len(ids),
            "processed_count": 0,
            "organized_count": 0,
            "location_not_found_count": 0,
            "failed_count": 0,
        }
        self.client.db.setdefault("organize_jobs", []).append(job)
        items = self.client.db.setdefault("organize_job_items", [])
        for row in saved:
            items.append({
                "id": f"organize_job_items-{len(items) + 1}",
                "user_id": user_id,
                "job_id": job["id"],
                "saved_reel_id": row["id"],
                "status": "queued",
                "place_count": 0,
                "analysis_charge_state": "not_charged",
            })
        self.client.db.setdefault("organize_events", []).append({
            "id": "organize_events-1",
            "user_id": user_id,
            "job_id": job["id"],
            "sequence": 1,
            "event_type": "stage",
            "message": "Queued",
            "payload": {},
        })
        return _Result(job["id"])


def _place(name="Tokyo Tower"):
    return PlaceResult(
        name=name, category="attraction", lat=35.6, lng=139.7,
        confidence=0.9, evidence_quote="Tokyo Tower", source_url="https://source.test/a",
        country_code="JP", country_name="Japan",
    )


def test_place_only_generate_request_is_valid_and_empty_request_is_rejected():
    request = GenerateTripRequest(
        place_ids=["place-1"], start_date="2026-08-01", end_date="2026-08-02"
    )
    assert request.reel_urls == []
    with pytest.raises(ValueError):
        GenerateTripRequest(start_date="2026-08-01", end_date="2026-08-02")


def test_organize_request_is_bounded():
    assert OrganizeSavedReelsRequest(saved_reel_ids=["a"]).saved_reel_ids == ["a"]
    with pytest.raises(ValueError):
        OrganizeSavedReelsRequest(saved_reel_ids=[])
    with pytest.raises(ValueError):
        OrganizeSavedReelsRequest(saved_reel_ids=[str(i) for i in range(6)])


def test_organize_job_status_accepts_initializing():
    status = OrganizeJobStatus(
        job_id="job-1",
        status="initializing",
        status_message="Preparing",
        total_items=2,
    )

    assert status.status == "initializing"


@pytest.mark.asyncio
async def test_get_organize_status_does_not_invent_country_summaries():
    client = _Client({
        "organize_jobs": [{
            "id": "job-1",
            "user_id": "user-a",
            "status": "succeeded",
            "status_message": "Ready",
            "total_count": 1,
            "countries_found": ["Japan"],
        }],
        "organize_job_items": [{
            "id": "item-1",
            "job_id": "job-1",
            "user_id": "user-a",
            "saved_reel_id": "r1",
            "status": "organized",
        }],
    })

    status = await get_organize_status(client, "job-1", "user-a")

    assert "countries_found" not in status


@pytest.mark.asyncio
async def test_create_organize_job_enforces_owner_and_is_idempotent():
    client = _Client({"saved_reels": [{"id": "r1", "user_id": "user-a", "normalized_url": "u"}]})
    job_id = await create_organize_job(client, "user-a", ["r1"])
    assert job_id == "organize_jobs-1"
    assert client.db["organize_jobs"][0]["request_json"] == {"saved_reel_ids": ["r1"]}
    assert client.db["organize_job_items"][0]["analysis_charge_state"] == "not_charged"
    assert await create_organize_job(client, "user-a", ["r1"]) == job_id
    with pytest.raises(PermissionError):
        await create_organize_job(client, "user-b", ["r1"])


@pytest.mark.asyncio
async def test_create_organize_job_uses_atomic_rpc_and_maps_active_conflict():
    calls = []

    class _RpcClient:
        def rpc(self, name, params):
            calls.append((name, params))
            return _RpcResult("job-1")

    class _RpcResult:
        def __init__(self, value): self.value = value
        async def execute(self): return _Result(self.value)

    client = _RpcClient()
    assert await create_organize_job(client, "user-a", ["r1", "r2"]) == "job-1"
    assert calls == [(
        "create_saved_reels_organize_job",
        {
            "p_user_id": "user-a",
            "p_saved_reel_ids": ["r1", "r2"],
            "p_idempotency_key": calls[0][1]["p_idempotency_key"],
        },
    )]

    from postgrest.exceptions import APIError

    class _ConflictRpcClient:
        def rpc(self, _name, _params):
            class _ConflictResult:
                async def execute(self):
                    raise APIError({
                        "code": "P0001",
                        "message": "Saved Reel is already being organized",
                        "details": None,
                        "hint": None,
                    })
            return _ConflictResult()

    with pytest.raises(ActiveOrganizeConflict):
        await create_organize_job(_ConflictRpcClient(), "user-a", ["r1"])


@pytest.mark.asyncio
async def test_create_organize_job_is_initialized_atomically():
    client = _Client({
        "saved_reels": [
            {"id": "r1", "user_id": "user-a", "normalized_url": "u1"},
            {"id": "r2", "user_id": "user-a", "normalized_url": "u2"},
        ],
    })

    job_id = await create_organize_job(client, "user-a", ["r1", "r2"])

    assert client.db["organize_jobs"][0]["id"] == job_id
    assert client.db["organize_jobs"][0]["status"] == "pending"
    assert client.db["organize_jobs"][0]["status_message"] == "Queued"
    assert len(client.db["organize_job_items"]) == 2
    assert {row["saved_reel_id"] for row in client.db["organize_job_items"]} == {"r1", "r2"}
    assert client.db["organize_events"][0]["sequence"] == 1
    assert client.db["organize_events"][0]["message"] == "Queued"


@pytest.mark.asyncio
async def test_create_organize_job_rejects_active_overlap_without_partial_rows():
    client = _Client({
        "saved_reels": [
            {"id": "r1", "user_id": "user-a", "normalized_url": "u1"},
            {"id": "r2", "user_id": "user-a", "normalized_url": "u2"},
        ],
    })
    first = await create_organize_job(client, "user-a", ["r1"])

    with pytest.raises(ActiveOrganizeConflict):
        await create_organize_job(client, "user-a", ["r1", "r2"])

    assert len(client.db["organize_jobs"]) == 1
    assert client.db["organize_jobs"][0]["id"] == first
    assert len(client.db["organize_job_items"]) == 1
    assert len(client.db["organize_events"]) == 1


@pytest.mark.asyncio
async def test_create_organize_job_allows_terminal_overlap_and_disjoint_sets():
    client = _Client({
        "saved_reels": [
            {"id": "r1", "user_id": "user-a", "normalized_url": "u1"},
            {"id": "r2", "user_id": "user-a", "normalized_url": "u2"},
        ],
    })
    first = await create_organize_job(client, "user-a", ["r1"])
    client.db["organize_jobs"][0]["status"] = "succeeded"

    retry = await create_organize_job(client, "user-a", ["r1", "r2"])

    assert retry != first
    assert len(client.db["organize_jobs"]) == 2

    disjoint = _Client({
        "saved_reels": [
            {"id": "r1", "user_id": "user-a", "normalized_url": "u1"},
            {"id": "r2", "user_id": "user-a", "normalized_url": "u2"},
        ],
    })
    await create_organize_job(disjoint, "user-a", ["r1"])
    second = await create_organize_job(disjoint, "user-a", ["r2"])
    assert second == "organize_jobs-2"


@pytest.mark.asyncio
async def test_recover_organize_jobs_deletes_stale_initializing_job_and_children():
    stale_created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=121)
    ).isoformat()
    current_created_at = datetime.now(timezone.utc).isoformat()
    client = _Client({
        "organize_jobs": [
            {
                "id": "stale-job",
                "user_id": "user-a",
                "status": "initializing",
                "created_at": stale_created_at,
            },
            {
                "id": "current-job",
                "user_id": "user-a",
                "status": "initializing",
                "created_at": current_created_at,
            },
            {
                "id": "pending-job",
                "user_id": "user-b",
                "status": "pending",
                "created_at": current_created_at,
            },
        ],
        "organize_job_items": [
            {"id": "stale-item", "job_id": "stale-job"},
            {"id": "current-item", "job_id": "current-job"},
        ],
        "organize_events": [
            {"id": "stale-event", "job_id": "stale-job"},
            {"id": "current-event", "job_id": "current-job"},
        ],
    })

    pending = await recover_organize_jobs(client)

    assert {row["id"] for row in client.db["organize_jobs"]} == {
        "current-job", "pending-job",
    }
    assert [row["id"] for row in client.db["organize_job_items"]] == ["current-item"]
    assert [row["id"] for row in client.db["organize_events"]] == ["current-event"]
    assert [(row["id"], row["user_id"]) for row in pending] == [
        ("pending-job", "user-b"),
    ]


@pytest.mark.asyncio
async def test_recover_organize_jobs_immediately_requeues_prior_process_work():
    future_lock = (datetime.now(timezone.utc) + timedelta(minutes=14)).isoformat()
    client = _Client({
        "organize_jobs": [{
            "id": "interrupted-job",
            "user_id": "user-a",
            "status": "processing",
            "status_message": "Finding places",
            "locked_at": datetime.now(timezone.utc).isoformat(),
            "lock_expires_at": future_lock,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }],
    })

    pending = await recover_organize_jobs(client)

    job = client.db["organize_jobs"][0]
    assert job["status"] == "pending"
    assert job["status_message"] == "Requeued after restart"
    assert job["locked_at"] is None
    assert job["lock_expires_at"] is None
    assert [(row["id"], row["user_id"]) for row in pending] == [
        ("interrupted-job", "user-a"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["initial_event", "items_load", "counts", "finalization"])
async def test_unexpected_organizer_failure_marks_job_failed_and_emits_result(
    monkeypatch, failure
):
    class _FaultTable(_Table):
        async def execute(self):
            if failure == "initial_event" and self.name == "organize_events":
                if (
                    isinstance(self.op, tuple)
                    and self.op[0] == "insert"
                    and self.op[1].get("message") == "Finding places"
                ):
                    raise RuntimeError("initial event write failed")
            if failure == "items_load" and self.name == "organize_job_items":
                if self.op == "select" and self.filters.get("job_id") == "job-1":
                    raise RuntimeError("item load failed")
            if failure == "finalization" and self.name == "organize_jobs":
                if (
                    isinstance(self.op, tuple)
                    and self.op[0] == "update"
                    and "completed_at" in self.op[1]
                    and not self.db.get("finalization_failed")
                ):
                    self.db["finalization_failed"] = True
                    raise RuntimeError("finalization failed")
            return await super().execute()

    class _FaultClient(_Client):
        def table(self, name):
            return _FaultTable(name, self.db)

    client = _FaultClient({
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
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    if failure == "counts":
        async def fail_counts(*_args, **_kwargs):
            raise RuntimeError("count update failed")

        monkeypatch.setattr("organizer._update_job_counts", fail_counts)

    await run_organize_job(
        "job-1", "user-a", client=client,
        ground=lambda place: {"place": place, "country_code": "JP", "country_name": "Japan"},
    )

    job = client.db["organize_jobs"][0]
    assert job["status"] == "failed"
    assert job["status_message"] == "Organization failed"
    assert job["completed_at"]
    assert job["locked_at"] is None
    assert job["lock_expires_at"] is None
    result_events = [event for event in client.db.get("organize_events", []) if event["event_type"] == "result"]
    assert len(result_events) == 1
    assert result_events[0]["payload"] == {"status": "failed"}
    stream = [event async for event in stream_organize_events(client, "job-1", "user-a", poll_s=0)]
    streamed_result = json.loads(stream[-2].split("data: ", 1)[1])
    assert json.loads(streamed_result["content"]) == {"status": "failed"}
    assert stream[-1] == DONE


@pytest.mark.asyncio
async def test_uncached_source_failure_refunds_reserved_analysis(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{"id": "item-1", "job_id": "job-1", "user_id": "user-a", "saved_reel_id": "r1", "status": "queued"}],
        "saved_reels": [{"id": "r1", "user_id": "user-a", "normalized_url": "https://www.instagram.com/reel/A", "reel_cache_id": "cache-1", "analysis_status": "queued"}],
    })
    calls = []
    async def reserve(*_args, **_kwargs): calls.append("reserve"); return True
    async def refund(*_args, **_kwargs): calls.append("refund")
    async def scrape(*_args, **_kwargs): calls.append("scrape"); raise RuntimeError("source down")
    async def extract(*_args, **_kwargs): calls.append("extract")
    monkeypatch.setattr("organizer.reserve_organize_item_analysis", reserve)
    monkeypatch.setattr("organizer.refund_organize_item_analysis", refund)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: None)
    await run_organize_job("job-1", "user-a", client=client, scrape=scrape, extract=extract)
    assert calls == ["reserve", "scrape", "refund"]
    assert client.db["organize_job_items"][0]["status"] == "failed"


@pytest.mark.asyncio
async def test_cached_reel_skips_paid_calls_and_writes_terminal_state(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{"id": "item-1", "job_id": "job-1", "user_id": "user-a", "saved_reel_id": "r1", "status": "queued"}],
        "saved_reels": [{"id": "r1", "user_id": "user-a", "normalized_url": "https://www.instagram.com/reel/A", "reel_cache_id": "cache-1", "analysis_status": "queued"}],
        "reel_cache": [{"id": "cache-1", "normalized_url": "https://www.instagram.com/reel/A"}],
    })
    calls = []
    async def unexpected(*_args, **_kwargs): calls.append("paid"); raise AssertionError("paid call")
    def ground(place):
        return {"place": place, "country_code": "JP", "country_name": "Japan"}
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    await run_organize_job("job-1", "user-a", client=client, scrape=unexpected, extract=unexpected, ground=ground)
    assert calls == []
    assert client.db["organize_job_items"][0]["status"] == "organized"
    assert client.db["saved_reels"][0]["analysis_status"] == "organized"


@pytest.mark.asyncio
async def test_cached_retry_does_not_require_apify_token(monkeypatch):
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
        "reel_cache": [{"id": "cache-1", "normalized_url": "https://www.instagram.com/reel/A"}],
    })

    async def unexpected_scrape(*_args, **_kwargs):
        raise AssertionError("cache-backed retry must not call Apify")

    def ground(place):
        return {"place": place, "country_code": "JP", "country_name": "Japan"}

    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    monkeypatch.setattr("organizer.scrape_reel", unexpected_scrape)

    await run_organize_job("job-1", "user-a", client=client, ground=ground)

    assert client.db["organize_job_items"][0]["status"] == "organized"
    assert client.db["saved_reels"][0]["analysis_status"] == "organized"


@pytest.mark.asyncio
async def test_organize_stream_is_result_json_then_done():
    states = iter([
        {"job_id": "job-1", "status": "processing", "status_message": "Finding places"},
        {"job_id": "job-1", "status": "succeeded", "status_message": "Organized"},
    ])
    async def load(_client, _job_id, _user_id): return next(states)
    events = [event async for event in stream_organize_status(object(), "job-1", "user-a", poll_s=0, status_loader=load)]
    assert events[-1] == DONE
    result = json.loads(events[-2][len("data: "):])
    assert result["type"] == "result"
    assert isinstance(result["content"], str)
    assert events[-1] == "data: [DONE]\n\n"


@pytest.mark.asyncio
async def test_organize_event_stream_replays_integer_cursor_and_json_result():
    client = _Client({"organize_events": [
        {"sequence": 1, "job_id": "job-1", "user_id": "user-a", "event_type": "stage", "message": "Queued", "payload": {}},
        {"sequence": 2, "job_id": "job-1", "user_id": "user-a", "event_type": "result", "message": "Organized", "payload": {"status": "succeeded"}},
    ]})
    events = [event async for event in stream_organize_events(client, "job-1", "user-a", poll_s=0)]
    assert events[0].startswith("id: 1\ndata: ")
    assert "\"content\": \"{\\\"status\\\": \\\"succeeded\\\"}\"" in events[1]
    assert events[-1] == DONE


@pytest.mark.asyncio
async def test_place_ids_are_owner_scoped_through_organized_reel_proof():
    client = _Client({
        "reel_place_mentions": [{"place_id": "p1", "reel_cache_id": "cache-a", "evidence_quote": "proof", "source_url": None, "confidence": 0.9, "verification_version": "mapbox-country-v1"}],
        "saved_reels": [{"id": "r1", "user_id": "user-a", "reel_cache_id": "cache-a", "analysis_status": "organized"}],
        "places": [{"id": "p1", "name": "Canonical A", "place_type": "attraction", "lat": 1.0, "lng": 2.0, "city": "City"}],
    })
    assert (await authorize_place_ids(client, "user-a", ["p1"]))[0]["name"] == "Canonical A"
    with pytest.raises(PermissionError):
        await authorize_place_ids(client, "user-b", ["p1"])


@pytest.mark.asyncio
async def test_analysis_rpc_helpers_use_item_contract_without_python_dates():
    client = _Client({
        "rpc:reserve_organize_item_analysis": "2026-07-19",
        "rpc:refund_organize_item_analysis": True,
    })
    assert await reserve_organize_item_analysis(client, "item-a", "user-a") == "2026-07-19"
    assert await refund_organize_item_analysis(client, "item-a", "user-a") is True
    assert client.rpc_calls == [
        (
            "reserve_organize_item_analysis",
            {"p_item_id": "item-a", "p_user_id": "user-a"},
        ),
        (
            "refund_organize_item_analysis",
            {"p_item_id": "item-a", "p_user_id": "user-a"},
        ),
    ]


@pytest.mark.asyncio
async def test_refunded_item_gets_fresh_reservation_before_uncached_analysis(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued", "analysis_charge_state": "refunded",
            "analysis_usage_date": "2026-07-18",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "analysis_status": "queued",
        }],
    })
    calls = []

    async def reserve(_client, item_id, user_id):
        calls.append(("reserve", item_id, user_id))
        client.db["organize_job_items"][0].update({
            "analysis_charge_state": "reserved",
            "analysis_usage_date": "2026-07-19",
        })
        return "2026-07-19"

    async def scrape(url):
        calls.append(("scrape", url))
        return object()

    async def extract(_scraped):
        calls.append(("extract",))
        return [_place()]

    async def cache(_client, url, _scraped, _places, _version):
        calls.append(("cache", url))
        client.db.setdefault("reel_cache", []).append({
            "id": "cache-1", "normalized_url": url,
        })

    monkeypatch.setattr("organizer.reserve_organize_item_analysis", reserve)
    monkeypatch.setattr("organizer.cache_places", cache)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: None)

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=scrape, extract=extract,
        ground=lambda place: {"place": place, "country_code": "JP", "country_name": "Japan"},
    )

    assert calls[:3] == [("reserve", "item-1", "user-a"), ("scrape", "https://www.instagram.com/reel/A"), ("extract",)]
    assert client.db["organize_job_items"][0]["analysis_charge_state"] == "consumed"


@pytest.mark.asyncio
async def test_cache_retry_consumes_existing_reservation_without_apify(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued", "analysis_charge_state": "reserved",
            "analysis_usage_date": "2026-07-19",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "reel_cache_id": "cache-1", "analysis_status": "queued",
        }],
    })

    async def unexpected_reserve(*_args, **_kwargs):
        raise AssertionError("a reserved item must not reserve again")

    async def unexpected_scrape(*_args, **_kwargs):
        raise AssertionError("cache retry must not call Apify")

    monkeypatch.setattr("organizer.reserve_organize_item_analysis", unexpected_reserve)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=unexpected_scrape,
        ground=lambda place: {"place": place, "country_code": "JP", "country_name": "Japan"},
    )

    assert client.db["organize_job_items"][0]["analysis_charge_state"] == "consumed"
    assert client.db["organize_job_items"][0]["analysis_consumed_at"]


@pytest.mark.asyncio
async def test_terminal_items_are_not_replayed_after_requeue(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "organized", "analysis_charge_state": "consumed",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "reel_cache_id": "cache-1", "analysis_status": "organized",
        }],
    })

    async def unexpected_ground(*_args, **_kwargs):
        raise AssertionError("terminal items must not be replayed")

    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])

    await run_organize_job("job-1", "user-a", client=client, ground=unexpected_ground)

    assert client.db["organize_job_items"][0]["status"] == "organized"


@pytest.mark.asyncio
@pytest.mark.parametrize("code,name,lat,lng", [
    ("JP", "Japan", 35.67311, 139.73625),
    ("CN", "China", 31.2304, 121.4737),
    ("KR", "South Korea", 37.5665, 126.9780),
])
async def test_ground_place_accepts_matching_research_and_reverse_country(
    monkeypatch, code, name, lat, lng
):
    from models.geocode import CountryResult

    calls = []

    async def verify(got_lat, got_lng, **kwargs):
        calls.append((got_lat, got_lng, kwargs))
        return CountryResult(country_code=code, country_name=name)

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    place = PlaceResult(
        name="Verified place",
        category="attraction",
        lat=lat,
        lng=lng,
        confidence=0.8,
        evidence_quote="Verified place",
        source_url="https://www.gotokyo.org/en/spot/1749/index.html",
        country_code=code,
        country_name=name,
    )

    result = await _ground_place(place, verify_country=verify)

    assert result == {
        "place": place,
        "country_code": code,
        "country_name": name,
    }
    assert calls == [(lat, lng, {"token": "test-token"})]


@pytest.mark.asyncio
async def test_ground_place_uses_mapbox_name_after_country_code_agrees(monkeypatch):
    from models.geocode import CountryResult

    async def verify(*_args, **_kwargs):
        return CountryResult(country_code="JP", country_name="Japan")

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    poisoned = _place().model_copy(update={"country_name": "United States"})

    result = await _ground_place(poisoned, verify_country=verify)

    assert result["country_code"] == "JP"
    assert result["country_name"] == "Japan"
    assert result["place"].country_name == "Japan"


@pytest.mark.asyncio
async def test_ground_place_rejects_country_mismatch(monkeypatch):
    from models.geocode import CountryResult

    async def verify(*_args, **_kwargs):
        return CountryResult(country_code="MX", country_name="Mexico")

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    place = PlaceResult(
        name="Harry Potter Cafe",
        category="restaurant",
        lat=35.67311,
        lng=139.73625,
        confidence=0.8,
        evidence_quote="Harry Potter Cafe",
        source_url="https://hpcafe.jp/",
        country_code="JP",
        country_name="Japan",
    )

    assert await _ground_place(place, verify_country=verify) is None


@pytest.mark.asyncio
async def test_ground_place_rejects_valid_empty_country_result(monkeypatch):
    async def verify(*_args, **_kwargs):
        return None

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    place = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67311, lng=139.73625,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )

    assert await _ground_place(place, verify_country=verify) is None


@pytest.mark.asyncio
async def test_ground_place_fails_when_mapbox_verification_is_unavailable(monkeypatch):
    called = False

    async def verify(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("verifier must not run without a token")

    monkeypatch.delenv("MAPBOX_SECRET_TOKEN", raising=False)
    place = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67311, lng=139.73625,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )

    with pytest.raises(RuntimeError, match="verification is unavailable"):
        await _ground_place(place, verify_country=verify)
    assert called is False


@pytest.mark.asyncio
@pytest.mark.parametrize("updates", [
    {"country_code": None, "country_name": None},
    {"lat": None},
    {"lng": None},
    {"source_url": None},
    {"source_url": "https://example.com/place"},
])
async def test_ground_place_rejects_incomplete_research_without_mapbox_call(monkeypatch, updates):
    called = False

    async def verify(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("verification must not run")

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    place = PlaceResult(
        name="Harry Potter Cafe",
        category="restaurant",
        lat=35.67311,
        lng=139.73625,
        confidence=0.8,
        evidence_quote="Harry Potter Cafe",
        source_url="https://hpcafe.jp/",
        country_code="JP",
        country_name="Japan",
    ).model_copy(update=updates)

    assert await _ground_place(place, verify_country=verify) is None
    assert called is False


@pytest.mark.asyncio
async def test_ground_place_propagates_provider_outage_after_adapter_retry(monkeypatch):
    async def verify(*_args, **_kwargs):
        raise RuntimeError("Mapbox reverse-country failed: status 503")

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    place = PlaceResult(
        name="Harry Potter Cafe",
        category="restaurant",
        lat=35.67311,
        lng=139.73625,
        confidence=0.8,
        evidence_quote="Harry Potter Cafe",
        source_url="https://hpcafe.jp/",
        country_code="JP",
        country_name="Japan",
    )

    with pytest.raises(RuntimeError, match="reverse-country"):
        await _ground_place(place, verify_country=verify)


@pytest.mark.asyncio
async def test_persist_place_does_not_reuse_same_name_from_another_country():
    client = _Client({
        "places": [{
            "id": "place-mx",
            "name": "Harry Potter Cafe",
            "country_code": "MX",
        }],
    })
    place = PlaceResult(
        name="Harry Potter Cafe",
        category="restaurant",
        confidence=0.7,
        evidence_quote="Harry Potter Cafe",
        city_or_region_guess="Tokyo, Japan",
        lat=35.6764,
        lng=139.65,
    )

    place_id = await _persist_place(client, {
        "place": place,
        "country_code": "JP",
        "country_name": "Japan",
    })

    assert place_id != "place-mx"
    assert client.db["places"][-1]["country_code"] == "JP"


@pytest.mark.asyncio
async def test_create_organize_job_reuses_active_but_reprocesses_terminal_job():
    client = _Client({
        "saved_reels": [{"id": "r1", "user_id": "user-a", "normalized_url": "u"}],
    })

    first = await create_organize_job(client, "user-a", ["r1"])
    assert await create_organize_job(client, "user-a", ["r1"]) == first

    client.db["organize_jobs"][0]["status"] = "succeeded"
    retried = await create_organize_job(client, "user-a", ["r1"])

    assert retried != first
    assert len(client.db["organize_jobs"]) == 2


@pytest.mark.asyncio
async def test_create_organize_job_returns_active_winner_after_unique_race():
    client = _Client({
        "saved_reels": [{"id": "r1", "user_id": "user-a", "normalized_url": "u"}],
    })

    assert await create_organize_job(client, "user-a", ["r1"]) == "organize_jobs-1"
    assert client.rpc_calls[0][0] == "create_saved_reels_organize_job"


@pytest.mark.asyncio
async def test_persist_place_reuses_near_match_but_preserves_distant_same_name_branch():
    client = _Client({
        "places": [{
            "id": "place-tokyo",
            "name": "Harry Potter Cafe",
            "country_code": "JP",
            "lat": 35.67311,
            "lng": 139.73625,
        }],
    })
    near = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67320, lng=139.73630,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )
    far = near.model_copy(update={"lat": 34.6937, "lng": 135.5023})

    near_id = await _persist_place(client, {
        "place": near, "country_code": "JP", "country_name": "Japan",
    })
    far_id = await _persist_place(client, {
        "place": far, "country_code": "JP", "country_name": "Japan",
    })

    assert near_id == "place-tokyo"
    assert far_id != "place-tokyo"
    assert client.db["places"][-1]["lat"] == 34.6937
    assert client.db["places"][-1]["lng"] == 135.5023


@pytest.mark.asyncio
async def test_persist_place_repairs_poisoned_country_label_on_near_match():
    client = _Client({
        "places": [{
            "id": "place-tokyo",
            "name": "Harry Potter Cafe",
            "country": "United States",
            "country_code": "JP",
            "country_name": "United States",
            "lat": 35.67311,
            "lng": 139.73625,
        }],
    })
    place = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67320, lng=139.73630,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )

    place_id = await _persist_place(client, {
        "place": place, "country_code": "JP", "country_name": "Japan",
    })

    assert place_id == "place-tokyo"
    assert client.db["places"][0]["country_code"] == "JP"
    assert client.db["places"][0]["country"] == "Japan"
    assert client.db["places"][0]["country_name"] == "Japan"


@pytest.mark.asyncio
async def test_authorize_place_ids_rejects_unstamped_mention():
    client = _Client({
        "reel_place_mentions": [{
            "place_id": "p1", "reel_cache_id": "cache-a", "evidence_quote": "proof",
            "source_url": "https://source.test/a", "confidence": 0.9,
            "verification_version": None,
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a", "reel_cache_id": "cache-a",
            "analysis_status": "organized",
        }],
        "places": [{"id": "p1", "name": "Legacy wrong place"}],
    })

    with pytest.raises(PermissionError):
        await authorize_place_ids(client, "user-a", ["p1"])


@pytest.mark.asyncio
async def test_poisoned_legacy_mention_is_replaced_by_verified_japan_link(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "reel_cache_id": "cache-1", "analysis_status": "organized",
        }],
        "reel_cache": [{"id": "cache-1", "normalized_url": "https://www.instagram.com/reel/A"}],
        "places": [
            {
                "id": "place-mx", "name": "Harry Potter Cafe", "country_code": "MX",
                "country_name": "Mexico", "lat": 19.4326, "lng": -99.1332,
            },
            {
                "id": "place-us", "name": "Harry Potter Cafe", "country_code": "US",
                "country_name": "United States", "lat": 40.7128, "lng": -74.0060,
            },
        ],
        "reel_place_mentions": [
            {
                "id": "legacy-mx", "reel_cache_id": "cache-1", "place_id": "place-mx",
                "evidence_quote": "Harry Potter Cafe", "source_url": None, "confidence": 0.6,
                "verification_version": None,
            },
            {
                "id": "legacy-us", "reel_cache_id": "cache-1", "place_id": "place-us",
                "evidence_quote": "Harry Potter Cafe", "source_url": None, "confidence": 0.6,
                "verification_version": None,
            },
        ],
    })
    research = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67311, lng=139.73625,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )

    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [research])

    async def ground(place):
        return {"place": place, "country_code": "JP", "country_name": "Japan"}

    async def unexpected_scrape(*_args, **_kwargs):
        raise AssertionError("cached reel must not scrape")

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=unexpected_scrape, ground=ground
    )

    assert len(client.db["reel_place_mentions"]) == 1
    link = client.db["reel_place_mentions"][0]
    assert link["place_id"] != "place-mx"
    assert link["verification_version"] == "mapbox-country-v1"
    assert client.db["places"][-1]["country_code"] == "JP"


@pytest.mark.asyncio
async def test_country_mismatch_removes_all_poisoned_links_and_fails_closed(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "reel_cache_id": "cache-1", "analysis_status": "organized",
        }],
        "reel_cache": [{"id": "cache-1", "normalized_url": "https://www.instagram.com/reel/A"}],
        "reel_place_mentions": [
            {"id": "legacy-mx", "reel_cache_id": "cache-1", "place_id": "place-mx"},
            {"id": "legacy-us", "reel_cache_id": "cache-1", "place_id": "place-us"},
        ],
    })
    research = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67311, lng=139.73625,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [research])

    async def mismatch(_place):
        return None

    async def unexpected_scrape(*_args, **_kwargs):
        raise AssertionError("cached reel must not scrape")

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=unexpected_scrape, ground=mismatch
    )

    assert client.db["reel_place_mentions"] == []
    assert client.db["organize_job_items"][0]["status"] == "location_not_found"
    assert client.db["saved_reels"][0]["analysis_status"] == "location_not_found"


@pytest.mark.asyncio
@pytest.mark.parametrize("code,name,lat,lng", [
    ("JP", "Japan", 35.67311, 139.73625),
    ("CN", "China", 31.2304, 121.4737),
    ("KR", "South Korea", 37.5665, 126.9780),
])
async def test_run_organize_job_persists_verified_country_matrix(
    monkeypatch, code, name, lat, lng
):
    cache_id = f"cache-{code.lower()}"
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "reel_cache_id": cache_id, "analysis_status": "queued",
        }],
        "reel_cache": [{"id": cache_id, "normalized_url": "https://www.instagram.com/reel/A"}],
    })
    research = PlaceResult(
        name=f"Verified {code}", category="attraction", lat=lat, lng=lng,
        confidence=0.8, evidence_quote=f"Verified {code}",
        source_url="https://source.test/verified", country_code=code, country_name=name,
    )
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [research])

    async def ground(place):
        return {"place": place, "country_code": code, "country_name": name}

    async def unexpected_scrape(*_args, **_kwargs):
        raise AssertionError("cached reel must not scrape")

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=unexpected_scrape, ground=ground
    )

    assert client.db["places"][-1]["country_code"] == code
    assert client.db["places"][-1]["lat"] == lat
    assert len(client.db["reel_place_mentions"]) == 1
    assert client.db["reel_place_mentions"][0]["verification_version"] == "mapbox-country-v1"


@pytest.mark.asyncio
async def test_uncached_reel_caches_research_output_before_country_verification(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "analysis_status": "queued",
        }],
        "rpc:reserve_organize_item_analysis": "2026-07-19",
    })
    research = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67311, lng=139.73625,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )
    cached = []

    async def scrape(*_args, **_kwargs):
        return object()

    async def extract(_reel):
        return [research]

    async def cache(_client, _url, _reel, places, _version):
        cached.extend(places)

    async def verify(place):
        assert cached == [research]
        return {"place": place, "country_code": "JP", "country_name": "Japan"}

    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("organizer.cache_places", cache)

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=scrape, extract=extract, ground=verify
    )

    assert cached[0].lat == 35.67311
    assert cached[0].country_code == "JP"


@pytest.mark.asyncio
async def test_provider_outage_consumes_cached_research_then_retries_without_apify(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued", "analysis_charge_state": "not_charged",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A", "analysis_status": "queued",
        }],
    })
    research = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67311, lng=139.73625,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )
    cached = []
    calls = []

    async def reserve(*_args, **_kwargs):
        calls.append("reserve")
        client.db["organize_job_items"][0]["analysis_charge_state"] = "reserved"
        return True

    async def refund(*_args, **_kwargs):
        calls.append("refund")

    async def scrape(*_args, **_kwargs):
        calls.append("scrape")
        return object()

    async def extract(_reel):
        calls.append("extract")
        return [research]

    async def cache(_client, url, _reel, places, version):
        calls.append("cache")
        cached.extend(places)
        client.db.setdefault("reel_cache", []).append({
            "id": "cache-1", "normalized_url": url, "extractor_version": version,
        })

    async def outage(_place):
        calls.append("outage")
        raise RuntimeError("Mapbox reverse-country failed: status 503")

    monkeypatch.setattr("organizer.reserve_organize_item_analysis", reserve)
    monkeypatch.setattr("organizer.refund_organize_item_analysis", refund)
    monkeypatch.setattr(
        "organizer.get_cached_places",
        lambda *_args, **_kwargs: list(cached) if cached else None,
    )
    monkeypatch.setattr("organizer.cache_places", cache)

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=scrape, extract=extract, ground=outage
    )

    assert cached == [research]
    assert client.db["organize_job_items"][0]["analysis_charge_state"] == "consumed"
    assert client.db["organize_job_items"][0]["status"] == "failed"
    assert calls == ["reserve", "scrape", "extract", "cache", "outage"]

    client.db["organize_jobs"].append({
        "id": "job-2", "user_id": "user-a", "status": "pending",
    })
    client.db["organize_job_items"].append({
        "id": "item-2", "job_id": "job-2", "user_id": "user-a",
        "saved_reel_id": "r1", "status": "queued", "analysis_charge_state": "not_charged",
    })

    async def unexpected_scrape(*_args, **_kwargs):
        raise AssertionError("cache-backed retry must not call Apify")

    async def verified(place):
        calls.append("verified")
        return {"place": place, "country_code": "JP", "country_name": "Japan"}

    await run_organize_job(
        "job-2", "user-a", client=client, scrape=unexpected_scrape,
        extract=extract, ground=verified,
    )

    assert client.db["organize_job_items"][1]["status"] == "organized"
    assert calls == ["reserve", "scrape", "extract", "cache", "outage", "verified"]

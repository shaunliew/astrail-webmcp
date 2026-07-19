from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
from uuid import UUID

import pytest

from api.schemas import GenerateTripRequest, OrganizeJobStatus, OrganizeSavedReelsRequest
from genagents.place_extractor import EXTRACTOR_VERSION
from api.streaming import DONE, format_sse, stream_organize_events
from models.place import PlaceResult
from grounding import _ground_place, _persist_place
from pipeline.dedup import DEFAULT_DISTANCE_M
from pipeline.geo import haversine_m
import organizer
from organizer import (
    ActiveOrganizeConflict,
    InvalidOrganizeRequest,
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


def _split_top_level(expr):
    """Split a PostgREST filter list on commas that are not inside an `and(...)`/`or(...)`."""
    parts, depth, start = [], 0, 0
    for index, char in enumerate(expr):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append(expr[start:index])
            start = index + 1
    parts.append(expr[start:])
    return parts


# DEFERRED, with a trigger: comma-splitting above is parenthesis-depth-aware but NOT
# quote-aware, so `name.eq."a,b"` mis-splits on the embedded comma. No predicate in the repo
# constructs a quoted value containing a comma, so this is unreachable today. TRIGGER: make
# the splitter quote-aware the first time any predicate quotes a value — I5 and A-III both
# add predicates against this fake, and a mis-split term fails toward green.
def _lt(row, key, value):
    """Postgres semantics: `NULL < value` is NULL, so the row does NOT match.

    Deliberately not `row.get(key, "") < value`, which fails two different ways: for a row
    that OMITS the column it makes the NULL case always match (`"" < "2026-..."` is True),
    silently inverting the legacy-orphan reclaim tests; and for a row that carries the column
    as an explicit `None` — how Supabase actually returns it — the default never applies and
    it still raises TypeError. Checking the retrieved value covers both.
    """
    current = row.get(key)
    return current is not None and current < value


def _gt(row, key, value):
    """Postgres semantics: `NULL > value` is NULL, so the row does NOT match.

    The mirror of `_lt`, and load-bearing for the same reason. `stream_organize_events` now
    ALWAYS pushes a reconnect cursor down as `.gt("sequence", …)` instead of first asking the
    client whether it implements `gt` (B6), so this is real filter evaluation rather than a
    branch the fake used to skip. The previous spelling, `row.get(key, 0) > value`, invented a
    0 for a missing column — under which an event carrying no `sequence` outranks every cursor
    and replays on every reconnect.
    """
    current = row.get(key)
    return current is not None and current > value


def _eval_filter_term(row, term):
    """Evaluate one PostgREST filter term (`col.op.value`, or a nested `and(...)`/`or(...)`)."""
    if term.startswith("and(") and term.endswith(")"):
        return all(_eval_filter_term(row, part) for part in _split_top_level(term[4:-1]))
    if term.startswith("or(") and term.endswith(")"):
        return any(_eval_filter_term(row, part) for part in _split_top_level(term[3:-1]))
    if "(" in term or ")" in term:
        # A term carrying parens that did NOT match the and(...)/or(...) shapes above is
        # malformed — usually an unbalanced paren. Without this guard it falls through to the
        # split below and evaluates TRUE by accident: `"and(lock_expires_at.is.null"` parses as
        # key=`"and(lock_expires_at"`, op=`is`, value=`null`, and that key is absent from every
        # row, so `is null` holds. A typo'd predicate would then satisfy every filter and each
        # test built on it would pass while asserting nothing.
        raise ValueError(f"fake got a malformed/unbalanced filter group: {term!r}")
    key, op, value = term.split(".", 2)
    if op == "lt":
        return _lt(row, key, value)
    if op == "eq":
        return row.get(key) == value
    if op == "is":
        if value != "null":
            raise ValueError(f"fake implements only `is.null`, got {term!r}")
        return row.get(key) is None
    # Unimplemented operators must fail loudly. One that quietly evaluated True (or was
    # dropped) is how a later increment gets a green test that proves nothing.
    raise ValueError(f"fake does not implement PostgREST operator {op!r} in {term!r}")


class _Table:
    def __init__(self, name, db):
        self.name, self.db = name, db
        self.op = None
        self.filters = {}
        self.gt_filters = {}
        self.lt_filters = {}
        self.in_filters = {}
        self.is_null_filters = set()
        self.or_filters = []
        self.on_conflict = None
        self.single = False

    def select(self, *_args): self.op = "select"; return self
    def insert(self, row): self.op = ("insert", row); return self
    def upsert(self, row, on_conflict=None): self.op = ("upsert", row); self.on_conflict = on_conflict; return self
    def update(self, row): self.op = ("update", row); return self
    def delete(self): self.op = "delete"; return self
    def eq(self, key, value): self.filters[key] = value; return self
    def gt(self, key, value): self.gt_filters[key] = value; return self
    def lt(self, key, value): self.lt_filters[key] = value; return self
    def or_(self, expr): self.or_filters.append(expr); return self

    def is_(self, key, value):
        # postgrest normalizes `None` to `"null"` (base_request_builder.is_), so both spellings
        # reach the same filter and the fake must accept both. Anything else — `is.true`,
        # `is.unknown` — is unimplemented and fails loudly rather than filtering on nothing.
        if value not in (None, "null"):
            raise ValueError(f"fake implements only `is.null`, got .is_({key!r}, {value!r})")
        self.is_null_filters.add(key)
        return self

    def in_(self, key, values): self.in_filters[key] = set(values); return self
    def order(self, *_args, **_kwargs): return self
    def maybe_single(self): self.single = True; return self

    def _matches(self, row):
        return all(row.get(k) == v for k, v in self.filters.items()) and all(
            row.get(k) in values for k, values in self.in_filters.items()
        ) and all(
            row.get(k) is None for k in self.is_null_filters
        ) and all(_gt(row, k, v) for k, v in self.gt_filters.items()) and all(
            _lt(row, k, v) for k, v in self.lt_filters.items()
        ) and all(
            any(_eval_filter_term(row, term) for term in _split_top_level(expr))
            for expr in self.or_filters
        )

    async def execute(self):
        rows = self.db.setdefault(self.name, [])
        if isinstance(self.op, tuple) and self.op[0] == "insert":
            row = {"id": f"{self.name}-{len(rows) + 1}", **self.op[1]}
            rows.append(row)
            return _Result([row])
        if isinstance(self.op, tuple) and self.op[0] == "upsert":
            # `on_conflict` is REQUIRED, exactly as Postgres requires a matching unique index:
            # a fake that fell back to plain-insert would let a caller who forgot it duplicate
            # rows here and fail only against the real database.
            keys = [key.strip() for key in (self.on_conflict or "").split(",") if key.strip()]
            if not keys:
                raise ValueError("fake upsert requires on_conflict")
            row = self.op[1]
            existing = next((r for r in rows if all(r.get(k) == row.get(k) for k in keys)), None)
            if existing is not None:
                existing.update(row)
                return _Result([existing])
            stored = {"id": f"{self.name}-{len(rows) + 1}", **row}
            rows.append(stored)
            return _Result([stored])
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
    """A fake Supabase client that owns its own clock, because the DATABASE owns the real one.

    `clock_skew` moves THIS FAKE DATABASE's clock, not the caller's. Every lease instant is now
    `clock_timestamp()` inside Postgres (20260720170000), so the way a test says "five minutes
    passed" is to advance the database, exactly as production would experience it. A fake that
    read the *worker's* clock instead could not express host-clock skew at all — the property
    the lease RPCs exist to defend — and every skew test would be vacuous.
    """

    def __init__(self, db=None):
        self.db = db or {}
        self.rpc_calls = []
        self.clock_skew = timedelta(0)

    def db_now(self) -> datetime:
        return datetime.now(timezone.utc) + self.clock_skew

    def table(self, name): return _Table(name, self.db)
    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        if name == "create_saved_reels_organize_job":
            return _CreateOrganizeJobRpc(self, params)
        if name == "append_organize_event":
            return _AppendOrganizeEventRpc(self, params)
        if name == "replace_reel_place_mentions":
            return _ReplaceReelPlaceMentionsRpc(self, params)
        if name == "find_or_create_place":
            return _FindOrCreatePlaceRpc(self, params)
        if name in _LEASE_RPCS:
            mirror, table = _LEASE_RPCS[name]
            return mirror(self, params, self.db.setdefault(table, []))
        return _Rpc(self, name)


class _BarrierClient(_Client):
    """A client whose every round trip is a real interleaving point.

    `.execute()` waits until `parties` callers have reached one, so anything a caller decided
    BEFORE a round trip is guaranteed stale by the time it acts on it. That models the property
    that matters: a single database statement is atomic, and the gap between two of them is
    where a concurrent worker gets in.
    """

    def __init__(self, db=None, *, parties):
        super().__init__(db)
        self._barrier = asyncio.Barrier(parties)

    # Both seams are barriered on purpose. `_Table.execute()` contains no real await, so without
    # `_BarrierTable` two gathered callers would each run start-to-finish before the other began
    # and a select-then-insert would never interleave — the concurrency test would go green
    # against the very code it exists to reject. Confirmed by injection.
    def table(self, name): return _BarrierTable(name, self.db, self._barrier)

    def rpc(self, name, params):
        return _Barriered(super().rpc(name, params), self._barrier)


class _Barriered:
    def __init__(self, inner, barrier): self._inner, self._barrier = inner, barrier

    async def execute(self):
        await self._barrier.wait()
        return await self._inner.execute()


class _BarrierTable(_Table):
    def __init__(self, name, db, barrier):
        super().__init__(name, db)
        self._barrier = barrier

    async def execute(self):
        await self._barrier.wait()
        return await super().execute()


class _Rpc:
    def __init__(self, client, name): self.client, self.name = client, name
    async def execute(self): return _Result(self.client.db.get(f"rpc:{self.name}"))


# --- lease RPCs: mirrors of 20260720170000_db_clock_job_leases.sql ---------------------------
#
# Every instant below comes from `client.db_now()`, never `datetime.now()`. That is the entire
# property these functions exist to provide: the claim, the renewal and the expiry comparison
# are made by ONE clock — Postgres's — so two Render instances that disagree about the time
# cannot both believe they own a job. A mirror that read the caller's clock would model a
# database that does not have that property, and every skew test would pass against the
# Python-clock implementation these replaced.


def _iso(value: datetime) -> str:
    """`Z`-suffixed ISO-8601, matching what Postgres hands back through PostgREST."""
    return value.isoformat().replace("+00:00", "Z")


def _parse_ts(value) -> datetime | None:
    return None if value is None else datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _require_lease_params(params, *, needs_token: bool = True) -> None:
    """The functions' AS400 boundary checks. Mirrored because they are load-bearing, not
    defensive noise: a claim with no token writes a row nothing can later fence on, and a
    non-positive TTL mints a lease that is already expired — both fail toward two live
    workers, which is the failure this whole mechanism exists to prevent."""
    if needs_token and params.get("p_lease_token") is None:
        raise _pg_error("AS400", "lease token is required")
    ttl = params.get("p_ttl_seconds")
    if ttl is None or ttl <= 0:
        raise _pg_error("AS400", "lease TTL must be positive")


def _lease_is_expired(row, now: datetime, legacy_cutoff: datetime) -> bool:
    """The reclaim predicate, with POSTGRES's NULL semantics — where it is easiest to get wrong.

    `NULL < clock_timestamp()` is NULL, not true, so a row with no expiry does NOT match the
    first branch; it falls through to the legacy branch, which is itself gated on the expiry
    genuinely being NULL. Collapse either half and the mirror lies in one of two opposite
    directions: treat NULL as expired and the reaper steals live long-running leases, drop the
    legacy branch and pre-lease rows are skipped forever (guardrail #12's silent drop).
    """
    expiry = _parse_ts(row.get("lock_expires_at"))
    if expiry is not None:
        return expiry < now
    locked_at = _parse_ts(row.get("locked_at"))
    return locked_at is not None and locked_at < legacy_cutoff


class _ClaimTripJobRpc:
    """Mirror of `public.claim_trip_job`. `started_at` is re-stamped on every claim, matching
    the function (and unlike the organize claim, which coalesces)."""

    def __init__(self, client, params, rows):
        self.client, self.params, self.rows = client, params, rows

    async def execute(self):
        params = self.params
        _require_lease_params(params)
        now = self.client.db_now()
        matched = [row for row in self.rows
                   if row.get("id") == params["p_job_id"]
                   and row.get("status") in ("pending", "retryable")]
        for row in matched:
            row.update({
                "status": "running",
                "locked_at": _iso(now),
                "started_at": _iso(now),
                "lock_expires_at": _iso(now + timedelta(seconds=params["p_ttl_seconds"])),
                "lease_token": params["p_lease_token"],
                "completed_at": None,
                "error_message": None,
            })
        return _Result(bool(matched))


class _RenewTripJobLeaseRpc:
    """Mirror of `public.renew_trip_job_lease`. `status = 'running'` is part of the fence, not
    decoration: a job already reclaimed and re-dispatched must not be renewable by the run
    that lost it."""

    def __init__(self, client, params, rows):
        self.client, self.params, self.rows = client, params, rows

    async def execute(self):
        params = self.params
        _require_lease_params(params)
        now = self.client.db_now()
        matched = [row for row in self.rows
                   if row.get("id") == params["p_job_id"]
                   and row.get("status") == "running"
                   and row.get("lease_token") == params["p_lease_token"]]
        for row in matched:
            row["lock_expires_at"] = _iso(now + timedelta(seconds=params["p_ttl_seconds"]))
        return _Result(bool(matched))


class _ReclaimExpiredTripJobsRpc:
    """Mirror of `public.reclaim_expired_trip_jobs`. Returns the COUNT, as the function does.

    The lease fields are cleared, NOT just the status. `mark_job_done` fences on the token with
    no status guard, so a row that kept its token would let an expired-but-still-alive worker
    flip the freshly scheduled `retryable` back to `failed`.
    """

    def __init__(self, client, params, rows):
        self.client, self.params, self.rows = client, params, rows

    async def execute(self):
        params = self.params
        _require_lease_params(params, needs_token=False)
        now = self.client.db_now()
        legacy_cutoff = now - timedelta(seconds=params["p_ttl_seconds"])
        matched = [row for row in self.rows
                   if row.get("status") == "running"
                   and _lease_is_expired(row, now, legacy_cutoff)]
        for row in matched:
            row.update({"status": "retryable", "lease_token": None,
                        "lock_expires_at": None, "locked_at": None})
        return _Result(len(matched))


class _ClaimOrganizeJobRpc:
    """Mirror of `public.claim_organize_job`.

    `started_at` COALESCES rather than re-stamping: it is the run's user-visible elapsed time,
    and re-stamping on retry makes a job stuck in a retry loop report as though it had just
    begun. The owner scope is part of the predicate, not a courtesy.
    """

    def __init__(self, client, params, rows):
        self.client, self.params, self.rows = client, params, rows

    async def execute(self):
        params = self.params
        _require_lease_params(params)
        now = self.client.db_now()
        matched = [row for row in self.rows
                   if row.get("id") == params["p_job_id"]
                   and row.get("user_id") == params["p_user_id"]
                   and row.get("status") == "pending"]
        for row in matched:
            row.update({
                "status": "processing",
                "status_message": params["p_status_message"],
                "locked_at": _iso(now),
                "started_at": row.get("started_at") or _iso(now),
                "lock_expires_at": _iso(now + timedelta(seconds=params["p_ttl_seconds"])),
                "lease_token": params["p_lease_token"],
                "attempt_count": params["p_attempt_count"],
            })
        return _Result(bool(matched))


class _RenewOrganizeJobLeaseRpc:
    def __init__(self, client, params, rows):
        self.client, self.params, self.rows = client, params, rows

    async def execute(self):
        params = self.params
        _require_lease_params(params)
        now = self.client.db_now()
        matched = [row for row in self.rows
                   if row.get("id") == params["p_job_id"]
                   and row.get("user_id") == params["p_user_id"]
                   and row.get("status") == "processing"
                   and row.get("lease_token") == params["p_lease_token"]]
        for row in matched:
            row["lock_expires_at"] = _iso(now + timedelta(seconds=params["p_ttl_seconds"]))
        return _Result(bool(matched))


class _ReclaimExpiredOrganizeJobsRpc:
    def __init__(self, client, params, rows):
        self.client, self.params, self.rows = client, params, rows

    async def execute(self):
        params = self.params
        _require_lease_params(params, needs_token=False)
        now = self.client.db_now()
        legacy_cutoff = now - timedelta(seconds=params["p_ttl_seconds"])
        matched = [row for row in self.rows
                   if row.get("status") == "processing"
                   and _lease_is_expired(row, now, legacy_cutoff)]
        for row in matched:
            row.update({"status": "pending", "status_message": params["p_status_message"],
                        "locked_at": None, "lock_expires_at": None, "lease_token": None})
        return _Result(len(matched))


# name -> (mirror, the table it operates on). The table is named here rather than inside each
# mirror so a fake whose rows live somewhere other than `client.db` — `test_jobs._Client` keys
# its store by idempotency key — can construct the same mirror over its own rows and get
# identical semantics, instead of growing a second, drifting copy of the predicate.
_LEASE_RPCS = {
    "claim_trip_job": (_ClaimTripJobRpc, "jobs"),
    "renew_trip_job_lease": (_RenewTripJobLeaseRpc, "jobs"),
    "reclaim_expired_trip_jobs": (_ReclaimExpiredTripJobsRpc, "jobs"),
    "claim_organize_job": (_ClaimOrganizeJobRpc, "organize_jobs"),
    "renew_organize_job_lease": (_RenewOrganizeJobLeaseRpc, "organize_jobs"),
    "reclaim_expired_organize_jobs": (_ReclaimExpiredOrganizeJobsRpc, "organize_jobs"),
}


class _FindOrCreatePlaceRpc:
    """Mirror of `public.find_or_create_place` (20260720160000, widened by 20260720180000).

    ATOMIC ON PURPOSE — the body below contains no `await`, so no other coroutine can run
    between the lookup and the insert. That is not the fake being convenient: it is what the
    real function's `pg_advisory_xact_lock` buys, and a fake that awaited mid-body would model
    a database that does not have it, quietly reddening the concurrency test for the wrong
    reason.

    What it CANNOT reproduce is the lock itself — whether two separate BACKENDS are serialized
    is a property of Postgres, not of Python, so it is proven against real concurrent
    connections in `supabase/tests/012_serialized_place_find_or_create.sql`. This mirror pins
    the reuse rule the callers depend on: same name, a country that matches the verified one or
    is not set yet, inside the gate, verified rows preferred and lowest id breaking the tie.
    """

    def __init__(self, client, params): self.client, self.params = client, params

    def _match(self):
        params = self.params
        rows = self.client.db.setdefault("places", [])
        eligible = [
            row for row in rows
            if row.get("name") == params["p_name"]
            # `country_code = p_country_code or country_code is null` (20260720180000). A row
            # predating the country migration carries no country, and an equality predicate
            # would exclude it structurally — which is how the organizer ended up inserting a
            # duplicate for a venue it already had (ISSUES-B2).
            and row.get("country_code") in (params["p_country_code"], None)
            and params["p_lat"] is not None
            and params["p_lng"] is not None
            and row.get("lat") is not None
            and row.get("lng") is not None
            and haversine_m(params["p_lat"], params["p_lng"], row["lat"], row["lng"])
            < params["p_max_distance_m"]
        ]
        # `order by (country_code is null), id`. Both keys are load-bearing and neither can be
        # left to insertion order: a verified row beats a legacy one because it is already
        # Mapbox-grounded, and `id` then makes the winner among equally-eligible rows total, so
        # a re-organize resolves to the same canonical place every run. Seeding order must NOT
        # satisfy either — `test_persist_place_breaks_a_same_country_tie_by_lowest_id` seeds the
        # lower id second precisely so a fake that iterated the list would fail it.
        eligible.sort(key=lambda row: (row.get("country_code") is None, row["id"]))
        return eligible[0] if eligible else None

    async def execute(self):
        params = self.params
        row = self._match()
        if row is not None:
            row.update({
                "country": params["p_country"],
                "country_code": params["p_country_code"],
                "country_name": params["p_country_name"],
            })
            return _Result(row["id"])
        rows = self.client.db.setdefault("places", [])
        # `embedding` is deliberately absent, mirroring the function's column list (ISSUES-B3).
        stored = {
            "id": f"places-{len(rows) + 1}",
            "name": params["p_name"],
            "place_type": params["p_place_type"],
            "lat": params["p_lat"],
            "lng": params["p_lng"],
            "country": params["p_country"],
            "country_code": params["p_country_code"],
            "country_name": params["p_country_name"],
            "city": params["p_city"],
        }
        rows.append(stored)
        return _Result(stored["id"])


def _pg_error(code, message):
    from postgrest.exceptions import APIError

    return APIError({"code": code, "message": message, "details": None, "hint": None})


class _AppendOrganizeEventRpc:
    """Mirror of `public.append_organize_event` (20260720090000_job_leases.sql).

    The AS409 branch is the load-bearing part. `_record_organize_event` swallows a superseded
    append so a terminal path never crashes on it — which means a fake that always inserted
    would leave that handling as dead code AND let every fencing test below pass while the
    real RPC's fence was gone. The error ORDER matters too and mirrors the function: the row
    lookup happens first (AS404), then the null-token rejection (AS400), then the fence
    (AS409). `is distinct from` and Python's `!=` agree on a NULL lease against a real token.
    """

    def __init__(self, client, params): self.client, self.params = client, params

    async def execute(self):
        job_id, user_id = self.params["p_job_id"], self.params["p_user_id"]
        job = next((row for row in self.client.db.get("organize_jobs", [])
                    if row.get("id") == job_id and row.get("user_id") == user_id), None)
        if job is None:
            raise _pg_error("AS404", "Organize job not found")
        if self.params["p_lease_token"] is None:
            raise _pg_error("AS400", "Organize event requires a lease token")
        if job.get("lease_token") != self.params["p_lease_token"]:
            raise _pg_error("AS409", "Organize job lease superseded")
        events = self.client.db.setdefault("organize_events", [])
        sequence = max((row.get("sequence", 0) for row in events
                        if row.get("job_id") == job_id), default=0) + 1
        events.append({
            "id": f"organize_events-{len(events) + 1}",
            "user_id": user_id,
            "job_id": job_id,
            "sequence": sequence,
            "event_type": self.params["p_event_type"],
            "message": self.params["p_message"],
            "payload": self.params.get("p_payload") or {},
        })
        return _Result(sequence)


class _ReplaceReelPlaceMentionsRpc:
    """Mirror of `public.replace_reel_place_mentions` (20260720080000_..._user_scope.sql).

    Two properties are load-bearing and both are asserted against this fake in
    `test_organizer_mention_rewrite.py`: the upsert and the prune are ONE unit (no window in
    which a concurrent reader sees a half-written set), and the prune is scoped to
    `p_user_id`, so another owner's rows are unreachable by construction.

    What it CANNOT reproduce: Postgres rejecting a payload that names the same `place_id`
    twice with "ON CONFLICT DO UPDATE command cannot affect row a second time". A Python dict
    keyed on the same tuple simply overwrites. The `distinct on (place_id)` that prevents that
    is therefore pinned in pgTAP (`supabase/tests/007_saved_reels_organize.sql`), NOT here —
    the duplicate test in the mention-rewrite module pins the call shape only.
    """

    def __init__(self, client, params): self.client, self.params = client, params

    async def execute(self):
        params = self.params
        mentions = params["p_mentions"]
        if not isinstance(mentions, list):
            raise _pg_error("AS422", "mentions payload must be a JSON array")
        user_id, cache_id = params["p_user_id"], params["p_reel_cache_id"]
        deduped = {}
        for mention in mentions:            # first occurrence wins, as `distinct on ... order by ord`
            deduped.setdefault(mention["place_id"], mention)
        rows = self.client.db.setdefault("reel_place_mentions", [])
        for place_id, mention in deduped.items():
            row = next((candidate for candidate in rows
                        if candidate.get("user_id") == user_id
                        and candidate.get("reel_cache_id") == cache_id
                        and candidate.get("place_id") == place_id), None)
            values = {
                "user_id": user_id, "reel_cache_id": cache_id, "place_id": place_id,
                "evidence_quote": mention.get("evidence_quote"),
                "source_url": mention.get("source_url"),
                "confidence": mention.get("confidence") or 0,
                "verification_version": params["p_verification_version"],
            }
            if row is None:
                rows.append({"id": f"reel_place_mentions-{len(rows) + 1}", **values})
            else:
                row.update(values)
        # Prune ONLY this owner's superseded rows for this cache.
        self.client.db["reel_place_mentions"] = [
            row for row in rows
            if not (row.get("user_id") == user_id
                    and row.get("reel_cache_id") == cache_id
                    and row.get("place_id") not in deduped)
        ]
        return _Result(len(deduped))


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
            raise APIError({"code": "AS404", "message": "Saved Reel not found", "details": None, "hint": None})
        active_item = next((item for item in self.client.db.get("organize_job_items", [])
                            if item.get("saved_reel_id") in ids
                            and any(job.get("id") == item.get("job_id")
                                    and job.get("user_id") == user_id
                                    and job.get("status") in {"initializing", "pending", "processing"}
                                    for job in self.client.db.get("organize_jobs", []))), None)
        if active_item:
            raise APIError({
                "code": "AS409",
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


# The seams below are ASYNC because the things they stand in for are async (B6). `organizer`
# awaits `get_cached_places` and the injected `scrape`/`extract`/`ground` directly; it used to
# funnel them through a `_maybe_await` that accepted either shape, which let sync fakes pass
# for coroutine functions and hid the difference from every test in this file.
def _cached(value):
    """An async stand-in for `pipeline.cache.get_cached_places` returning a fixed result."""
    async def _get_cached_places(*_args, **_kwargs):
        return value
    return _get_cached_places


async def _grounds_to_japan(place):
    """The common `ground` seam: Mapbox verifies every place as being in Japan."""
    return {"place": place, "country_code": "JP", "country_name": "Japan"}


async def _extracts_one_place(_scraped):
    """The common `extract` seam: the extractor finds exactly one place."""
    return [_place()]


def test_place_only_generate_request_is_valid_and_empty_request_is_rejected():
    request = GenerateTripRequest(
        place_ids=["11111111-1111-1111-1111-111111111111"], start_date="2026-08-01", end_date="2026-08-02"
    )
    assert request.reel_urls == []
    with pytest.raises(ValueError):
        GenerateTripRequest(start_date="2026-08-01", end_date="2026-08-02")


def test_organize_request_is_bounded():
    saved_reel_id = "22222222-2222-2222-2222-222222222222"
    assert OrganizeSavedReelsRequest(saved_reel_ids=[saved_reel_id]).saved_reel_ids == [UUID(saved_reel_id)]
    with pytest.raises(ValueError):
        OrganizeSavedReelsRequest(saved_reel_ids=[])
    with pytest.raises(ValueError):
        OrganizeSavedReelsRequest(saved_reel_ids=[f"22222222-2222-2222-2222-{i:012d}" for i in range(6)])


def test_organize_request_rejects_duplicate_ids():
    # The RPC already rejects duplicates, but only with the generic P0001
    # 'Saved Reel organize request is invalid' -- a message create_organize_job's mapping
    # does not match, so a direct API client would get a 500. Reject at the boundary.
    saved_reel_id = "22222222-2222-2222-2222-222222222222"
    with pytest.raises(ValueError):
        OrganizeSavedReelsRequest(saved_reel_ids=[saved_reel_id, saved_reel_id])


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
                        "code": "AS409",
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
async def test_recover_organize_jobs_immediately_requeues_prior_process_work():
    # Seeded with an EXPIRED lease: recovery is expiry-gated now, so a future lock_expires_at
    # would (correctly) mean a live instance still owns the job. Field-level clearing and the
    # unexpired/legacy-NULL branches are covered in test_organizer_lease.py.
    expired_lock = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    client = _Client({
        "organize_jobs": [{
            "id": "interrupted-job",
            "user_id": "user-a",
            "status": "processing",
            "status_message": "Finding places",
            "locked_at": datetime.now(timezone.utc).isoformat(),
            "lock_expires_at": expired_lock,
            "lease_token": "t-old",
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
    class _FaultRpc:
        async def execute(self):
            raise RuntimeError("initial event write failed")

    class _FaultTable(_Table):
        async def execute(self):
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

        def rpc(self, name, params):
            # The opening event moved from a table insert to `append_organize_event`, so the
            # fault has to move with it. Left on the table, this hook would simply never fire
            # and the case would assert the SUCCESS path while still looking green.
            call = super().rpc(name, params)
            if (
                failure == "initial_event"
                and name == "append_organize_event"
                and params.get("p_message") == "Finding places"
            ):
                return _FaultRpc()
            return call

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
    monkeypatch.setattr("organizer.get_cached_places", _cached([_place()]))
    if failure == "counts":
        async def fail_counts(*_args, **_kwargs):
            raise RuntimeError("count update failed")

        monkeypatch.setattr("organizer._update_job_counts", fail_counts)

    await run_organize_job(
        "job-1", "user-a", client=client,
        ground=_grounds_to_japan,
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
    monkeypatch.setattr("organizer.get_cached_places", _cached(None))
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
    async def ground(place):
        return {"place": place, "country_code": "JP", "country_name": "Japan"}
    monkeypatch.setattr("organizer.get_cached_places", _cached([_place()]))
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

    async def ground(place):
        return {"place": place, "country_code": "JP", "country_name": "Japan"}

    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    monkeypatch.setattr("organizer.get_cached_places", _cached([_place()]))
    monkeypatch.setattr("organizer.scrape_reel", unexpected_scrape)

    await run_organize_job("job-1", "user-a", client=client, ground=ground)

    assert client.db["organize_job_items"][0]["status"] == "organized"
    assert client.db["saved_reels"][0]["analysis_status"] == "organized"


@pytest.mark.asyncio
async def test_default_scrape_seam_fails_closed_without_an_apify_token(monkeypatch):
    """The ONLY test that invokes `run_organize_job`'s default (un-injected) Apify seam.

    Every other organize test passes `scrape=`. The one that does not,
    `test_cached_retry_does_not_require_apify_token` above, is a cache HIT — it CONSTRUCTS the
    default closure and never CALLS it. Defining a nested function resolves none of the names
    in its body; that lookup happens at call time. So when B6's split left `import os` off
    organizer.py, the closure's `os.environ` was a latent NameError and all 727 tests stayed
    green. Only a cache MISS executes the body, which is what this test drives.

    `scrape_reel` is stubbed to raise rather than merely left alone: that is the assertion
    that the token guard short-circuits BEFORE the provider call, so reordering those two
    lines fails loudly here instead of quietly dialling Apify from a unit test.
    """
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued", "analysis_charge_state": "not_charged",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "reel_cache_id": "cache-1", "analysis_status": "queued",
        }],
        "rpc:reserve_organize_item_analysis": "2026-07-19",
        "rpc:refund_organize_item_analysis": True,
    })
    seams, past_the_seam = [], []
    real_item_context = organizer._ItemContext

    def _capture_seam(**fields):
        # Pure observation — the job still runs on a real `_ItemContext`. Holding the closure
        # is what lets us assert WHICH error it raises: `_process_item` swallows the exception
        # and records a deliberately generic `error_message`, which cannot tell the intended
        # RuntimeError from the NameError a missing import would produce.
        ctx = real_item_context(**fields)
        seams.append(ctx.scrape)
        return ctx

    async def unexpected_scrape_reel(*_args, **_kwargs):
        raise AssertionError("the no-token path must fail before calling Apify")

    async def unexpected_stage(*_args, **_kwargs):
        past_the_seam.append("called")

    # MANDATORY, not decorative: conftest loads backend/.env under --run-live, so a real
    # APIFY_TOKEN can genuinely be in the environment.
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    monkeypatch.setattr(organizer, "_ItemContext", _capture_seam)
    monkeypatch.setattr("organizer.get_cached_places", _cached(None))
    monkeypatch.setattr("organizer.scrape_reel", unexpected_scrape_reel)

    await run_organize_job(
        "job-1", "user-a", client=client, extract=unexpected_stage, ground=unexpected_stage
    )

    assert client.db["organize_job_items"][0]["status"] == "failed"
    # The USER-facing message stays generic — the provider detail below is operator-facing and
    # never reaches the item row.
    assert client.db["organize_job_items"][0]["error_message"] == "Reel organization failed"
    assert past_the_seam == []
    with pytest.raises(RuntimeError, match="Reel extraction is unavailable"):
        await seams[0]("https://www.instagram.com/reel/A")


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
async def test_organize_event_stream_resumes_after_a_cursor():
    """A reconnect with a cursor replays only what the client has not already seen.

    This path had NO coverage while `stream_organize_events` guarded it with
    `hasattr(query, "gt")`: against a fake without `gt` the filter was silently skipped, so the
    guard read as "cursors are optional" rather than "this fake is incomplete". The filter is
    unconditional now, which is what makes this exercise the real query.

    HONEST LIMIT: production ALSO skips `sequence <= cursor_sequence` row by row, so this stays
    green if the pushed-down `.gt` is broken — the two guards share a predicate. What pins the
    fake's `gt` itself is `test_fake_gt_skips_null_columns_like_postgres`.
    """
    client = _Client({"organize_events": [
        {"sequence": 1, "job_id": "job-1", "user_id": "user-a", "event_type": "stage",
         "message": "Queued", "payload": {}},
        {"sequence": 2, "job_id": "job-1", "user_id": "user-a", "event_type": "stage",
         "message": "Finding places", "payload": {}},
        {"sequence": 3, "job_id": "job-1", "user_id": "user-a", "event_type": "result",
         "message": "Organized", "payload": {"status": "succeeded"}},
    ]})

    events = [event async for event in stream_organize_events(
        client, "job-1", "user-a", cursor="1", poll_s=0
    )]

    assert [event.split("\n", 1)[0] for event in events[:-1]] == ["id: 2", "id: 3"]
    assert events[-1] == DONE


@pytest.mark.asyncio
async def test_organize_event_stream_times_out_with_terminal_result_before_done():
    events = [event async for event in stream_organize_events(
        _Client({"organize_events": []}), "job-1", "user-a", poll_s=0, max_polls=1
    )]
    result = json.loads(events[-2][len("data: "):])
    assert result["type"] == "result"
    assert json.loads(result["content"])["error"] == "organize stream timed out"
    assert events[-1] == DONE


@pytest.mark.asyncio
async def test_place_ids_are_owner_scoped_through_organized_reel_proof():
    client = _Client({
        "reel_place_mentions": [{"user_id": "user-a", "place_id": "p1", "reel_cache_id": "cache-a", "evidence_quote": "proof", "source_url": None, "confidence": 0.9, "verification_version": "mapbox-country-v1"}],
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
    monkeypatch.setattr("organizer.get_cached_places", _cached(None))

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=scrape, extract=extract,
        ground=_grounds_to_japan,
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
    monkeypatch.setattr("organizer.get_cached_places", _cached([_place()]))

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=unexpected_scrape,
        ground=_grounds_to_japan,
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

    monkeypatch.setattr("organizer.get_cached_places", _cached([_place()]))

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

    result = await _ground_place(_Client({}), place, verify_country=verify)

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

    result = await _ground_place(_Client({}), poisoned, verify_country=verify)

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

    assert await _ground_place(_Client({}), place, verify_country=verify) is None


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

    assert await _ground_place(_Client({}), place, verify_country=verify) is None


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
        await _ground_place(_Client({}), place, verify_country=verify)
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

    assert await _ground_place(_Client({}), place, verify_country=verify) is None
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
        await _ground_place(_Client({}), place, verify_country=verify)


@pytest.mark.asyncio
async def test_persist_place_does_not_reuse_same_name_from_another_country():
    """The verified country is what separates two same-named venues — nothing else may be.

    The MX row deliberately sits at the JP place's EXACT coordinates. It used to carry no
    lat/lng at all, which made this test unfalsifiable: the distance gate skips a candidate
    with no coordinates, so it passed with the country predicate deleted outright (injected,
    confirmed). Same coordinates means only `country_code` can keep these two apart.
    """
    client = _Client({
        "places": [{
            "id": "place-mx",
            "name": "Harry Potter Cafe",
            "country_code": "MX",
            "lat": 35.6764,
            "lng": 139.65,
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
async def test_concurrent_persist_of_the_same_place_creates_one_canonical_row():
    """Two workers racing for the same new place must leave ONE `places` row, not two.

    This is the defect, reproduced: `places` has no unique key, so an expired worker and its
    replacement both looked, both saw nothing, and both inserted. Fencing the mention row only
    decides which duplicate gets referenced — the orphan stays in the GLOBAL flywheel and every
    later organize resolves the same venue to an arbitrary one of the two ids.

    The interleaving is real, not asserted on call counts: `_BarrierClient` holds every
    `.execute()` until both callers have reached one, so each round trip is a point where the
    other coroutine is guaranteed to have run. What the barrier models is exactly what Postgres
    gives us — one statement is atomic, the gap BETWEEN two statements is not. So this pins the
    Python half of the fix (the decision and the write are one round trip); that the single
    statement is itself serialized against another *connection* is the advisory lock, proven
    with real concurrent backends in `supabase/tests/012_serialized_place_find_or_create.sql`.

    Against the old select-then-insert both selects clear the barrier before either insert
    runs, both see an empty table, and the table ends with two rows.
    """
    client = _BarrierClient({}, parties=2)
    grounded = {
        "place": PlaceResult(
            name="Harry Potter Cafe", category="restaurant", lat=35.67311, lng=139.73625,
            confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
            country_code="JP", country_name="Japan",
        ),
        "country_code": "JP",
        "country_name": "Japan",
    }

    async with asyncio.timeout(5):          # a barrier deadlock must fail, not hang the suite
        first, second = await asyncio.gather(
            _persist_place(client, grounded), _persist_place(client, grounded),
        )

    assert len(client.db["places"]) == 1, "the race duplicated the canonical place row"
    assert first == second == client.db["places"][0]["id"]


@pytest.mark.asyncio
async def test_persist_place_omits_embedding_deliberately():
    """ISSUES-B3: null `embedding` is an accepted MVP state, not an oversight.

    There is no shared embedding producer in this repo, and a zero vector would pollute every
    future similarity search. Characterization only — when a producer exists, this test is the
    place that has to change, deliberately.
    """
    client = _Client({})

    await _persist_place(client, {
        "place": _place("Shibuya Sky"), "country_code": "JP", "country_name": "Japan",
    })

    assert "embedding" not in client.db["places"][0]


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


def _legacy_null_country_row(place_id, lat, lng):
    """A canonical row created BEFORE the country migration: name + coords, no country.

    Written with explicit `None`s rather than omitted keys because that is how Supabase
    actually returns a nullable column, and the two differ under `row.get(key, default)`.
    """
    return {"id": place_id, "name": "Harry Potter Cafe", "lat": lat, "lng": lng,
            "country": None, "country_code": None, "country_name": None}


@pytest.mark.asyncio
async def test_persist_place_reuses_and_backfills_a_near_null_country_legacy_row():
    """ISSUES-B2: `.eq("country_code", ...)` structurally excludes pre-migration rows, so the
    organizer inserted a SECOND canonical row for a venue it already had. Coordinates — not the
    name — are what license the reuse, and the verified country is written onto the reused row.
    """
    client = _Client({"places": [_legacy_null_country_row("place-legacy", 35.67311, 139.73625)]})
    place = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67320, lng=139.73630,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )

    place_id = await _persist_place(client, {
        "place": place, "country_code": "JP", "country_name": "Japan",
    })

    assert place_id == "place-legacy"
    assert len(client.db["places"]) == 1, "reuse must not also insert a duplicate"
    assert client.db["places"][0]["country_code"] == "JP"
    assert client.db["places"][0]["country"] == "Japan"
    assert client.db["places"][0]["country_name"] == "Japan"


@pytest.mark.asyncio
async def test_persist_place_does_not_reuse_a_far_null_country_row():
    """The distance gate is what keeps null-aware matching from being data corruption: two
    genuinely different venues sharing a name must stay two rows, and the far row must NOT be
    stamped with a country it was never verified against.
    """
    client = _Client({"places": [_legacy_null_country_row("place-osaka", 34.6937, 135.5023)]})
    place = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67320, lng=139.73630,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )

    place_id = await _persist_place(client, {
        "place": place, "country_code": "JP", "country_name": "Japan",
    })

    assert place_id != "place-osaka"
    assert len(client.db["places"]) == 2
    assert client.db["places"][0]["country_code"] is None, "the far row must stay untouched"
    assert client.db["places"][-1]["lat"] == 35.67320


@pytest.mark.asyncio
async def test_persist_place_prefers_the_country_code_match_over_a_null_country_row():
    """Both rows are inside the gate, so both are reusable — the choice must be deterministic
    and must pick the row whose country is already verified, not whichever came back first.
    """
    client = _Client({"places": [
        _legacy_null_country_row("place-legacy", 35.67311, 139.73625),
        {"id": "place-verified", "name": "Harry Potter Cafe", "lat": 35.67315,
         "lng": 139.73628, "country": "Japan", "country_code": "JP", "country_name": "Japan"},
    ]})
    place = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67320, lng=139.73630,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )

    place_id = await _persist_place(client, {
        "place": place, "country_code": "JP", "country_name": "Japan",
    })

    assert place_id == "place-verified"
    assert client.db["places"][0]["country_code"] is None, "the unchosen row stays untouched"


@pytest.mark.asyncio
async def test_persist_place_finds_or_creates_in_exactly_one_round_trip():
    """The whole find-or-create is ONE call, and it is the RPC (B2 + 20260720160000).

    B2 made reuse null-country-aware with two unconditional selects, so an organize of N places
    issued up to 2N; B6 collapsed them into one `or=` select; the serialization then moved the
    entire lookup-and-insert into `find_or_create_place`, which is what makes the count exactly
    one rather than merely fewer. `_persist_place` runs once per grounded place, so this is the
    loop worth keeping tight — and the count is now CORRECTNESS, not just cost: a second round
    trip is by definition outside the function's transaction and therefore outside its advisory
    lock, which is precisely the race 20260720160000 closed. Without this, a later increment
    re-adds a read here and every other test in this file stays green.
    """
    round_trips = []

    class _CountingClient(_Client):
        def table(self, name):
            round_trips.append(("table", name))
            return super().table(name)

        def rpc(self, name, params):
            round_trips.append(("rpc", name))
            return super().rpc(name, params)

    client = _CountingClient({"places": [
        _legacy_null_country_row("place-legacy", 35.67311, 139.73625),
    ]})
    place = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67320, lng=139.73630,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )

    place_id = await _persist_place(client, {
        "place": place, "country_code": "JP", "country_name": "Japan",
    })

    assert round_trips == [("rpc", "find_or_create_place")]
    assert place_id == "place-legacy"        # and it still reused, rather than trip-counting a no-op
    # The reuse rule needs every one of these, and a missing key would raise inside the mirror
    # rather than silently widen the gate. Which candidate the rule then PREFERS is decided by
    # `order by (country_code is null), id` inside the function — proven against real Postgres
    # in `supabase/tests/012_serialized_place_find_or_create.sql`, since no Python assertion can
    # reach a SQL ORDER BY.
    assert client.rpc_calls[0][1] == {
        "p_name": "Harry Potter Cafe",
        "p_place_type": "restaurant",
        "p_lat": 35.67320,
        "p_lng": 139.73630,
        "p_country": "Japan",
        "p_country_code": "JP",
        "p_country_name": "Japan",
        "p_city": None,
        "p_max_distance_m": DEFAULT_DISTANCE_M,
    }


@pytest.mark.asyncio
async def test_persist_place_omits_embedding_deliberately():
    """CHARACTERIZATION (ISSUES-B3) — pins today's behaviour; there was no red phase.

    A null `embedding` is a DECISION, not an oversight. Organizer places join the pgvector
    flywheel through the future shared embedding producer, never through a blocking OpenAI
    call on the organize critical path. The whole system is consistent here: no production
    embedding writer exists repo-wide, and `pipeline/dedup.py` matches without embeddings
    too. If this assertion bothers you, you are building that producer — see the trigger in
    `ISSUES.md` B3, and change BOTH writers together.
    """
    client = _Client({})
    place = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67320, lng=139.73630,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )

    await _persist_place(client, {
        "place": place, "country_code": "JP", "country_name": "Japan",
    })

    inserted = client.db["places"][-1]
    assert "embedding" not in inserted, (
        "an embedding written here would be a new blocking OpenAI call on the organize path"
    )


@pytest.mark.asyncio
async def test_authorize_place_ids_rejects_unstamped_mention():
    client = _Client({
        "reel_place_mentions": [{
            # OWNED by the requesting user on purpose: without user_id the A3 owner filter
            # rejects the row first and this test would pass without ever exercising the
            # verification-version check it exists to pin.
            "user_id": "user-a",
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
            # Owned by the organizing user — post-A3 every mention has an owner, and the
            # rewrite replaces exactly that owner's set for the cache.
            {
                "id": "legacy-mx", "user_id": "user-a",
                "reel_cache_id": "cache-1", "place_id": "place-mx",
                "evidence_quote": "Harry Potter Cafe", "source_url": None, "confidence": 0.6,
                "verification_version": None,
            },
            {
                "id": "legacy-us", "user_id": "user-a",
                "reel_cache_id": "cache-1", "place_id": "place-us",
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

    monkeypatch.setattr("organizer.get_cached_places", _cached([research]))

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
async def test_country_mismatch_fails_closed_without_destroying_mentions(monkeypatch):
    """A country mismatch must fail CLOSED — but no longer by deleting.

    Pre-A3 this test asserted the mentions table was emptied. That deletion was the
    cross-user destruction Major: it ran before the grounding result was known and was scoped
    to `reel_cache_id` alone, so a Mapbox brownout wiped every user's verified evidence for
    the Reel. A3 removes the delete entirely; fail-closed is now carried by the
    verification-version stamp, which `authorize_place_ids` requires — so the poisoned links
    survive as rows yet remain unusable, and no other owner's evidence is at risk.
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
            "reel_cache_id": "cache-1", "analysis_status": "organized",
        }],
        "reel_cache": [{"id": "cache-1", "normalized_url": "https://www.instagram.com/reel/A"}],
        "reel_place_mentions": [
            {"id": "legacy-mx", "user_id": "user-a", "reel_cache_id": "cache-1", "place_id": "place-mx"},
            {"id": "legacy-us", "user_id": "user-a", "reel_cache_id": "cache-1", "place_id": "place-us"},
        ],
    })
    research = PlaceResult(
        name="Harry Potter Cafe", category="restaurant", lat=35.67311, lng=139.73625,
        confidence=0.8, evidence_quote="Harry Potter Cafe", source_url="https://hpcafe.jp/",
        country_code="JP", country_name="Japan",
    )
    monkeypatch.setattr("organizer.get_cached_places", _cached([research]))

    async def mismatch(_place):
        return None

    async def unexpected_scrape(*_args, **_kwargs):
        raise AssertionError("cached reel must not scrape")

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=unexpected_scrape, ground=mismatch
    )

    assert client.db["organize_job_items"][0]["status"] == "location_not_found"
    assert client.db["saved_reels"][0]["analysis_status"] == "location_not_found"
    # Not destroyed — a failed grounding is a partial failure, not a data-loss event.
    assert {row["place_id"] for row in client.db["reel_place_mentions"]} == {"place-mx", "place-us"}
    # ...and still unusable, because neither carries the verification stamp.
    with pytest.raises(PermissionError):
        await authorize_place_ids(client, "user-a", ["place-mx"])


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
    monkeypatch.setattr("organizer.get_cached_places", _cached([research]))

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

    monkeypatch.setattr("organizer.get_cached_places", _cached(None))
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
    async def get_cached_places(*_args, **_kwargs):
        return list(cached) if cached else None

    monkeypatch.setattr("organizer.get_cached_places", get_cached_places)
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


@pytest.mark.asyncio
async def test_item_failure_logs_only_fixed_phase_and_job_item_ids(monkeypatch, caplog):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued", "analysis_charge_state": "not_charged",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a", "normalized_url": "https://www.instagram.com/reel/A",
            "reel_cache_id": "cache-1",
        }],
    })

    monkeypatch.setattr("organizer.get_cached_places", _cached([_place()]))

    async def leak(_place):
        raise RuntimeError("TOKEN=secret https://private.example/reel/A")

    with caplog.at_level("ERROR", logger="organizer"):
        await run_organize_job("job-1", "user-a", client=client, ground=leak)

    assert "phase=mapbox" in caplog.text
    assert "job_id=job-1" in caplog.text
    assert "item_id=item-1" in caplog.text
    assert "secret" not in caplog.text
    assert "private.example" not in caplog.text


@pytest.mark.asyncio
async def test_zero_place_job_does_not_report_as_organized(monkeypatch):
    """4 failed + 1 location_not_found is `succeeded` with ZERO places — it must not say
    "Organized".

    `final_status` is deliberately unchanged (it is the frontend contract, and one
    location_not_found among failures is still a completed run, not a crashed one). The
    MESSAGE is what a user reads, and "Organized" on a job that produced no place is a lie
    the status endpoint and the terminal SSE event both repeat.
    """
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [
            {"id": f"item-{key}", "job_id": "job-1", "user_id": "user-a",
             "saved_reel_id": f"r{key}", "status": "queued"}
            for key in "ABCDE"
        ],
        "saved_reels": [
            {"id": f"r{key}", "user_id": "user-a",
             "normalized_url": f"https://www.instagram.com/reel/{key}",
             "reel_cache_id": f"cache-{key}", "analysis_status": "queued"}
            for key in "ABCDE"
        ],
        "reel_cache": [
            {"id": f"cache-{key}", "normalized_url": f"https://www.instagram.com/reel/{key}"}
            for key in "ABCDE"
        ],
    })
    # One place per Reel, named after it, so the shared `ground` seam can behave per item.
    async def get_cached_places(_client, url, _version):
        return [_place(name=url.rsplit("/", 1)[-1])]

    monkeypatch.setattr("organizer.get_cached_places", get_cached_places)

    async def ground(place):
        if place.name == "E":
            return None                             # grounds to nothing -> location_not_found
        raise RuntimeError("mapbox unavailable")    # -> failed

    await run_organize_job("job-1", "user-a", client=client, ground=ground)

    status = await get_organize_status(client, "job-1", "user-a")
    assert (status["failed_items"], status["location_not_found_items"], status["organized_items"]) == (4, 1, 0)
    job = client.db["organize_jobs"][0]
    assert job["status"] == "succeeded"
    assert job["status_message"] == "No locations found"
    result_events = [e for e in client.db["organize_events"] if e["event_type"] == "result"]
    assert [e["message"] for e in result_events] == ["No locations found"]


@pytest.mark.asyncio
async def test_organized_job_still_reports_organized(monkeypatch):
    """The honest-message change must not relabel a job that DID produce places."""
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{"id": "item-1", "job_id": "job-1", "user_id": "user-a",
                                "saved_reel_id": "r1", "status": "queued"}],
        "saved_reels": [{"id": "r1", "user_id": "user-a",
                         "normalized_url": "https://www.instagram.com/reel/A",
                         "reel_cache_id": "cache-1", "analysis_status": "queued"}],
        "reel_cache": [{"id": "cache-1", "normalized_url": "https://www.instagram.com/reel/A"}],
    })
    monkeypatch.setattr("organizer.get_cached_places", _cached([_place()]))

    await run_organize_job(
        "job-1", "user-a", client=client,
        ground=_grounds_to_japan,
    )

    job = client.db["organize_jobs"][0]
    assert (job["status"], job["status_message"]) == ("succeeded", "Organized")


@pytest.mark.asyncio
async def test_extraction_cache_read_blip_is_a_miss_not_an_item_failure(monkeypatch):
    """A `reel_cache` SELECT blip must degrade to a MISS, exactly as the trip runner does
    (`pipeline/runner.py:208-211`), not fail the item.

    Deliberately runs the REAL `get_cached_places` — monkeypatching it would test the fake
    rather than the seam where the blip actually arrives. Only the SELECT faults; the
    write-through upsert still has to work, so a MISS can complete.
    """

    class _BlipTable(_Table):
        async def execute(self):
            if self.name == "reel_cache" and self.op == "select":
                raise RuntimeError("connection reset by peer")
            return await super().execute()

    class _BlipClient(_Client):
        def table(self, name): return _BlipTable(name, self.db)

    client = _BlipClient({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{"id": "item-1", "job_id": "job-1", "user_id": "user-a",
                                "saved_reel_id": "r1", "status": "queued"}],
        "saved_reels": [{"id": "r1", "user_id": "user-a",
                         "normalized_url": "https://www.instagram.com/reel/A",
                         "reel_cache_id": "cache-1", "analysis_status": "queued"}],
        "reel_cache": [{"id": "cache-1", "normalized_url": "https://www.instagram.com/reel/A",
                        "extractor_version": EXTRACTOR_VERSION, "extracted_places": []}],
    })
    scraped = []

    async def scrape(url):
        scraped.append(url)
        return SimpleNamespace(caption="c", location_name=None, transcript=None)

    async def reserve(*_args, **_kwargs): return "2026-07-20"
    monkeypatch.setattr("organizer.reserve_organize_item_analysis", reserve)

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=scrape,
        extract=_extracts_one_place,
        ground=_grounds_to_japan,
    )

    # The blip is a MISS: the item scraped fresh and completed, rather than failing.
    assert scraped == ["https://www.instagram.com/reel/A"]
    assert client.db["organize_job_items"][0]["status"] == "organized"
    assert client.db["organize_jobs"][0]["status"] == "succeeded"


# ---------------------------------------------------------------------------
# B5(d): organize-job errors map by SQLSTATE, never by message text.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("code,expected", [
    ("AS409", ActiveOrganizeConflict),
    ("AS404", PermissionError),
    ("AS422", InvalidOrganizeRequest),
])
async def test_organize_job_errors_map_by_sqlstate_through_a_reworded_message(code, expected):
    """The WHOLE point of (d): the message text is deliberately NOT the current wording.

    Matching on `exc.message` meant a copy-edit in the SQL — or Postgres surfacing the text
    differently — silently downgraded a 409 to a 500, and no test could see it because both
    sides shared one literal. Asserting against prose nobody would ever write is what proves
    the mapping no longer depends on prose at all.
    """
    class _RewordedRpcClient:
        def rpc(self, _name, _params):
            class _Raiser:
                async def execute(self):
                    raise _pg_error(code, "totally different wording, copy-edited later")
            return _Raiser()

    with pytest.raises(expected):
        await create_organize_job(_RewordedRpcClient(), "user-a", ["r1"])


@pytest.mark.asyncio
async def test_unmapped_organize_job_sqlstate_still_propagates():
    """P0001 is now "some other validation the RPC rejects" — it must NOT be silently
    absorbed into one of the three mapped outcomes."""
    class _UnmappedRpcClient:
        def rpc(self, _name, _params):
            class _Raiser:
                async def execute(self):
                    raise _pg_error("P0001", "Saved Reel is already being organized")
            return _Raiser()

    from postgrest.exceptions import APIError

    with pytest.raises(APIError):
        await create_organize_job(_UnmappedRpcClient(), "user-a", ["r1"])


# ---------------------------------------------------------------------------
# B5(e): dangling quota reservations are reconciled at recovery.
# ---------------------------------------------------------------------------


def _items_client(*items) -> "_Client":
    return _Client({"organize_jobs": [], "organize_job_items": list(items)})


@pytest.mark.asyncio
async def test_recovery_refunds_only_dangling_reserved_charges_on_terminal_items(monkeypatch):
    """A terminal item still holding `reserved` was charged a quota unit nobody released.

    It gets there when `refund_organize_item_analysis` ITSELF fails inside `_process_item`'s
    handler: the item goes terminal `failed`, the reservation stays, and nothing else in the
    system ever looks at it — the user loses that unit permanently, and re-organizing the
    same Reel charges again. Two provider faults are needed to reach it, which is why it is
    low-severity and not zero.

    The `status` filter is as load-bearing as the `analysis_charge_state` one: an item still
    `queued` or `processing` holds its reservation LEGITIMATELY — a live worker is mid-run and
    will consume or refund it. Refunding that one hands out free analyses.
    """
    refunded: list[tuple[str, str]] = []

    async def refund(_client, item_id, user_id):
        refunded.append((item_id, user_id))
        return True

    monkeypatch.setattr("organizer.refund_organize_item_analysis", refund)
    client = _items_client(
        {"id": "dangling", "user_id": "user-a", "status": "failed", "analysis_charge_state": "reserved"},
        {"id": "dangling-organized", "user_id": "user-a", "status": "organized", "analysis_charge_state": "reserved"},
        {"id": "dangling-nlf", "user_id": "user-b", "status": "location_not_found", "analysis_charge_state": "reserved"},
        {"id": "settled", "user_id": "user-a", "status": "organized", "analysis_charge_state": "consumed"},
        {"id": "free", "user_id": "user-a", "status": "failed", "analysis_charge_state": "not_charged"},
        {"id": "already", "user_id": "user-a", "status": "failed", "analysis_charge_state": "refunded"},
        {"id": "in-flight", "user_id": "user-a", "status": "processing", "analysis_charge_state": "reserved"},
        {"id": "queued", "user_id": "user-a", "status": "queued", "analysis_charge_state": "reserved"},
    )

    await recover_organize_jobs(client)

    assert refunded == [
        ("dangling", "user-a"),
        ("dangling-organized", "user-a"),
        ("dangling-nlf", "user-b"),
    ]


@pytest.mark.asyncio
async def test_a_failing_refund_does_not_stop_recovery_dispatching_pending_jobs(monkeypatch):
    """The sweep is janitorial; re-dispatch is guardrail #12. A blip in the former must never
    cost the latter — otherwise this fix trades a leaked quota unit for a dropped job."""
    async def refund(*_args, **_kwargs):
        raise RuntimeError("postgrest unavailable")

    monkeypatch.setattr("organizer.refund_organize_item_analysis", refund)
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending",
                           "created_at": datetime.now(timezone.utc).isoformat()}],
        "organize_job_items": [
            {"id": "dangling", "user_id": "user-a", "status": "failed",
             "analysis_charge_state": "reserved"},
        ],
    })

    pending = await recover_organize_jobs(client)

    assert [row["id"] for row in pending] == ["job-1"]

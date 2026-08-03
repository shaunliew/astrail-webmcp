import asyncio
import logging

import pytest

from models.enrichment import WeatherReport
from models.place import CanonicalPlace
from pipeline import persist
from pipeline.feasibility import group_places_by_day


def _cp(name, lat, lng, *, category="attraction", source_type="reel_extracted",
        aliases=None, name_local=None):
    return CanonicalPlace(
        name=name, name_local=name_local, category=category, source_type=source_type,
        lat=lat, lng=lng, confidence=0.9, evidence_quote=f"📍{name}",
        source_url="https://example.org/a", formatted_address=None,
        city_or_region_guess="Tokyo", aliases=aliases or [name],
        evidence_quotes=[f"📍{name}"], times_referenced=1,
    )


# --- pure mappers -----------------------------------------------------------
def test_place_type_maps_transport_to_station_and_unknown_to_other():
    assert persist._place_type("transport") == "station"
    assert persist._place_type("restaurant") == "restaurant"
    assert persist._place_type("Attraction") == "attraction"   # case-insensitive
    assert persist._place_type("station") == "station"          # already valid passes through
    assert persist._place_type("nonsense") == "other"


def test_source_summary_never_contains_blocked_keys():
    p = _cp("X", 1.0, 2.0)
    ss = persist._source_summary(p)
    assert isinstance(ss, dict)
    for blocked in ("caption", "transcript", "trip_id", "user_id", "raw_payload"):
        assert blocked not in ss


def test_group_places_by_day_is_identity_based_not_name_based():
    # Two DISTINCT places sharing the literal name "7-Eleven" but far apart still land in
    # groups keyed by object identity, not merged/confused by name.
    a = _cp("7-Eleven", 35.0, 139.0)
    b = _cp("7-Eleven", 35.06, 139.06)   # ~7.5km away
    groups = group_places_by_day([a, b], ["2026-08-01", "2026-08-02"])
    all_places = [p for _, group in groups for p in group]
    assert all_places.count(a) == 1 and all_places.count(b) == 1
    assert a is not b


# --- async fake client ------------------------------------------------------
class _Result:
    def __init__(self, data): self.data = data


class _Table:
    def __init__(self, name, db):
        self.name, self.db = name, db
        self._op = None; self._f = {}; self._range = {}; self._in = {}
        self._on_conflict = None; self._single = False; self._columns = None

    def insert(self, row): self._op = ("insert", row); return self
    def upsert(self, row, on_conflict=None):
        self._op = ("upsert", row); self._on_conflict = on_conflict; return self
    def update(self, row): self._op = ("update", row); return self
    def delete(self): self._op = ("delete", None); return self
    def select(self, *columns):
        # PostgREST returns ONLY the projected columns, and honouring that here is load-bearing
        # rather than cosmetic: a whole-row fake lets production omit a column from its
        # `.select(...)` and still read it in this file, so the read passes every test while the
        # real client leaves the key out and `row.get(col)` is `None` in production.
        cols = [c.strip() for spec in columns for c in str(spec).split(",") if c.strip()]
        self._op = ("select", None)
        self._columns = None if (not cols or "*" in cols) else cols
        return self

    def eq(self, c, v): self._f[c] = v; return self
    def gte(self, c, v): self._range[(c, "gte")] = v; return self
    def lte(self, c, v): self._range[(c, "lte")] = v; return self
    def in_(self, c, values): self._in[c] = list(values); return self
    def maybe_single(self): self._single = True; return self

    def _project(self, r):
        """The selected columns only. A selected key the stored row lacks comes back as `None`,
        which is how PostgREST reports a column that exists on the table and is NULL here."""
        if self._columns is None:
            return dict(r)
        return {c: r.get(c) for c in self._columns}

    def _match(self, r):
        if not all(r.get(k) == v for k, v in self._f.items()):
            return False
        if not all(r.get(k) in vs for k, vs in self._in.items()):
            return False
        for (c, op), v in self._range.items():
            if op == "gte" and not r.get(c, 0) >= v: return False
            if op == "lte" and not r.get(c, 0) <= v: return False
        return True

    async def execute(self):
        # SUSPEND, exactly once, like every real client call. Without this the fake is `async`
        # in name only: a coroutine runs start-to-finish before any sibling starts, so an
        # `asyncio.gather` over this fake never interleaves and every concurrency assertion in
        # this file is vacuous — a flat `gather` over same-coordinate places passes the
        # "verifier called once" test here while calling Mapbox twice in production, because
        # there the cache read awaits real I/O and both tasks miss.
        await asyncio.sleep(0)
        op, arg = self._op
        rows = self.db.setdefault(self.name, [])
        if op == "insert":
            row = {"id": f"{self.name}-{len(rows) + 1}", **arg}
            rows.append(row); return _Result([row])
        if op == "upsert":
            # `on_conflict` is REQUIRED, exactly as Postgres requires a matching unique index:
            # a fake falling back to plain-insert would let a caller who forgot it duplicate
            # rows here and fail only against the real database.
            keys = [k.strip() for k in (self._on_conflict or "").split(",") if k.strip()]
            if not keys:
                raise ValueError("fake upsert requires on_conflict")
            existing = next((r for r in rows if all(r.get(k) == arg.get(k) for k in keys)), None)
            if existing is not None:
                existing.update(arg); return _Result([existing])
            row = {"id": f"{self.name}-{len(rows) + 1}", **arg}
            rows.append(row); return _Result([row])
        if op == "update":
            matched = [r for r in rows if self._match(r)]
            for r in matched:
                r.update(arg)
            return _Result(matched)
        if op == "delete":
            keep = [r for r in rows if not self._match(r)]
            self.db[self.name] = keep; return _Result([])
        matched = [self._project(r) for r in rows if self._match(r)]
        # `.maybe_single()` yields the ROW (not a list), and `None` on zero rows — the shape
        # `grounding._lookup_cached_country` reads. Without it that call raised AttributeError,
        # which its blanket `except` logged as a cache MISS, so the whole write-through cache
        # was invisible to this file's fakes.
        if self._single:
            return _Result(matched[0] if matched else None)
        return _Result(matched)


class _ReplaceTripItineraryRpc:
    """Mirror of `public.replace_trip_itinerary` (20260720150000).

    The fence and the delete-reinsert are ONE unit here for the same reason they are one
    transaction there: a superseded worker must destroy neither the replacement's trip_places
    nor its trip_days. A fake that ignored the lease would leave `_replace_trip_rows`'s
    `LeaseLost` branch dead under test. The predicate mirrors the SQL exactly, `trip_id`
    included: a lease on job X may only rewrite job X's own trip.
    """

    def __init__(self, client, params): self.client, self.params = client, params

    async def execute(self):
        p, db = self.params, self.client.db
        job = next((r for r in db.get("jobs", [])
                    if r.get("id") == p["p_job_id"] and r.get("trip_id") == p["p_trip_id"]
                    and r.get("lease_token") == p["p_lease_token"]
                    and r.get("status") == "running"), None)
        if job is None:
            return _Result(False)
        trip_id = p["p_trip_id"]
        for table in ("trip_places", "trip_days"):
            db[table] = [r for r in db.setdefault(table, []) if r.get("trip_id") != trip_id]
        for table, key in (("trip_places", "p_places"), ("trip_days", "p_days")):
            rows = db.setdefault(table, [])
            for row in p.get(key) or []:
                rows.append({"id": f"{table}-{len(rows) + 1}", "trip_id": trip_id, **row})
        return _Result(True)


class _Client:
    def __init__(self, db=None): self.db = db if db is not None else {}
    def table(self, name): return _Table(name, self.db)

    def rpc(self, name, params):
        if name == "replace_trip_itinerary":
            return _ReplaceTripItineraryRpc(self, params)
        raise AssertionError(f"fake does not implement rpc {name!r}")


@pytest.mark.asyncio
async def test_the_fake_select_returns_only_the_projected_columns():
    """The fake's PROJECTION contract, pinned directly — every dedup test below rests on it.

    A fake that returns whole rows lets production forget a column in its `.select(...)` and
    still read it here, so the read looks correct in this file while PostgREST omits the key in
    production and every `row.get(col)` comes back `None`. That is not a hypothetical: the
    country-conflict gate below is exactly a `row.get("country_code")` read, and with a
    whole-row fake it would ship green and never fire against the real database.
    """
    c = _Client({"places": [{"id": "p1", "country_code": "SG"}]})

    rows = (await c.table("places").select("id").execute()).data

    assert rows == [{"id": "p1"}]


@pytest.mark.asyncio
async def test_persist_writes_places_trip_places_and_days():
    c = _Client()
    canonical = [_cp("Tokyo Tower", 35.6586, 139.7454),
                 _cp("Senso-ji", 35.7148, 139.7967)]
    dropped = await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"],
                                                job_id=None, lease_token=None)

    assert dropped == 0
    assert len(c.db["places"]) == 2
    tps = c.db["trip_places"]
    assert len(tps) == 2
    assert {tp["source_type"] for tp in tps} == {"reel_extracted"}
    assert all(tp["trip_id"] == "trip-1" and tp["place_id"] for tp in tps)
    assert {tp["day_number"] for tp in tps} == {1}
    assert {tp["sort_order"] for tp in tps} == {0, 1}
    assert len(c.db["trip_days"]) == 1 and c.db["trip_days"][0]["day_number"] == 1


@pytest.mark.asyncio
async def test_persist_writes_the_local_name_on_a_new_place():
    """The trip pipeline inserts into `places` directly, so it is a SECOND write path.

    `grounding._persist_place` goes through `find_or_create_place`, which gained `name_local` in
    20260720190000 — but `persist_itinerary` never did, and a column only one of two writers
    fills is a column you cannot trust. `_place_matches` right above already READS `name_local`
    for alias dedup, so a trip-created row that dropped it stayed unmatched by the very name the
    next reel would caption it with.
    """
    c = _Client()
    canonical = [_cp("Tokyo Tower", 35.6586, 139.7454, name_local="東京タワー"),
                 _cp("Senso-ji", 35.7148, 139.7967)]

    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"],
                                    job_id=None, lease_token=None)

    rows = {p["name"]: p for p in c.db["places"]}
    assert rows["Tokyo Tower"]["name_local"] == "東京タワー"
    # Present-and-null, not absent: a caption with no local-script name is the common case and
    # null is the honest answer (guardrail #1 — never inferred or transliterated).
    assert rows["Senso-ji"]["name_local"] is None


@pytest.mark.asyncio
async def test_persist_drops_no_coord_places():
    c = _Client()
    canonical = [_cp("Has Coords", 35.0, 139.0), _cp("No Coords", None, None)]
    dropped = await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"],
                                                job_id=None, lease_token=None)
    assert dropped == 1
    assert len(c.db["places"]) == 1 and c.db["places"][0]["name"] == "Has Coords"
    assert len(c.db["trip_places"]) == 1


@pytest.mark.asyncio
async def test_dedup_on_write_reuses_existing_nearby_place():
    # A pre-existing global place ~10m away with the same name → reused, not re-inserted.
    c = _Client({"places": [{"id": "existing-1", "name": "Tokyo Tower",
                             "aliases": ["Tokyo Tower"], "lat": 35.6586, "lng": 139.7454}]})
    canonical = [_cp("Tokyo Tower", 35.65861, 139.74541)]  # ~1m away
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"],
                                                job_id=None, lease_token=None)
    assert len(c.db["places"]) == 1  # NOT a new row — flywheel reuse
    assert c.db["trip_places"][0]["place_id"] == "existing-1"


@pytest.mark.asyncio
async def test_two_canonical_resolving_to_same_place_link_once():
    # Both canonical places match the SAME existing global place (name/alias overlap + <500m) →
    # exactly ONE trip_places row (guards trip_places UNIQUE(trip_id, place_id)).
    c = _Client({"places": [{"id": "existing-1", "name": "Tokyo Tower",
                             "aliases": ["Tokyo Tower", "東京タワー"],
                             "lat": 35.6586, "lng": 139.7454}]})
    canonical = [_cp("Tokyo Tower", 35.65861, 139.74541),
                 _cp("東京タワー", 35.65859, 139.74539, name_local="東京タワー",
                     aliases=["東京タワー"])]
    dropped = await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"],
                                                job_id=None, lease_token=None)
    assert dropped == 1  # the second canonical place resolved to the SAME place_id, skipped
    assert len(c.db.get("places", [])) == 1
    assert len(c.db["trip_places"]) == 1  # both resolved to existing-1 → linked once, no UNIQUE crash


@pytest.mark.asyncio
async def test_persist_is_retry_safe_deletes_prior_rows():
    c = _Client()
    canonical = [_cp("Tokyo Tower", 35.6586, 139.7454)]
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"],
                                                job_id=None, lease_token=None)
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"],
                                                job_id=None, lease_token=None)  # retry
    assert len(c.db["trip_places"]) == 1   # not doubled
    assert len(c.db["trip_days"]) == 1
    assert len(c.db["places"]) == 1        # dedup reused the place from attempt 1


@pytest.mark.asyncio
async def test_persist_assigns_distinct_days_by_identity_not_name():
    # Two DISTINCT canonical places sharing the literal name "7-Eleven", ~6km apart, over a
    # 2-day span. Name-based day assignment (the old `_day_lookup`) would collapse both onto
    # whichever day the FIRST "7-Eleven" occupied in the itinerary's place_names list — a
    # silently-wrong result. Identity-based assignment (`group_places_by_day`) must place them
    # on their own geo-chain days.
    c = _Client()
    near = _cp("7-Eleven", 35.6586, 139.7454)
    far = _cp("7-Eleven", 35.70, 139.80)   # ~6km away
    canonical = [near, far]
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01", "2026-08-02"],
                                     job_id=None, lease_token=None)

    tps = c.db["trip_places"]
    assert len(tps) == 2
    assert len({tp["day_number"] for tp in tps}) == 2   # DIFFERENT days, not both on day 1


# --- country grounding on the web pipeline ----------------------------------
# `places.country` is a VERIFICATION RECEIPT, not a label: non-NULL means a coordinate was
# reverse-geocoded AND the answer agreed with an independent LLM claim. The organize path has
# always upheld that (`grounding._ground_place`); `persist_itinerary` dropped the value at the
# insert, so 87% of `places` rows were NULL. These tests pin the guarantee on this second path
# — including that an UNVERIFIABLE place still gets NULL, which is what stops the column from
# quietly becoming "whatever the LLM said".
from models.geocode import CountryResult

_JP = (35.6586, 139.7454)
_SG = (1.2834, 103.8607)
# `_cp`'s default `https://example.org/a` is in `_FAKE_DOMAINS`, so `is_placeholder_url` is
# True and `_ground_place` returns None BEFORE any network call. A grounding test built on it
# passes without executing one line of the change; these tests need a real-looking URL.
_REAL_URL = "https://www.instagram.com/reel/ABC/"
_PLACEHOLDER_URL = "https://example.org/a"


def _gp(name, lat, lng, *, country_code="JP", country_name="Japan", source_url=_REAL_URL):
    """A groundable CanonicalPlace — real-looking source_url + an LLM country claim.

    Built directly rather than from `_cp` so the `country_code`/`country_name` pair validator
    runs on every case in the tables below.
    """
    return CanonicalPlace(
        name=name, name_local=None, category="attraction", source_type="reel_extracted",
        lat=lat, lng=lng, confidence=0.9, evidence_quote=f"📍{name}",
        source_url=source_url, formatted_address=None, city_or_region_guess="Tokyo",
        aliases=[name], evidence_quotes=[f"📍{name}"], times_referenced=1,
        country_code=country_code, country_name=country_name,
    )


class _Verifier:
    """A `verify_country` stub that COUNTS provider calls.

    Every same-coordinate assertion below is an assertion about `.calls`: it is what separates
    "each member asked the cache" from "each member asked Mapbox", and what reddens a flat
    `gather` that defeats the write-through cache.
    """

    def __init__(self, country=CountryResult(country_code="JP", country_name="Japan"),
                 *, by_coord=None):
        self.country, self.by_coord = country, by_coord
        self.calls, self.coords = 0, []

    async def __call__(self, lat, lng, *, token):
        self.calls += 1
        self.coords.append((lat, lng))
        return self.by_coord[(lat, lng)] if self.by_coord is not None else self.country


class _FailingVerifier(_Verifier):
    """Mapbox is down for every call (guardrail #3: the trip must still save)."""

    async def __call__(self, lat, lng, *, token):
        self.calls += 1
        raise RuntimeError("Mapbox reverse-country error: ConnectError")


class _FailsOnceVerifier(_Verifier):
    """Raises on the FIRST call only — one transient blip must null one place, not a group."""

    async def __call__(self, lat, lng, *, token):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("Mapbox reverse-country error: ReadTimeout")
        return self.country


class _FaultTable(_Table):
    """Raise on one operation against one table; behave normally otherwise."""

    def __init__(self, name, db, failing_ops):
        super().__init__(name, db)
        self._failing_ops = failing_ops

    async def execute(self):
        if self._op[0] in self._failing_ops:
            raise RuntimeError(f"supabase {self._op[0]} failed")
        return await super().execute()


class _CacheWriteFailsClient(_Client):
    """`geocode_country_cache` reads fine and writes fail — separating a verification failure
    from a cache-write failure, which `_store_cached_country` raises on BY DESIGN."""

    def table(self, name):
        if name == "geocode_country_cache":
            return _FaultTable(name, self.db, {"upsert"})
        return super().table(name)


def _country_of(c, name):
    """(country, country_code, country_name) of the persisted `places` row — all three, because
    all three must move together.

    Only the code/name PAIR is a database constraint (`places_country_fields_pair_check`,
    20260718130000, is `(country_code is null) = (country_name is null)`); `country` is
    unconstrained and the database would happily accept it filled while the other two are NULL.
    Keeping it in step is an APPLICATION-layer invariant, so reading all three here is what
    holds it — nothing below the code does.
    """
    row = next(p for p in c.db["places"] if p["name"] == name)
    return (row.get("country"), row.get("country_code"), row.get("country_name"))


_VERIFIED = ("Japan", "JP", "Japan")
_NULL = (None, None, None)


@pytest.mark.parametrize("claim_code,claim_name,source_url,verifier_cls,expected,calls", [
    # `country` carries the country NAME, matching find_or_create_place's `p_country` — one
    # column must never hold "JP" for some rows and "Japan" for others (PlaceIntelPanel joins it).
    pytest.param("JP", "Japan", _REAL_URL, _Verifier, _VERIFIED, 1, id="verified"),
    # The guard this whole change exists to keep: a claim the geocoder contradicts stays NULL
    # rather than becoming a filled-in guess (guardrail #1).
    pytest.param("US", "United States", _REAL_URL, _Verifier, _NULL, 1, id="mismatch"),
    pytest.param(None, None, _REAL_URL, _Verifier, _NULL, 0, id="no_claim"),
    pytest.param("JP", "Japan", _PLACEHOLDER_URL, _Verifier, _NULL, 0, id="placeholder_url"),
    pytest.param("JP", "Japan", _REAL_URL, _FailingVerifier, _NULL, 1, id="provider_raises"),
])
@pytest.mark.asyncio
async def test_persist_grounds_one_place(monkeypatch, claim_code, claim_name, source_url,
                                         verifier_cls, expected, calls):
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client()
    verifier = verifier_cls()
    place = _gp("Tokyo Tower", *_JP, country_code=claim_code, country_name=claim_name,
                source_url=source_url)

    dropped = await persist.persist_itinerary(c, "trip-1", [place], ["2026-08-01"],
                                              job_id=None, lease_token=None,
                                              verify_country=verifier)

    assert _country_of(c, "Tokyo Tower") == expected
    assert verifier.calls == calls
    # Guardrail #3 in every row of this table: grounding never drops a place or fails the trip.
    assert dropped == 0 and len(c.db["trip_places"]) == 1


@pytest.mark.asyncio
async def test_persist_writes_the_verified_country_name_not_the_llm_claim(monkeypatch):
    """Provenance, not presence. `_ground_place` overwrites the claimed name with Mapbox's
    (`model_copy(update={"country_name": ...})`), so a JP/Japan -> JP/Japan test cannot tell a
    correct implementation from one that uses grounding as a boolean gate and then inserts the
    LLM's own name. Poison the claim's NAME and the two diverge: without this, `Tokyo, United
    States` ships and every other assertion here is still green."""
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client()
    poisoned = _gp("Tokyo Tower", *_JP, country_code="JP", country_name="United States")

    await persist.persist_itinerary(c, "trip-1", [poisoned], ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=_Verifier())

    assert _country_of(c, "Tokyo Tower") == _VERIFIED


@pytest.mark.asyncio
async def test_persist_cache_write_failure_yields_null_country(monkeypatch):
    """A verified answer we could not PERSIST is discarded (guardrail #7, strict write-through
    — `_store_cached_country` raises by design). NULL is the honest degradation; the tempting
    alternative (use the country, skip the cache) is deliberately not what happens."""
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _CacheWriteFailsClient()
    verifier = _Verifier()

    await persist.persist_itinerary(c, "trip-1", [_gp("Tokyo Tower", *_JP)], ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)

    assert verifier.calls == 1          # the provider DID answer — this is the write side failing
    assert _country_of(c, "Tokyo Tower") == _NULL
    assert len(c.db["trip_places"]) == 1


@pytest.mark.asyncio
async def test_persist_same_coordinate_calls_the_verifier_once(monkeypatch):
    """Guardrail #7's read side, and the reason grounding is parallel ACROSS coordinates but
    sequential WITHIN one: fire two same-coordinate places concurrently and both observe a
    cache miss before either upsert lands, so both pay Mapbox. The first member seeds the
    cache; the second hits it."""
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client()
    verifier = _Verifier()
    places = [_gp("Tower A", *_JP), _gp("Tower B", *_JP)]

    await persist.persist_itinerary(c, "trip-1", places, ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)

    assert verifier.calls == 1
    assert _country_of(c, "Tower A") == _VERIFIED
    assert _country_of(c, "Tower B") == _VERIFIED


@pytest.mark.parametrize("claims,expected", [
    pytest.param([("US", "United States"), ("JP", "Japan")], [_NULL, _VERIFIED], id="a1_us_then_jp"),
    pytest.param([("JP", "Japan"), ("US", "United States")], [_VERIFIED, _NULL], id="a2_jp_then_us"),
    pytest.param([("JP", "Japan"), ("US", "United States"), ("JP", "Japan")],
                 [_VERIFIED, _NULL, _VERIFIED], id="a3_alternating"),
])
@pytest.mark.asyncio
async def test_persist_same_coordinate_compares_each_claim_independently(monkeypatch, claims,
                                                                         expected):
    """One cached provider answer, one comparison PER MEMBER — the pairing no wrong
    implementation reaches. A flat `gather` calls the verifier twice; copying the first
    member's verdict onto the group writes `Japan` onto a place claiming `US` (a2); copying it
    only when it succeeded survives a1 and dies on a2; a cacheless implementation fails the
    call count. Both claim orders are required, and a3's alternating third member forces a
    per-member loop rather than any first-vs-rest special case."""
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client()
    verifier = _Verifier()
    names = [f"Tower {i}" for i in range(len(claims))]
    places = [_gp(name, *_JP, country_code=code, country_name=cname)
              for name, (code, cname) in zip(names, claims)]

    await persist.persist_itinerary(c, "trip-1", places, ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)

    assert [_country_of(c, name) for name in names] == expected
    assert verifier.calls == 1


@pytest.mark.asyncio
async def test_persist_same_coordinate_isolates_a_failing_first_member(monkeypatch):
    """The `except` sits INSIDE the per-member loop, not around the coordinate group —
    otherwise one transient blip silently nulls every place sharing that coordinate. Nothing
    was cached by the failed call, so the second member pays its own (successful) call."""
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client()
    verifier = _FailsOnceVerifier()
    places = [_gp("Tower A", *_JP), _gp("Tower B", *_JP)]

    await persist.persist_itinerary(c, "trip-1", places, ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)

    assert _country_of(c, "Tower A") == _NULL
    assert _country_of(c, "Tower B") == _VERIFIED
    assert verifier.calls == 2
    assert len(c.db["trip_places"]) == 2


@pytest.mark.parametrize("urls,expected", [
    pytest.param([_REAL_URL, _PLACEHOLDER_URL, _REAL_URL], [_VERIFIED, _NULL, _VERIFIED],
                 id="d1_ineligible_middle"),
    pytest.param([_PLACEHOLDER_URL, _REAL_URL, _PLACEHOLDER_URL], [_NULL, _VERIFIED, _NULL],
                 id="d2_ineligible_first"),
])
@pytest.mark.asyncio
async def test_persist_same_coordinate_applies_each_members_gates(monkeypatch, urls, expected):
    """Same coordinate, SAME claim, mixed eligibility — the only case that makes each member's
    ELIGIBILITY GATES load-bearing rather than only its country comparison. An implementation
    that memoizes by claim passes every other test here and fails these: it labels the
    placeholder-URL member `Japan` from its sibling's verdict, because it never calls
    `_ground_place` for that member at all. d2 puts an ineligible member first, so no
    "first member is special" shortcut survives either."""
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client()
    verifier = _Verifier()
    names = [f"Tower {i}" for i in range(len(urls))]
    places = [_gp(name, *_JP, source_url=url) for name, url in zip(names, urls)]

    await persist.persist_itinerary(c, "trip-1", places, ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)

    assert [_country_of(c, name) for name in names] == expected
    assert verifier.calls == 1


@pytest.mark.asyncio
async def test_persist_grounds_distinct_coordinates_independently(monkeypatch):
    """Two coordinate groups, two countries — the simple case. Every other test here has a
    single group, so a bug that merged the groups or lost one would go unseen.

    It does NOT pin the id-keyed result mapping, though it reads like it should: one place per
    group makes canonical order and flatten order identical, so positional pairing passes this
    unharmed. `test_persist_pairs_grounding_results_by_identity_not_position` below is what
    actually pins that.
    """
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client()
    verifier = _Verifier(by_coord={
        _JP: CountryResult(country_code="JP", country_name="Japan"),
        _SG: CountryResult(country_code="SG", country_name="Singapore"),
    })
    places = [_gp("Tokyo Tower", *_JP),
              _gp("Marina Bay", *_SG, country_code="SG", country_name="Singapore")]

    await persist.persist_itinerary(c, "trip-1", places, ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)

    assert _country_of(c, "Tokyo Tower") == _VERIFIED
    assert _country_of(c, "Marina Bay") == ("Singapore", "SG", "Singapore")
    assert verifier.calls == 2


@pytest.mark.asyncio
async def test_persist_pairs_grounding_results_by_identity_not_position(monkeypatch):
    """Canonical order and group-flatten order DELIBERATELY differ — the only shape in this file
    that makes `_ground_all`'s `id(place)` keying load-bearing.

    `_ground_all` groups by coordinate, so results come back in GROUP order — JP=[Tokyo Tower,
    Senso-ji], SG=[Marina Bay], flattened to (Tokyo Tower, Senso-ji, Marina Bay) — while
    `canonical` is (Tokyo Tower, Marina Bay, Senso-ji). Every other grounding test here has one
    group, or one place per group, which makes the two orders identical and lets positional
    pairing (`zip(canonical, flattened)`) pass unnoticed.

    It does not pass here. Positionally, Marina Bay inherits Senso-ji's rejection and — worse —
    Senso-ji inherits `Singapore`, though its coordinate is in Tokyo and its own claim is the
    United States: an unverified country written into the receipt column, which is the single
    thing this change exists to prevent (guardrail #1).
    """
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client()
    verifier = _Verifier(by_coord={
        _JP: CountryResult(country_code="JP", country_name="Japan"),
        _SG: CountryResult(country_code="SG", country_name="Singapore"),
    })
    places = [
        _gp("Tokyo Tower", *_JP),                                                # JP coord, agrees
        _gp("Marina Bay", *_SG, country_code="SG", country_name="Singapore"),    # SG coord, agrees
        # JP coordinate, US claim: the geocoder contradicts it, so its only correct value is NULL.
        _gp("Senso-ji", *_JP, country_code="US", country_name="United States"),
    ]

    await persist.persist_itinerary(c, "trip-1", places, ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)

    assert _country_of(c, "Tokyo Tower") == _VERIFIED
    assert _country_of(c, "Marina Bay") == ("Singapore", "SG", "Singapore")
    assert _country_of(c, "Senso-ji") == _NULL
    # Two coordinates, two provider calls — Senso-ji shares Tokyo Tower's coordinate and hits
    # the cache that member seeded, so a third call would mean the group loop stopped sharing.
    assert verifier.calls == 2


# Long enough that two coroutines entering the same function cannot miss each other on a loaded
# machine; short enough that the sequential FAILURE mode is a red assertion seconds later. Only
# a failing run ever waits this out — a correct one trips the barrier immediately.
_RENDEZVOUS_TIMEOUT_S = 2.0


class _RendezvousVerifier(_Verifier):
    """Answers only once BOTH coordinates are in flight — an executable proof of parallelism.

    A verifier that merely counts calls cannot tell `asyncio.gather` from a sequential loop:
    the calls, the rows and the log line are identical either way. Meeting at a barrier can.

    The `asyncio.timeout` is what keeps the sequential case a TEST FAILURE rather than a hung
    suite: each lone waiter is cancelled into a `TimeoutError`, which `_safe_ground` absorbs as
    a grounding failure, so the countries land NULL and the assertions redden. A cancelled
    waiter breaks the barrier, but `Barrier` resets itself to FILLING once the last waiter
    leaves, so the cost is one timeout PER COORDINATE — measured at ~4s for the two below, and
    paid only by a run that is already failing.
    """

    def __init__(self, *args, parties=2, **kwargs):
        super().__init__(*args, **kwargs)
        self._barrier = asyncio.Barrier(parties)

    async def __call__(self, lat, lng, *, token):
        async with asyncio.timeout(_RENDEZVOUS_TIMEOUT_S):
            await self._barrier.wait()
        return await super().__call__(lat, lng, token=token)


@pytest.mark.asyncio
async def test_persist_grounds_distinct_coordinates_in_parallel(monkeypatch):
    """`_ground_all`'s OUTER `asyncio.gather`, pinned by a rendezvous instead of a stopwatch.

    Nothing else in this file distinguishes it from `for group in by_coord.values(): await
    _ground_group(...)` — same rows, same call counts, same aggregate log — so a later
    "simplification" back to a loop would land green while turning a trip's eight
    distinct-coordinate Mapbox timeouts from ~30s of wall clock into ~240s, on the critical
    path of every save.

    Neither verifier call may return until both have entered. Under the gather both coordinates
    are in flight at once, the barrier trips, and both countries land. Sequentially the first
    call waits for a partner that cannot start until it returns, and the resulting NULLs redden
    the assertions below.
    """
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client()
    verifier = _RendezvousVerifier(by_coord={
        _JP: CountryResult(country_code="JP", country_name="Japan"),
        _SG: CountryResult(country_code="SG", country_name="Singapore"),
    })
    places = [_gp("Tokyo Tower", *_JP),
              _gp("Marina Bay", *_SG, country_code="SG", country_name="Singapore")]

    await persist.persist_itinerary(c, "trip-1", places, ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)

    assert _country_of(c, "Tokyo Tower") == _VERIFIED
    assert _country_of(c, "Marina Bay") == ("Singapore", "SG", "Singapore")
    assert verifier.calls == 2


_OSAKA = (34.6937, 135.5023)
_KYOTO = (35.0116, 135.7681)


class _VerifierRaisingAt(_Verifier):
    """Answers per coordinate, EXCEPT one that raises — the only way to put a `failed` place
    and a `mismatched` place in the same trip, which is the pairing the log line exists for."""

    def __init__(self, *args, raise_at, **kwargs):
        super().__init__(*args, **kwargs)
        self.raise_at = raise_at

    async def __call__(self, lat, lng, *, token):
        if (lat, lng) == self.raise_at:
            self.calls += 1
            raise RuntimeError("Mapbox reverse-country error: ConnectError")
        return await super().__call__(lat, lng, token=token)


def _four_outcome_trip():
    """One place per grounding outcome, on four distinct coordinates (so no member's cached
    answer decides another's), plus the verifier that produces them."""
    places = [
        _gp("Grounded", *_JP),
        # Ineligible: `_ground_place` returns None at its gate, before any provider call.
        _gp("Ineligible", *_SG, country_code="SG", country_name="Singapore",
            source_url=_PLACEHOLDER_URL),
        # Mismatched: eligible, verified, and the geocoder CONTRADICTS the claim.
        _gp("Mismatched", *_OSAKA, country_code="US", country_name="United States"),
        _gp("Failed", *_KYOTO),
    ]
    verifier = _VerifierRaisingAt(raise_at=_KYOTO, by_coord={
        _JP: CountryResult(country_code="JP", country_name="Japan"),
        _OSAKA: CountryResult(country_code="JP", country_name="Japan"),
    })
    return places, verifier


def _grounding_lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records
            if r.getMessage().startswith("trip_place_grounding")]


@pytest.mark.asyncio
async def test_persist_logs_one_grounding_line_counting_all_four_outcomes(monkeypatch, caplog):
    """The counters, on a trip that produces every outcome at once.

    `failed` and `mismatched` are the pair this line exists to separate, and they are
    INDISTINGUISHABLE in the database: both persist `country` NULL, so the rows cannot say
    whether eight places disagreed with their coordinates (working as designed) or eight
    HTTPStatusErrors came back from a revoked credential (an outage). Asserted here as one
    exact line, which also pins "ONE aggregate line per trip" — a per-place log would bury the
    aggregate under fifty lines at INFO.
    """
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    caplog.set_level(logging.INFO, logger="pipeline.persist")
    c = _Client()
    places, verifier = _four_outcome_trip()

    dropped = await persist.persist_itinerary(c, "trip-1", places, ["2026-08-01"],
                                              job_id=None, lease_token=None,
                                              verify_country=verifier)

    assert _grounding_lines(caplog) == [
        "trip_place_grounding grounded=1 ineligible=1 mismatched=1 failed=1 "
        "failure_types=RuntimeError"]
    # The rows the counters describe: three NULLs that no query could tell apart.
    assert _country_of(c, "Grounded") == _VERIFIED
    assert [_country_of(c, n) for n in ("Ineligible", "Mismatched", "Failed")] == [_NULL] * 3
    # Guardrail #3: counting is observation, not control flow — every place still persists.
    assert dropped == 0 and len(c.db["trip_places"]) == 4


@pytest.mark.parametrize("mirror,counts", [
    pytest.param(True, "grounded=1 ineligible=0 mismatched=2 failed=1", id="always_eligible"),
    pytest.param(False, "grounded=1 ineligible=2 mismatched=0 failed=1", id="never_eligible"),
])
@pytest.mark.asyncio
async def test_the_grounding_log_classification_never_changes_a_persisted_value(monkeypatch,
                                                                                caplog,
                                                                                mirror, counts):
    """`_is_eligible_for_grounding` is a MIRROR of `_ground_place`'s gate, for the log only.

    Two mirrors of one rule drift, and the drift has an obvious wrong repair: wire the cheap
    local mirror into the persist path so the two can never disagree. That hands a logging
    predicate the decision of which places get a country — guardrail #1 inverted, since the
    mirror knows only that a claim EXISTS, never that a geocoder agreed with it.

    So the mirror is falsified outright, in BOTH directions, and the persisted rows must not
    move by one value while the counters — all it may touch — do. Both directions are required:
    always-True catches a mirror that gates a write ON (an ineligible place handed a country),
    always-False catches one that gates a write OFF (the verified place losing its own).
    """
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    caplog.set_level(logging.INFO, logger="pipeline.persist")
    monkeypatch.setattr(persist, "_is_eligible_for_grounding", lambda _place: mirror)
    c = _Client()
    places, verifier = _four_outcome_trip()

    await persist.persist_itinerary(c, "trip-1", places, ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)

    assert _country_of(c, "Grounded") == _VERIFIED
    assert [_country_of(c, n) for n in ("Ineligible", "Mismatched", "Failed")] == [_NULL] * 3
    assert len(c.db["trip_places"]) == 4
    assert _grounding_lines(caplog) == [
        f"trip_place_grounding {counts} failure_types=RuntimeError"]


@pytest.mark.asyncio
async def test_persist_grounds_by_default_with_no_injected_verifier(monkeypatch):
    """THE LIVE SEAM. Every other test here injects a verifier; the only production caller
    (`runner.py`) injects none. An implementation that grounds only when the parameter is
    supplied passes all sixteen other outcomes and is a total no-op in production — the change
    ships, the suite is green, and every row still writes NULL.

    `verify_country` is dependency substitution for tests, NEVER a feature switch: this drives
    the default path, with a durable job_id/lease_token so it mirrors the live fenced call.
    Monkeypatching the module attribute works because `_ground_place` imports `reverse_country`
    INSIDE the function, so the name resolves at call time."""
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    calls = []

    async def fake_reverse(lat, lng, *, token):
        calls.append((lat, lng))
        return CountryResult(country_code="JP", country_name="Japan")

    monkeypatch.setattr("geocode.mapbox_reverse.reverse_country", fake_reverse)
    c = _Client({"jobs": [{"id": "job-1", "trip_id": "trip-1", "lease_token": "tok-1",
                           "status": "running"}]})

    await persist.persist_itinerary(c, "trip-1", [_gp("Tokyo Tower", *_JP)], ["2026-08-01"],
                                    job_id="job-1", lease_token="tok-1")

    assert calls == [_JP]
    assert _country_of(c, "Tokyo Tower") == _VERIFIED
    assert len(c.db["trip_places"]) == 1


@pytest.mark.asyncio
async def test_persist_writes_null_country_without_a_mapbox_token(monkeypatch):
    """The credential-free offline suite IS the production degradation path: no token ->
    `_ground_place` raises on line 1 -> absorbed -> NULL, which is exactly today's behaviour
    and why the pre-existing tests in this file stay green. Deleted explicitly rather than
    assumed unset — a developer shell carrying the real token would otherwise call Mapbox."""
    monkeypatch.delenv("MAPBOX_SECRET_TOKEN", raising=False)
    c = _Client()

    await persist.persist_itinerary(c, "trip-1", [_gp("Tokyo Tower", *_JP)], ["2026-08-01"],
                                    job_id=None, lease_token=None)

    assert _country_of(c, "Tokyo Tower") == _NULL
    assert len(c.db["trip_places"]) == 1


# --- R1: never REUSE a places row whose country contradicts the verified one ------------------
# The dedup gate is name/alias + haversine < 500m with no country term, so an incoming Malaysian
# venue matching a Singapore row 400m away is linked to the Singapore row: the trip renders the
# wrong country and the wrong canonical pin. Suppressing the country WRITE on such a row is not
# a fix — it still returns that row's id. R1 rejects the candidate and falls through.
#
# It applies ONLY when we hold a verified country. With `grounded is None` (no claim, placeholder
# URL, provider outage) dedup stays country-agnostic first-match, or a Mapbox outage would start
# forking the `places` corpus.
_VENUE = "Kopi Corner"
_JB = (1.4655, 103.7578)            # Johor Bahru (MY) — the incoming place's coordinate
_JB_NEAR = (1.46575, 103.7578)      # ~28m from _JB: inside the 500m gate, so only country decides
_JB_NEAR2 = (1.4655, 103.75805)     # ~28m from _JB on the other axis — a second passing candidate
_JP_NEAR = (35.65885, 139.7454)     # ~28m from _JP
_JP_NEAR2 = (35.6586, 139.74571)    # ~28m from _JP
_MY_RESULT = CountryResult(country_code="MY", country_name="Malaysia")
_COUNTRY_LABELS = {"MY": "Malaysia", "SG": "Singapore", "JP": "Japan"}


def _place_row(row_id, coord, *, country_code, labels=None, name=_VENUE):
    """One pre-existing global `places` row, in the shape the candidate query reads.

    `labels` overrides the human-readable `country`/`country_name` independently of the code.
    That combination is legal in the database — `places_country_fields_pair_check` pairs only
    `country_code` and `country_name`, and `country` is unconstrained — so a legacy row really
    can carry a correct code beside a wrong name, which is what case 3 below leans on.
    """
    label = labels if labels is not None else _COUNTRY_LABELS.get(country_code)
    return {"id": row_id, "name": name, "aliases": [name],
            "lat": coord[0], "lng": coord[1],
            "country": label, "country_code": country_code, "country_name": label}


def _row_by_id(c, row_id):
    """These fixtures deliberately share ONE name across rows (that is the whole collision), so
    they cannot be read back with `_country_of`'s name lookup."""
    return next(p for p in c.db["places"] if p["id"] == row_id)


def _country_triple(row):
    return (row.get("country"), row.get("country_code"), row.get("country_name"))


async def _link_one(c, place, verifier):
    """Persist ONE place and return the global place_id its trip_places row points at."""
    await persist.persist_itinerary(c, "trip-1", [place], ["2026-08-01"],
                                    job_id=None, lease_token=None, verify_country=verifier)
    return c.db["trip_places"][0]["place_id"]


@pytest.mark.asyncio
async def test_persist_rejects_a_candidate_whose_verified_country_conflicts(monkeypatch):
    """The bug itself: the ONLY nearby same-name row is in the wrong country.

    Asserting a new id — not merely that the Singapore row kept its own country — is what kills
    the first draft of this fix, which suppressed the country write and went on returning that
    row's id. Not overwriting a wrong answer is not the same as not using it.
    """
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client({"places": [_place_row("sg-row", _JB_NEAR, country_code="SG")]})
    place = _gp(_VENUE, *_JB, country_code="MY", country_name="Malaysia")

    place_id = await _link_one(c, place, _Verifier(_MY_RESULT))

    assert place_id != "sg-row"
    assert len(c.db["places"]) == 2
    assert _country_triple(_row_by_id(c, place_id)) == ("Malaysia", "MY", "Malaysia")
    # R1 REJECTS, it does not repair — touching the other row is R3, deferred and not gated.
    assert _country_triple(_row_by_id(c, "sg-row")) == ("Singapore", "SG", "Singapore")


@pytest.mark.asyncio
async def test_persist_falls_through_a_conflicting_candidate_to_a_compatible_one(monkeypatch):
    """Conflict FIRST, compatible second — both passing the name and <500m gates.

    An implementation that inserts as soon as it meets a conflicting candidate passes the case
    above and violates the required fall-through: it forks a second Malaysian row for a venue
    the corpus already holds.
    """
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client({"places": [_place_row("sg-row", _JB_NEAR, country_code="SG"),
                            _place_row("my-row", _JB_NEAR2, country_code="MY")]})
    place = _gp(_VENUE, *_JB, country_code="MY", country_name="Malaysia")

    place_id = await _link_one(c, place, _Verifier(_MY_RESULT))

    assert place_id == "my-row"
    assert len(c.db["places"]) == 2          # zero inserts


@pytest.mark.asyncio
async def test_persist_reuses_a_candidate_matching_on_the_code_not_the_country_names(monkeypatch):
    """Same `country_code`, deliberately poisoned `country`/`country_name`.

    An implementation comparing the human-readable NAMES instead of the code passes every other
    case here and rejects this one, forking a duplicate row for a venue whose provenance already
    agrees. The comparison is the code, which is the only half the database constrains.
    """
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client({"places": [_place_row("my-row", _JB_NEAR, country_code="MY",
                                       labels="Singapore")]})
    place = _gp(_VENUE, *_JB, country_code="MY", country_name="Malaysia")

    place_id = await _link_one(c, place, _Verifier(_MY_RESULT))

    assert place_id == "my-row"
    assert len(c.db["places"]) == 1
    assert _country_triple(_row_by_id(c, "my-row")) == ("Singapore", "MY", "Singapore")


@pytest.mark.asyncio
async def test_persist_reuses_a_null_country_candidate_without_repairing_it(monkeypatch):
    """A NULL country is an ABSENT claim, not a conflicting one — 87% of the corpus is NULL, so
    rejecting those would fork a duplicate for nearly every venue we already hold. Repairing the
    reused row is R3: deferred, not gated, and deliberately not what happens here."""
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client({"places": [_place_row("null-row", _JB_NEAR, country_code=None)]})
    place = _gp(_VENUE, *_JB, country_code="MY", country_name="Malaysia")

    place_id = await _link_one(c, place, _Verifier(_MY_RESULT))

    assert place_id == "null-row"
    assert len(c.db["places"]) == 1
    assert _country_triple(_row_by_id(c, "null-row")) == (None, None, None)


@pytest.mark.asyncio
async def test_persist_without_a_verified_country_keeps_todays_first_match_dedup(monkeypatch):
    """`grounded is None` — the unverified path, which must behave exactly as it does today.

    A JP-claim place whose provider call fails, with an SG row FIRST and a JP row second: the SG
    row still wins, because with no verified country there is nothing to compare against. An
    implementation that applies the country term here would fall through to the JP row (or
    insert), which means one Mapbox outage silently re-points every trip and forks the corpus.
    """
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    c = _Client({"places": [_place_row("sg-row", _JP_NEAR, country_code="SG"),
                            _place_row("jp-row", _JP_NEAR2, country_code="JP")]})
    place = _gp(_VENUE, *_JP, country_code="JP", country_name="Japan")
    verifier = _FailingVerifier()

    place_id = await _link_one(c, place, verifier)

    assert verifier.calls == 1               # the provider WAS asked, and it was down
    assert place_id == "sg-row"              # first match wins, country-agnostic, as today
    assert len(c.db["places"]) == 2          # no insert
    assert _country_triple(_row_by_id(c, "sg-row")) == ("Singapore", "SG", "Singapore")
    assert _country_triple(_row_by_id(c, "jp-row")) == ("Japan", "JP", "Japan")


@pytest.mark.asyncio
async def test_persist_weather_updates_trip_days_by_date():
    c = _Client({"trip_days": [
        {"id": "d1", "trip_id": "trip-1", "day_number": 1, "day_date": "2026-08-01"},
        {"id": "d2", "trip_id": "trip-1", "day_number": 2, "day_date": "2026-08-02"},
    ]})
    reports = [WeatherReport(date="2026-08-01", temp_min_c=24.0, temp_max_c=31.0,
                             precipitation_mm=0.0, weather_code=2, summary="Partly cloudy, 24-31°C")]
    await persist.persist_weather(c, "trip-1", reports)
    d1 = [d for d in c.db["trip_days"] if d["day_date"] == "2026-08-01"][0]
    assert d1["weather_source"] == "open_meteo"
    assert d1["weather_summary"].startswith("Partly cloudy")
    assert d1["weather_payload"]["weather_code"] == 2
    d2 = [d for d in c.db["trip_days"] if d["day_date"] == "2026-08-02"][0]
    assert "weather_source" not in d2  # untouched day (no report)


@pytest.mark.asyncio
async def test_persist_transport_inserts_legs_per_consecutive_pair():
    # 3 stops on day 1 → 2 legs; day 2 has 1 stop → 0 legs.
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
            {"trip_id": "trip-1", "place_id": "pc", "day_number": 1, "sort_order": 2},
            {"trip_id": "trip-1", "place_id": "pd", "day_number": 2, "sort_order": 0},
        ],
        "trip_days": [
            {"id": "d1", "trip_id": "trip-1", "day_number": 1},
            {"id": "d2", "trip_id": "trip-1", "day_number": 2},
        ],
        "places": [
            {"id": "pa", "lat": 35.60, "lng": 139.70}, {"id": "pb", "lat": 35.61, "lng": 139.71},
            {"id": "pc", "lat": 35.62, "lng": 139.72}, {"id": "pd", "lat": 35.70, "lng": 139.80},
        ],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 600, "distance_m": 800, "code": "Ok"} for _ in range(len(coords) - 1)]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 2
    legs = c.db["transport_legs"]
    assert len(legs) == 2
    assert {l["leg_order"] for l in legs} == {0, 1}
    assert all(l["trip_id"] == "trip-1" and l["trip_day_id"] == "d1" for l in legs)
    assert all(l["transport_mode"] == "walk" and l["routing_profile"] == "walking" for l in legs)
    assert all(l["status"] == "ok" and l["duration_seconds"] == 600 for l in legs)
    frm_to = {(l["from_place_id"], l["to_place_id"]) for l in legs}
    assert frm_to == {("pa", "pb"), ("pb", "pc")}


@pytest.mark.asyncio
async def test_persist_transport_marks_no_route():
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [{"id": "pa", "lat": 35.6, "lng": 139.7}, {"id": "pb", "lat": 40.0, "lng": 145.0}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": None, "distance_m": None, "code": "NoRoute"}]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 1 and c.db["transport_legs"][0]["status"] == "no_route"


@pytest.mark.asyncio
async def test_persist_transport_retry_safe_deletes_first():
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [{"id": "pa", "lat": 35.6, "lng": 139.7}, {"id": "pb", "lat": 35.61, "lng": 139.71}],
        "transport_legs": [{"trip_id": "trip-1", "leg_order": 0, "from_place_id": "x", "to_place_id": "y"}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 1, "distance_m": 1, "code": "Ok"}]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 1 and len(c.db["transport_legs"]) == 1   # stale leg deleted, not appended


@pytest.mark.asyncio
async def test_persist_transport_deletes_stale_legs_when_trip_places_empty():
    # A pre-existing stale transport_legs row from an earlier run, but THIS run's trip_places
    # now resolves to zero rows (e.g. every place got dropped on a re-run) — the early return
    # on empty tps must still hit the delete-first path, not leave the stale legs behind.
    c = _Client({
        "transport_legs": [{"trip_id": "trip-1", "leg_order": 0, "from_place_id": "x", "to_place_id": "y"}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 1, "distance_m": 1, "code": "Ok"}]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 0
    assert c.db["transport_legs"] == []


@pytest.mark.asyncio
async def test_persist_transport_isolates_per_day_failure():
    # Day 1's fetch succeeds; day 2's fetch raises. Day 1's real legs, day 2's `failed` rows,
    # and (implicitly) any later day's real legs must ALL persist — no silent partial drop.
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
            {"trip_id": "trip-1", "place_id": "pc", "day_number": 2, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pd", "day_number": 2, "sort_order": 1},
        ],
        "trip_days": [
            {"id": "d1", "trip_id": "trip-1", "day_number": 1},
            {"id": "d2", "trip_id": "trip-1", "day_number": 2},
        ],
        "places": [
            {"id": "pa", "lat": 35.60, "lng": 139.70}, {"id": "pb", "lat": 35.61, "lng": 139.71},
            {"id": "pc", "lat": 35.62, "lng": 139.72}, {"id": "pd", "lat": 35.63, "lng": 139.73},
        ],
    })

    async def fake_legs(coords, *, profile="walking"):
        if coords[0] == (35.62, 139.72):   # day 2's first coord — simulate a Mapbox blip
            raise RuntimeError("Mapbox Directions request failed: ConnectError")
        return [{"duration_s": 600, "distance_m": 800, "code": "Ok"} for _ in range(len(coords) - 1)]

    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    legs = c.db["transport_legs"]
    day1_legs = [leg for leg in legs if leg["trip_day_id"] == "d1"]
    day2_legs = [leg for leg in legs if leg["trip_day_id"] == "d2"]
    assert day1_legs and all(leg["status"] == "ok" for leg in day1_legs)
    assert day2_legs and all(leg["status"] == "failed" for leg in day2_legs)
    assert all(leg["duration_seconds"] is None and leg["distance_meters"] is None for leg in day2_legs)
    assert written == len(day1_legs) + len(day2_legs)


@pytest.mark.asyncio
async def test_persist_transport_long_walk_becomes_transit_hint():
    # day 1: leg0 short (walk), leg1 >2km (transit_hint with a warning; walking numbers retained).
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
            {"trip_id": "trip-1", "place_id": "pc", "day_number": 1, "sort_order": 2},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [
            {"id": "pa", "lat": 35.60, "lng": 139.70}, {"id": "pb", "lat": 35.61, "lng": 139.71},
            {"id": "pc", "lat": 35.70, "lng": 139.80},
        ],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 300, "distance_m": 500, "code": "Ok"},        # short -> walk
                {"duration_s": 5640, "distance_m": 10054, "code": "Ok"}]     # 10km -> transit_hint
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 2
    legs = {leg["leg_order"]: leg for leg in c.db["transport_legs"]}
    assert legs[0]["transport_mode"] == "walk" and legs[0]["warning"] is None
    assert legs[1]["transport_mode"] == "transit_hint"
    assert legs[1]["warning"] and "transit" in legs[1]["warning"]
    assert legs[1]["routing_profile"] == "walking"       # numbers are still the real walking route
    assert legs[1]["distance_meters"] == 10054


@pytest.mark.asyncio
async def test_persist_transport_driving_profile_never_transit_hints():
    # a long leg on a non-walking profile is NOT a transit hint (driving a long leg is normal).
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [{"id": "pa", "lat": 35.6, "lng": 139.7}, {"id": "pb", "lat": 35.7, "lng": 139.8}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 900, "distance_m": 10054, "code": "Ok"}]
    await persist.persist_transport(c, "trip-1", profile="driving", fetch_legs=fake_legs)
    leg = c.db["transport_legs"][0]
    assert leg["transport_mode"] == "drive" and leg["warning"] is None


# --- persist_restaurants ----------------------------------------------------
from models.enrichment import RestaurantCandidate


def _rcand(name, lat, lng, *, name_local="ラーメン", summary="tasty"):
    return RestaurantCandidate(name=name, name_local=name_local, cuisine="ramen", summary=summary,
                               lat=lat, lng=lng, address="Tokyo", mapbox_id="poi.1",
                               categories=["レストラン"], distance_m=25)


async def _seed_two_places_one_day(c):
    canonical = [_cp("Tokyo Tower", 35.6586, 139.7454), _cp("Senso-ji", 35.7148, 139.7967)]
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"],
                                                job_id=None, lease_token=None)


@pytest.mark.asyncio
async def test_persist_restaurants_writes_row_place_and_near_id():
    c = _Client()
    await _seed_two_places_one_day(c)
    tower_id = next(p["id"] for p in c.db["places"] if p["name"] == "Tokyo Tower")

    async def suggest(places, *, city=None, preference_block=None):
        return [_rcand("Ramen Near Tower", 35.6587, 139.7455)]   # right next to Tokyo Tower

    written = await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert written == 1
    rs = c.db["restaurant_suggestions"][0]
    assert rs["summary"] == "tasty" and rs["cuisine"] == "ramen"
    assert rs["near_place_id"] == tower_id                        # nearest day place
    assert rs["restaurant_place_id"]                              # a places row was created/reused
    assert rs["preference_match_json"] == {}
    assert rs["evidence_json"]["mapbox_id"] == "poi.1"
    rest_place = next(p for p in c.db["places"] if p["id"] == rs["restaurant_place_id"])
    assert rest_place["name"] == "Ramen Near Tower" and rest_place["place_type"] == "restaurant"


@pytest.mark.asyncio
async def test_persist_restaurants_passes_city_from_places():
    c = _Client()
    await _seed_two_places_one_day(c)                             # _cp sets city_or_region_guess="Tokyo"
    seen = {}

    async def suggest(places, *, city=None, preference_block=None):
        seen["city"] = city
        return []

    await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert seen["city"] == "Tokyo"


@pytest.mark.asyncio
async def test_persist_restaurants_retry_safe_deletes_first():
    c = _Client({"restaurant_suggestions": [{"id": "stale", "trip_id": "trip-1", "summary": "old"}]})
    await _seed_two_places_one_day(c)

    async def suggest(places, *, city=None, preference_block=None):
        return []                                                # a re-run that now yields nothing

    written = await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert written == 0 and c.db["restaurant_suggestions"] == []  # stale row cleared


@pytest.mark.asyncio
async def test_persist_restaurants_no_trip_places_returns_zero():
    c = _Client()

    async def suggest(places, *, city=None, preference_block=None):
        raise AssertionError("suggest must not be called with no trip_places")

    assert await persist.persist_restaurants(c, "trip-1", suggest=suggest) == 0


@pytest.mark.asyncio
async def test_persist_restaurants_distinct_mapbox_ids_not_merged():
    # Two chain branches within 500m whose LLM name_en collapses to the SAME "Gusto" but with
    # DIFFERENT mapbox_ids must get SEPARATE places rows. The itinerary flywheel's name+geo dedup
    # would mis-merge them (same "gusto" key + <500m); restaurant dedup is by mapbox_id.
    c = _Client()
    await _seed_two_places_one_day(c)
    b1 = RestaurantCandidate(name="Gusto", name_local="ガスト 渋谷店", cuisine="family",
                             summary="branch one", lat=35.6586, lng=139.7454, address="A",
                             mapbox_id="poi.a", categories=["レストラン"], distance_m=10)
    b2 = RestaurantCandidate(name="Gusto", name_local="ガスト 道玄坂店", cuisine="family",
                             summary="branch two", lat=35.6588, lng=139.7456, address="B",
                             mapbox_id="poi.b", categories=["レストラン"], distance_m=30)

    async def suggest(places, *, city=None, preference_block=None):
        return [b1, b2]

    written = await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert written == 2
    rest_ids = {r["restaurant_place_id"] for r in c.db["restaurant_suggestions"]}
    assert len(rest_ids) == 2, "distinct-mapbox_id branches must not merge into one places row"
    by_pid = {p["id"]: p for p in c.db["places"]}
    assert {by_pid[pid]["source_summary"].get("mapbox_id") for pid in rest_ids} == {"poi.a", "poi.b"}


@pytest.mark.asyncio
async def test_persist_restaurants_writes_the_local_name_from_the_poi():
    """The restaurant writer is the THIRD path into `places`, and its local name is the good one.

    `genagents/restaurant.py` takes `name_local` STRUCTURALLY from the Mapbox POI and never from
    the LLM, so it is grounded provider data, not a transliteration — exactly what the column is
    for, and the case that matters most in Japan, where Mapbox indexes POIs under their Japanese
    names. It was already being flattened into `aliases`; the column makes it addressable.
    """
    c = _Client()
    await _seed_two_places_one_day(c)

    async def suggest(places, *, city=None, preference_block=None):
        return [_rcand("Ramen X", 35.70, 139.75, name_local="ラーメンX")]

    await persist.persist_restaurants(c, "trip-1", suggest=suggest)

    rest_id = c.db["restaurant_suggestions"][0]["restaurant_place_id"]
    rest_place = next(p for p in c.db["places"] if p["id"] == rest_id)
    assert rest_place["name_local"] == "ラーメンX"


@pytest.mark.asyncio
async def test_persist_restaurants_same_mapbox_id_reuses_place():
    # The same POI suggested twice (near two stops, or on a retry) dedups to ONE places row.
    c = _Client()
    await _seed_two_places_one_day(c)
    places_before = len(c.db["places"])
    cand = _rcand("Ramen X", 35.70, 139.75)          # mapbox_id="poi.1" (default)

    async def suggest(places, *, city=None, preference_block=None):
        return [cand, cand]

    written = await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert written == 2                                # two suggestion rows...
    rest_ids = {r["restaurant_place_id"] for r in c.db["restaurant_suggestions"]}
    assert len(rest_ids) == 1                          # ...sharing ONE places row (deduped by mapbox_id)
    assert len(c.db["places"]) == places_before + 1


@pytest.mark.asyncio
async def test_persist_restaurants_forwards_preference_block():
    c = _Client()
    await _seed_two_places_one_day(c)
    seen = {}

    async def suggest(places, *, city=None, preference_block=None):
        seen["preference_block"] = preference_block
        return []

    await persist.persist_restaurants(c, "trip-1", suggest=suggest,
                                      preference_block="Stated preferences: ramen")
    assert seen["preference_block"] == "Stated preferences: ramen"


# --- persist_narration ------------------------------------------------------
from models.enrichment import DayNarration, NarrationResult


@pytest.mark.asyncio
async def test_persist_narration_writes_day_and_trip_prose():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1"}]})
    await _seed_two_places_one_day(c)   # 2 places, day 1, one trip_days row

    async def narrate(days, *, city=None, preference_block=None):
        assert days and days[0]["day_number"] == 1 and days[0]["places"]   # structured-only input
        return NarrationResult(days=[DayNarration(day_number=1, title="Day 1: Icons",
                                                  summary="Tokyo Tower, then Senso-ji.")],
                               trip_title="Tokyo Highlights", trip_summary="A compact one-day run.")

    written = await persist.persist_narration(c, "trip-1", "u1", narrate=narrate)
    assert written == 1
    td = next(d for d in c.db["trip_days"] if d["day_number"] == 1)
    assert td["title"] == "Day 1: Icons" and td["summary"] == "Tokyo Tower, then Senso-ji."
    trip = next(t for t in c.db["trips"] if t["id"] == "trip-1")
    assert trip["title"] == "Tokyo Highlights" and trip["summary"] == "A compact one-day run."


@pytest.mark.asyncio
async def test_persist_narration_no_trip_places_returns_zero():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1"}]})

    async def narrate(days, *, city=None, preference_block=None):
        raise AssertionError("narrate must not be called with no trip_places")

    assert await persist.persist_narration(c, "trip-1", "u1", narrate=narrate) == 0


@pytest.mark.asyncio
async def test_persist_narration_blank_trip_summary_does_not_write_trip():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "summary": "old"}]})
    await _seed_two_places_one_day(c)

    async def narrate(days, *, city=None, preference_block=None):
        return NarrationResult(days=[DayNarration(day_number=1, title="t", summary="s")],
                               trip_title=None, trip_summary="")

    await persist.persist_narration(c, "trip-1", "u1", narrate=narrate)
    trip = next(t for t in c.db["trips"] if t["id"] == "trip-1")
    assert trip["summary"] == "old"   # a blank narrator trip_summary never nulls a prior value


@pytest.mark.asyncio
async def test_persist_narration_owner_check_blocks_foreign_user():
    # Guardrail #6 regression net: the trips UPDATE filters on id AND user_id (service_role bypasses
    # RLS). A foreign user_id must NOT overwrite the owner's trips.title/summary — the sole direct
    # trips write in the persist layer. Without the .eq("user_id", ...) this test would fail.
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "summary": "old"}]})
    await _seed_two_places_one_day(c)

    async def narrate(days, *, city=None, preference_block=None):
        return NarrationResult(days=[DayNarration(day_number=1, title="t", summary="s")],
                               trip_title="Hijacked", trip_summary="Should not persist.")

    await persist.persist_narration(c, "trip-1", "not-the-owner", narrate=narrate)
    trip = next(t for t in c.db["trips"] if t["id"] == "trip-1")
    assert trip.get("title") is None and trip["summary"] == "old"   # foreign user_id blocked the trips write


@pytest.mark.asyncio
async def test_persist_narration_forwards_preference_block():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1"}]})
    await _seed_two_places_one_day(c)
    seen = {}

    async def narrate(days, *, city=None, preference_block=None):
        seen["preference_block"] = preference_block
        return NarrationResult(days=[], trip_title=None, trip_summary="")

    await persist.persist_narration(c, "trip-1", "u1", narrate=narrate,
                                    preference_block="Preferred pace: relaxed")
    assert seen["preference_block"] == "Preferred pace: relaxed"


# --- persist_hotels ---------------------------------------------------------
@pytest.mark.asyncio
async def test_persist_hotels_writes_rows_from_trip_and_city():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "start_date": "2026-08-01",
                            "end_date": "2026-08-03", "adult_count": 2, "room_count": 1,
                            "destination_hint": "Japan"}]})
    await _seed_two_places_one_day(c)   # places carry city="Tokyo" (from _cp)
    seen = {}

    async def fetch(location, check_in, check_out, rooms):
        seen.update(location=location, check_in=check_in, check_out=check_out, rooms=rooms)
        return "sess-1", [{"name": "Park Hyatt Tokyo", "star": 5, "pricePerNight": 900,
                           "totalPrice": 900, "currency": "USD", "hotelId": 13278,
                           "packageId": "pkg-a", "headline": "In Tokyo (Shinjuku)"}]

    written = await persist.persist_hotels(c, "trip-1", fetch=fetch)
    assert written == 1
    assert seen["location"] == "Tokyo"                 # derived from places.city, NOT "Japan"
    assert seen["check_in"] == "2026-08-01" and seen["check_out"] == "2026-08-03"
    assert seen["rooms"] == ["2"]
    h = c.db["hotel_suggestions"][0]
    assert h["name"] == "Park Hyatt Tokyo" and h["star_rating"] == 5.0
    assert h["source"] == "travala" and h["status"] == "suggested" and h["base_place_id"] is None
    assert h["travala_hotel_id"] == "13278" and h["travala_session_id"] == "sess-1"
    assert h["price_snapshot"]["currency"] == "USD" and h["travala_result_json"]["name"] == "Park Hyatt Tokyo"


@pytest.mark.asyncio
async def test_persist_hotels_single_day_forces_one_night():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "start_date": "2026-08-01",
                            "end_date": "2026-08-01", "adult_count": 1, "room_count": 1}]})
    await _seed_two_places_one_day(c)
    seen = {}

    async def fetch(location, check_in, check_out, rooms):
        seen["check_out"] = check_out
        return None, []

    await persist.persist_hotels(c, "trip-1", fetch=fetch)
    assert seen["check_out"] == "2026-08-02"            # 0-night -> forced to >=1 night


@pytest.mark.asyncio
async def test_persist_hotels_skips_when_no_location_or_dates():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "start_date": None, "end_date": None}]})

    async def fetch(*a, **k):
        raise AssertionError("fetch must not run when dates/location are missing")

    assert await persist.persist_hotels(c, "trip-1", fetch=fetch) == 0


@pytest.mark.asyncio
async def test_persist_hotels_retry_safe_and_star_nullsafe():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "start_date": "2026-08-01",
                            "end_date": "2026-08-03", "adult_count": 1, "room_count": 1}],
                 "hotel_suggestions": [{"id": "stale", "trip_id": "trip-1", "name": "old"}]})
    await _seed_two_places_one_day(c)

    async def fetch(location, check_in, check_out, rooms):
        return "s", [{"name": "No Star Inn", "star": 9, "pricePerNight": 50, "currency": "USD"},
                     {"star": 3, "pricePerNight": 40}]   # 2nd has NO name -> skipped

    written = await persist.persist_hotels(c, "trip-1", fetch=fetch)
    assert written == 1                                  # stale cleared; no-name row skipped
    rows = c.db["hotel_suggestions"]
    assert len(rows) == 1 and rows[0]["name"] == "No Star Inn"
    assert rows[0]["star_rating"] is None                # star=9 out of [0,5] -> NULL (CHECK-safe)


def test_evidence_kind_maps_source_type():
    assert persist._evidence_kind("reel_extracted") == "reel_quote"
    assert persist._evidence_kind("user_requested") == "requested_by_you"
    assert persist._evidence_kind("agent_suggested") == "suggested_by_astrail"
    assert persist._evidence_kind("nonsense") == "suggested_by_astrail"  # safe fallback


@pytest.mark.parametrize("src,kind", [
    ("reel_extracted", "reel_quote"),
    ("user_requested", "requested_by_you"),
    ("agent_suggested", "suggested_by_astrail"),
])
def test_evidence_json_conforms_to_TripPlaceEvidence(src, kind):
    p = _cp("Senso-ji", 35.71, 139.79, source_type=src)
    ev = persist._evidence_json(p)
    # exact contract key set — no legacy keys (evidence_quote/evidence_quotes must be GONE)
    assert set(ev.keys()) == {"confidence", "source_url", "quote", "quotes",
                              "rationale", "evidence_kind"}
    assert "evidence_quote" not in ev and "evidence_quotes" not in ev
    assert ev["quote"] == "📍Senso-ji"
    assert ev["quotes"] == ["📍Senso-ji"]
    assert ev["rationale"] is None
    assert ev["evidence_kind"] == kind
    assert ev["confidence"] == 0.9


# --- persist_tradeoffs -------------------------------------------------------
from models.tradeoff import TradeoffOption, TripTradeoffComparison, TripTradeoffNote


def test_persist_tradeoffs_writes_full_object_in_one_update():
    from pipeline.persist import persist_tradeoffs
    c = _Client({"trips": [{"id": "t1", "user_id": "u1",
                            "tradeoffs": {"notes": [], "comparisons": []}}]})
    note = TripTradeoffNote(kind="empty_day", scope="day", severity="flag",
                            detail="day has no stops", day_number=3)
    comp = TripTradeoffComparison(
        axis="price_vs_rating",
        option_a=TradeoffOption(label="A", value="8000 JPY/night", pro="cheaper", con="3-star"),
        option_b=TradeoffOption(label="B", value="12000 JPY/night", pro="4-star", con="pricier"),
        refs=["a", "b"])
    asyncio.run(persist_tradeoffs(c, "t1", "u1", notes=[note], comparisons=[comp]))
    row = c.db["trips"][0]
    assert row["tradeoffs"]["notes"][0]["kind"] == "empty_day"
    assert row["tradeoffs"]["comparisons"][0]["axis"] == "price_vs_rating"


def test_persist_tradeoffs_is_owner_scoped():
    from pipeline.persist import persist_tradeoffs
    c = _Client({"trips": [{"id": "t1", "user_id": "u1",
                            "tradeoffs": {"notes": [], "comparisons": []}}]})
    # wrong user -> no row matches -> nothing written
    asyncio.run(persist_tradeoffs(c, "t1", "WRONG", notes=[], comparisons=[]))
    assert c.db["trips"][0]["tradeoffs"] == {"notes": [], "comparisons": []}

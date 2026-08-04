# astrail #42 — per-leg road polylines into `transport_legs.route_geometry`

> **Board:** `#42` — Todo, owner Shaun, Phase 1.2, repo `astrail`. **Public beta: 2026-08-08.**
> **Plan-gate history:** Codex R1 5.0 → R2 5.1 → R3 4.8 → R4 5.6 → R5 6.2 (all FAIL) → R6 6.8 (all FAIL) → R7 6.6 (all FAIL) → R8 5.8 (all FAIL) → R9 6.7 (all FAIL) → R10 6.8 (all FAIL) → R11 6.4 (all FAIL) → **this is R12.**
> R12 continues the R4 clean rewrite: three rounds of inline amendment produced internal
> contradictions, and each round's *fixes* introduced new defects. each round since R4 deliberately **shrinks**
> specified surface — one strict-receipt predicate instead of three divergent validators.

## Why

Pitch: *"Astrail turns scattered travel inspiration into the route you actually take."* The map
draws **straight lines pin-to-pin** on every trip. The feature is a closed loop of nothing:

| Piece | State |
|---|---|
| `supabase/migrations/20260702012806_generated_trip_outputs.sql:32` | `route_geometry jsonb` exists — always NULL |
| `frontend/lib/trip/backend-types.ts:116` | `route_geometry: GeoJSON.LineString \| null` exists |
| `backend/genagents/transport.py:38` | `overview=false`, **no `geometries` param at all** |
| `backend/pipeline/persist.py::_insert_leg` | never writes `route_geometry` |
| `frontend/components/map/TripMap.tsx:93` | builds the line from place coords |

## Research + probe (settled — do not re-derive)

**Docs** (`mapbox-docs-mcp`, `docs.mapbox.com/api/navigation/directions.md`, 2026-08-03):
`route_geometry` is **per-leg**; Directions returns geometry at the **route** level; the code makes
**one call per day**. Resolution: `steps=true` — `steps[]` is nested *inside* each leg
(`routes[0].legs[i].steps[j].geometry`), each documented as running "from this route step to the
next", so a leg's own steps reconstruct it. **Splitting `routes[0].geometry` at waypoint indices is
impossible** — no such field exists (`via_waypoints[].geometry_index` is a different feature,
populated only with an explicit `waypoints=` param). **One call per leg is rejected**: Directions
allows **300 req/min** and counts a multi-waypoint request as **1 request**, so per-leg calls
multiply cost by N. `overview` governs only route-level geometry — keep it `false`.
Max waypoints: 25/request (Astrail days are far under).

**Live probe** (1 call, 3-stop Tokyo walking day, 2026-08-03) — `n_legs == n_coords-1` holds with
`steps=true`; `route.geometry` absent under `overview=false`; and two undocumented shapes that
drive the implementation:

1. **71/71 step boundaries repeat the previous step's last coordinate.** Dedup is required.
2. **Each leg's final "arrive" step is degenerate** (`[P, P]`). A boundary-only rule re-appends
   `P`; **collapsing any consecutive identical point** handles both.
3. Measured size: **~175 pts/leg ≈ 4.6KB**, ~90KB per 20-leg trip (the research estimate of
   ~25 pts/leg was 5-6× low). Fine for jsonb — Postgres TOASTs it.

## Decisions (user, 2026-08-03)

| # | Decision |
|---|---|
| D1 | **Strict receipt.** Non-NULL `route_geometry` *means* drawable. Otherwise NULL, with duration/distance/mode intact. |
| D2 | Live probe run — see above. |
| D3 | `transit_hint` legs **keep** their walking geometry. Gate on `code`, never on `transport_mode`. |
| D4 | **No backfill.** New runs only. |
| D5 | Minimal frontend change **in scope**, in its own commit. |

## Scope

**IN:** request geometry · derive per-leg · persist · make the smoke see it · minimal `TripMap`
consumption · reconcile the PRD.
**OUT:** backfill (D4) · real transit routing · `raw_payload` · any migration · any
`backend-types.ts` change · other enrich agents.

## Contracts

- **#3 best-effort** — geometry failure → NULL, never fails the trip. `persist_transport`'s per-day
  isolation is not weakened.
- **#4 schema parity** — column and TS type already exist and agree; the obligation is that the
  persisted shape matches `GeoJSON.LineString` exactly, **lng before lat**.
- **Token safety** — `transport.py` avoids `raise_for_status()` because `MAPBOX_SECRET_TOKEN` rides
  in the query string, and sanitizes non-2xx + `httpx.RequestError`. Preserved verbatim; no code
  path may surface the URL; nothing raises the root logger.
- **Eval safety** — `evals/` never imports `genagents.transport` (verified: `"transport_legs"`
  appears only as a string in `PENDING_CHECKS`, `evals/checks.py:19`). Anchor
  `mean_intra_day_travel_m = 6229.0` must not move.

**Baseline (verified 2026-08-03):** `uv run pytest -q` → 1239 passed, 8 skipped ·
`uv run pytest evals/ -q` → 49 passed.

## What already exists (reused, not rebuilt)

DB column · TS type · `persist_transport` per-day `try/except` · `_leg_mode_and_warning` ·
the projection-honouring `_Table` fake · `tokyo-trip.ts`'s `roadish()` fixture · existing
`fake_legs` doubles (which return dicts with **no** `"geometry"` key — hence `leg.get("geometry")`).

---

# Task 1 — `backend/genagents/transport.py`

**ONE strict-receipt predicate, four consumers.** R2 introduced a second, weaker validator in the
smoke; R3 caught that it silently accepted malformed geometry. The fix is not two validators that
agree — it is one definition.

```python
# WGS84 bounds. A coordinate outside these is not a place on Earth.
_LNG_MIN, _LNG_MAX = -180.0, 180.0
_LAT_MIN, _LAT_MAX = -90.0, 90.0


def _clean_coord(pt) -> tuple[float, float] | None:
    """One coordinate → validated (lng, lat), or None.

    The container check is load-bearing, not defensive: a 2-key dict unpacks its KEYS, so
    `{1: 'x', 2: 'y'}` would yield a valid-looking (1.0, 2.0) without it (verified by execution).
    NaN/inf need no separate test — every comparison against NaN is False, so the bounds check
    below rejects them. A `math.isfinite` call would be dead code no test could redden.
    """
    if not isinstance(pt, (list, tuple)) or len(pt) != 2:
        return None
    lng, lat = pt
    for v in (lng, lat):
        if isinstance(v, bool) or not isinstance(v, (int, float)):   # bool is an int subclass
            return None
    if not (_LNG_MIN <= lng <= _LNG_MAX and _LAT_MIN <= lat <= _LAT_MAX):
        return None
    return float(lng), float(lat)


def is_drawable_linestring(obj) -> bool:
    """D1's strict receipt, as ONE predicate. Public — FOUR call sites depend on it:

      1. `_leg_geometry`'s return gate (producer),
      2. `persist_transport`'s storage boundary (`fetch_legs` is injectable, so a future or
         test provider could hand us anything),
      3. `scripts/live_run.py`'s acceptance check (the smoke must judge by the same rule it
         claims to verify),
      4. `scripts/live_run.py`'s per-leg point-count print (so the count can never contradict
         the acceptance verdict printed beneath it).

    Each call site needs its OWN sentinel-spy test, and every such spy must CONTROL, not merely
    OBSERVE (Codex R12 — all three of its blocking findings were this one mistake). Asserting
    "the predicate was called with X" is satisfied by:

        is_drawable_linestring(geom)          # spy sees the exact argument; result DISCARDED
        valid = local_weaker_validator(geom)  # production actually decides here

    So every consumer spy must: feed an otherwise-DRAWABLE geometry, force the spy to return
    False, and assert the PRODUCTION OUTCOME FLIPPED. A spy that cannot change the result cannot
    prove the result depends on it.

    Total: never raises, for any input.
    """
    if not isinstance(obj, dict) or obj.get("type") != "LineString":
        return False
    coords = obj.get("coordinates")
    # isinstance ONLY — no length check. The distinctness test below SUBSUMES it, verified by
    # execution: `any(...)` over an empty list is False, and over a single point compares it to
    # itself → False. A `len(coords) < 2` guard would be dead code no test could redden, the same
    # trap `math.isfinite` fell into (Codex R5 blocking #1). Removing it also makes the singleton,
    # empty and all-identical tests all attributable — to DISTINCTNESS, which is the one guard
    # that actually produces their result. The isinstance check IS load-bearing: a tuple
    # `([1,2],[3,4])` otherwise passes.
    if not isinstance(coords, list):
        return False
    # Compare NORMALIZED points, never the raw containers. `[[1,2], (1,2)]` compares unequal in
    # Python (list != tuple) but both serialize to `[1,2]`, so a raw comparison would accept a
    # physically all-identical, undrawable line — and because this predicate is shared, that one
    # false positive would pass the producer, the storage boundary AND the smoke. Verified by
    # execution (Codex R4 blocking #1; an R4-introduced defect from centralizing the predicate).
    cleaned = [_clean_coord(pt) for pt in coords]
    if any(c is None for c in cleaned):
        return False
    # Written as an `if`-guard, NOT `return any(...)`, so that the prescribed fault injection
    # ("delete the guard") is actually executable. Deleting a trailing `return any(...)` makes the
    # function fall off the end and return None — which REJECTS everything, so the singleton and
    # all-identical tests would stay green and prove nothing (Codex R6 blocking #1). Deleting the
    # two lines below instead makes the predicate ACCEPT a 1-point line, which is the mutation the
    # tests actually name.
    if not any(c != cleaned[0] for c in cleaned):     # empty, singleton, or all-identical
        return False
    return True


def _leg_geometry(leg) -> dict | None:
    """Concatenate ONE Directions leg's step geometries into a GeoJSON LineString.

    TOTALITY IS LOAD-BEARING, AND IS CHECKED WITH isinstance, NOT `or []`. `or []` is a
    TRUTHINESS guard: `{"steps": 1}` yields `1`, and `for step in 1` raises TypeError. A raise
    here is caught by persist_transport's per-day `except`, which marks the WHOLE DAY failed and
    discards duration/distance Mapbox returned successfully — violating D1.

    NO PARTIAL RESULTS. A step whose `coordinates` is missing or EMPTY voids the leg; skipping it
    would return earlier steps' points as though the leg were complete — a non-NULL,
    plausible-looking polyline ending in the wrong place.

    `code == "Ok"` is the caller's gate; this is the shape gate.
    """
    if not isinstance(leg, dict):
        return None
    steps = leg.get("steps")
    # isinstance ONLY — no `not steps`. An empty list needs no guard: the loop runs zero times and
    # the final predicate rejects it anyway, so a `not steps` check would be unprovable.
    if not isinstance(steps, list):
        return None
    coords: list[list[float]] = []
    for step in steps:
        if not isinstance(step, dict):
            return None
        geometry = step.get("geometry")
        if not isinstance(geometry, dict):
            return None
        pts = geometry.get("coordinates")
        if not isinstance(pts, list) or not pts:      # empty → void, never truncate
            return None
        for pt in pts:
            cleaned = _clean_coord(pt)
            if cleaned is None:
                return None                            # one bad point voids the leg
            point = [cleaned[0], cleaned[1]]
            if coords and coords[-1] == point:         # collapse consecutive duplicates
                continue
            coords.append(point)
    out = {"type": "LineString", "coordinates": coords}
    return out if is_drawable_linestring(out) else None
```

**Request params** (line 38) — `overview` stays `"false"`:

```python
        resp = await http.get(url, params={
            "access_token": token,
            "steps": "true",          # per-leg geometry lives in legs[i].steps[j].geometry
            "geometries": "geojson",  # → {"type":"LineString","coordinates":[[lng,lat],…]}
            "overview": "false",      # route-level polyline is dead weight
        })
```

**Both return shapes carry `"geometry"`** (explicitly, so every leg dict has one shape):

```python
    if data.get("code") != "Ok" or not data.get("routes"):
        code = data.get("code", "NoRoute")
        return [{"duration_s": None, "distance_m": None, "code": code, "geometry": None}
                for _ in range(n_legs)]
    ...
        out.append({..., "code": "Ok", "geometry": _leg_geometry(leg)})
```

Update the docstring's promised keys to include `'geometry'`.

## Task 1 tests

**THE MASKING RULE.** A validator test feeding ONE bad coordinate proves nothing: delete the
validator and the result is a 1-point list, which **the distinctness guard** rejects anyway. (The
masking mechanism is distinctness, not a length check — that guard was deleted as dead code.)
**Every validator test carries a second VALID, DISTINCT coordinate.** Also note: the non-numeric,
wrong-arity, malformed-step and non-list cases redden **by raising** after the mutation, not by
returning a value. Red is red — just don't write them as value assertions.

**The requirement is:** every guard reddens **at least one** test whose expected outcome the other
guards cannot produce. (Not "exactly one test" — deleting the collapse guard reddens the two
exact-array collapse tests, and a third if the production-wiring fixture also carries duplicate
step boundaries. **Pin that fixture to have NO duplicate boundaries**, so the count is exactly two
and the wiring test stays about wiring.)

| Test | Guard |
|---|---|
| `..._collapses_duplicate_step_boundaries` | collapse — assert the **exact** shorter array |
| `..._collapses_degenerate_arrive_step` | collapse, probe case 2 — `P` appears **once** at the tail |
| `..._none_for_single_point` | **distinctness** (not length — that guard is deleted as dead code). Remove distinctness → a 1-point LineString is returned → red. |
| `..._none_for_out_of_range_coord` | bounds — `[[999.0,35.0],[139.8,35.7]]` |
| `..._none_for_bool_coord` | bool — `[[True,35.0],[139.8,35.7]]` |
| `..._none_for_non_numeric_coord` | numeric — `[["139.7",35.0],[139.8,35.7]]` |
| `..._none_for_wrong_arity_coord` | `len(pt)!=2` — `[[139.7,35.0,12.0],[139.8,35.7]]` |
| `..._none_for_dict_coord` | **container type** — `[{1:'x',2:'y'},[139.8,35.7]]`. Verified: without the isinstance check this unpacks the KEYS and returns a drawable `(1.0,2.0)`. |
| `..._none_for_malformed_step_geometry` | `isinstance(geometry, dict)` — fixture **must be a non-dict**, e.g. `{"geometry": 1}`. With `{}` the coordinates guard catches it instead and deleting the dict check leaves the test green. |
| `..._none_for_non_dict_step` | `isinstance(step, dict)` |
| `..._none_for_non_list_steps` | `isinstance(steps, list)` — `{"steps": 1}` → None, **not** TypeError |
| `..._none_for_non_list_coordinates` | `isinstance(pts, list)` — fixture **must be an integer**, e.g. `{"coordinates": 1}`. A string is rejected later by `_clean_coord` anyway, leaving the test green after deleting the intended guard. |
| `..._none_for_empty_intermediate_step` | `not pts` — preceding step **must carry ≥2 distinct valid points**, else **distinctness** masks it |
| `..._none_for_non_dict_leg` | `isinstance(leg, dict)` |
| `test_leg_geometry_gate_calls_the_shared_predicate` | **the PRODUCER's gate** (Codex R12 blocking #3). Currently **bypassable**: rewrite the gate as `return out if len(coords) >= 2 else None` and **every other Task 1 test stays green**, because the coord loop has already normalized, validated and collapsed by then — so the shared predicate does no work the producer hasn't already done. Spy `is_drawable_linestring`, assert it receives the **exact constructed two-point LineString**, force it to return `False`, and assert `_leg_geometry(...)` returns `None`. |
| `..._is_total_over_malformed_inputs` | totality — table-driven, asserts **no exception**. Declared a shared property pin, not single-guard attributable. |
| **`test_fetch_directions_legs_builds_distinct_geometry_per_leg`** | **the production wiring.** Every other test calls `_leg_geometry` directly, and the existing fetch test expects `None`; so `"geometry": None` could be written in production and the suite stays green. Two legs, **distinct** step geometries, assert **both exact LineStrings** — also pins per-leg alignment. |
| `test_is_drawable_linestring_rejects_wrong_type` | `type != "LineString"` — fixture **must** be `{"type":"Polygon","coordinates":[[139.7,35.0],[139.8,35.7]]}`, i.e. two valid **distinct** coords. With a degenerate fixture the coordinates guard rejects it anyway and deleting the type check changes nothing (Codex R4 blocking #2). |
| `test_is_drawable_linestring_rejects_all_identical` | distinctness |
| `test_is_drawable_linestring_rejects_invalid_point` | **`any(c is None ...)`** — `{"type":"LineString","coordinates":[[139.7,35.0],[999.0,35.7]]}` → `False`. **Nothing else tests this guard** (Codex R8 blocking #3): every other bad-coordinate test enters through `_leg_geometry`, which rejects bad points earlier in its own loop, so the predicate's copy is shadowed. Verified by execution: without the guard, `cleaned` is `[(139.7,35.0), None]`, distinctness sees two different values, and the predicate returns **`True`**. |
| `test_is_drawable_linestring_rejects_empty_coordinates` | distinctness — `{"type":"LineString","coordinates":[]}` → `False`, **no exception** |
| `test_is_drawable_linestring_rejects_tuple_coordinates` | **`isinstance(coords, list)`** — `{"type":"LineString","coordinates":([1,2],[3,4])}` → `False`. Verified: without the guard this returns `True`. Nothing else in the suite proves the outer container type. |
| `test_is_drawable_linestring_rejects_mixed_list_and_tuple_identical_points` | **normalized comparison** — `{"type":"LineString","coordinates":[[1,2],(1,2)]}` → `False`. Compare raw containers instead → `True` → red. Regression pin for the R4-introduced defect. |
| `test_is_drawable_linestring_is_total` | **Declared shared property pin** — asserts no raise for `None`, `"str"`, `[]`, `{}`; not single-guard attributable. |
| `..._requests_steps` / `..._requests_geojson_geometries` / `..._requests_overview_false` | one param each — a single test over three params cannot attribute |
| `..._no_route_legs_carry_null_geometry` | assert `leg["geometry"] is None` by **SUBSCRIPT** — `.get()` also returns None for a *missing* key |

**`test_leg_geometry_none_for_all_identical_points` is now ATTRIBUTABLE — to distinctness.** This
explanation has been wrong twice, in opposite directions, and the ambiguity was a symptom of the
redundant length guard rather than of the test. With `len(coords) < 2` deleted:

| Mutation | Result |
|---|---|
| remove collapse | `[P,P]` survives → distinctness rejects → still `None` → **green** |
| remove distinctness | collapse yields `[P]` → a 1-point LineString is **returned** → **RED** |

So it names distinctness, and only distinctness. Note the corollary: **the collapse guard reddens
exactly the two exact-array collapse tests** — not three, as an earlier draft claimed.

**MUST-FIX existing test.** `genagents/test_transport.py:40` asserts
`legs[0] == {"duration_s": 610, "distance_m": 821, "code": "Ok"}` — **exact dict equality**. Add
`"geometry": None` (its payload has no `steps`). Keep it exact; it pins the full leg contract.

**Fault injection:** clear `__pycache__` first, delete each guard, confirm its test reddens,
restore, re-clear. Also reverse `"geometry": _leg_geometry(leg)` → `"geometry": None`.

---

# Task 2 — `backend/pipeline/persist.py`

`_insert_leg` gains `route_geometry: dict | None = None`, written into the insert dict.
`persist_transport`'s success path:

```python
            # D1 enforced AT THE STORAGE BOUNDARY, not merely assumed of the producer. `fetch_legs`
            # is injectable (tests today, another provider later), so both the code gate and the
            # shape gate belong here. D3 is unaffected: transit_hint legs have code == "Ok".
            geom = leg.get("geometry") if leg.get("code") == "Ok" else None
            ...
            await _insert_leg(..., warning=warning,
                              route_geometry=geom if is_drawable_linestring(geom) else None)
```

The per-day failure path still omits the kwarg (→ `None`), so guardrail #3 needs no new branch.

| Test | Attribution |
|---|---|
| `..._writes_route_geometry` | **Declared shared** — call-site forwarding and insert serialization produce the same failure. End-to-end pin. |
| `..._no_route_geometry_is_gated_out` | Attributable — `fetch_legs` returns `code="NoRoute"` carrying an **explicitly DRAWABLE** geometry: `{"type":"LineString","coordinates":[[139.7,35.0],[139.8,35.7]]}`. "Non-NULL" was too loose (Codex R6 blocking #2): with `{}` or a Polygon, the **shape** gate stores `None` anyway, so deleting the **code** gate changed nothing and the test stayed green. This is the only test proving the code gate. |
| `..._malformed_geometry_is_gated_out` | Attributable — `code="Ok"` with a **structurally invalid** geometry (e.g. `{"type":"Polygon",...}`); stored `None`, metrics intact. Remove `is_drawable_linestring` → red. |
| `..._failed_day_nulls_geometry_and_later_day_still_writes` | Attributable — day 1 raises, **day 2 succeeds with geometry asserted exactly**. Distinguishes "isolated" from "aborted after day 1". |
| `..._storage_gate_calls_the_shared_predicate` | **the storage boundary's use of the SHARED predicate** (Codex R11 blocking #2). The Polygon test proves only that *some* validator rejects a Polygon — a weaker local `dict + type == "LineString"` check passes every other Task 2 test while accepting one-point, all-identical and invalid-coordinate LineStrings. Monkeypatch `persist.is_drawable_linestring` with a spy that **CONTROLS the outcome** (Codex R12 blocking #2 — asserting the stored outcome alone is insufficient, since production could call the spy, discard its result, and validate independently). Pin the counterfactual: feed `code="Ok"` plus a **genuinely drawable** sentinel, force the spy to return **`False`**, and assert `route_geometry is None` **with metrics intact**. The predicate's own unit tests prove strictness; this proves the boundary actually calls it. |
| `..._transit_hint_keeps_geometry` | **Declared non-attributable** — generic wiring removal produces the same failure. Kept as a D3 contract pin. |

**The metrics-under-malformed-steps test belongs in Task 1, not here** (R3 blocking #4):
`persist_transport` receives *normalized* legs and never reads Mapbox `steps`, so feeding it
malformed steps proves nothing. Put it through `fetch_directions_legs` with a mocked payload —
**valid `duration`/`distance` + malformed `steps` → metrics preserved, `geometry=None`, no raise.**
**Declared SHARED / non-single-guard-attributable** (Codex R7 material #2): "malformed steps" can be
caught by several guards, so the test proves the D1 seam end-to-end, not one guard. Pin the fixture
to `steps: [{"geometry": 1}]` so the mutation under test is unambiguous, and do not claim it
attributes `isinstance(geometry, dict)` — `geometry={}` would be caught by the coordinates guard
instead, leaving it green.
That is D1 at the seam that actually consumes steps.

The `_Table` fake needs **no changes** (verified 2026-08-03).

---

# Task 3 — `backend/scripts/live_run.py`

Today the `.select(...)` at line 180 omits `route_geometry`, so the smoke prints identical output
whether this arc landed or was a no-op. Add the column, print per-leg point counts, and judge with
the **same predicate the writer uses**.

**Import `is_drawable_linestring` at MODULE scope**, not inside `_geometry_acceptance`:

```python
from genagents.transport import is_drawable_linestring   # top of scripts/live_run.py
```

A function-local import binds a function-local name, so `_inspect`'s per-leg print block — which
calls the same predicate — would raise `NameError` on the first leg, before printing anything
(Codex R8 blocking #1; an earlier draft specified exactly that). Module scope is safe here because
`transport.py` is deliberately **import-keyless**: `MAPBOX_SECRET_TOKEN` is read inside the
function, never at import time.

**MUST-FIX docstring** (Codex R9 minor — verified). `scripts/live_run.py:9-10` currently states
*"Import stays keyless: the app modules are imported inside the run body, never at module scope."*
This module-scope import makes that false. Amend it to record the single intentional exception and
why it is safe — `genagents.transport` reads no credential at import time — so the next reader does
not "restore" the discipline and reintroduce the `NameError`.

```python
def _geometry_acceptance(legs: list[dict]) -> tuple[bool, str]:
    """#42's live acceptance. A bare with_geom/total ratio is the WRONG condition — a healthy trip
    may legitimately contain no_route/failed legs, so N/N fails a correct run. Judges with
    `is_drawable_linestring`, the same rule the writer enforces (R3 blocking #1: a second, weaker
    validator here silently passed malformed geometry)."""
    ok = [lg for lg in legs if lg.get("status") == "ok"]
    ok_good = [lg for lg in ok if is_drawable_linestring(lg.get("route_geometry"))]
    leaked = [lg for lg in legs if lg.get("status") != "ok" and lg.get("route_geometry") is not None]
    passed = bool(ok) and len(ok_good) == len(ok) and not leaked
    return passed, (f"    → geometry acceptance {'PASS' if passed else 'FAIL'}: "
                    f"{len(ok_good)}/{len(ok)} ok-legs drawable; {len(leaked)} non-ok leaked; "
                    f"{'routed legs present' if ok else 'NO ROUTED LEG AT ALL'}")
```

Note `leaked` tests `is not None` — **literal NULL**, so `{}` counts as a leak (R3 blocking #1).

**Add `route_geometry` to the `.select(...)` at line 180**, and append a NULL-safe per-leg point
count to the existing print:

```python
        # NULL-safe by construction, and judged by the SHARED predicate. The acceptance rule
        # explicitly permits no_route/failed legs with route_geometry = NULL, so the obvious
        # `len(lg["route_geometry"]["coordinates"])` would pass a healthy-only test and then CRASH
        # on a legitimate partial trip (Codex R7 material #1). Malformed geometry prints 0pts
        # rather than a plausible count, so this line can never disagree with the acceptance
        # verdict printed below it.
        g = lg.get("route_geometry")
        pts = g["coordinates"] if is_drawable_linestring(g) else []
        geo = f"  ▸{len(pts)}pts" if pts else "  ▸no-geom"
```

Then print `_geometry_acceptance(legs)`'s line after the per-leg loop.

| Test | Proves |
|---|---|
| `..._acceptance_passes_on_healthy_trip` | **Declared POSITIVE CONTROL, not attributable** (Codex R4 material #2) — no single guard owns a `True` result. Keeps the other three from passing vacuously. |
| `..._acceptance_calls_the_shared_predicate` | **the acceptance helper's use of the SHARED predicate** (Codex R11 blocking #3). Its Polygon test proves only that some validator rejects a Polygon. And the point-count spy **deliberately patches `_geometry_acceptance` away**, so it cannot vouch for this call site. Give it its own spy on `scripts.live_run.is_drawable_linestring` that **CONTROLS the outcome** (Codex R12 blocking #1 — argument-only observation is satisfied by an implementation that calls the predicate and discards its result). Feed an otherwise **drawable** geometry, force the spy to return **`False`**, and assert the exact argument, `passed is False`, **and** the exact `FAIL` / `0/1` acceptance line. |
| `..._acceptance_fails_when_no_routed_leg` | `bool(ok)` — zero ok legs → `False` (a bare `0/0` ratio would report success) |
| `..._acceptance_fails_when_ok_leg_geometry_malformed` | the completeness check — ok leg with `{"type":"Polygon",...}` → `False` |
| `..._acceptance_fails_when_non_ok_leg_carries_empty_dict` | `not leaked` — a `no_route` leg with `{}`. **The fixture MUST also contain a healthy `ok` leg with drawable geometry**, otherwise `bool(ok)` is already `False` and removing `not leaked` changes nothing (Codex R4 blocking #2). |
| **`test_inspect_point_count_calls_the_shared_predicate`** | **"one predicate, three consumers" as a test** (Codex R9 material #1). The Polygon test below proves the print rejects *that* input, but a separate local validator checking `type == "LineString"` + list would pass it while still being weaker than `is_drawable_linestring`. **Isolate the point-count call first** (Codex R10 blocking #1): `_inspect` reaches the predicate by **two** paths — directly for the point count, and indirectly via `_geometry_acceptance` — so a bare "was it invoked?" spy stays green even if the point-count code uses a weaker local validator, because the acceptance call satisfies the spy alone. So: monkeypatch `_geometry_acceptance` to a **no-op that does not call the predicate**, replace `scripts.live_run.is_drawable_linestring` with a **sentinel-returning spy**, run `_inspect`, and assert **both the exact argument it received and the resulting `▸no-geom` / `▸Npts` output**. The module-scope import is what makes this seam patchable. |
| **`test_inspect_prints_no_geom_for_malformed_ok_leg`** | **the print's use of the SHARED predicate** (Codex R8 blocking #2). Seed an `ok` leg carrying a **Polygon with two valid coordinates**. Assert acceptance prints `FAIL`, the leg prints `▸no-geom`, and **no plausible `▸Npts` appears**. Without this, swapping the print guard for a weaker `isinstance(g, dict)`/coordinates check passes every other assertion — and the smoke would print a confident point count for geometry the acceptance line simultaneously calls invalid. |
| **`test_inspect_prints_geometry_acceptance_pass_and_point_counts`** | **R3 blocking #2 + R7 material #1.** Seed a **PARTIAL** trip — one `ok` drawable leg **AND** one `no_route` leg with `route_geometry=None` — because a healthy-only fixture lets a non-NULL-safe implementation pass here and crash in production. Assert the **exact `geometry acceptance PASS`** string, that **both** legs print (`▸Npts` and `▸no-geom`), and that `_inspect` does not raise. A generic "a line appeared" assertion stays green when the projection is dropped (the helper then prints FAIL). Drive real `_inspect` against the projection-honouring fake with captured stdout. |

**Fault injection (three separate reversions):** drop `route_geometry` from the `.select(...)`;
remove the `_geometry_acceptance` call; remove the per-leg `▸Npts` print. Each must redden.

---

# Task 4 — minimal frontend consumption (SEPARATE COMMIT, D5)

> `TripMap.tsx:81-86` says the trail is *"Deliberately built from the ordered stops, NOT from
> transport legs: most 'saved with gaps' trips come back with zero legs… This always connects."*
> A naive "read `route_geometry` instead" **regresses every saved-with-gaps trip**. Per-hop
> substitution *with* the straight-line fallback keeps the invariant.

```ts
// Per-hop road geometry with a straight-line fallback. The trail must ALWAYS connect (see
// TripMap.drawTrail) — most "saved with gaps" trips carry zero legs — so a hop only upgrades when
// a leg exists for that exact pair ON THAT DAY.
//
// The day dimension is DEFENSE-IN-DEPTH, not a production bug fix — be honest about this, and
// about WHY. It is NOT the `unique (trip_id, place_id)` constraint: that only stops a place
// appearing twice, and would still permit an A→B leg spanning two days (the transport_legs FK
// checks only that the day belongs to the trip, not endpoint-day membership —
// 20260702012806:43). The real reason today's producer cannot emit such a bundle is that
// `persist_transport` GROUPS STOPS BY DAY before constructing pairs (persist.py:556), so every
// leg it writes is within one day by construction. The day key is kept
// because it makes "cross-day hops stay straight" true by construction rather than by relying
// on an invariant enforced in a different table, and it costs three lines.
export function trailCoordinates(bundle: TripBundle): [number, number][] {
  const stops = orderedTripPlaces(bundle)
  if (stops.length < 2) return []
  // ONE key builder, used by BOTH insertion and lookup. Constructing the key at two sites made
  // the day/FROM/TO fields two-site guards: removing a field from only one expression still
  // leaves the keys mismatched, so the geometry stays unconsumed and the wrong-day/FROM/TO tests
  // stay GREEN. Only a coordinated two-site edit changed behaviour — i.e. no single-site fault
  // injection could redden them (Codex R7 blocking #1). With one builder, deleting one field
  // reddens exactly the test that names it.
  const hopKey = (day: number | undefined, from: string | null, to: string | null) =>
    `${day}|${from}->${to}`
  const dayOf = new Map(bundle.days.map((d) => [d.id, d.day_number]))
  const byHop = new Map<string, [number, number][]>()
  for (const leg of bundle.transport_legs) {
    // `if (coords)` IS load-bearing — R10 deleted it and R10's review proved that wrong.
    // Storing `undefined` equals not storing ONLY when the key is absent. `transport_legs` has NO
    // unique constraint on hop, day/hop, or day/order (20260702012806:19-43), so two rows CAN
    // share a composite key; without this branch a later NULL-geometry row `Map.set`s over an
    // earlier drawable one and the hop silently degrades to a straight line.
    // POLICY: DRAWABLE WINS over a later NULL for the same hop.
    // ACCEPTED LIMIT (Codex R12 material): two DRAWABLE rows on one hop remain order-dependent —
    // last-write-wins, and the frontend orders only by leg_order (supabase-api.ts:59) with no
    // uniqueness in the schema (20260702012806:113). Today's producer cannot emit that state, so
    // an arbitrary-but-drawable winner is explicitly ACCEPTED rather than given a tie-break rule.
    // Trigger to revisit: any producer that can emit two drawable rows for one hop.
    // The `day !== undefined && from && to` preconditions stay removed — those were genuinely
    // inert (Codex R6): they only produced keys no real-stop lookup could match.
    const coords = leg.route_geometry?.coordinates
    if (coords) {
      const day = leg.trip_day_id ? dayOf.get(leg.trip_day_id) : undefined
      byHop.set(hopKey(day, leg.from_place_id, leg.to_place_id), coords as [number, number][])
    }
  }
  const out: [number, number][] = [[stops[0].place.lng, stops[0].place.lat]]
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1]
    // Same-day hops only. A cross-day transition has no leg by construction and stays straight.
    const hop = prev.day_number === stops[i].day_number
      ? byHop.get(hopKey(prev.day_number, prev.place_id, stops[i].place_id))
      : undefined
    // Interior points only — endpoints snap to the pins. Mapbox returns road-snapped ends that can
    // sit tens of metres off a place (one inside a park), and the trail must meet the pins.
    if (hop) for (const c of hop.slice(1, -1)) out.push(c)
    out.push([stops[i].place.lng, stops[i].place.lat])
  }
  return out
}
```

`TripMap.tsx:93` becomes `const coordinates = trailCoordinates(bundle)`; keep an early return on
`coordinates.length < 2`.

| Test | Proves |
|---|---|
| `threads road geometry for a same-day hop` | **Declared shared positive control** — a happy-path pin, not independently attributable. |
| `falls back to a straight hop with zero legs` | **anti-regression** — the "always connects" invariant |
| `snaps hop endpoints to the pins` | **exact full array** — `slice(1)` leaves the stop coord last, so a first/last-only assertion passes against broken code. **The fixture must use deliberately OFF-PIN route endpoints**: `roadish()` ends exactly on the pins (its `bends` array starts and ends at `0`), so with that fixture the test proves duplicate-removal rather than endpoint snapping, which is the property under test. |
| `ignores a leg whose TO does not match` | distinctive interior coords must NOT appear |
| `ignores a leg whose FROM does not match` | a one-sided key check passes the single-case version |
| `ignores a leg whose trip_day_id points at the wrong day` | **the `${day}\|` key prefix** (Codex R5 blocking #3). Dropping R4's repeated-pair test left the prefix with **no test at all**, so its required fault injection would stay green. This fixture does not violate `unique (trip_id, place_id)`: stops A→B are consecutive **on day 1**, and a synthetic leg A→B is mis-assigned to **day 2's** `trip_day_id`. With the prefix it is ignored (straight hop); without it, it is consumed. That is also the truthful rationale for the guard — **defense against a wrong-day leg association**, not against a cross-day transition. |
| `keeps a cross-day hop straight even when a same-pair leg exists` | the day-**equality** guard. **Synthetic-data hardening** — the schema does **not** forbid this bundle (`unique (trip_id, place_id)` only stops a place repeating; the `transport_legs` FK checks day-belongs-to-trip, not endpoint-day membership). It is unreachable only because today's producer groups stops by day before pairing them (`persist.py:556`). The fixture must assign its synthetic leg to the **previous stop's** day; otherwise the prefixed lookup fails for an unrelated reason and deleting the equality guard still passes. R4's repeated-same-pair test is **dropped** — it asserted behaviour on a bundle today's producer cannot emit. |
| `keeps drawable geometry when a duplicate hop row carries NULL` | **`if (coords)`** (Codex R10 material #1). Two legs sharing one composite key: the first drawable, the second with `route_geometry: null`. **The first geometry MUST carry a distinctive INTERIOR point** — `[pinA, [distinctLng, distinctLat], pinB]` — because a valid *two-point* LineString has no interior after `hop.slice(1, -1)` and renders **identically to the straight fallback**, leaving the test green when the guard is deleted (Codex R11 blocking #1). Assert the exact array **including** the interior point; deletion then yields `[pinA, pinB]` → red. Schema-permitted because `transport_legs` has no uniqueness over hop/day/order. |
| `returns [] for zero stops` / `returns [] for a single stop` | **the `stops.length < 2` guard** (Codex R5 blocking #4). After rewiring, `drawTrail` calls `trailCoordinates` **before** checking output length, so removing the guard makes an empty saved-with-gaps bundle index `stops[0]` and throw. No listed test used zero or one resolved stop. Assert exactly `[]`. |
| **`TripMap draws the trail from route_geometry`** | the integration. Reverting `TripMap.tsx:93` reddens. |

**MUST-FIX existing test.** `frontend/components/map/__tests__/TripMap.test.tsx:178-191` asserts
the exact straight 5-stop array, and `TOKYO_TRIP` **already carries `roadish()` geometry** on its
two `ok` legs — so this goes red the moment the selector is wired. Update it **derivationally**,
not with hand-computed floats:

```ts
const geomOf = (id: string) =>
  TOKYO_TRIP.transport_legs.find((l) => l.id === id)!.route_geometry!.coordinates
coordinates: [
  [139.7967, 35.7148],              // Senso-ji            (D1 s1)
  ...geomOf('leg_1').slice(1, -1),  // road interior, D1 hop
  [139.7906, 35.6497],              // teamLab             (D1 s2)
  [139.7016, 35.658],               // Shibuya Sky         (D2 s3) — cross-day, straight
  ...geomOf('leg_2').slice(1, -1),  // road interior, D2 hop
  [139.7002, 35.6606],              // Ichiran             (D2 s4)
  [139.8804, 35.6329],              // Disneyland          (D3 s5) — cross-day, straight
]                                    // 13 points
```

Expected is assembled by a **different expression** than the implementation (explicit literals +
slices vs. a loop over `byHop`), so it is not circular: `slice(1)` yields 15 points → red.
**Preserve the test's continuous-trail and global-numbering assertions** — they test something else.
Note this test and the new integration test are now **redundant** for catching an unwired selector;
that redundancy is fine, but neither is "the only test" that catches it.

**MUST-FIX comment.** `TripMap.tsx:81-86` becomes false after this task. Rewrite it to say the
trail is built from ordered stops **with per-hop road geometry substituted where a same-day leg
provides it**, keeping the "always connects" rationale.

**MUST-FIX roadmap doc** (Codex R5 material #2). `TripMap.tsx:81` cites
`docs/roadmap/trip-map-day-connections.md`, which currently states the trail *"ignores transport
legs entirely"* (:32, :43) and files real routed geometry as future **Phase C** work (:91). Task 4
implements exactly that. Update it **inside the same frontend commit**, so the independently
revertible unit stays self-consistent — reverting the commit must also restore the doc. Note this
makes it a **frontend-SCOPED** commit, not "frontend-only": it contains `docs/roadmap/...`.

**Editor trap:** VS Code format-on-save applies Prettier defaults against this repo's
single-quote/no-semicolon style. Write frontend files via `Bash` heredoc, not `Edit`; check
`git diff --stat`.

**Fault injection:** revert `TripMap.tsx:93`; the `hop.slice(1,-1)` boundaries; the day-equality
guard; the `stops.length < 2` early return; **`if (coords)`** (duplicate-hop fixture); and **inside `hopKey`, one field at a time** — drop
`${day}|`, drop `from`, drop `to`. Mutating the single builder is what makes these attributable:
with the key built at two sites, a one-site edit only mismatched the keys a different way and left
all three tests green. Each fixture must keep the other two fields correct.

---

# Task 5 — reconcile `docs/PRD.md:537-542`

The PRD says *"Prefer per-leg calls over one large daily route call"* — contradicting shipped code
since the transport agent landed. Left alone, a future reviewer "fixes" it back to N calls.
State the tradeoff **honestly**:

- One call **per day**. Mapbox counts multi-waypoint as **1 request** against **300 req/min**.
- **Buys:** N-fold request reduction; per-leg geometry anyway via `steps=true`.
- **Genuinely sacrifices**, against the PRD's own four reasons: *per-leg failure isolation*
  (**sacrificed** — one failed daily request loses that whole day's legs; `persist_transport`
  isolates only day-to-day), *per-leg profile* (**sacrificed**, unrealized today), *per-leg
  caching* (**sacrificed**, unrealized today). *Precise per-leg warnings* is **only partly
  achieved** (Codex R5 material #3 — an earlier draft overclaimed it): distance-based
  `transit_hint` warnings **are** per-leg and precise, but a top-level daily `NoRoute` is copied
  onto **every** pair (`transport.py:50-52`), so a route failure cannot identify which hop failed.
- **Trigger to revisit:** a per-leg profile requirement (mixed walk/drive days) or a measured need
  for per-leg caching.

---

# Verification gates

1. `(cd backend && uv run pytest -q)` → 1239 + new, 8 skipped.
2. `(cd backend && uv run pytest evals/ -q)` → 49 passed, anchor unmoved.
   (The repo root has **no** `pyproject.toml` — it lives at `backend/pyproject.toml`, so a bare
   `uv run` from the root does not work.)
3. **Fault injection across the four CODE tasks** (Tasks 1-4; Task 5 is doc-only) — call sites,
   not just guards: every defect this arc found was an unwired seam. `__pycache__` cleared each
   cycle.
4. `(cd frontend && npm test && npm run typecheck)` green; `git diff --stat` shows no Prettier churn.
5. Final `astrail-reviewer` whole-branch pass on **fable**.
6. gstack `/review` **Codex cross-model** on the code.
7. **DEPLOY — BOTH halves. `render.yaml:37` is `autoDeploy: false`, so merging deploys NOTHING**,
   and Task 4 ships on Vercel, not Render. Every step needs the user's explicit go.
   1. Merge to `dev`.
   2. **Manually deploy the merged `dev` SHA to Render** (`astrail-backend`); verify the deployed
      SHA + health.
   3. **Deploy or identify the Vercel build carrying Task 4's commit**; verify its SHA. Without
      this, browser QA exercises **old frontend against new backend**.
   4. Generate a **fresh authenticated trip through the deployed Render service**.
   5. Run `_geometry_acceptance` against **that** trip → must print `PASS`.
   6. Browser `/qa` on **that same non-mock trip**, against the verified Vercel build — **not**
      `TOKYO_TRIP`, whose synthetic `roadish()` geometry renders road-following curves with **zero**
      backend change (the most convincing false positive available).
   **Rollback is symmetric on both halves:** revert *and* redeploy Render; revert *and* promote the
   prior Vercel build.

# Deferrals (with triggers)

| Deferred | Trigger |
|---|---|
| Backfill (D4) | A user complains about an old trip, or the board promotes a backfill card with a cost estimate. |
| Geometry thinning | A trip's total exceeds ~1MB or bundle-read latency regresses. Baseline ~4.6KB/leg, ~90KB/20-leg trip. |
| Batching the per-leg INSERT loop | Pre-existing N+1 write; this arc raises each payload to ~4.6KB. Trigger: measured transport-stage regression, or >40 legs. |
| `raw_payload` | A debugging need the parsed fields cannot serve. |
| Real transit routing | Existing non-Google v2 decision. |
| >25 stops/day | Directions waypoint ceiling. |
| Activating `transport_legs` in `PENDING_CHECKS` | Would move the frozen anchor — needs its own task where that is the intended outcome. |
| Producer-version receipt on `transport_legs` | Would make legacy-vs-failure provenance exact (see D4 below). |
| **A DB CHECK (or a second gated writer) for `route_geometry`** | D1's "non-NULL ⇒ drawable" is an **application-level invariant only** — `transport_legs.route_geometry jsonb` has no CHECK, and it spans two independently-deployed services. Today `_insert_leg` (`persist.py`) is the **sole** writer and is gated by `is_drawable_linestring`, so it holds. **Trigger: ANY new writer** — a backfill script, a manual edit, another service. If violated the failure is concrete, not cosmetic: an empty-but-non-null `coordinates` array is **truthy in JS**, so it wins over an earlier drawable duplicate (breaking "drawable wins"); and a non-array shape reaching `hop.slice(1,-1)` **throws inside TripMap's rAF callback, which runs BEFORE `flyToTrip()`** — so the camera silently never frames the trip. Point any future writer at `is_drawable_linestring` first. |
| **`sort_order` NULL semantics differ across the stack** | `persist.py` sorts NULL as `0`; the frontend's `orderedTripPlaces` sorts NULL as `+Infinity` — opposite ends. Unreachable today because `persist_itinerary` always assigns sequential non-null `sort_order` to every dayed place. **Trigger:** any writer that leaves `sort_order` NULL on a dayed `trip_place`, which would silently reorder the trail against the pins. |

# Rollback

Code-only, no migration. **NOT "no data change"**: geometry written during the rollout **persists**
after a code revert.

**Two rollback paths, because a code revert does not undo the payload** (Codex R4 material #3):

| Rollback motivated by | Path |
|---|---|
| **Rendering** (wrong/ugly trail) | Revert Task 4's commit + promote the prior Vercel build. Stored geometry is then simply unread. |
| **Bundle size / read latency** | Code revert is **NOT sufficient**. `frontend/lib/trip/supabase-api.ts:59` reads transport legs with `select('*')`, so every stored polyline is still downloaded even with Task 4 reverted. See the ordered purge below. |

**The performance purge is ORDERED, and the order is load-bearing** (Codex R5 material #1):

1. Revert **and redeploy** the backend producer.
2. **Verify the reverted Render SHA** — no build that writes geometry may be live.
3. **Only then** run the approved purge — **scoped**, never unqualified:
   ```sql
   UPDATE transport_legs SET route_geometry = NULL WHERE route_geometry IS NOT NULL;
   ```
   Without the `WHERE`, Postgres writes a new tuple for every already-NULL row too — avoidable
   WAL and table bloat during an incident (Codex R6 material #3).

Purging while the writing build is still live lets new or reclaimed jobs repopulate the column,
so the purge silently fails to hold.

**The purge has an irreversible consequence beyond D4, and it is not the same as "legacy trips
stay NULL":** post-deploy trips that *successfully had* geometry become **permanently** NULL, and
idempotent replay will **not** regenerate them once the feature is re-enabled — the same replay
short-circuit as D4 consequence #1. Only an output-affecting input change or operator action
recovers them. Do not run the purge for a cosmetic reason.

Task 4's *commit* is independently revertible **provided** the selector, its tests, the `TripMap`
wiring, the updated existing exact-array expectation, the comment, **and the
`docs/roadmap/trip-map-day-connections.md` update** stay in one **frontend-scoped** commit (it is
not "frontend-only" — it carries a docs file). Its *deployed* rollback needs the Vercel promotion in gate 7.

## D4 consequences beyond "old trips stay straight" (verified)

1. **Re-running the same request does NOT regenerate.** `main.py:375-379` is an idempotent replay —
   the same request key returns the **existing** trip without re-running the pipeline.
2. **NULL is ambiguous, and `trip.created_at` will NOT disambiguate it.** A pre-deploy trip can be
   reclaimed (`main.py:155`) and re-executed (`main.py:557`) after deployment; operator regeneration keeps the old
   creation time. Use **`jobs.completed_at` / `transport_legs.created_at`** plus the deployment
   window. Exact provenance stays impossible without a producer-version receipt (deferred above).
3. **A transient failure on a NEW trip is sticky** — idempotent replay returns that trip forever
   for the same request; the user has no self-service retry.
4. **Rollout residue survives a backend revert.** Geometry written between deploy and revert stays
   in the table; see the two rollback paths above for when that matters and how to purge it safely.

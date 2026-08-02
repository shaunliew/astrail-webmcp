# PLAN — `places.country` is NULL on 87% of rows: two writers, one guarantee

> Status: **PLAN ONLY, NOT REVIEWED. No code written.**
> Author: Shaun · Date: 2026-08-02 · Written at the end of the Telegram-ingest session, for a
> fresh session to pick up cold.
>
> **Read §1 and §2 before touching anything.** The obvious two-line fix is the wrong one, and §2
> explains why. The diagnosis in §1 is measured against production, not inferred.
>
> **This is a change to the LIVE web trip-generation pipeline.** `pipeline/persist.py` runs on every
> `/generate-trip`. Beta is 2026-08-08. Scope accordingly.

---

## 1. The finding, measured

`public.places` has **104 rows: 14 with a `country`, 90 without.** The split is not random — it is
perfectly correlated with which of two independent writers created the row.

```
WITH country: 14   of which reachable via reel_place_mentions: 14   (100%)
NULL country: 90   of which reachable via reel_place_mentions:  0   (0%)
```

### There are two writers to `places`, with different guarantees

| Writer | Path | Country |
|---|---|---|
| `grounding.py:173` → `find_or_create_place` RPC | organize (Saved Reels + Telegram worker) | `p_country` + `p_country_code`, **reverse-geocode verified** |
| `pipeline/persist.py:102` → direct `.insert()` | `/generate-trip` web pipeline | **no country field in the insert at all** |

`CanonicalPlace` extends `PlaceResult`, so it **has** `country_code`/`country_name`. `persist.py`
simply never writes them. This is not a missing value upstream — it is a dropped value at the
persistence boundary.

### Things this is NOT — all three were proposed during diagnosis and all three are wrong

- **NOT the known Mapbox-Japan-language issue.** That memory concerns **forward** geocoding
  (`/forward` needs a Japanese query for Japanese POIs). `_ground_place` uses **reverse** geocoding
  on lat/lng. Verified directly: `reverse_country()` on three affected coordinates returned
  `JP / Japan` for every one. The geocoder works.
- **NOT "the extractor omits `country_code`".** It emits it; `PlaceResult` even has a validator
  (`country_fields_are_a_pair`) enforcing that the two fields are set together.
- **NOT caused by the Telegram worker.** Oldest affected row is 2026-07-05. All four places the
  worker created on 2026-08-02 are correctly grounded with `country='Japan'`.

### Why nobody noticed

`grounding.py`'s gate returns early when the LLM supplied no country, so a NULL looks like a
verification failure rather than a persistence gap:

```python
if (place.lat is None or place.lng is None
    or is_placeholder_url(place.source_url)
    or not place.country_code
    or not place.country_name):
    return None
```

That gate is correct and is not the bug. The bug is on the other path, which never consults it.

---

## 2. The decision: ground before persisting. NOT "just add the column."

Three options were considered. **Take option 2.**

**Option 1 — add `country`/`country_code` to `persist.py`'s insert. REJECTED.**
Today `country` is non-NULL **only** when a coordinate was reverse-geocoded *and* agreed with the
LLM's claim. A populated `country` is therefore a **verification receipt**, not a label. Filling it
from the LLM's unverified claim would make 90 rows look verified when nothing checked them, and
afterwards there would be no way to distinguish the two kinds. **NULL is currently honest.** This
is a guardrail-#1 violation wearing the costume of a two-line fix.

**Option 2 — ground in the web path before persisting. TAKE THIS.**
`_ground_place` already exists, is already tested, and already does exactly the right thing:
reverse-geocode the coordinate, compare against the LLM's claimed country, and only accept on a
match. Reusing it means `country` keeps meaning exactly what it means today, on both paths.
Cost: one Mapbox reverse call per new place — **already cached** by `geocode_country_cache`
(`_lookup_cached_country` / `_store_cached_country`), so a warm coordinate is free.

**Option 3 — make `persist.py` call `find_or_create_place`. DEFER, but read §5.**
Structurally the best answer, and it would close a second problem (§5). But it puts the web
pipeline onto an RPC that currently only the organize path uses, days before beta. Not now.

---

## 3. Tasks

### T1 — Prove the current behaviour before changing it

Write a failing test first. `pipeline/persist.py`'s `_find_or_create_place` receives a
`CanonicalPlace` carrying `country_code`/`country_name`; assert the inserted row has them. It will
fail. That test is the specification.

Also pin the **existing** guarantee so this change cannot weaken it: a place whose coordinate does
NOT reverse-geocode to its claimed country must still end up with `country` NULL, not a filled-in
guess. That is the assertion protecting against option 1 being re-introduced later.

### T2 — Ground before persisting

In the web pipeline, ground each place before `_find_or_create_place` writes it, and pass the
**verified** country through. Reuse `grounding._ground_place` — do not write a second grounding
implementation.

Decide and record: where in `pipeline/runner.py` / `persist.py` the grounding call belongs, and
whether it is per-place or batched. `_ground_place` takes one place; the cache makes repeats cheap,
but a 8-place trip means 8 sequential awaits unless you gather them.

**Best-effort, per guardrail #3.** A Mapbox failure must not fail the trip. On failure the place
persists with `country` NULL — exactly today's behaviour, which is why this change is safe to ship
incrementally.

### T3 — Backfill, or decide not to

90 existing rows. Their coordinates are good and reverse-geocoding them works (verified). A
backfill script would populate them with the same verified-country guarantee.

**This is a judgement call, not an obvious yes.** Arguments: the corpus becomes uniform, and
`country` becomes queryable. Against: 90 Mapbox calls, and nothing currently reads `places.country`
for anything user-visible — confirm that with a grep before spending the effort. If nothing reads
it, backfilling is tidiness, not value.

### T4 — Guardrail check

`grep -rn "places.*country\|\.country" frontend/ backend/ --include='*.ts' --include='*.py'` and
establish what actually consumes this column. If the answer is "nothing yet", say so in the report
— it changes T3's priority and it is worth knowing before treating this as urgent.

---

## 4. Constraints

- **`pipeline/persist.py` and `pipeline/runner.py` are on every `/generate-trip`.** This is the live
  web path. Beta is 2026-08-08.
- **Eval safety.** `uv run pytest evals/ -q` — the frozen `#16` anchor
  `mean_intra_day_travel_m = 6229.0` (`evals/test_run_eval.py:82`) must not move. Grounding affects
  which places survive, so this is a real risk, not a formality. Run it early, not just at the end.
- **Guardrail #1** — no hallucinated places. The entire point of this plan is that `country` stays
  a verified value. If a change makes it easier to write an unverified country, that change is
  wrong regardless of how clean it looks.
- **Guardrail #3** — a Mapbox failure degrades to NULL, never fails the trip.
- **Guardrail #7** — caches are write-through. `geocode_country_cache` already is; do not bypass it.

---

## 5. The finding underneath, recorded but out of scope

Two independent writers to `places` do **different dedup**:

- `grounding.py` → `find_or_create_place`, an advisory-lock-serialized RPC (`20260720160000`).
- `persist.py:87` → its own candidate query plus `_place_matches` and a haversine distance check.

So the same real-world place reached by the two paths can produce two rows, and only one of them
carries a verified country. That is very likely why the corpus contains near-duplicates.

Converging them is option 3 above. It is the right long-term answer and it should not be attempted
in the same change as this one — fixing the country while the dedup divergence remains is still a
strict improvement, and bundling them makes both harder to review.

---

## 6. Definition of done

- `pipeline/persist.py` writes a **verified** country, or NULL — never an unverified claim.
- A test pins that an unverifiable place still gets NULL.
- `uv run pytest -q` and `uv run pytest evals/ -q` both pass, anchor intact.
- T4's grep result recorded, so the next person knows whether anything reads this column.
- Backfill decided either way, with the reason written down.
- BUILD-LOOP followed: plan review (gstack `/plan-eng-review` + Codex) before code, per-task
  `astrail-reviewer` gates, then both final gates.

---

## 6b. Amendments — measured 2026-08-03, before any code

> Added by the implementing session. These are **facts gathered against the repo**, plus the two
> judgement calls §3 explicitly delegated. Nothing here revisits §2.

### A. T4 is answered, and it inverts the plan's guess

§3 T4 asked whether anything reads `places.country`, and §3 T3 said "if nothing reads it,
backfilling is tidiness, not value." **Something reads it, and it is user-visible on the trip
surface this very pipeline writes.**

```
frontend/lib/trip/supabase-api.ts:56
  supabase.from('trip_places').select('*, place:places(*)')     # the whole places row, country included
frontend/lib/trip/backend-types.ts:43
  country: string | null                                        # in the Place contract (guardrail #4)
frontend/components/trip/PlaceIntelPanel.tsx:18
  {[place.area, place.city, place.country].filter(Boolean).join(', ')}
```

`PlaceIntelPanel` is the trip workspace's evidence panel (`TripWorkspace.tsx:261`). Because
`filter(Boolean)` drops the NULL, the panel renders `"Tokyo"` where it should render
`"Tokyo, Japan"` — **degraded, not broken**, which is why this was invisible.

Separately, `country_code` / `country_name` are read by the **organize** path only
(`frontend/lib/reels/organize.ts` → `CountryTrays.tsx`, fed by the RPCs' JSON), and those rows
already carry a verified country. That path is unaffected by this change.

Consequence: T2 is worth more than the plan assumed, and T3 (backfill) is a **user-visible
repair of 90 rows**, not tidiness. It is still not urgent — a missing line beats a wrong one.

### B. T2 design decision — batched, inside `persist_itinerary`

§3 T2 delegated *where* the grounding call belongs and *whether* it is per-place or batched.

**Decision: inside `pipeline/persist.py::persist_itinerary`, batched with `asyncio.gather`
before the day-loop, passing the verified country into `_find_or_create_place` explicitly.**

1. **In `persist.py`, not `runner.py`.** §1 diagnoses this as "a dropped value at the
   persistence boundary". Put the fix at that boundary and the guarantee is a property of the
   write itself. In `runner.py` it would hold only while the runner remembers to do it —
   `persist_itinerary` has other callers (`scripts/live_run.py`, `scripts/smoke_generate.py`,
   the tests), and every one of them would silently regress.
2. **Batched, not per-place-sequential.** `persist_itinerary` already pays N sequential
   round-trips (`_find_or_create_place` does one `places` SELECT per place). Grounding
   per-place inside that loop roughly doubles it on the live SSE critical path. One
   `asyncio.gather` before the loop collapses N cold Mapbox reverse calls into ~1 round-trip of
   wall-clock. Precedent: `runner.py` gathers scrape/extract; enrich-parallelization was a
   shipped latency lever.
3. **What batching costs.** It grounds places that then dedup to an existing row — a wasted
   call for that place. Rejected the alternative (ground lazily only on the insert branch)
   because it re-serializes the calls, and on a cold trip most places ARE new, so the wasted
   fraction is small. Deferred: resolving dedup for all places first, then grounding only the
   misses — a real restructure of a live function, not worth it days before beta.
   **Trigger to revisit:** if `geocode_country_cache` growth shows a sustained majority of
   groundings landing on dedup hits.
4. **Bounded.** Up to 5 reels × 10 places pre-dedup means a single trip could otherwise fire
   ~50 simultaneous Mapbox reverse calls. Cap the gather with an `asyncio.Semaphore`. A 429
   degrades to NULL (harmless), but it would burn quota and can bleed into other calls.
5. **Keyed by `id(place)`.** Matches `group_places_by_day`'s existing identity contract, so two
   distinct places sharing a name stay distinct. Safe **only** because `canonical` holds a
   strong reference for the whole call — no object can be freed and its id reused. Say so in a
   comment; it is the kind of invariant that silently rots.
6. **Write all three columns** — `country`, `country_code`, `country_name` — exactly as
   `find_or_create_place` does (`p_country` is the country *name*). `places_country_fields_pair_check`
   (`20260718130000`) requires code and name to be set together, so it is all three or none.

### C. Best-effort shape (guardrail #3) — and why the suite stays green

Each `_ground_place` call is individually wrapped; any exception → `None` → that place persists
with `country` NULL, which is exactly today's behaviour. Two consequences worth stating:

- The offline suite is **credential-free by design** (`backend/conftest.py` loads `.env` only
  under `--run-live`), so `MAPBOX_SECRET_TOKEN` is unset and `_ground_place` raises
  `RuntimeError` on line 1. Absorbed → NULL → **all 1186 existing tests are unaffected.**
- That is also the production degradation path, so it must be *tested*, not merely relied upon.

### D. Two traps for whoever writes the tests

1. **The existing fixture cannot ground.** `pipeline/test_persist.py::_cp` sets
   `source_url="https://example.org/a"`, and `example.org` is in `_FAKE_DOMAINS`, so
   `is_placeholder_url` → `True` and `_ground_place` returns `None` **before any network call**.
   A new test that copies `_cp` verbatim passes without exercising one line of the change —
   BUILD-LOOP's false-coverage shape #6 ("an earlier gate short-circuits"), exactly. New tests
   must pass a real-looking URL (e.g. `https://www.instagram.com/reel/ABC/`).
2. **The fake client cannot reach the cache.** `test_persist.py::_Table` implements no
   `maybe_single()` and no `upsert()` — see the standing note at `persist.py:559`. So
   `_lookup_cached_country`'s blanket `except` swallows an `AttributeError` as a cache MISS and
   `_store_cached_country` raises. Both degrade quietly, so the **cache half of guardrail #7
   would never be exercised.** Extend the fake with both methods, faithfully (per the
   fake-fidelity rule: a partial fake is the same bug wearing a hat), and add a test that a
   second place at the same coordinate does NOT call `verify_country` again.

### E. Known limitations this change deliberately does NOT fix

Both are conservative — they yield NULL, never a wrong country — so neither violates §2.

- **`user_requested` places stay NULL.** `_ground_place` gates on
  `is_placeholder_url(place.source_url)`, and `is_placeholder_url(None)` is `True`. That gate is
  an *organize-path provenance* rule (a Saved Reel always has a real URL); in the web pipeline a
  user-typed place legitimately has no source URL. Relaxing it would change guardrail-#1
  behaviour on the organize path — out of scope. **Trigger:** revisit when `user_requested`
  places become common enough to matter on the trip surface.
- **The organized-places branch stays NULL.** `runner.py:235-241` builds `PlaceResult` from
  `authorize_place_ids` rows without `country_code`/`country_name`, so `_ground_place`
  short-circuits. Harmless in practice: those places dedup to the existing canonical row, which
  `grounding.py` already gave a verified country. Passing the two fields through is a two-line
  change with no new failure mode — **flagged for the plan review to accept or reject**, not
  taken unilaterally, because it touches the Saved Reels branch.

### F. Deployment reality (for the cross-model gate)

**This change ships no migration.** All three columns and their CHECK constraints already exist
in production (`20260701162954`, `20260718130000`). So the schema/code merge-ordering hazard —
the class of defect the Codex gate has historically caught here — is structurally absent. The
review surface is instead: code shipping onto a live Render service on merge, `autoDeploy:false`,
`/health` performing no schema check, and `persist.py` running on every `/generate-trip`.

---

## 7. Evidence appendix — commands that produced §1

```
places: 104 total, 14 with country, 90 NULL
  WITH country -> 14/14 reachable via reel_place_mentions
  NULL country -> 0/90 reachable via reel_place_mentions

reverse_country() on three NULL places' coordinates:
  Sushizanmai Yurakucho   35.67232688,139.76020952  -> JP / Japan
  Tsukishima Monja …      35.6727357,139.7604427    -> JP / Japan
  Tinun Ginza             35.6722277,139.76044356   -> JP / Japan

places created 2026-08-02:
  4 via organize(mention) -> country='Japan'   (the Telegram worker)
 10 via neither mention nor trip_places -> country=None  (all restaurants, via persist.py)
```

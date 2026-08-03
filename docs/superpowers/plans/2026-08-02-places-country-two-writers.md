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

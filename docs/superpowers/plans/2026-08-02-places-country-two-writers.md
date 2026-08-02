# PLAN — `places.country` is NULL on 87% of rows: two writers, one guarantee

> Status: **PLAN ONLY, no implementation code written.** Reviewed — gstack `/plan-eng-review`
> (§6c) plus three Codex cross-model rounds (§6d, §6e, §6f). **§6b, §6d, §6e and §6f are
> amendments and SUPERSEDE the original §3 task text wherever they disagree.**
>
> ⚠ **The review gate has NOT passed.** Round 3 scored 6.9/10 against a 7.0 bar; its single
> blocking finding is folded but unverified, and the 3-round cap was reached. **Read §6f first
> — run one targeted round 4 before writing any code.**
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

> **AMENDED by the Codex plan review, round 1 (blocking finding #1).** The original wording
> below made `_find_or_create_place` the subject of the specifying test. That test can pass
> while every live `/generate-trip` still writes NULL: the helper gains the parameter, its
> focused test goes green, and nobody wires `persist_itinerary` to pass it. **The load-bearing
> test MUST enter through `persist_itinerary`** — the function the runner actually calls — with
> a real-looking `source_url`, `MAPBOX_SECRET_TOKEN` set via `monkeypatch`, and an injected
> verifier whose invocation is asserted. A helper-level test may exist alongside it, but it is
> not the specification.

Write a failing test first: drive `persist_itinerary` with a `CanonicalPlace` carrying
`country_code`/`country_name` and an injected verifier that agrees; assert the row inserted into
`places` has `country`, `country_code` and `country_name`. It will fail. That test is the
specification.

Also pin the **existing** guarantee so this change cannot weaken it: a place whose coordinate does
NOT reverse-geocode to its claimed country must still end up with `country` NULL, not a filled-in
guess. That is the assertion protecting against option 1 being re-introduced later.

And pin the **provenance** of the value, not merely its presence (Codex blocking finding #2):
`_ground_place` deliberately overwrites the LLM's country_name with Mapbox's
(`grounding.py:134`), so a test whose input and provider both say `JP`/`Japan` cannot tell a
correct implementation from one that uses grounding as a boolean gate and then inserts the LLM's
original name. Use a **poisoned name**: input `country_code="JP", country_name="United States"`,
provider returns `JP`/`Japan`, assert the row reads `country="Japan"`, `country_code="JP"`,
`country_name="Japan"`. Without this, `Tokyo, United States` ships and every other test is green.

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

> **AMENDED twice. Read both.**
>
> **(i) The "nothing reads it" premise is false** — §6b A. `PlaceIntelPanel` renders it. So the
> value side of this judgement call is higher than §3 assumed.
>
> **(ii) But a coordinate-only backfill CANNOT deliver the same guarantee** (Codex round 1,
> non-blocking #2 — the finding that actually decides this task). `country` means
> "reverse-geocoded **and agreed with an independent claim**". Those 90 rows no longer carry the
> LLM claim they were born with — `places` never stored it — and the restaurant-writer rows
> (A1) never had one at all. So reverse-geocoding 90 coordinates proves only what Mapbox says,
> which is a **strictly weaker** guarantee than the one the live path will now uphold.
>
> Running it anyway would put two different meanings in one column with no way to tell them
> apart — the exact failure §2 rejects, arriving through the back door. **A valid backfill must
> reconstruct each row's original claim from durable extraction data (`reel_cache` /
> the extraction cache), compare it, and leave the row NULL when the claim cannot be
> recovered.** "Run 90 Mapbox calls" is not a backfill design.
>
> See §6d for the resulting recommendation.

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
   persistence boundary". Put the fix at that boundary and the guarantee becomes a property of
   the write itself rather than of one call site's discipline. To be accurate about the
   strength of this argument: `runner.py:370` is today the **only** production caller
   (`scripts/live_run.py` and `scripts/smoke_generate.py` drive the API, not this function), so
   this is not "several callers would regress" — it is that a guarantee about what a row
   contains belongs next to the INSERT that writes the row, where the next caller inherits it
   for free. The second, concrete reason: the value has to reach `_find_or_create_place`'s
   insert dict anyway, so `runner.py` would only be threading it through.
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
4. **Grouped by coordinate: parallel ACROSS coordinates, sequential WITHIN one.**
   *(Revised by the Codex plan review, round 1, blocking finding #3 — the earlier "just gather
   them all" design was self-defeating.)* `_ground_place` is read-cache → call provider →
   upsert-cache. Fire two same-coordinate places concurrently and **both** observe a cache miss
   before either upsert lands, so **both** call Mapbox — which is not a correctness bug (the PK
   upsert is idempotent) but it defeats the cache and makes the write-through test in §6b D2
   unwritable: asserting "the second place does not re-call the provider" would fail against
   the implementation.

   So: group the places by `(lat, lng)`, `gather` across the distinct coordinates, and walk each
   group's members **sequentially**. The first member seeds the cache; later members hit it.

   Critically, each member still runs its **own** `_ground_place` call and therefore its own
   claim comparison — do NOT reuse the first member's grounded result for the rest. Two places
   at one coordinate can carry different LLM country claims, and the second one's claim must be
   checked against the cached answer, not assumed to match the first one's.

   **This is the most safety-sensitive invariant in the change, and round 2 found it was
   specified but not enforceable.** The shortcut below passes every test the plan required
   before round 3, and writes `Japan` onto a place that claimed `US` — a guardrail-#1
   violation introduced by the very fix for round 1's blocker #3:

   ```python
   grounded = await safe_ground(group[0])       # WRONG
   for place in group:
       grounded_by_id[id(place)] = grounded     # one member's verdict, applied to all of them
   ```

   The two tests that make it red are in §6b D2. Both are required; they are not combinable
   with each other or with anything else.

   **Keying detail (round 2):** key the map from the **original input object**, never from
   `id(grounded["place"])` — `_ground_place` returns a `model_copy`, so that id belongs to a
   different object and the lookup silently misses. Have each group worker return
   `(id(input_place), grounded)` so the pairing is explicit rather than positional. And keep
   persisting in `group_places_by_day` order — never rebuild ordering from gather-completion
   order.

5. **No semaphore.** *(Also revised in round 1 — the original bound was solving a problem that
   does not exist.)* `dedupe_places` caps `canonical` at `DEFAULT_MAX_PLACES = 8`
   (`pipeline/dedup.py:17`), so the fan-out is at most 8 distinct coordinates, not the ~50 the
   earlier draft feared. Eight concurrent reverse calls need no limiter, and a per-trip
   semaphore would not have bounded aggregate concurrency across simultaneous jobs anyway — it
   would have been a comforting no-op. The one way `canonical` exceeds 8 is the
   `user_requested`-only edge case at `dedup.py:119-122`, and those places have no `source_url`,
   so `is_placeholder_url` short-circuits them before any network call. The unbounded case is
   exactly the case that makes zero Mapbox calls. **Trigger for a process-wide limiter:**
   observed 429s from concurrent jobs.
6. **Keyed by `id(place)`.** Matches `group_places_by_day`'s existing identity contract, so two
   distinct places sharing a name stay distinct. Safe **only** because `canonical` holds a
   strong reference for the whole call — no object can be freed and its id reused. Say so in a
   comment; it is the kind of invariant that silently rots.
7. **Write all three columns** — `country`, `country_code`, `country_name` — exactly as
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
   fake-fidelity rule: a partial fake is the same bug wearing a hat).

   The cache test itself must then assert the thing the grouping in §6b B4 buys: **two places
   at the SAME coordinate, driven through ONE `persist_itinerary` call, invoke the injected
   verifier exactly once.** Round 1 flagged that this assertion is what makes the
   parallel-across / sequential-within design load-bearing — under a naive flat `gather` it
   fails, and under a purely sequential implementation it passes for a reason that has nothing
   to do with this change (the existing sequential cache test at
   `test_geocode_country_cache.py:121` already covers that). Assert the call **count**, not just
   the values.

   **Round 2 added two more, and they are the load-bearing pair.** A call-count assertion
   alone cannot distinguish "each member compared its own claim against the cached answer" from
   "one member's verdict was copied onto the whole group". Both required, both through ONE
   `persist_itinerary` call, neither combinable with anything else:

   **(a) Same coordinate, DIFFERENT claims — BOTH claim orders, parametrized.** Two places at
   identical coordinates with different LLM claims; the injected provider returns `JP`/`Japan`.
   Assert the verifier was called **exactly once** in each case, and:

   | case | claims (A, B) | expected rows (A, B) |
   |---|---|---|
   | a1 | `US`, `JP` | `NULL`, `Japan` |
   | a2 | `JP`, `US` | `Japan`, `NULL` |
   | a3 | `JP`, `US`, `JP` (three members) | `Japan`, `NULL`, `Japan` |

   **Both orders are required, and round 3 is why** — a1 alone is not enough. In a1 the first
   member's grounding returns `None`, so this implementation passes it *and* passes (b), while
   still writing a wrong country:

   ```python
   first = await safe_ground(group[0])                              # WRONG
   for place in group[1:]:
       grounded = first if first is not None else await safe_ground(place)
   ```

   It only copies the first verdict when that verdict **succeeded** — and a1 is precisely the
   case where it did not. Reverse to a2 and the successful `Japan` is copied onto a place
   claiming `US`. a3 (alternating, three members) additionally forces the per-member loop shape
   rather than any first-vs-rest special case.

   The mechanism that makes these provable in one assertion each: `_ground_place` stores the
   provider answer in the cache *before* it compares the member's claim
   (`grounding.py:122-132`), so a cache hit and an independent comparison are separable in the
   observed outcome. No wrong implementation reaches all three rows: the flat gather calls the
   verifier twice, the copy-the-first shortcut mislabels one row, the conditional variant above
   fails a2, and a cacheless implementation fails the call count.

   **(b) The first member of a group RAISES.** A stateful verifier that raises on its first
   call and returns `JP`/`Japan` on its second, with two same-coordinate places. Assert **the
   first row is NULL, the second is Japan, and the call count is two.** This proves the
   `except Exception` sits *inside* the per-member loop rather than around the whole coordinate
   group — otherwise one transient blip silently nulls every place sharing that coordinate.

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

## 6c. Eng review findings (gstack `/plan-eng-review`, 2026-08-03)

> Run autonomously (the user was asleep and had pre-authorised the review gates). The skill's
> per-finding `AskUserQuestion` prompts could not fire, so every finding below carries an
> explicit recommendation and a **DECIDED / FOR USER** marker instead. Nothing here changes §2.

### Step 0 — scope challenge

Complexity check does **not** trigger: 2 production files (`pipeline/persist.py`,
`pipeline/test_persist.py`), 0 new classes, 0 new services, 0 new dependencies, no migration.
The `asyncio.gather` approach is stdlib **[Layer 1]** — no custom concurrency primitive is being
invented. Scope accepted as-is. *(This section originally also credited an `asyncio.Semaphore`;
§6b B5 removed it as a per-trip no-op against an 8-place cap. **Do not reinstate it** — that
reference is superseded, not a second opinion.)*

### A1 — [P1] (confidence 8/10) There is a THIRD writer to `places`, and §1 misses it

`backend/pipeline/persist.py:378` —
```python
    inserted = (await client.table("places").insert({
        "name": cand.name,
```
`pipeline/persist.py` inserts into `places` at **two** distinct sites, not one:

| Site | Creates | Fixed by T2? |
|---|---|---|
| `_find_or_create_place` (persist.py:102) | itinerary places from reels | **yes** |
| `_find_or_create_restaurant_place` (persist.py:378) | Mapbox restaurant POIs | **no** |

This matters because the plan's own §7 evidence points at the writer it does not fix:

```
10 via neither mention nor trip_places -> country=None  (all restaurants, via persist.py)
```

A row absent from `trip_places` was not created by `persist_itinerary` — that function links
every place it creates. So those 10 rows came from the **restaurant** writer, and **T2 as
scoped would not have fixed the most recent rows the plan cites as evidence.** The plan's title
("two writers") undercounts by one.

**Recommendation: leave it out of scope — DECIDED — but for a §2-consistent reason, stated.**
A Mapbox Search Box POI carries no LLM-claimed country, so `_ground_place`'s fail-closed
comparison (`country.country_code != place.country_code`) has nothing to compare *against*.
Grounding a restaurant would mean writing a bare reverse-geocode result, which produces a
**second, weaker meaning of non-NULL `country`** — "reverse-geocoded" rather than
"reverse-geocoded AND agreed with an independent claim" — and leaves no way to tell the two
apart in the column afterwards. That is the same failure mode §2 rejects in option 1, arriving
by a different road. Fixing it needs its own decision about what the column means for
provider-sourced rows, which is a plan, not a patch.

Blast radius of deferring: bounded. `PlaceIntelPanel` renders `country` only for `TripPlace`
rows (the `trip_places` join), and restaurant places reach the frontend through
`restaurant_suggestions` / `suggestionPlaces`, which do not render a country line. So the
deferred half is **not** user-visible today; it degrades the `places` corpus, not the UI.

**Trigger to revisit:** when anything renders a country for a restaurant place, or when a
`places` query starts filtering on `country` (at which point a NULL-heavy corpus silently
under-returns).

### A2 — [P2] (confidence 9/10) Grounding failure vs cache-write failure are different, and only one is obvious

`grounding.py:82` `_store_cached_country` **raises by design** (strict write-through,
guardrail #7). Wrapping all of `_ground_place` in one `except` means a *successful* Mapbox
verification whose cache write failed is discarded, and the place persists with `country` NULL.

**Recommendation: keep that behaviour — DECIDED.** It is guardrail #7 read correctly ("we do
not hand back a verified result we could not persist"), and NULL is the honest degradation. But
it must be a written decision rather than a side effect of a broad `except`, because the
alternative (use the country, skip the cache) is what a later reader will assume was intended.

### C1 — [P2] (confidence 9/10) `country` must be the country NAME, matching the other writer

`20260720160000_serialized_place_find_or_create.sql:104` inserts
`(name, place_type, lat, lng, country, country_code, country_name, city)` with `p_country`
bound from `grounded["country_name"]` at `grounding.py:185`. If persist.py writes the *code*
into `country` while the RPC writes the *name*, one column carries two formats and
`PlaceIntelPanel` renders `"Tokyo, JP"` for some places and `"Tokyo, Japan"` for others.
**Assert this explicitly in a test** — it is a one-character mistake with a user-visible result.

### T1 — [P1] Test coverage diagram

Every row enters through `persist_itinerary` (Codex round 1 blocking #1), never through the
helper alone.

```
CODE PATHS (pipeline/persist.py)                        USER-VISIBLE OUTCOME
[~] persist_itinerary()
  ├── _ground_all() (new: grouped by coord, parallel across / sequential within)
  │   ├── [GAP] verified: code matches claim    -> country written  PlaceIntelPanel: "Tokyo, Japan"
  │   ├── [GAP] POISONED NAME: claim JP/"United States", provider JP/"Japan"
  │   │                                         -> row reads "Japan"   <- provenance, not presence
  │   ├── [GAP] MISMATCH: code != claim         -> country NULL     "Tokyo"   <- guards option 1
  │   ├── [GAP] no LLM claim (country_code=None)-> NULL, no network call
  │   ├── [GAP] placeholder/None source_url     -> NULL, no network call  (user_requested)
  │   ├── [GAP] Mapbox raises                   -> NULL, trip still saves  <- guardrail #3
  │   ├── [GAP] cache-write raises              -> NULL  (A2, deliberate)
  │   ├── [GAP] 2 places, SAME coord, ONE call  -> verifier invoked EXACTLY ONCE  <- guardrail #7
  │   ├── [GAP] SAME coord, claims US,JP        -> NULL, "Japan"   + 1 call  <- D2(a1), guardrail #1
  │   ├── [GAP] SAME coord, claims JP,US        -> "Japan", NULL   + 1 call  <- D2(a2), REQUIRED
  │   ├── [GAP] SAME coord, claims JP,US,JP     -> "Japan",NULL,"Japan"      <- D2(a3)
  │   └── [GAP] SAME coord, 1st member RAISES   -> NULL, "Japan"   + 2 calls <- D2(b)
  └── _find_or_create_place()
      ├── [GAP] insert carries country + country_code + country_name (all three, C1)
      ├── [★★ TESTED] dedup hit reuses row — test_persist.py:154 (existing, unaffected)
      └── [★★ TESTED] no-coord place dropped — test_persist.py:143 (existing, unaffected)

NOT COVERED BY DESIGN: _find_or_create_restaurant_place (A1, deferred)
NOT A FAILURE MODE:     absent MAPBOX_SECRET_TOKEN — boot secret, see Failure modes below

COVERAGE: 0/13 new paths tested — all 13 are the work of T1/T2.
```

**Every one of those 13 outcomes is required.** Two are regression-class under the IRON RULE
(mismatch→NULL, and Mapbox-raises→trip-still-saves): they pin behaviour that exists today and
that this change could silently take away.

**Thirteen outcomes need not be thirteen test functions** (round 2). Parametrize the compatible
single-place cases — verified / mismatch / no-claim / placeholder-URL / provider-raises all
share one arrange-act shape and differ only in input and expected row. D2 (a1)/(a2)/(a3) are
also naturally one parametrized test. **Do NOT merge across the same-coordinate group** (the
call-count case, the (a) family, and (b) first-member-raises): their failure modes are distinct,
and each one's expected outcome is what makes a *specific* wrong implementation red.

**Fault-injection duty (BUILD-LOOP "tests that cannot fail").** Each test must redden from a
guard only *it* can exercise. Specifically: the mismatch test and the no-claim test both expect
`country IS NULL`, so **neither alone proves the comparison runs** — deleting
`country.country_code != place.country_code` leaves the no-claim test green. Give the mismatch
test an outcome the other paths cannot produce: seed a claim that a *successful* geocode
contradicts, and assert the row is NULL **while a second, agreeing place in the same call is
non-NULL**. One call, both outcomes; no single deletion satisfies both.

### P1 — [P2] Performance: the batch is a latency win, not a cost-free one

`persist_itinerary` already pays one `places` SELECT plus one INSERT per place, serially.
Per-place grounding would add a third serial round-trip each; the batched gather adds ~1 total.
The real new cost is **up to 8 Mapbox reverse calls per cold trip** where there were 0 — bounded
by `DEFAULT_MAX_PLACES`, absorbed by `geocode_country_cache` on repeat coordinates, and degrading
to NULL on 429. Accepted. Deferred alternative and its trigger are in §6b B(3).

**Worst-case latency (round 2):** `geocode/mapbox_reverse.py:80` retries twice with a 15s
timeout, so a hard provider outage adds ~30s per distinct coordinate before the trip degrades to
NULL. Coordinate groups run concurrently, so the wall-clock floor is ~30s, not 8×30s — but a
group whose first member fails then pays that cost again for each later member, since each runs
its own call. Bounded at 8 places. **Record this in the live smoke against the 180s target.**

### Required outputs

**What already exists (reused, not rebuilt):** `_ground_place` (verification + comparison),
`_lookup_cached_country` / `_store_cached_country` + the `geocode_country_cache` table
(PK `(coord_key, verification_version)`, so the concurrent upsert is idempotent — checked),
`is_placeholder_url`, and the `places` country columns + CHECK constraints. This change writes
**no new grounding logic**; it moves an existing guarantee onto a second path.

**NOT in scope** (each with the trigger that reopens it):
- Restaurant writer grounding — A1; needs its own decision on what `country` means for
  provider-sourced rows.
- Dedup convergence / option 3 — §5; bundling makes both harder to review.
- `user_requested` places — §6b E; blocked on the placeholder-URL gate's provenance meaning.
- Organized-places branch pass-through — §6b E. **DECIDED: defer.** Two lines, but it edits the
  Saved Reels branch, which has 5 open PRs against it; and those places dedup onto rows that
  already carry a verified country, so the gap is near-theoretical.
- Repairing an existing row's NULL country on dedup hit — that is what T3's backfill is for.

**Failure modes (new codepaths only):**

| Failure | Test? | Handled? | User sees |
|---|---|---|---|
| Mapbox 5xx/timeout | required above | yes, per-place `except` | `"Tokyo"` not `"Tokyo, Japan"` — silent, correct |
| Mapbox 401 / 429 | required above | yes, same `except` | same |
| Cache write fails | required above | yes, by design (A2) | country NULL |
| Geocoder disagrees | required above | yes, that IS the guard | country NULL |
| ~~Token missing in prod~~ | n/a | **cannot happen** | — |

**Correction (Codex round 1, non-blocking #5): the "silent missing token" critical gap I flagged
was wrong.** `MAPBOX_SECRET_TOKEN` is in `REQUIRED_SECRETS` (`config_validation.py:29-33`), so a
genuinely absent token stops the service booting — it can never degrade silently in production.
It IS unset in the offline test suite, which is why the existing 1186 tests stay green, but
that is a test-environment property, not a production failure mode.

What remains genuinely silent is the set that survives boot: an invalid/revoked credential, a
401, a 429, a provider outage, and plain programming error. **Recommendation — DECIDED,
implemented in T2:** emit ONE aggregate structured log line per trip carrying the counts —
grounded / mismatched / failed, with the failure exception types. Round 1's improvement on my
original idea: a bare "zero countries verified" warning is ambiguous, because a trip where every
coordinate legitimately disagrees with its claim produces zero too. Counts separate
"eight mismatches" (working as designed) from "eight `HTTPStatusError`s" (credential is dead).

**Parallelization:** sequential — T1 and T2 both rewrite `pipeline/persist.py` and its test
file. No worktree split. T3 (backfill script) is independent but gated on T4's result, which is
already in.

---

## 6d. Codex cross-model plan review — round 1 disposition (2026-08-03)

`codex exec -m gpt-5.6-sol`, reasoning effort high, read-only, prompted with the deployment
reality per BUILD-LOOP §6.

**Round 1 verdict: 6.3/10 — FAIL** (Correctness 7.0 · Safety 7.0 · **Testability 4.0** ·
Completeness 5.5 · Clarity 8.0). §2's decision was explicitly endorsed as safe: *"Reusing
`_ground_place` is the right way to preserve the meaning of non-NULL country. I do not recommend
rewriting that decision."* Every failure was in the **test design**, which is the dimension a
plan is most able to get wrong and least able to notice.

| # | Blocking finding | Folded into | Disposition |
|---|---|---|---|
| 1 | The specifying test targets `_find_or_create_place`, so it can pass while `persist_itinerary` is never wired and every live trip still writes NULL | §3 T1 | **Accepted** — the load-bearing test now enters through `persist_itinerary` |
| 2 | A `JP/Japan` → `JP/Japan` success test cannot distinguish "uses the verified name" from "uses grounding as a boolean gate, inserts the LLM's name" — ships `Tokyo, United States` | §3 T1, §6c diagram | **Accepted** — poisoned-name test added |
| 3 | The same-coordinate cache assertion is **incompatible with the flat `gather`** the plan proposed: both tasks miss the cache and both call Mapbox | §6b B4 | **Accepted** — design changed to parallel-across-coordinates / sequential-within |

Finding 3 is the one worth remembering: it was not a gap in the plan's tests, it was a test the
plan required and an implementation the plan required, which **could not both be true**. That is
only visible to a reviewer that reads the plan and the code together.

**Non-blocking findings, all folded:** the third writer (independently confirmed my A1, and
agreed with deferring it); the backfill guarantee problem (§3 T3 amendment (ii)); the semaphore
being a per-trip no-op against an 8-place cap (§6b B5); Mapbox's 2 attempts × 15s timeout adding
~30s on an outage (note for the live smoke); and my incorrect "silent missing token" gap
(§6c Failure modes). Also: **catch `Exception`, never `BaseException`**, so `CancelledError`
from a lost lease keeps propagating through the gather.

**Confirmed non-findings** (worth recording, so nobody re-derives them): no schema/deploy-order
blocker (no migration ships); no structural eval-anchor risk, *provided grounding never filters
or mutates `canonical`* — a constraint the implementation must hold and the anchor run must
confirm; and the shared Supabase client is safe under the gather (per-request builders over one
async HTTP client, cache PK + `on_conflict` upsert).

### Backfill recommendation (T3) — **DO NOT RUN, and do not write the naive script**

Answering the judgement call delegated in §3 T3, with both amendments in hand:

- **Value is real**: `PlaceIntelPanel` renders `country`, and the 90 rows **do not self-heal**.
  Deferral (e) means a later trip that dedups onto an existing NULL row reuses it *without*
  repairing the country, so those rows stay blank indefinitely.
- **But the obvious script is wrong**: it would write a weaker guarantee into the same column,
  which is §2's rejected option 1 wearing a different costume.
- **So the deliverable here is the reasoning, not a script.** Writing
  `for row in places: reverse_country(row)` would hand over something that looks ready to run
  and quietly corrupts the column's meaning the moment it does.

**Recommended sequence, for the user to decide on:** (1) a read-only query establishing how many
of the 90 still have a recoverable original claim in the extraction cache — this is cheap and it
determines whether a correct backfill is even possible; (2) if the claims are recoverable, a
backfill that re-runs the *same* `_ground_place` comparison per row and leaves the rest NULL;
(3) if they are not, accept the 90 as permanently NULL and let the corpus improve forward-only.
**No production query has been run and no script has been written.**

---

## 6e. Codex cross-model plan review — round 2 disposition (2026-08-03)

**Round 2 verdict: 6.9/10 — FAIL** (Correctness 6.8 · Safety 7.8 · Testability 6.0 ·
Completeness 6.8 · Clarity 7.8). All three round-1 blockers confirmed resolved. One **new**
blocking finding — and it is the most instructive result of the whole gate, because *the fix for
round 1's blocker #3 is what created it.*

### The new blocker: same-coordinate result isolation was specified but not load-bearing

§6b B4 says every group member must run its own `_ground_place` and its own claim comparison.
Saying it is not enforcing it. This implementation satisfied **every test the plan required
after round 1**:

```python
grounded = await safe_ground(group[0])
for place in group:
    grounded_by_id[id(place)] = grounded
```

It calls the verifier exactly once (passing the D2 cache assertion), writes a verified country
(passing the success assertion), and **writes `Japan` onto a place that claimed `US`** — the
guardrail-#1 violation this entire plan exists to prevent, reintroduced by its own remedy.

Folded: §6b D2 (a) and (b), plus §6b B4's explicit "do not do this" block quoting the wrong
implementation. Test (a) is the elegant one — same coordinate, different claims, provider
returns `JP`/`Japan`, assert `A=NULL ∧ B=Japan ∧ calls==1`. No wrong implementation can produce
that triple: the flat gather calls twice, the copy-the-first shortcut writes Japan onto A, a
cacheless implementation calls twice. It works only because `_ground_place` caches *before* it
compares.

**The generalisable lesson, worth carrying past this task:** a fix that resolves a review
finding is new, unreviewed design. Round 1's blocker was "your test and your implementation
contradict each other"; the repair introduced a data-correctness hazard that neither round-1
finding described. Re-review the repair, not just the original defect.

### Also folded from round 2

- **Key from the original input object**, never `id(grounded["place"])` — `_ground_place`
  returns a `model_copy`, so that id belongs to a different object and every lookup misses.
  Group workers return `(id(input_place), grounded)`.
- **Persist in `group_places_by_day` order**, never gather-completion order.
- **Worst-case latency** ~30s per distinct coordinate on a provider outage (2 attempts × 15s,
  `mapbox_reverse.py:80`), and a failed first member makes each later member in that group pay
  it again. Recorded for the live smoke.
- **Stale text removed**: the header's "NOT REVIEWED", and §6c's two surviving references to the
  deleted semaphore — flagged because an implementer reading §6c alone could have reinstated it.
- **Test count**: parametrize the five compatible single-place cases; keep the three
  same-coordinate cases separate, because each one's expected outcome is what reddens a
  specific wrong implementation.

### Confirmed clean in round 2

Float-keyed `(lat, lng)` grouping (Pydantic rejects NaN/inf; `-0.0`/`0.0` coalesce the same way
`_coord_cache_key` does); determinism (dict insertion order + `gather`'s input-order results);
`except Exception` preserving `CancelledError`; no P0/critical findings; no new
deployment/schema hazard. The backfill restraint, aggregate logging, third-writer deferral and
semaphore removal were all endorsed as correctly scoped.

---

## 6f. Codex round 3 + GATE STATUS — READ THIS BEFORE IMPLEMENTING (2026-08-03)

**Round 3 verdict: 6.9/10 — FAIL** (Correctness 6.8 · Safety 7.6 · Testability 6.2 ·
Completeness 7.4 · Clarity 7.6). One blocking finding, now folded. **No round 4 was run — the
process cap is 3 rounds.**

### ⚠ The gate did NOT pass. Status when this session stopped:

| Round | Overall | Blocking findings | Folded? |
|---|---|---|---|
| 1 | 6.3 FAIL | 3 (all test-design) | yes |
| 2 | 6.9 FAIL | 1 (introduced by round 1's fix) | yes |
| 3 | 6.9 FAIL | 1 (D2(a) only tested one claim order) | yes — **unverified** |

Round 3's finding is folded into §6b D2 (a1/a2/a3) but **has not been re-reviewed**. Codex's own
words: *"Minimal repair: make D2(a) cover both claim orders."* That is exactly what was folded,
so a 4th round is expected to clear the 7.0 bar — but expected is not verified. **Run one
targeted round 4 before implementing.** Per BUILD-LOOP, code does not start on a failed gate.

### Round 3's finding, because it is subtle and worth not re-deriving

D2(a) originally specified one claim order: A claims `US`, B claims `JP`, provider returns `JP`.
That order makes the *first* member's grounding return `None` — so an implementation that copies
the first verdict **only when it succeeded** passes it, and passes (b) too:

```python
first = await safe_ground(group[0])
for place in group[1:]:
    grounded = first if first is not None else await safe_ground(place)
```

Reverse the claims (A=`JP`, B=`US`) and the successful `Japan` gets copied onto a place claiming
`US`. Both orders are now required, plus a three-member alternating case.

**Three rounds, three findings, all the same shape:** an assertion that looked like it pinned a
behaviour but left at least one wrong implementation green. None was a design flaw — §2's
decision was endorsed as safe in every round. The design was right from the start; what took
three rounds was making the tests able to *prove* it.

### What is settled and needs no further review

The architecture, the failure isolation, the ordering/determinism, the cancellation behaviour,
the latency accounting, the backfill restraint, the third-writer deferral and the
no-migration deployment analysis were all confirmed strong in round 3, with no P0/critical
findings across any round.

---

## 6g. Mapbox research — grounded in live docs, 2026-08-03

> Done via the `mapbox-docs-mcp` server against `docs.mapbox.com/api/search/geocoding.md`, not
> from memory. Three facts, each closing a question the plan had been answering by assertion.

### 1. A batch reverse endpoint EXISTS — and we should still not use it here

`POST https://api.mapbox.com/search/geocode/v6/batch` accepts reverse queries, supports
`permanent=true`, and bundles many coordinates into one HTTP request. Cap: the prose says 1000,
the error table says `Batch queries must include 50 queries or less` — **50 is the real limit**.

**Decision: do NOT adopt it for T2.** Three reasons, in order of weight:

1. **It cannot reuse `_ground_place`.** That function's entire structure is per-place:
   cache-read → provider → cache-write → compare. A batch call inverts it (collect all misses →
   one request → fan the results back out), so adopting it means writing the *second grounding
   implementation* §3 T2 explicitly forbids, on the live path, five days before beta.
2. **It saves almost nothing.** The batch's win is round-trips — but the coordinate-grouped
   `gather` (§6b B4) already collapses up to 8 calls into ~1 round-trip of wall-clock. Batch
   would save connection overhead, not a serial chain.
3. **It is not cheaper.** *"Each individual search in a batch geocoding request counts as one
   request"* — 8 coordinates bill as 8 either way.

**Where it IS the right tool: the T3 backfill.** 90 coordinates is 2 batch requests instead of
90 calls, on an offline script with no live-path risk and no `_ground_place` reuse constraint.
Recorded for whoever builds that script — see §6d's backfill sequence, which this does not
otherwise change (the claim-recovery problem is still the blocker, not the call count).

### 2. The rate limit is 1000 requests/minute — the no-semaphore call is now quantified

§6b B5 dropped the semaphore on the argument that 8 was small. The measured number: the default
Geocoding rate limit is **1000 req/min**, adjustable per account. A trip's worst case of 8
concurrent reverse calls is **0.8%** of that. Even 10 simultaneous trips would sit at 8%. The
semaphore was solving nothing, and this replaces the plan's hand-waving with a figure.
**Trigger for revisiting stays the same: observed 429s.**

### 3. Our existing call is valid, and this change does not alter the compliance posture

`geocode/mapbox_reverse.py:89-97` sends `types=country` **and** `limit=1` together, which the
docs require — *"limit must be combined with a single type parameter when reverse geocoding"*
(422 otherwise). It also sends `permanent=true`, the storable-results tier, which is what makes
persisting the answer into `places.country` legitimate rather than a ToS violation.

Both were already true on the organize path. **This change applies the identical call on a
second path — it introduces no new Mapbox surface, no new parameter, and no new compliance
question.** That is the strongest argument that the provider-facing risk here is near zero.

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

> **Note added 2026-08-03:** that last line is the evidence for §6c A1 — a row in neither
> `reel_place_mentions` nor `trip_places` was created by `_find_or_create_restaurant_place`
> (persist.py:378), the **third** writer, which this plan deliberately does not fix.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_OPEN | 8 issues, 0 critical gaps |
| Codex Review | `codex exec gpt-5.6-sol` | Independent 2nd opinion | 3 | ISSUES_FOUND | 5 blocking across 3 rounds, all folded; last unverified |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** 3 rounds, 6.3 → 6.9 → 6.9 against a 7.0 bar. Round 1: three test-design blockers
  (helper-level spec test, non-provenance success test, cache assertion incompatible with the
  proposed gather). Round 2: the round-1 repair itself admitted a guardrail-#1 violation. Round
  3: the round-2 repair tested only one claim order. All folded; round 3's fold is unverified.
- **CROSS-MODEL:** No tension on §2 — the eng review and all three Codex rounds independently
  endorsed grounding-before-persist over the two-line insert. Codex independently reproduced the
  eng review's third-writer finding (A1) and agreed on deferring it. Codex **corrected** the eng
  review twice: the "silent missing token" critical gap (it is a required boot secret) and the
  semaphore's blast-radius claim (an 8-place cap makes it a no-op). Both corrections verified
  against the source and folded.
- **VERDICT:** **NOT CLEARED — eng review required.** The plan is materially stronger than at
  round 0 and its design is settled, but the gate never reached 7.0 and the 3-round cap is
  spent. Implementation must not begin until a targeted round 4 verifies §6b D2 (a1/a2/a3).

**UNRESOLVED DECISIONS:**
- Round 3's blocking finding is folded into §6b D2 but not re-reviewed; one targeted Codex round
  4 is needed to clear the 7.0 bar before any code is written.

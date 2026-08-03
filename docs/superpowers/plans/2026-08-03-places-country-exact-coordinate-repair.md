# PLAN — Option F: repair a NULL `country` when the reused row IS the coordinate we just verified

> Status: **PLAN ONLY, no code written.** Third arc on `fix/places-country-verified`
> (arc 1 = ground-before-persist, arc 2 = R1 conflict rejection; both merge-ready, gates green).
> First gate on the §5c sketch scored **5.4/10** — this document is the executable rewrite.
>
> **`pipeline/persist.py` runs on every `/generate-trip`.** Beta is 2026-08-08.

---

## 1. Why — measured, not theorised

Live smoke, 4-venue reel, cold coordinates:

```
[log] pipeline.persist trip_place_grounding grounded=4 ineligible=0 mismatched=0 failed=0
=== grounding: 0/4 places carry a VERIFIED country (0 created by THIS run, 4 reused)
```

Four real Mapbox calls, four verified answers, **all four discarded** — every place deduped onto
a pre-existing NULL-country row. **On the measured traffic pattern arc 1 delivered zero.**

Then the decisive measurement:

```
NULL row 'CHERMSIDE SANDWICH …': exact-coord VERIFIED in cache
NULL row 'SANDO LAB TOKYO':      exact-coord VERIFIED in cache
NULL row 'Pelican Cafe':         exact-coord VERIFIED in cache
NULL row 'Sandwich Senmon Ten Popo': exact-coord VERIFIED in cache
=== exact-coordinate repair would reach 4/4 NULL row(s)
```

Cause: a re-run reel replays byte-identical coordinates from the extraction cache, so the row a
place dedups onto was created from the **same coordinate**.

## 2. The decision

On a dedup hit onto a candidate whose `country_code` **IS NULL**, if the candidate's stored
`lat`/`lng` is the **same binary64 coordinate** as the incoming place's, fill the three country
fields from the `grounded` dict **already in memory**, via a compare-and-swap. Otherwise do
nothing — today's behaviour.

**Terminology, corrected by the gate: "same binary64 coordinate modulo signed zero", NOT "byte
identity".** `_coord_cache_key` preserves Python float identity and deliberately collapses
`-0.0`/`0.0` (`grounding.py:35-50`); Postgres `float8` uses shortest-precise output and this repo
sets no reduced-precision override, so a correctly re-read value is the stored binary value. The
live 4/4 measurement is deployment-specific evidence for those four coordinates — it proves four
real round trips, **not** universal serialization fidelity.

Equal coordinates do not prove the same *venue* (two venues can share a building centroid). They
prove the same **coordinate-level country fact**, and since F writes only country fields, that is
exactly sufficient.

### Why F, and not R3

| | R3 | **F** |
|---|---|---|
| Extra Mapbox call per repair | one | **none** — reuses the in-memory result |
| Coordinate projection risk | receipt for a ≤500 m neighbour | **none** — same coordinate |
| Two-source agreement | a *compatibility gate* (name+500 m can merge chain branches) | **full** — `_ground_place` already compared this coordinate against this claim (`grounding.py:132`) |
| Fail-closed complexity | required | **N/A** — no new grounding to fail |
| Measured coverage | broader in principle | **4/4 measured** |

F does not subsume R3: a genuinely *different* coordinate within 500 m stays unrepaired. R3 can
be layered later if a measurement ever shows that case matters. R2/R3/R4 remain deferred.

## 3. Loop composition — specify the order, do not leave it to the implementer

```
name + distance gates pass
  ├─ grounded AND non-NULL conflicting country_code → continue          [arc 2, R1]
  ├─ grounded AND country_code IS NULL AND same binary64 coordinate
  │     → best-effort CAS repair
  │         ├─ matched   → return this id
  │         └─ zero rows → re-read the row:
  │                          compatible or still NULL → return this id
  │                          now conflicting          → continue        [preserves R1]
  │                          row ABSENT (deleted)     → continue        [never return a dead id]
  │                          re-read RAISES           → continue        [fail closed]
  └─ otherwise → return this id
```

Three hard rules:

- **F must never repair and then `continue`.** If it repairs, it returns that id.
- **F runs only after the name/distance gates and after R1's conflict check** — never before.
- **Every uncertain re-read outcome falls through, never returns.** Round 2 caught that the first
  draft specified only compatible/NULL/conflicting: a candidate deleted between the select and
  the re-read, or a re-read that raises, were undefined. Returning a missing row's id risks an FK
  failure on `trip_places`. Fail closed — `continue` — in both cases.

## 4. Tasks

### T1 — Two test-fake fixes (both prerequisites)

**(a) `.is_()`** — `test_persist.py::_Table` has no `.is_()` (`test_persist.py:56`). Implement it
with real NULL semantics: `.is_("country_code", "null")` must match **only** rows whose value is
None, and the update must return only the rows it actually matched. A fake that accepts `.is_()`
and ignores it makes every CAS test vacuous. Pin it with a direct fake-contract test.

**(b) `maybe_single()` must return a BARE `None` on zero rows** — round 4's blocker, and a shape
this repo has already been bitten by. The fake returns `_Result(None)` (`test_persist.py:134`);
**real PostgREST returns a bare `None`** (`postgrest/_async/request_builder.py:162`). The repo
already knows this — `live_run.py:51` carries the comment, `_lookup_cached_country` handles it
correctly (`result.data if result is not None else None`), and `test_main.py:940` is a regression
test for it from an earlier review.

With the current fake, this implementation passes **all sixteen** cases and breaks in production:

```python
try:
    response = await reread.execute()
except Exception:
    continue
if response.data is None:      # WRONG: `response` is bare None in production
    continue                   #        -> AttributeError, OUTSIDE the catch
```

So: make the fake return bare `None`, add a direct fake-contract test for that shape, and
**require both the `execute()` AND the response unwrapping to sit inside the reconciliation
`try`.**

**(c) `.eq(column, None)` must FAIL FAST in the fake** — round 5's blocker, and the same class
again. The fake's `.eq()` stores Python `None` (`test_persist.py:77`) and its matcher treats a
missing/NULL value as equal to `None` (`test_persist.py:90`). So this CAS passes **all 16 cases
AND the standalone `.is_()` contract test**, while being a silent no-op in production:

```python
.update(patch).eq("id", row["id"]).eq("country_code", None)   # WRONG: must be .is_(…, "null")
```

Real PostgREST serializes `eq(None)` as `eq.None` — it matches **zero** NULL rows. The CAS
touches nothing, reconciliation sees the row still NULL, returns its id unrepaired, and
production stays 0/4 while the whole offline suite is green. §6's live acceptance would catch it;
the unit gate that claims to be load-bearing would not.

**Make `_Table.eq(col, None)` RAISE** rather than merely not-match. `eq(None)` is never a valid
PostgREST filter — turning it into a loud test failure converts a silent production no-op into an
immediate red. Add **case 17** proving `.eq(None)` cannot substitute for `.is_(col, "null")`.

**(d) `maybe_single()` must RAISE on multiple rows** — round 6's blocker, the last of this class.
Real PostgREST raises when `maybe_single()` matches more than one row; the fake does not. So a
re-read that forgets its filter stays green:

```python
.select("id,country_code").maybe_single()      # WRONG: missing .eq("id", row["id"])
```

Cases 7, 8, 14 and 15 all happen to seed at most one relevant row, so the unfiltered fake re-read
returns the right thing by luck. In production it sees every global row, real `maybe_single()`
raises, the catch swallows it, and a racer inserts a duplicate instead of resolving the row.

So: make the fake raise on multi-row `maybe_single()` (**case 18** pins it), **and seed case 7
with an unrelated out-of-bbox row** so omitting `.eq("id", row["id"])` reddens.

### T2 — Candidate projection
`_find_or_create_place`'s select already fetches `country_code` (arc 2). Add `country`,
`country_name` **only if** the implementation needs them to decide; it should not — the decision
is `country_code IS NULL` and the values written come from `grounded`. Prefer not widening.

### T3 — The repair
Compare with `_coord_cache_key(place.lat, place.lng) == _coord_cache_key(row["lat"], row["lng"])`
— reuses the lossless helper and its signed-zero normalization. **Note for the reviewer:** for
finite coordinates this is behaviourally equivalent to raw `==`, including signed zero, so a
`-0.0` test does **not** prove the helper is used. Helper use is a DRY contract, not a
test-enforceable one; do not write a test claiming otherwise.

CAS shape:
```python
.update(patch).eq("id", row["id"]).is_("country_code", "null")
```
Write all three fields from `grounded` (`country` = the country NAME, matching `p_country`).

**Best-effort, narrowly scoped (guardrail #3):** wrap ONLY the repair call. Any exception → no
repair, the place still links, the trip still saves. Catch `Exception`, never `BaseException`, so
a lost lease's `CancelledError` keeps propagating.

### T4 — Tests
Every case must be proven to redden by deleting its own guard.

| # | Case | Required assertion | Wrong impl it kills |
|---|---|---|---|
| 1 | exact NULL hit | same id, no insert, all three fields from the **provider-grounded** values | no-op; partial write; LLM-claim-derived write |
| 2 | idempotent rerun | second run returns the same id and issues **no second update** | unconditional rewrite of compatible rows |
| 3a | one-ULP neighbour on **latitude** (`math.nextafter`) | candidate reused but **stays NULL** | proximity / rounding / bucketed projection |
| 3b | one-ULP neighbour on **longitude** | candidate reused but **stays NULL** | a comparator checking only the axis the other fixture perturbs — round 2 found 3a alone lets it pass all twelve |
| 4 | cache populated but `grounded is None` | row stays NULL | repairing from the cache instead of the in-memory receipt |
| 5 | exact-coordinate row with a **different name** | untouched; the real candidate wins | running F before the name/distance gates |
| 6 | exact-coordinate row with a **conflicting** country | R1 skips it; it stays untouched | running F before R1 |
| 7 | two pipeline racers | exactly **one** CAS matches; both resolve the same compatible id | missing CAS; a fake `.is_()` no-op |
| 8 | CAS loser finds it now conflicting | loser re-reads, rejects that id, falls through to a compatible candidate or a correct insert | "CAS then always return id" |
| 9 | repair request raises | row still links; fenced replacement completes | unwrapped repair exception |
| 10 | lease lost during repair | `CancelledError` propagates; no stale trip rewrite | `except BaseException`; misplaced isolation |
| 11 | lease lost **after** a successful repair | the global repair remains; prior itinerary unchanged; `LeaseLost` surfaces | assuming the trip fence rolls global writes back |
| 12 | fake contract | `.is_()` changes only NULL rows and returns only matches | a fake that accepts but ignores `.is_()` |
| 13 | **a failure raised AFTER candidate selection, inside the match logic** — monkeypatch `_place_matches` or `haversine_m` to raise | it **propagates**; the trip degrades as it does today, not silently | a broad **per-candidate** `try` around matching + CAS + re-read. Round 3 found the earlier version of this case (candidate *select* raises) only killed a whole-*function* catch, because a per-candidate wrap sits after the select and never sees it. This placement is the one that pins the boundary. |
| 15 | CAS returns zero rows, then the **re-read RAISES** | candidate A is **never returned**; resolution picks a seeded compatible B or inserts correctly | treating a failed reconciliation read as "good enough, return A". Round 3: case 9 (the CAS *request* raising, which deliberately permits linking) cannot also prove this — they are different branches. |
| 14 | candidate **deleted** between select and re-read — the fake MUST return a bare `None`, not `_Result(None)` | `continue`; never returns the dead id | returning a missing row's id → FK failure; **and** unwrapping `.data` outside the `try`, which only reddens against the real bare-`None` shape |
| 16 | fake contract: zero-row `maybe_single()` | returns a **bare `None`**, not a result object | a fake whose shape production does not share — the round-4 blocker |
| 17 | fake contract: `.eq(col, None)` | **raises** — it is never a valid PostgREST filter | a CAS written as `.eq("country_code", None)`, which passes all 16 other cases and the `.is_()` contract test while matching zero rows in production — the round-5 blocker |
| 18 | fake contract: multi-row `maybe_single()` | **raises**, as real PostgREST does | a re-read missing `.eq("id", row["id"])` — the round-6 blocker. Case 7 must also seed an unrelated out-of-bbox row, or the unfiltered re-read returns the right row by luck |

**Case 8 is reachable, but not between two pipeline workers** (round 2): two pipeline workers
sharing the same exact-coordinate receipt write the same value, so the loser never sees a
conflict. Construct it as pipeline-vs-RPC: (1) the pipeline reads exact candidate A as NULL,
(2) pause before its CAS, (3) an RPC-shaped writer commits a *conflicting* country derived from a
nearby coordinate, (4) resume the CAS — it matches zero rows, (5) assert the re-read rejects A and
selects a seeded compatible candidate B, or inserts correctly. This tests **F as the CAS loser**.
It does **not** assert the reverse, corrupting interleaving is safe.

**Do not** write a green test asserting the RPC race is safe (§5).

## 4b. A rule that is real but UNFALSIFIABLE — recorded, not faked

§3's second hard rule ("F runs only after R1's conflict check") **cannot be pinned by any test
against the code as shipped**, and the implementer and the per-task reviewer established this
independently:

- R1 fires only when `row["country_code"]` is truthy **and** conflicts.
- F fires only when `row["country_code"] is None`.

The two predicates are **mutually exclusive on the same row**, so no row can reach both blocks
and the ordering is behaviourally unobservable. Moving F above R1 leaves the entire suite green.
Case 6 reddens only under the *full* wrong implementation — hoisted above R1 **and** the NULL
guard dropped **and** a plain update instead of the CAS — because three independent guards each
defeat it alone.

**Keep the rule. Do not write a test that pretends to pin it.** The rule is defence-in-depth for
a *future* loosening of either guard (e.g. NULL → "NULL or empty string"), at which point the
predicates stop being disjoint and the ordering starts to matter. A test asserting it today would
pass for reasons unrelated to what it claims — precisely the false-green this arc exists to
eliminate. Case 6's docstring says so in the test file; this section says so in the plan.

**Trigger to revisit:** any change that loosens F's NULL guard or R1's conflict guard.

## 5. The RPC race — an ACCEPTED RESIDUAL RISK, not benign

**The §5c sketch claimed this race was benign. That claim was false and is retracted.**

`find_or_create_place` can select a NULL same-name row using **any** input coordinate within
500 m (`20260720190000:82`), then overwrite `country` **unconditionally** (`:117`). Its country
was verified for the **RPC's** incoming coordinate, not the selected row's. "Both are verified
within 500 m" is insufficient — **arc 2's R1 exists precisely because 500 m can cross a border.**

The race is **pre-existing**. F narrows it whenever F writes first, but no Python-only change
closes an RPC that has already selected the row and later overwrites. Closing it needs the RPC to
gain a conditional update — a migration, out of scope here (and blocked anyway by the
alias/normalization gap that killed convergence). **Record the deterministic corrupting
interleaving as deferred evidence; do not paper over it.**

Pre-fence global writes are otherwise acceptable: a completed repair is global, idempotent
provenance — the same shape as the existing pre-fence cache and insert effects. A superseded
worker may leave a valid repair behind while the itinerary fence still blocks its trip rewrite.

## 6. Constraints and done

- No migration in this arc (none in any of the three).
- Frozen `#16` anchor `6229.0` — F writes to `places`, never to which places survive. Run
  `uv run pytest evals/ -q` regardless.
- Guardrails #1 (only ever write a receipt that describes *that* row's coordinate), #3, #7.
- **Live acceptance — an observable procedure, not a vibe** (round 2 found the first wording
  unobservable: identical `live_run` inputs only re-inspect the idempotent prior trip, and the
  place inspection omits `updated_at`).
  1. Add `updated_at` to `live_run.py`'s place select.
  2. Run reel `DXwcVVliX3B` with a **fresh date window** (new idempotency key). Snapshot: the four
     row ids, the three country fields per row, and `updated_at`. (No global `places` count —
     round 4 polish: the per-row `[REUSED]` observable already establishes that global growth is
     irrelevant.)
  3. Require **4/4 rows `[REUSED]` and repaired**.
     **"Zero new rows" means zero new rows from `_find_or_create_place`, NOT a global count**
     (round 3 asked for this): the restaurant writer legitimately inserts `places` rows on every
     run — run 3 showed several `POST /places 201` from it — so the global total WILL grow and
     that is unrelated. The observable is per-row: every one of the trip's four linked places
     must print `[REUSED]`, i.e. `created_at` earlier than the trip's.
  4. Run again with a **second fresh window**. Require the four row **ids**, their country
     triples, **and `updated_at`** all unchanged — that is the fixed point. `updated_at` is the
     only field separating "no second write" from "an idempotent rewrite", and the ids must be
     printed for the comparison to be possible at all.
- **Rollback:** reverting F stops future repairs; rows already repaired remain valid receipts.
  Schema-safe, no migration to unwind.


---

## 7. FINAL RECORD — all gates green, MERGE-READY (2026-08-03)

| Gate | Result |
|---|---|
| Plan — Codex ×6 | 5.4 → 6.5 → 6.8 → 6.9 → 6.9 → closed on the reviewer's own advice that further plan rounds were the wrong instrument |
| Code — `astrail-reviewer` per-task | **APPROVE WITH MINORS** (both minors closed or recorded) |
| Code — `astrail-reviewer` whole-branch, all 3 arcs (fable) | **MERGE** — 12 fault injections, each killed by exactly its intended test |
| Code — Codex final cross-model | **DO-NOT-MERGE → MERGE** after two P1s |

**Every one of the six plan-gate findings was a test-harness fidelity gap** — the fake diverging
from the real postgrest client — not a defect in F's design, which was stable from round 2. The
four fixes (`.is_()` NULL semantics, bare-`None` `maybe_single`, raising `.eq(col, None)`, raising
multi-row `maybe_single`) are the durable value here: they close a class of false-green for every
future test in this file.

### The two P1s the final cross-model gate caught

1. **Credential leak (SECURITY).** `live_run.py`'s `_configure_logging` set the ROOT logger to
   INFO, so `httpx` logged full Mapbox URLs **including `access_token=sk...`**. Real secrets were
   printed during this branch's live smokes. Fixed with an explicit allow-list
   (`_VERBOSE_LOGGERS`) plus pinned `_NOISY_TRANSPORT_LOGGERS`, following
   `telegram_ingest/worker.py`'s existing pattern, with a canary regression test. The
   implementer found a **second** channel nobody had named: `realtime` logs
   `wss://…?apikey=<SERVICE_ROLE_KEY>` at DEBUG. **`MAPBOX_SECRET_TOKEN` must be rotated.**
2. **`_ground_all` swallowed a child-origin `CancelledError`.** `gather(return_exceptions=True)`
   captured it and the `isinstance(r, BaseException)` filter discarded it, so a lost lease's abort
   became a group of silent NULLs and the superseded worker walked on into the destructive
   rewrite. **The fable whole-branch review had called this "unreachable defensive code,
   cosmetic".** Codex reproduced it. Fixed by re-raising `BaseException` explicitly while keeping
   `return_exceptions=True` for its real property — draining siblings rather than leaving them
   detached mid-cache-write.

That second one is the clearest single justification for running both final gates: one model
called it cosmetic, the other reproduced it as a P1.

### Required before the Render deploy — NOT before merge

1. **Rotate `MAPBOX_SECRET_TOKEN`** — install the replacement, verify, then revoke the exposed one.
2. Arc 3's two-run live acceptance (§6), two different fresh date windows.
3. Confirm the smoke output contains **no** `access_token=` and no service-role credential.
4. Wall-clock against the 180 s target; terminal `result` then `[DONE]`.
5. Deploy the exact merged `dev` SHA manually (`autoDeploy:false`); all three arcs together,
   since R1 and F depend on arc 1's grounded dict.
6. Post-deploy: `/health`, one authenticated `/generate-trip`, persisted receipts, clean logs.

**Waived with reason:** arc 2's conflicting-country live smoke would require manufacturing
contradictory production data. Recorded as a waiver rather than seeding bad rows.

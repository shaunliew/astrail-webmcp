# PLAN — repair a NULL `country` when a trip dedups onto an existing `places` row

> Status: **PLAN ONLY, no code written.** Follow-up to
> `2026-08-02-places-country-two-writers.md` (merged-ready branch `fix/places-country-verified`).
> Surfaced by that branch's final whole-branch review as the strongest remaining gap.
>
> **This is a change to the LIVE web trip-generation pipeline.** `pipeline/persist.py` runs on
> every `/generate-trip`. Beta is 2026-08-08.

---

## 1. The gap

The parent branch makes `persist_itinerary` write a **verified** country on the INSERT path.
It does nothing on the **dedup-hit** path: `_find_or_create_place` returns `row["id"]` and
discards the verification it just paid Mapbox for.

Three facts compound (all three found by the parent branch's fable whole-branch review):

1. `_find_or_create_place`'s dedup hit returns the row id with **no country repair**
   (`persist.py:226-228`).
2. `_find_or_create_restaurant_place` (`persist.py:~529`) keeps minting **new country-less
   rows** — including NULL doppelgängers of a just-verified reel row for the same venue in the
   same trip, because restaurant dedup is `mapbox_id`-only and never reuses the reel row.
3. A later trip's grounded reel place matches whichever bbox candidate comes back first
   (an unordered select, first-match loop), so it can **nondeterministically absorb into the
   NULL twin** even when a verified row for the same venue exists.

Net: food venues featured in Reels — core to the product — can render NULL in `PlaceIntelPanel`
indefinitely, and the Mapbox call made for them is wasted. The corpus does **not** "improve
forward-only" as the parent plan's §6d assumed.

## 2. The decision: FILL-IF-NULL only. Explicitly NOT the RPC's overwrite.

The review that surfaced this recommended "mirroring the RPC's existing behaviour." **Read the
RPC before copying it — it does something stronger, and the stronger thing is wrong here.**

`find_or_create_place` (`20260720190000:96-104`) **overwrites** `country`/`country_code`/
`country_name` on reuse, reasoning that "this run RE-VERIFIED them against Mapbox, so the fresh
value is strictly better than the stored one." That is sound **there** because its reuse
predicate already constrains country:

```sql
where name = p_name
  and (country_code = p_country_code or country_code is null)   -- agrees, or is unset
```

A row it reuses therefore either already agrees with the freshly verified country or has none.

**`persist.py`'s gate is different and weaker: name/alias match + haversine < 500 m, with no
country term at all** (`persist.py:221-228`). So a row it reuses can carry a *different*
non-NULL country, set from **a coordinate we did not verify** (two same-named venues 500 m
apart across a border is the real case). Overwriting it would replace a verification receipt for
one coordinate with a receipt for another — writing an unverified claim about that row.
That is guardrail #1 pointing the other way.

**Therefore: write the three columns ONLY when the existing row's `country_code` IS NULL.**
Never overwrite a non-NULL value. Strictly narrower than the RPC, and the asymmetry is a
consequence of the weaker dedup gate — not an oversight. If §5 of the parent plan is ever done
(converging the two writers onto the RPC), this restriction disappears with it.

## 3. Tasks

### T1 — Fetch `country_code` in the candidate query

`_find_or_create_place`'s select is `"id,name,aliases,lat,lng"`. Add `country_code` so the
NULL-vs-set decision needs no second round-trip. It is one more column on a query that already
runs per place.

### T2 — Repair on the dedup hit

When a candidate matches AND `grounded is not None` AND the matched row's `country_code` is
NULL, `UPDATE` that row's `country` / `country_code` / `country_name` from the verified result,
then return its id. All three or none (`places_country_fields_pair_check`).

**Best-effort (guardrail #3):** the repair is an optimisation, not the trip. Wrap it so any
failure is swallowed — the place still links, the trip still saves, the row just stays NULL as
it is today. Log the exception TYPE only, never the message.

**Idempotent:** a second run sees a non-NULL `country_code` and issues no write.

### T3 — Tests

| # | Case | Expected |
|---|---|---|
| 1 | dedup hit onto a **NULL-country** row, grounding verified | row repaired to `Japan/JP/Japan`; trip links to it |
| 2 | dedup hit onto a row that **already has** a country, ours differs | **NOT overwritten** — the anti-RPC guard |
| 3 | dedup hit, grounding returned `None` | no UPDATE issued at all |
| 4 | the repair UPDATE raises | trip still persists, place still linked (guardrail #3) |
| 5 | INSERT path (no dedup hit) | exactly one write; no stray repair UPDATE |
| 6 | run twice | second run issues no UPDATE (idempotent) |

Case 2 is the load-bearing one: it is the only test that distinguishes this design from the
RPC's overwrite, and an implementation that copies the RPC passes every other case.

Per the parent branch's hard-won lesson — **state what makes each test red when its guard is
removed, then prove it by deleting the guard.** The parent arc's 10 blocking findings were all
tests that could not fail.

## 4. Constraints

- `pipeline/persist.py` is on every `/generate-trip`. No migration ships.
- Frozen `#16` anchor `mean_intra_day_travel_m = 6229.0` (`evals/test_run_eval.py:82`). This
  change cannot affect it — it writes to `places`, never to which places survive — but run
  `uv run pytest evals/ -q` anyway.
- Guardrail #1 (never write an unverified country), #3 (best-effort), #7 (cache untouched).
- **Out of scope, unchanged:** the third writer (`_find_or_create_restaurant_place` still mints
  country-less rows — this plan reduces the damage, it does not stop the source), the 90-row
  backfill, and the §5 dedup convergence.

## 5. Definition of done

- A dedup hit onto a NULL-country row repairs it; a hit onto a set-country row does not.
- Every test above passes and each has been proven to redden from its own guard.
- `uv run pytest -q` and `uv run pytest evals/ -q` green, anchor intact.
- Plan reviewed (Codex) before code; per-task review + final gates after.

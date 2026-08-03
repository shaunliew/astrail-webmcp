# PLAN — R1: stop reusing a `places` row whose country contradicts the verified one

> Status: **PLAN ONLY, no code written. RE-SCOPED 2026-08-03 to R1 alone**, on the plan
> reviewer's direct recommendation after two rounds (4.7/10, then 6.2/10 on the full R1–R4).
> R2–R4 are specified in §6 and **deferred until after beta** with their open problems recorded.
>
> Follow-up to `2026-08-02-places-country-two-writers.md` (branch `fix/places-country-verified`,
> merge-ready). **`pipeline/persist.py` runs on every `/generate-trip`.** Beta is 2026-08-08.

---

## 1. The bug — present in production today

`_find_or_create_place`'s dedup gate is **name/alias match + haversine < 500 m, with no country
term** (`persist.py:221-228`).

An incoming Malaysian venue whose name matches a Singapore row 400 m away is **linked to the
Singapore row**. The trip renders the wrong country and the wrong canonical pin. This is not
caused by the parent branch — the parent branch made it *visible*, by giving us a verified
country to compare against for the first time.

Two rounds of review agreed this is the highest-value part of the follow-up and that it **stands
alone**: no provider latency, no repair path, no concurrency guard.

## 2. The decision — R1: reject, don't merely refrain from writing

**When we hold a grounded (verified) result, skip any candidate whose non-NULL `country_code`
differs from the verified code.** Fall through to the next candidate; if none is compatible,
insert a new verified row.

The first draft of this plan proposed only *suppressing the write* on such a row. That was
wrong and the mistake is worth keeping on record:

> Suppressing the write still **returns that row's id**. The Malaysian trip stays linked to the
> Singapore pin. Not overwriting a wrong answer is not the same as not using it.

**When we have no grounded result** (`grounded is None` — no claim, placeholder URL, provider
failure), behave **exactly as today**: no country term, first match wins. This change must not
alter dedup for the unverified path, or a Mapbox outage would silently start forking the
`places` corpus.

### Why this cannot orphan a trip (verified against the code)

Day grouping happens before place-id resolution (`persist.py:340`), and every id is resolved
**before** the fenced itinerary replacement (`persist.py:319`). A lookup or insert failure
leaves the prior itinerary intact. R1 does not regroup days.

It *can* produce more `places` rows — deliberately, when the only nearby same-name row has
contradicting provenance. **That is the point**, and it is strictly safer than linking a trip
across a border. It may also change the `dropped` count by preventing two canonical inputs from
collapsing onto one global id, which *preserves* an intended stop rather than losing one.

## 3. Tasks

### T1 — Fix the test fake's projection handling (prerequisite P1)

`test_persist.py`'s `_Table` **ignores `.select()` projections** and returns whole rows
(`test_persist.py:67,117`). So an implementation that forgets to add `country_code` to the
production select passes every test, while real PostgREST omits the column,
`row.get("country_code")` is `None`, and the conflicting row is reused anyway — the exact bug
R1 exists to fix, shipped green.

Make the fake honour the projection, and add a **direct fake-contract test** proving an
unselected column is absent from the returned dict. Without that test, P1 itself is unverified.

### T2 — Fetch `country_code` in the candidate query

`"id,name,aliases,lat,lng"` → add `country_code`. One more column on a query that already runs
per place. (Ordering by `(country_code is null)` — preferring verified rows — is **R2**, not
here.)

### T3 — Reject conflicting candidates

In the match loop, after the name and distance gates pass, skip the candidate when
`grounded is not None` and `row["country_code"]` is non-NULL and differs from
`grounded["country_code"]`. Continue the loop.

### T4 — Tests

| # | Case | Expected | Wrong impl it kills |
|---|---|---|---|
| 1 | conflict-only candidate | **not reused**; a new verified row is inserted | suppress-the-write-but-still-reuse (the first draft) |
| 2 | **conflict first, compatible second** | the compatible row is reused; no insert | inserting immediately on the first conflict |
| 3 | compatible candidate (same code) | reused, as today | over-rejecting |
| 4 | candidate with **NULL** country_code | reused, as today (repair is R3, deferred) | rejecting NULL rows as "conflicting" |
| 5 | `grounded is None` | first match wins, **exactly as today** | applying the country term on the unverified path |
| 6 | fake-contract: unselected column absent | `country_code` missing from the row dict | P1 not actually implemented |

Case 2 is the one round 2 specifically called out as missing: an implementation that inserts on
the first conflict passes Case 1 and still violates the required fall-through.

Per the parent arc's lesson — **10 of its 10 blocking findings were tests that could not fail** —
state what makes each red when its guard is removed, then delete the guard and prove it.

## 4. Constraints

- No migration. `pipeline/persist.py` is on every `/generate-trip`; beta 2026-08-08.
- Frozen `#16` anchor `6229.0` — R1 changes which global row a place links to, never which
  places survive. Run `uv run pytest evals/ -q` regardless.
- Guardrails #1 (never write **or reuse** an unverified/contradicting country), #3, #7.
- **R1 depends on the parent branch's grounded result**, so merge the parent and R1 before the
  same manual Render deploy, or deploy them back-to-back.

## 5. Definition of done

- A conflicting-country candidate is never reused; a compatible one still is; the unverified
  path is byte-for-byte unchanged.
- All six tests pass, each proven to redden from its own guard.
- `uv run pytest -q` and `uv run pytest evals/ -q` green, anchor intact.
- **Live smoke: a conflicting-country dedup** (not the NULL-repair smoke — that belongs to R3).

## 6. DEFERRED to after beta — R2, R3, R4, with their open problems

Specified here so the reasoning is not lost. **Do not implement these without re-gating.**

- **R2 — prefer a compatible verified candidate over a NULL one**, so repeated generations
  converge instead of oscillating with the first-match loop. *Open problem:* a row can legally be
  `(country=NULL, code=JP, name=Japan)` (`places_country_fields_pair_check` pairs only code and
  name; `country` is unconstrained), and a legacy row can carry a poisoned `country`/`country_name`
  beside a correct code (`20260720190000:98`). R2 as drafted would call such a row "verified" and
  prefer it.
- **R3 — repair a NULL candidate by reverse-geocoding the ROW'S OWN coordinate** and comparing
  against the incoming claim (never projecting our coordinate's receipt onto it — the repo
  refuses to let even an 11 m neighbour stand in, `grounding.py:35-48`). *Open problems:* (i) it
  must **fail closed** — if row-coordinate grounding returns `None`, reject that candidate too,
  otherwise a Malaysian input still reuses a Singapore-coordinate NULL row; (ii) it is **not**
  full two-source venue agreement — Mapbox verifies the row's coordinate, and the incoming claim
  is only a compatibility gate, since name+500 m can merge different chain branches
  (`persist.py:512`). Do not describe it as two-source agreement.
- **R4 — atomic repair write** (`.is_("country_code", "null")` CAS, zero rows → re-read and reuse
  only if compatible). *Open problem:* this closes pipeline-vs-pipeline only. The RPC writer can
  select a NULL row, lose the CAS, and then **overwrite unconditionally** (`20260720180000:93`);
  that cross-writer race cannot be closed without converging on the RPC (parent plan §5). Record
  it as unresolved rather than implying R4 fixes it. The fake also has no `.is_()` and must gain
  real NULL semantics plus matched-mutation counts.

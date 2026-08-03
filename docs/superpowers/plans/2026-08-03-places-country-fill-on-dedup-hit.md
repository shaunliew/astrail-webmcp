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

Round 3 specified the exact fixture shape each case needs; a loose reading of the same six
lets a wrong implementation through, so build them this way:

| # | Case | Fixture + required proof | Wrong impl it kills |
|---|---|---|---|
| 1 | conflict-only candidate | assert the trip links the NEW id, exactly one verified row inserted with all three country fields, and **the conflicting row is untouched** | suppress-the-write-but-still-reuse (the first draft) |
| 2 | **conflict first, compatible second** | both candidates must pass the name AND `<500m` gates; assert the exact compatible id and **zero inserts** | inserting immediately on the first conflict |
| 3 | compatible candidate | same `country_code` but **deliberately poisoned/different `country`/`country_name`**; assert reuse | an implementation comparing NAMES instead of the code — it passes all six otherwise |
| 4 | candidate with explicit `country_code: None` | assert its exact id is reused, with no insert and no repair | rejecting NULL rows as "conflicting" |
| 5 | `grounded is None` | JP-claim place, **SG first / JP second**; assert SG (the first match) wins, no insert, rows unchanged | applying the country term on the unverified path |
| 6 | fake-contract | seed `{id, country_code}`, call `.select("id")`, assert the result is **exactly** `{"id": ...}` | P1 not actually implemented |

Case 5 cannot literally prove "byte-for-byte today" — T2 necessarily changes the response
projection. It proves the observable contract (country-agnostic first-match, identical returned
id, identical insert behaviour); code review confirms nothing else on the unverified path moved.
Case 6 pins T1's fake contract; cases 1–2 then pin T2, but **only once the fake omits unselected
fields**. That layering is deliberate.

Case 2 is the one round 2 specifically called out as missing: an implementation that inserts on
the first conflict passes Case 1 and still violates the required fall-through.

Per the parent arc's lesson — **10 of its 10 blocking findings were tests that could not fail** —
state what makes each red when its guard is removed, then delete the guard and prove it.

## 4. Constraints

- No migration. `pipeline/persist.py` is on every `/generate-trip`; beta 2026-08-08.
- Frozen `#16` anchor `6229.0`. **Precision (round 3):** the eval is safe because it does not
  exercise persistence at all — *not* because persisted stop survival cannot change. R1 can
  change `dropped` by avoiding an id collision, which **preserves** a stop that would otherwise
  have been skipped. Run `uv run pytest evals/ -q` regardless.
- Guardrails #1 (never write **or reuse** an unverified/contradicting country), #3, #7.
- **R1 depends on the parent branch's grounded result**, so merge the parent and R1 before the
  same manual Render deploy, or deploy them back-to-back.

## 5. Definition of done

- A conflicting-country candidate is never reused; a compatible one still is; the unverified
  path is byte-for-byte unchanged.
- All six tests pass, each proven to redden from its own guard.
- `uv run pytest -q` and `uv run pytest evals/ -q` green, anchor intact.
- **Live smoke: a conflicting-country dedup** (not the NULL-repair smoke — that belongs to R3).

## 5b. Review record

| Gate | Result |
|---|---|
| Plan — Codex ×3 | 4.7 (full R1–R4) → 6.2 → **8.1 PASS** (re-scoped to R1 alone on the reviewer's own sequencing advice) |
| Code — `astrail-reviewer` per-task | **APPROVED** — all 6 fault injections independently reproduced |
| Code — Codex final, combined branch | **MERGE** — 18 mutations reddened their intended tests; no vacuous test; R2/R3/R4 confirmed absent |

The first draft's error is preserved in §2 because it is easy to repeat: suppressing the write
on a conflicting row still returns that row's id.

## 6. DEFERRED to after beta — R2, R3, R4, with their open problems

Specified here so the reasoning is not lost. **Do not implement these without re-gating.**

- **R2 — prefer a compatible verified candidate over a NULL one**, so repeated generations
  converge instead of oscillating with the first-match loop. **The concrete ordering R1 leaves
  uncovered** (named by the final gate, and deliberate): candidates ordered
  *conflicting-SG → NULL-country → compatible-MY*. R1 skips SG, reuses the NULL row, and never
  reaches MY. That leaves the country honestly NULL rather than wrong, repairs nothing and
  duplicates nothing — but it means an existing NULL row can still absorb a verified place.
  This is the case R2 exists to fix. *Open problem:* a row can legally be
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

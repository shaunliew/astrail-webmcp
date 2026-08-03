# PLAN — the dedup-hit path: reject conflicting countries, repair NULL ones safely

> Status: **PLAN ONLY, no code written. REWRITTEN 2026-08-03 after a plan review scored the
> first draft 4.7/10 (Correctness 3, Safety 3, Testability 2).** §2 records what the first
> draft got wrong, because the mistake is instructive and easy to make again.
>
> Follow-up to `2026-08-02-places-country-two-writers.md` (branch `fix/places-country-verified`,
> merge-ready). **`pipeline/persist.py` runs on every `/generate-trip`.** Beta is 2026-08-08.

---

## 1. Two problems, one seam

`_find_or_create_place`'s dedup gate is **name/alias match + haversine < 500 m, with no country
term** (`persist.py:221-228`). That produces two distinct defects.

**(A) A bug that exists in production RIGHT NOW, independent of any of this.** An incoming
Malaysian venue whose name matches a Singapore row 400 m away is linked to the Singapore row.
The trip renders the wrong country and the wrong canonical place. Nothing in the current code
prevents it; the parent branch merely made it *visible*, because we now hold a verified country
to compare against.

**(B) The gap the parent branch's whole-branch review flagged.** On a dedup hit we return
`row["id"]` and discard the verification we just paid Mapbox for. Combined with the still-
deferred third writer (`_find_or_create_restaurant_place` keeps minting country-less rows) and
the unordered first-match loop, a verified food venue can render NULL indefinitely.

## 2. What the first draft got wrong — read this before "simplifying" the plan back

The first draft proposed **fill-if-null, and nothing else**. Its Case 2 asserted that a reused
row with a *conflicting* country must not be overwritten. That is true and insufficient:

> Suppressing the write still **returns that row's id**. The Malaysian trip stays linked to the
> Singapore pin. Not overwriting a wrong answer is not the same as not using it.

**A differing non-NULL country must REJECT the candidate, not merely suppress the update.**

The draft also assumed filling a NULL row from *our* coordinate was safe. It is not: the reused
row's stored coordinate can be up to 500 m from ours, and this repo's own
`_coord_cache_key` docstring (`grounding.py:35-48`) refuses to let an **11 m** neighbour stand in
for exact-coordinate verification, precisely because two nearby points can straddle a border.
Filling row R's country from coordinate C is a receipt for C, stamped onto R. That breaks the
invariant the parent branch exists to protect.

Finally, the draft repeated an error already corrected in the parent plan:
`places_country_fields_pair_check` pairs only `country_code` and `country_name`. **`country`
itself is unconstrained**, so `(country=NULL, code=JP, name=Japan)` is a legal row.

## 3. The decision

Three rules, in this order.

**R1 — Reject conflicting candidates.** When we hold a grounded result, skip any candidate whose
non-NULL `country_code` differs from the verified code. Fixes (A). This is the highest-value
part of the change and it stands alone.

**R2 — Prefer a compatible verified candidate** over a NULL-country one, so repeated generations
converge on the verified row instead of oscillating with the first-match-wins loop.

**R3 — Repair a NULL candidate only against ITS OWN coordinate.** Do not project our receipt
onto it. Reverse-geocode the **row's stored `lat`/`lng`** and compare against the incoming
place's claimed country; fill only on agreement. Reuse `_ground_place` — build a
`place.model_copy(update={"lat": row["lat"], "lng": row["lng"]})` so the existing gates and the
existing coordinate cache both apply unchanged. The receipt then genuinely describes that row.

Cost: one extra reverse call per NULL-country dedup hit, absorbed by `geocode_country_cache` on
repeats. This is what makes R3 worth doing at all — the byte-identical-coordinate alternative
would almost never fire, since the motivating case is a Mapbox-POI row meeting an LLM
coordinate, which are never byte-identical.

**R4 — The repair write is atomic.** `.eq("id", row_id).is_("country_code", "null")` so two
concurrent trips cannot last-writer-wins. A zero-row result means someone else won: re-read that
row and reuse it **only if its country is now compatible**, else fall through to the next
candidate. (`20260720180000:31` documents this exact race for the RPC's own NULL path.)

**Best-effort throughout (guardrail #3):** every repair step is an optimisation, never the trip.
Any failure → no repair, place still links, trip still saves. Catch `Exception`, never
`BaseException`.

## 4. Tests — and the fake has to be fixed first

The plan review found the current fake **cannot observe** most of what this change does. Two
prerequisites, both real defects in the test harness:

**P1 — the fake ignores `.select()` projections** (`test_persist.py:67,117`) and returns whole
rows. So forgetting to add `country_code` to the production select passes every test, while real
PostgREST omits it, `row.get("country_code")` is `None`, and production overwrites a set country.
Make the fake honour the projection.

**P2 — the fake records no operation ledger.** "Issues no UPDATE" is unobservable. Record
(table, op) per `execute()` and assert against it.

| # | Case | Expected | Wrong impl it kills |
|---|---|---|---|
| 1 | conflicting non-NULL country candidate | **not reused, not written**; insert a new verified row | fill-if-null-only (the first draft) |
| 2 | NULL candidate, row's OWN coord verifies | repaired + reused | projecting our receipt onto the row |
| 3 | NULL candidate, row's own coord DISAGREES with the claim | **not repaired**; row stays NULL | grounding our coordinate instead of the row's |
| 4 | both a verified-compatible and a NULL candidate present | the **verified** one is reused (R2) | first-match-wins |
| 5 | grounded is `None` | no UPDATE issued at all (ledger) | unconditional repair |
| 6 | repair UPDATE raises | trip persists, place linked, only the exception **type** logged | non-best-effort; leaking the message |
| 7 | run twice | second run issues no UPDATE (ledger) | RPC-style unconditional update |
| 8 | two concurrent trips, same NULL row, different countries | atomic guard: exactly one write; loser re-reads and only reuses if compatible | non-atomic read/check/write |
| 9 | poisoned name (claim `JP`/"United States", provider `JP`/"Japan") | row reads `Japan` | writing the LLM's claim during repair |
| 10 | INSERT path (no candidate) | exactly one write, no stray UPDATE | repair firing on the insert path |

Per the parent arc's lesson — **10 of its 10 blocking findings were tests that could not fail** —
state what makes each red when its guard is removed, then delete the guard and prove it.

## 5. Constraints and scope

- No migration. `pipeline/persist.py` is on every `/generate-trip`; beta 2026-08-08.
- Frozen `#16` anchor `6229.0` — unaffected in principle (this writes to `places`, never to
  which places survive), but run `uv run pytest evals/ -q` anyway.
- Guardrails #1 (never write an unverified country — including never *reusing* a row whose
  country contradicts the verified one), #3, #7.
- **A live dedup-hit smoke is part of done**, not optional: arrange a NULL-country row, run a
  trip that dedups onto it, confirm the repair. The current `live_run.py` prints state but
  arranges nothing.
- **Out of scope:** the third writer (this reduces the damage, it does not stop the source —
  give it a concrete trigger), the 90-row backfill, and the §5 RPC convergence. If convergence
  ever happens, R1–R4 all collapse into the RPC and should be deleted.

## 6. Honest scope note

This is **no longer the small follow-up** the parent review implied. R1 changes dedup matching on
the live path, R3 adds a provider call, R4 adds a concurrency guard, and the test harness needs
two fixes before any of it is observable. Rule R1 alone fixes a real current bug and could ship
separately if the rest slips past beta.

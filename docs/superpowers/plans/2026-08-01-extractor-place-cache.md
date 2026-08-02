# PLAN B — Extractor place-cache shortcut (Arc 2)

> Status: **PLAN, revision 9 — SCOPE CUT TO T1–T3 (schema + probe). T4–T6 are PAUSED.**
> **Round 8 PASSED the pair: 8.5/10 — READY TO IMPLEMENT** (Correctness 8.8, Deployment safety 8.6,
> Completeness 8.4, Risk 8.8, Clarity 7.8; no blockers, no majors). Eight rounds:
> 4.6 → 5.2 → 5.5 → 6.4 → 6.8 → 6.0 → 6.5 → **8.5**.
>
> - **Round 2** marked this plan's kill switch **NOT FIXED** — structural, not patchable at the
>   cache layer — so T4–T6 were paused and the five preconditions recorded (§8).
> - **Round 3** judged *"T1 and T3 are safe; T2 is viable but the privilege contract, research
>   timestamp, test updates and rollback order must be fixed first"* — all four fixed (§13).
> - **Round 4** fixed §10's stale cross-plan contract and the pgTAP count (**7+7**).
> - **Rounds 5–7** were release-sequencing: quiesce both writers, then a resume that was missing,
>   then a resume ordered after a deploy that cannot run while suspended.
> - **Round 8** confirmed §5.5 executes correctly start to finish, and left three doc-hygiene
>   minors — folded in rev 9 (this file's metadata, and step 7's verb).
>
> Companion: `2026-08-01-telegram-reel-ingestion.md` (PLAN A, rev 9).
> Author: Shaun · Date: 2026-08-01

## 1. What is in scope now

| Task | In scope? | Why |
|---|---|---|
| T1 `pipeline/place_lookup.py` (pure) | **YES** | Needed by T3; pure and offline |
| T2 migration — `lookup_keys` + GIN + `find_or_create_place` v3 + backfill | **YES** | The aliases/`lookup_keys` accumulation improves the **existing** dedup flywheel whether or not the shortcut ever ships |
| T3 probe — measure the would-be hit rate | **YES** | No LLM, no extractor change, no risk. Answers "is any of this worth it" with real numbers |
| **GATE** | | **<5 % hit rate ⇒ the shortcut is dead. T1/T2 stay.** |
| T4 pass-A agent | **PAUSED** | |
| T5 `resolve_mentions` | **PAUSED** | |
| T6 two-pass extractor + flag + the version bump | **PAUSED** | Blocked on §8 |

**Nothing in T1–T3 changes extractor behaviour, and there is NO `EXTRACTOR_VERSION` bump in this
scope.** That removes the entire class of round-1/round-2 findings about version semantics, the
kill switch, and the deploy dance — they return only if T4–T6 unpause.

## 2. Why the shortcut exists (unchanged)

Extraction is per-*reel*: the prompt mandates a `web_search` for every candidate in every caption,
regardless of what is already in `places`. Two reels mentioning "Ichiran Shibuya" each pay a full
run. Break-even for a two-pass shortcut is ≈5 % place-level hit rate; worst case ≈+4 % spend. **All
the risk is recall, not cost** — which is exactly what T3 measures, before any of it is built.

Two honest caveats, unchanged: `reel_cache` already removes repeat-*reel* cost so this only helps
**cold** reels; and the stronger near-term justification may be **latency** (a full-hit reel returns
in one tool-less call instead of a 12-turn search loop) rather than money.

## 3. Corrected facts (round 1 found the plan asserting these wrongly)

- **`reel_cache` is unique on `normalized_url` ALONE** (`20260701162954:14`); `extractor_version` is
  a plain freshness column. A bump does not re-charge every user — the first cold caller per URL
  pays and overwrites the single global row.
- **Deleting a `reel_cache` row is destructive far beyond the cache** —
  `reel_place_mentions.reel_cache_id … on delete cascade` (`20260718130000:26`).
- **`_ground_place` verifies country, not venue identity** (`grounding.py:99-139`). A wrong
  same-country branch passes it.

## 4. T1 — `backend/pipeline/place_lookup.py` (pure, offline)

`lookup_keys_for_place(name, name_local, aliases)`, `lookup_keys_for_mention(...)`,
`resolve_candidates(...)`. Thin compositions of `pipeline.dedup.normalize_name` — a named contract
with one edit site, not a fork.

### 4.1 Matching rule — exact normalized equality, never fuzzy

A trigram predicate merges "Ichiran Shibuya" into "Ichiran Shinjuku" the moment it is loose enough
to be useful (`ARCHITECTURE.md:179`). Equality never does. Recall comes from the **alias list**, not
a loose predicate.

### 4.2 [R2/M4] Resolve PER MENTION, not per reel

Round 2 caught a real bug: unioning all of a reel's mention keys into one candidate set and then
demanding a single 500 m cluster means **a reel mentioning Tokyo Tower *and* Ichiran Shibuya yields
two legitimate distant clusters and therefore an all-miss.** That would depress T3's measured hit
rate and could wrongly kill the arc.

**Fix:** one set-based query fetches candidates for all mention keys, then candidates are
**partitioned per mention key in Python** and ambiguity is resolved **per mention**. The
"one query per reel" performance claim survives; the correctness bug does not.

| condition (per mention) | outcome |
|---|---|
| 0 rows | MISS |
| all rows within 500 m of the anchor | **HIT** |
| rows don't collapse to one 500 m cluster | AMBIGUOUS → MISS |
| `len(rows) == limit` (saturation) | AMBIGUOUS → MISS — a truncated set can't prove non-ambiguity |

### 4.3 [R2/M2] Anchor selection must reach a fixed point

Round 1's "confirming query" still diverged. Round 2's counterexample, which the round-1 two-row
test could not catch:

```
R at 0 m (has the lookup key)   Q at 400 m (lower id)   S at 800 m (lowest id)
query centred on R  -> sees {R, Q}      -> picks Q
persist centred on Q -> sees {R, Q, S}  -> picks S      <-- divergence
```

Because `_persist_place` calls the RPC with the *returned* place's coordinates
(`grounding.py:173-189`) and the RPC re-evaluates its 500 m predicate around **those**
(`20260720190000:82-95`), one confirming hop is not enough.

**Fix:** iterate the RPC's own predicate to a **fixed point** — re-centre on each winner until the
winner stops changing (bounded, ~3 iterations, then treat as AMBIGUOUS). **Required regression test
is the three-row chain above**; a two-row fixture passes vacuously.

Residual, deferred: `pipeline/persist.py:87` still bypasses the advisory-lock RPC with its own
select-then-insert, so pre-existing and concurrent duplicates remain possible
(`20260720160000:30-36` already says so).

### 4.4 The index — delete the parity problem rather than test it

`lookup_keys` is populated **from Python**; SQL does zero string processing, only array overlap.
One normalization implementation, `pipeline/dedup.normalize_name`. An expression index or plpgsql
normalization would reimplement it in POSIX regex, where Postgres `\w` is locale-dependent
`[[:word:]]` and Python's is `re.UNICODE` — they diverge on combining marks and some scripts,
**silently, producing wrong matches rather than errors.**

Drift tripwire: `test_lookup_keys_are_python_derived_only` greps the migration SQL and asserts no
`regexp_replace`/`lower(` over `name`/`aliases`.

**`normalize_name` must NOT change** — the `#16` anchor `6229.0` depends on dedup clustering, which
depends on it. Pin with `test_normalize_name_is_frozen` carrying that reason.

**RED when:** the per-mention partition is removed (Tokyo Tower + Ichiran in one reel ⇒ all-miss);
the fixed-point iteration is removed (the three-row chain diverges); the cluster gate is removed
(two `"ichiran"` rows 6 km apart resolve — *the* Shibuya/Shinjuku guard); saturation is treated as
complete; `normalize_name` is edited.

## 5. T2 — the migration

```sql
alter table public.places
  add column lookup_keys text[] not null default '{}',
  add column last_research_verified_at timestamptz;
create index places_lookup_keys_gin on public.places using gin (lookup_keys);
```

### 5.1 [R1/B4] The signature contract

Adding parameters makes a **different** signature — the repo already says so:

> *"DROP AND RECREATE, NOT `create or replace`. Adding a parameter makes a DIFFERENT signature, so
> `create or replace` would leave the 9-argument function in place as an OVERLOAD"*
> — `20260720190000_place_name_local.sql:25-30`

That prior migration dropped 9-arg and created 10-arg **with no defaults** — breaking. This one must
not repeat that:

- **One transaction:** `drop function public.find_or_create_place(<10 arg types>);` then
  `create function` with **four** new trailing params, all defaulted:
  `p_aliases text[] default '{}'`, `p_lookup_keys text[] default '{}'`,
  `p_source_summary jsonb default '{}'::jsonb`, and
  **[R2/M3] `p_research_verified boolean default false`**.
- The deployed 10-arg call (`backend/grounding.py:173-189`) still resolves — defaults fill in.
- **Union/preserve semantics are load-bearing:** an old caller passes `'{}'`, so the RPC must UNION
  aliases/`lookup_keys` (never overwrite) and `p_source_summary || source_summary` (existing wins).
  Otherwise deployed code silently **erases** every alias on each reuse. Cap arrays at 50.
- **[R2/B4] `NOTIFY pgrst, 'reload schema';` at the end of the migration.** PostgREST caches
  function signatures; without a reload it can serve stale metadata and return `PGRST202` while
  `/health` stays green. Round 1 and 2 both missed this.
- **[R3/B4] Re-declare the full privilege contract in the create.** A `drop` + `create` starts from
  nothing — unlike `create or replace`, **none of it is inherited**: `security definer`,
  `set search_path = ''`, `revoke all … from public, anon, authenticated`,
  `grant execute … to service_role`. Copy them verbatim from `20260720190000`. Silently losing
  `search_path = ''` on a `security definer` function is a privilege-escalation footgun, and losing
  the revoke would expose a service-role-only write path to `authenticated`.

### 5.1a [R3] The existing pgTAP tests pin the old signature — update them in the same PR

Round 3 flagged this absence and it is concrete. **[R4/m1] Verified count: the 10-arg signature
string appears 7 times in `supabase/tests/015_place_name_local.sql` and 7 times in
`supabase/tests/012_serialized_place_find_or_create.sql`** — 14 sites, not the 9+1 rev 3 claimed
(rev 3 miscounted 015's line 32, which pins the *9*-arg signature as the previous
did-not-survive assertion). Between them they cover existence, `security definer`, `search_path`,
and all three privilege assertions.

The moment T2 lands, both files fail. Update all 14 occurrences to the 14-arg signature, and **keep
015's `to_regprocedure(<old>) is null` pattern** by adding `to_regprocedure(<10-arg>) is null` —
that assertion is exactly what proves the old overload did not survive the drop.

### 5.2 [R2/M3] The `last_research_verified_at` writer contract

Round 2: with no parameter distinguishing a fresh search from a reuse, the column is meaningless —
stamp on every reuse and a hot place is immortal; never stamp and no row ever qualifies.

`p_research_verified boolean default false`. **Only fresh-web-search callers pass `true`.** In the
current T1–T3 scope every `find_or_create_place` call comes from a fresh extraction, so
`grounding._persist_place` passes `true` and the column is correct from day one — and the parameter
already exists when T4+ unpauses, so **no second drop-and-recreate is ever needed.**

Do **not** use `updated_at`: the `places_set_updated_at` trigger fires on every reuse.

**[R3] Two timestamp gaps the default creates, both closed by the backfill:**
- **Pre-existing rows** have `last_research_verified_at = NULL` and would never qualify for lookup.
- **Rows written between the migration and the T2 code deploy** get `false` (the deployed caller
  passes nothing) and are equally unstamped.

Both are correct to stamp, because **until T4 unpauses there is no reuse path** — every
`find_or_create_place` call in existence came from a fresh web search. So the backfill (§5.4) sets
`last_research_verified_at = coalesce(last_research_verified_at, created_at)` for all rows. Run it
**after** the code deploy so it also sweeps up the window. State in the migration that this
equivalence holds only while T4–T6 are paused; once reuse exists, the parameter is the only truth.

### 5.3 [R2/M5] Rollback (round 2: "prose is not an executable rollback")

`supabase/migrations/rollback/` holds only the `20260720100000` pair. Add and **host-test** a T2
down script. **[R3] The order is load-bearing and must be stated, because the reverse leaves live
code calling a function that no longer exists:**

```
1. Revert the T2 WRITER CODE first (grounding.py / persist.py stop sending the 4 new params).
   Skipping this is the whole trap: the 10-arg function cannot accept them.
2. drop function public.find_or_create_place(<14 arg types>);
   create ... the 10-arg version, copied VERBATIM from 20260720190000 including
   security definer / search_path='' / revoke / grant.
3. drop index places_lookup_keys_gin;
   alter table public.places drop column lookup_keys, drop column last_research_verified_at;
4. NOTIFY pgrst, 'reload schema';
5. Revert the pgTAP edits (012, 015) to the 10-arg signature strings.
```

Test host-side — `supabase test db` cannot reach `rollback/`, and testing a *copy* of the script is
how a divergent script ships green (`BUILD-LOOP.md`).

### 5.4 Callers + backfill

`grounding._persist_place` sends the four new params (`p_research_verified=true`).
`pipeline/persist._find_or_create_place` writes `lookup_keys` on insert (~3 lines, reusing the
`normalize_name` calls it already makes at `persist.py:70-76`); **its match rule is unchanged** — no
fourth identity rule.

`scripts/backfill_place_lookup_keys.py`: batched, service-role, idempotent. It does two things —
populate `lookup_keys` from Python, and stamp
`last_research_verified_at = coalesce(last_research_verified_at, created_at)` per §5.2. **Run it
after the code deploy**, so it also covers rows written during the migration→deploy window.

**pgTAP → RED when:** the old 10-arg overload survives (`to_regprocedure(<10-arg sig>) is null`);
union becomes overwrite (call with `'{}'`, assert existing aliases survive); an existing
`source_summary` key loses; `p_research_verified=false` stamps the timestamp.

### 5.5 Deploy order

**[R4/M3] The preflight must quiesce BOTH job types, and the index build is not free.** Rev 3's
preflight checked only `organize_jobs` — but **trip generation independently inserts into `places`**
via `pipeline/persist.py:87`, a path that never touches `organize_jobs`. A non-concurrent
`CREATE INDEX` blocks writes and `ALTER TABLE` takes `ACCESS EXCLUSIVE`, so a trip starting after an
organize-only preflight can block on the migration long enough to hit `PIPELINE_TIMEOUT`.

```
0. Pre-flight. [R5/m2] An emptiness CHECK is not quiescence -- a new web request one
   second later writes `places` anyway. So actually QUIESCE, do not just look:
     - Suspend `astrail-backend`   (trip jobs write places via persist.py:87,
                                    organize jobs via grounding.py)
     - Suspend `astrail-telegram-ingest` IF PLAN A HAS SHIPPED. The worker calls
       run_organize_job independently, so suspending only web is insufficient once
       it exists -- and the two plans explicitly permit either ordering.
     - THEN confirm no in-flight `jobs` and no in-flight `organize_jobs`.
   Note the SHA; PITR marker.
   Set lock_timeout = '3s' and a statement_timeout so the migration fails fast
   rather than queueing behind a reader and holding ACCESS EXCLUSIVE.
   If `places` is large enough for the GIN build to matter, move it OUT of the
   transaction to a separately managed CREATE INDEX CONCURRENTLY step
   (it cannot run inside a transaction block).
1. T2 migration, ONE transaction: drop 10-arg; create 14-arg with 4 trailing defaults;
   re-declare security definer / search_path='' / revoke / grant; union semantics;
   add columns (+ GIN index, unless split out per step 0);
   NOTIFY pgrst, 'reload schema'.
2. VERIFY LIVE via the REST API: BOTH the deployed 10-key call AND the future 14-key call
   resolve.  [R2/B4 — smoking only the 10-key shape proves nothing about whether the new
   parameter set is actually in PostgREST's cache]
   This is what proves the STILL-SUSPENDED old code is compatible, so it is safe to
   bring the API back up before deploying anything new.
3. Merge the writer PR.  (No deploy fires: autoDeploy is false.)
4. *** [R6/B1 + R7/B1] RESUME BEFORE DEPLOYING. ORDER IS LOAD-BEARING. ***
   Rev 5 added the suspend and forgot the resume. Rev 6 added a resume but put it
   AFTER the deploy -- and you cannot deploy to a suspended Render service; the
   deploy trigger returns 409, so the resume was unreachable and the API stayed
   down. The service must be RUNNING before it can accept a deploy.
     a. Resume `astrail-backend`.  (It is still running the OLD code, which step 2
        just proved compatible with the new schema.)
     b. Deploy the exact merge SHA from step 3. Wait for deploy success.
     c. Verify the LIVE SHA equals the merge SHA -- not just "a deploy happened".
     d. Verify /health AND /readiness (the deep probe; /health never touches the DB,
        so it cannot see a bad schema).
     e. Run ONE real DB-backed operation end to end and confirm it writes a place.
5. Resume `astrail-telegram-ingest` if step 0 suspended it.
   [R7/m1] The worker also has autoDeploy: false, so resuming it alone can leave it
   running the PREVIOUS image. That image still works (the RPC defaults preserve
   compatibility) but it sends p_research_verified=false and no lookup_keys -- so
   every place it writes after this point is INVISIBLE to T3 and silently depresses
   the hit-rate measurement the whole Arc-2 GO/NO-GO rests on.
     -> Deploy the same merge SHA to the worker and assert its live SHA matches.
        A heartbeat proves liveness, not version.
6. Backfill: lookup_keys AND last_research_verified_at (per 5.2 -- after BOTH
   services are on the new SHA, or the backfill races code that is still writing
   unstamped rows).
7. RUN pgTAP 012 + 015 (they were UPDATED pre-merge as part of step 3's PR, per 5.1a --
   [R8/m2] rev 8 said "update ... same PR as step 3" at a point where that PR is
   already merged, which is not an executable instruction). Confirm green.
8. T3 probe -> GO / NO-GO.
ROLLBACK: 5.3, code first.
```

## 6. T3 — the probe, and the gate

`backend/scripts/probe_place_cache_hits.py` — read-only, `RUN_DB_INTEGRATION`-guarded. Replays
cached `reel_cache.extracted_places` + captions through `resolve_candidates` against production
`places`, using a **regex-only tier scan** (no LLM, no extractor change). Unit-tested against a
fixture dict.

It must use the **§4.2 per-mention partition and the §4.3 fixed-point anchor** — otherwise it
under-reports and could wrongly kill the arc.

Reports: would-be hit rate, ambiguity rate, saturation rate, and the distribution of
`web_search_calls=N` already printed by `place_extractor.py:328` (grep Render logs — free, no code).

**GATE: place-level hit rate <5 % after backfill and ~2 weeks of warming ⇒ STOP.** T1/T2 stay —
they improve the existing dedup flywheel regardless.

## 7. Baseline (T0, no code)

From logs: searches/reel distribution, cold reels/month. From the DB: `places` row count, and the
count of normalized-name clusters with ≥2 rows >500 m apart — the ambiguity population, which is
the ceiling on what the shortcut can ever resolve.

## 8. PAUSED — T4–T6, and what must be solved before they unpause

**[R2/B3] The kill switch is structural, not a cache-layer check. This is the blocker that paused
this half.**

Round 2 proved the round-1 fix insufficient. Gating `get_cached_places` stops serving a bad *cached
extraction*, but a wrong place written under `on` has already been **persisted into
`reel_place_mentions`**, and:

- `saved_reel_cards` joins mentions on `verification_version` + `analysis_status='organized'` with
  **no provenance check** (`20260720120000:91-95`) → the wrong place stays visible in the user's tray.
- `authorize_place_ids` filters on the same two things with **no provenance check**
  (`backend/organizer.py:158-168`) → the wrong place stays **authorized for `/generate-trip`**.
- The flag is a per-service env var and **two services run the extractor**, so `off` is
  process-local — a web dyno still in `on` re-overwrites the single global cache row via
  `cache_places`' upsert on `normalized_url` (`cache.py:84`).

**Preconditions for unpausing T4–T6** (each is real work, and none should start before T3 says the
arc pays):

1. Provenance persisted **downstream of the cache** — a `research_source` on `reel_place_mentions`
   (new column + migration + backfill), not only inside `PlaceResult`.
2. `saved_reel_cards` **and** `authorize_place_ids` exclude invalidated shortcut provenance.
3. A **DB-backed** kill flag both services read, not an env var — plus defined
   shutdown/purge/reprocess semantics across processes.
4. The purge stays an **UPDATE** (`extracted_places = NULL`), never a DELETE — a DELETE cascades
   away every user's mentions.
5. Then, and only then, the single `EXTRACTOR_VERSION` bump with its four coupled edits
   (`place_extractor.py:27-45`), including the `saved_reel_cards` view-literal migration and its
   rollback.

Design work already done and worth keeping when this unpauses: pass A is a no-tools agent carrying
the same `_PROMPT_INJECTION_RE` guardrail; pass B is the **existing** agent seeded with an
`ALREADY VERIFIED` block, not a second agent; empty pass A ⇒ full run; a hit that fails
`keep_valid_places` **demotes to a MISS, never drops**; shadow mode samples on
`hashlib.sha256(normalized_url)` — **not** Python's `hash()`, which is per-process randomized;
promotion requires `disagree == 0` over ≥200 hits with **every orphan individually adjudicated**,
not a `<5 %` rate.

**Also fix on unpause:** `place_extractor.py:41` names
`test_extractor_version_invalidates_pre_country_cache_rows`, which **exists nowhere** — verified.
The real test is `test_extractor_version_is_pinned_so_a_bump_is_deliberate`
(`genagents/test_place_extractor.py:33`).

## 9. Provenance and guardrail #1 — the honest position (kept, for whenever T4 resumes)

Round 1 claimed reuse "strengthens guardrail #1". **That was rationalization.** `_ground_place`
verifies only that coordinates reverse-geocode to the claimed **country** — not that the venue is
there. A stored row's chain is `web_search → keep_valid_places → country agreement`, which is
exactly what a fresh search plus the same grounding produces. Reuse is **not** a longer chain.

The honest claim: reuse is a *measured optimization* trading a fresh search for a prior verified
result of **equal** strength, gated by the ambiguity rules and a shadow measurement. It does not
violate guardrail #1 — the coordinate is not model-invented and `evidence_quote`/`name_local` still
come verbatim from *this* caption — but the safety comes from the gates, not the provenance.

## 10. Cross-plan contract with PLAN A

**[R4/M2] This section previously said PLAN A "MUST" pass the new parameters and "SHOULD" write
`source_summary.source_url`. Both were wrong, and it contradicted PLAN A §6. Corrected:**

- **The new parameters belong entirely to this plan.** Ingest reaches `find_or_create_place` only
  *through* `backend/grounding.py:173` — the same call path every web organize run uses. Changing it
  is a live-path change owned by T2 here, not a requirement on PLAN A's diff.
- **Do NOT write the reel's source URL into `places.source_summary`.** That column's CHECK
  blacklists reel-evidence keys including `normalized_reel_url`
  (`20260701162954_global_knowledge_foundation.sql:35-50`), and the correct home already exists and
  is already written: `reel_place_mentions.source_url` (`organizer.py:499`). Rev 3 invented a
  requirement that duplicated a shipped column into a place the schema is explicitly hostile to.
- **The only real relationship is sequencing:** *if* you want PLAN A's corpus to feed T3's probe,
  land T1–T2 first. PLAN A's own diff requires nothing from this plan.

T3 can run any time after PLAN A has been ingesting for ~2 weeks.

## 11. Deferrals with triggers

| Deferred | Trigger |
|---|---|
| **T4–T6 (the shortcut itself)** | T3 reports ≥5 % hit rate **and** §8's five preconditions are planned |
| Mini model for pass A | STACK.md approves a mini id; `ASTRAIL_MENTION_MODEL` is the seam |
| Country/city narrowing of the lookup | Ambiguity >20 % of mentions in the T3 probe |
| Underscore/@handle normalization | >10 % of probe misses are handle-shaped. Fix in `lookup_keys_for_*` **only** |
| Porting `pipeline/persist.py` onto the RPC (§4.3 residual) | T3 shows trip-path rows are a material share of misses |
| **Trigram / fuzzy matching for coordinate reuse — NEVER** | Design red line |
| Semantic pgvector matching (ISSUES-B3) | Unchanged trigger. `lookup_keys` is not a substitute |

## 12. Round-2 findings status

| Finding | Status in rev 3 |
|---|---|
| B3 kill switch NOT FIXED | **DESCOPED** — T4–T6 paused; §8 records the five preconditions |
| B4 PostgREST schema cache | **FIXED** §5.1 — `NOTIFY pgrst, 'reload schema'` + §5.5 smokes both call shapes |
| M2 confirming query still diverges | **FIXED** §4.3 — fixed-point iteration + the three-row regression test |
| M3 `last_research_verified_at` no writer contract | **FIXED** §5.2 — `p_research_verified` trailing default, added now so no second signature change is ever needed |
| M4 one-query-per-reel conflates mentions | **FIXED** §4.2 — partition per mention key |
| M5 no rollback scripts | **FIXED** §5.3 — T2 down script + host-side test |
| Codex #6 residual — `persist.py` bypasses the RPC | **DEFERRED** §11, pre-existing, documented |

## 13. Round-3 findings status

Round 3 scored the pair 5.5/10 and answered its own question 5 as *"T1 and T3 are safe; T2's
transactional drop/recreate approach is viable, but the privilege contract, false research
timestamp, test updates, and rollback order must be fixed first."* All four are now fixed:

| Round-3 finding | Status in rev 4 |
|---|---|
| B4 — the recreated function loses `security definer` / `search_path` / revoke / grant | **FIXED** §5.1 — a `drop`+`create` inherits **nothing**; all four re-declared verbatim |
| Existing pgTAP pin the old signature (absence) | **FIXED** §5.1a — **7 sites in 015 and 7 in 012** (round 4 corrected rev 3's 9+1 miscount); all 14 updated in the same PR, keeping the `to_regprocedure(<old>) is null` proof |
| Incorrect / missing research timestamps | **FIXED** §5.2 — the backfill stamps `coalesce(last_research_verified_at, created_at)` and runs **after** the code deploy, covering both pre-existing rows and the migration→deploy window; valid only while T4–T6 are paused, and said so |
| T2 rollback order (absence) | **FIXED** §5.3 — five ordered steps, **code reverted first** |
| B3 — kill switch structural | **DESCOPED** §8 — T4–T6 paused; five preconditions recorded |

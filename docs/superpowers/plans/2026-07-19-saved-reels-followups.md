# Saved Reels Follow-ups — Batched Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all remaining Saved Reels follow-up work across **three independently
reviewable and mergeable arcs**: the two merged-diff-review Majors (deploy-overlap double
execution, cross-user mention destruction), correct distributed job leasing for BOTH job
systems, the Mapbox coordinate→country cost cache, ISSUES-B1–B7, the review's
minors/refactors, and a separated frontend polish track.

**Architecture:** Refactor-first — extract the per-item body of `run_organize_job` into
`_process_item` + `_ground_and_persist` so every subsequent organizer edit lands into flat,
tested helpers instead of 6-level nesting. Then land correct leasing (fenced, heartbeated,
reaped — for organize jobs AND trip jobs), then user-scoped mention replacement, then the cost
cache. Hygiene follows in its own arc; frontend is Zhi Hao's arc.

> **Amended twice after failed Codex plan-review gates (round 1: 5.8/10, round 2: 6.2/10).**
> Round 2's diagnosis score rose (7.0 → 8.5) while *risk management* fell (5.0 → 4.5) and
> *feasible-first* held at 5.0 — the round-1 amendment bought correctness with machinery. The
> round-3 amendment therefore **cuts** where it can: the reaper's select-then-CAS loop collapses
> into one atomic statement, A3's impossible expand/contract split is replaced by a
> single-migration maintenance window, and Arc A is broken into **five independently reviewable
> PRs** instead of one XL branch. Both revisions are summarized in "What changed in this
> revision" at the end.

## Arc structure (3 arcs; Arc A ships as a 5-PR stack)

| Arc | Theme | Tasks | Owner | Est. size |
|---|---|---|---|---|
| **A** | Reliability + security (the P1s) | A1 · A2 · A3 · A4 · A5 · A6 | Shaun | 5 stacked PRs (below) |
| **B** | Hygiene (ISSUES-B2/B3/B6, minors, dead code) | B1 · B2 · B3 · B4 · B5 · B6 | Shaun | M — one branch |
| **C** | Frontend | C1 · C2 | Zhi Hao | S + open-ended |

### Arc A ships as five sequential PRs, not one branch

One XL branch carrying six tasks, three migrations, two job systems, an authorization change
and a deployment transition is not reviewable in one pass — that packaging, not the leasing
machinery itself, was the feasible-first failure in review round 2. Each PR below branches off
the **previous PR's merge commit on `dev`**, is reviewed and merged on its own, and is
independently revertable. This repo has no stacked-PR tooling, so "stacked" here means
strictly sequential branch-off-`dev`-after-merge.

| PR | Branch | Contents | Size | Migration? | Depends on |
|---|---|---|---|---|---|
| **A-I** | `feat/organizer-extract-helpers` | A1 — behavior-preserving extraction | **S–M** (~0.5 day, ~1 file, +2 helpers, 2 new tests) | no | `dev` |
| **A-II** | `feat/organize-job-leases` | A2 organize side: lease migration, `recover_organize_jobs`, claim, heartbeat, fenced `append_organize_event` RPC | **M** (~1 day, ~7 tests) | **yes** | A-I |
| **A-III** | `feat/trip-job-leases` | A2 trip side: `jobs.py` + `runner.py` leases/heartbeat/fencing, shared periodic reaper in `main.py`, ISSUES-B4 semaphore | **M** (~1 day, ~6 tests incl. 4 barrier interleavings) | no (uses A-II's) | A-II |
| **A-IV** | `feat/mentions-user-scope` | A3 — user-scoping migration + RPC + Python + the maintenance-window deployment transition | **L** (~2 days; the deployment is half the work) | **yes** | A-III |
| **A-V** | `feat/saved-reels-arc-a-tail` | A4 country cache · A5 log redaction · A6 invariant comment | **M** (~1 day) | **yes** (A4) | A-IV |

A-II and A-III both descend from the single `20260720090000_job_leases.sql` migration, which
ships in **A-II**; A-III adds no DDL. The migration-before-merge protocol below applies to
A-II, A-IV and A-V individually — each is its own apply-verify-merge cycle, which is the point
of the split. A-V's three tasks are independent of each other and share a PR only because each
is individually too small to be worth a gate; split it further if its review needs more than
one round.

Arcs land in order A → B → C. Arc B's B3 re-creates the `saved_reel_cards` view and therefore
**must copy the definition Arc A's A-IV leaves behind**, not the one on `dev` today (see B3).
That is the only cross-arc coupling; everything else is independent.

> **⚠ Naming collision — read once, then it is unambiguous.** `ISSUES.md` numbers its issues
> B1–B7, and this plan now numbers Arc B's tasks B1–B6. **In this document, a bare `A1`/`B1`/`C1`
> is always a TASK id; an ISSUES.md issue is always written `ISSUES-B1`.** They do not
> correspond (task B1 implements ISSUES-B6; ISSUES-B1 is implemented by task A5).

**Tech Stack:** FastAPI + async supabase-py (service role), Mapbox Geocoding v6 reverse
(permanent), OpenAI Agents SDK extractor, pytest (offline, injected fakes), pgTAP, Vitest.

**Inputs (read if a task's rationale is unclear):**
- `docs/superpowers/reviews/2026-07-19-saved-reels-merged-diff-review.md` (the third-pass review — the authority for the Majors, call math, and ISSUES-B1–B7 corrections)
- `ISSUES.md` (ISSUES-B1–B7 as originally documented)
- `HANDOFF.md` (verification state, machine quirks, locked decisions)

## Model assignment (locked by the user — do not change)

| Role | Model |
|---|---|
| Implementer (`astrail-developer`, one per task) | **opus** |
| Per-task review gate (`astrail-reviewer`) | **sonnet** |
| Final whole-branch pass (`astrail-reviewer`), **once per arc** | **fable** |
| Cross-model code review (BUILD-LOOP step 6) | `codex exec -m gpt-5.6-sol -c model_reasoning_effort="high"` |

## Global Constraints

- **Decisions already made (do NOT re-litigate):** ISSUES-B1 = redact now, defer one-time token behind the sentinel-probe decision gate (both branches planned in A5). ISSUES-B7 = presentation-layer `CN → China` mapping in the frontend; stored Mapbox canonical name is never mutated; `CN` stays the grouping key. **A2 gets the full lease design** (atomic reclaim on the observed lease, periodic reaping, renewal heartbeat, per-attempt fencing token) and **A3 gets a user-scoping migration** — both are user decisions taken after the Codex review; do not re-scope them down.
- **Guardrails (`.claude/CLAUDE.md`)**: #1 no hallucinated places · #3 partial failure OK · #4 schema parity (Pydantic ⇄ TS ⇄ migration in the same task) · #5 auth everywhere · #6 owner checks via RLS · #7 write-through caches · #11 untrusted reel content · #12 durable jobs, restart-with-cache-reuse not resume. Each task lists which it touches.
- **Schema parity (guardrail #4) — corrected.** The earlier blanket claim that "no task in this arc touches schema parity" was **false**: `GenerateTripRequest.pace` (`backend/api/schemas.py:20`) has no TypeScript mirror in `frontend/lib/trip/backend-types.ts` — verified, `pace` appears nowhere in `frontend/lib/trip/`. That is a live guardrail-#4 violation in code already on `dev`. **Task B1 fixes it** (backend field → TS mirror → contract test) because B1 already edits that exact request contract. Remaining parity notes: A4's cache table is backend-internal (service-role only — no TS mirror by design); C1 is TS-only presentation. State this in each PR body.
- **Eval anchor:** frozen `#16` offline `mean_intra_day_travel_m = 6229.0` must never move. Run `uv run pytest evals/ -q --basetemp=.pytest-tmp` after EVERY task. B3 is the only task flagged as plausibly eval-adjacent — if evals move there, STOP and report.
- **SSE contract is frozen:** `data: {"type":"result",...}\n\n` then `data: [DONE]\n\n`; error paths also end `[DONE]`. No task renames an event type. B5(b) changes only a `status_message` string (message *content*, not shape — non-breaking).
- **Verification gates:**
  - Every backend task: `cd backend && uv run pytest -q --basetemp=.pytest-tmp` then `uv run pytest evals/ -q --basetemp=.pytest-tmp`.
  - Every task that adds/changes a migration — **Arc A: A2 (in PR A-II), A3 (A-IV), A4 (A-V); Arc B: B3, B5(d), B6** — runs `supabase db reset && supabase test db && supabase db lint --local`. **Mandatory, never environment-optional** (HANDOFF: a `CREATE OR REPLACE VIEW` bug slipped past everything except a clean reset). If Docker's Linux engine hangs, restart it and rerun the WHOLE reset→test→lint sequence; do not report a task green without it.
  - Frontend tasks (C1, C2): from `frontend/`: `npm test && npm run typecheck && npm run build`.
- **Machine quirks (HANDOFF):** backend pytest from `backend/` with `--basetemp=.pytest-tmp`; Supabase gates need Docker Desktop's Linux engine (restart it and rerun the whole reset→test→lint sequence if it hangs); `supabase db reset` erases local auth fixtures.
- **Feasible-first:** smallest working change. The review explicitly rules a package split of `organizer.py` NOT warranted — the file stays one module. No speculative abstraction anywhere in this arc.
- **Migrations are append-only.** Never edit a shipped migration; every DDL change is a NEW `supabase/migrations/*.sql` file.
- **Reviewer fault-injection is mandatory per task:** revert the named guard → the new test goes red → restore. Each task names its injection.

## Task order and why

**Arc A — reliability/security**

1. **A1 — refactor `run_organize_job`** (both Majors, the lease heartbeat, ISSUES-B2, ISSUES-B5, and the cache all edit this exact block; land them into flat helpers, not 6-level nesting).
2. **A2 — correct leasing for BOTH job systems** (organize + trip): staleness gate, atomic reclaim conditioned on the observed lease, periodic reaper, renewal heartbeat, per-attempt fencing token, atomic event-sequence allocation, ISSUES-B4's semaphore. Highest severity in the plan.
3. **A3 — user-scoped mention replacement** (cross-user data destruction Major) — migration + transactional RPC.
4. **A4 — coordinate→country cache** (kills warm-path Mapbox spend AND closes the quota-exempt billable loop).
5. **A5 — ISSUES-B1 stream-token log exposure** (decision gate).
6. **A6 — ISSUES-B5: pin the event-sequencing invariant** — last, because A2 is what makes a true statement available to pin.

**Arc B — hygiene:** B1 (ISSUES-B6 + `pace` parity + duplicate-UUID validation) → B2 (ISSUES-B2)
→ B3 (coordinate-echo + `EXTRACTOR_VERSION` bump + read-surface alignment) → B4 (ISSUES-B3)
→ B5 (grouped minors) → B6 (test-double honesty + dead code).

**Arc C — frontend:** C1 (ISSUES-B7) → C2 (polish track). Independent of A and B.

**A1 before A2 — settled.** The amended A2 wraps the item loop in a lease-lost check and threads
a fencing token through the per-item writes, so it touches `_process_item` directly; the
refactor is a real dependency. Codex's round-1 "move A2 first" suggestion was withdrawn in
round 2 ("the plan is right; my earlier ordering recommendation was wrong"). Do not re-open.

**Deployment status (confirmed by the user 2026-07-19 — an earlier draft of this plan asserted
the backend was NOT deployed; that was a wrong inference from HANDOFF's "no deploy should
proceed" line, which constrains the *next* deploy, not prior ones):** `astrail-backend` **IS
live** at `https://astrail-backend.onrender.com/`, but carries **no production traffic yet** —
the team redeploys it as they go. Consequences:

- The deploy-overlap double execution is **reachable today** on every redeploy, but its blast
  radius is currently near-zero (no real users, so few or no in-flight organizes). It becomes
  a live data-integrity bug the moment users are onboarded. A2 is therefore **important and
  pre-onboarding-blocking**, not an emergency — it does not justify skipping A1's refactor.
- **A5's sentinel probe is UNBLOCKED and can run NOW** against the existing deployment. It
  needs no new deploy and no valid JWT — a bogus `?token=SENTINEL…` that 401s still produces
  the logged request line, which is exactly what the probe measures. Run it before A5 starts so
  the redact-vs-one-time-token branch is settled rather than discovered mid-task.
- **A3's pre-flight orphan audit must run against the deployed Supabase**, not just a local
  reset. "No production traffic" is not "no rows" — the team's own live-verification runs
  (HANDOFF documents a real OTP → Saved Reel → Organize → Tokyo pin acceptance run) created
  real `reel_place_mentions` data.

A1 is a behavior-preserving extraction with the 585-test suite as its net; it should take well
under a day and it makes A2 reviewable.

---

# ARC A — Reliability and security

**Branches:** five sequential PRs (A-I … A-V, see "Arc A ships as five sequential PRs" above).
**Closeout:** see "Arc A closeout" after A6. **Three migrations, in A-II (A2), A-IV (A3) and
A-V (A4)** — each runs the full Supabase gate and its own apply-verify-merge cycle.

### ⚠ DEPLOY HAZARD — code auto-ships, migrations do NOT (verified 2026-07-19)

`render.yaml` sets `autoDeploy: true` on `dev`, and the service confirms
`autoDeployTrigger: commit`. **There is no `preDeployCommand`, no release command, and nothing
in the `Dockerfile` that applies migrations** — verified by reading both files. Migrations are
applied manually via the Supabase CLI, so code and schema ship on completely separate tracks.

**Consequence: the moment a PR merges to `dev`, Render deploys code that queries
`reel_place_mentions.user_id` (A-IV) and `geocode_country_cache` (A-V) against a database where
neither exists.** Every organize fails at runtime until someone remembers to run the migrations.

**Mandatory merge protocol for every migration PR (A-II, A-IV, A-V):**

1. Apply that PR's migration to the deployed Supabase **FIRST**, and verify.
2. Confirm the old (currently-deployed) code still works against the new schema.
3. **Then** merge the branch to `dev` and let auto-deploy ship the code.

Step 2 holds for A-II (additive columns + a new RPC — old code ignores both) and A-V (a new
table only new code reads). **It does NOT hold for A-IV**, and that is the whole problem:

**A-IV (A3) needs a brief maintenance window — an expand/contract split is IMPOSSIBLE here.**
Today's PK is `(reel_cache_id, place_id)` (`20260718130000_saved_reels_organize.sql:25`).
Fanning one mention out to N owners needs N rows sharing that key, so **the backfill cannot run
until the PK is dropped** — there is no nullable-column two-step that keeps old code working.
And dropping the PK immediately breaks the currently-deployed `_persist_mention`, which upserts
`on_conflict="reel_cache_id,place_id"` (`backend/organizer.py:219`): Postgres requires a unique
index matching the conflict target, so old code starts erroring the instant the constraint goes.
Old and new code cannot coexist against either schema. **Overlap must be eliminated, not
tolerated.** The service carries zero production traffic, so a short window is cheap and the
correct feasible-first answer. Procedure (A-IV Step 6 repeats it as executable checklist steps):

1. **Drain.** `select count(*) from public.organize_jobs where status in ('pending','processing')`
   and the same for `public.jobs` in `('pending','running','retryable')`. Both must be 0. If not,
   wait for them to finish — do not proceed with writers in flight.
2. **Stop writers: suspend the Render service.** ⚠ **`render services suspend` / `resume` DO NOT
   EXIST** — verified against the installed CLI v2.21.0: `render services` offers only
   `create | delete | instances | update`, and there is no top-level `suspend`. Suspend/resume are
   **Dashboard or REST API only**:
   - Dashboard → `astrail-backend` → Suspend, **or**
   - `POST https://api.render.com/v1/services/srv-d976aess728c738pskk0/suspend`
     (Bearer `RENDER_API_KEY`); resume is the matching `/resume`.

   Chosen over scale-to-zero (`astrail-backend` is a web service — not offered on starter) and over
   a feature flag (a flag needs its own deploy to land, which is the very thing being sequenced).
   Suspension stops the container outright, the only mechanism that provably ends organizer writes.
   **`render services update --maintenance-mode` is NOT a substitute** — it fronts a static page
   while the container and its background organizer keep running.
3. **Migrate.** Run the Step-0 orphan audit, then apply the single atomic migration
   `20260720080000_reel_place_mentions_user_scope.sql`.
4. **Ship the code.** Merge A-IV to `dev`, then resume the service (Dashboard/API per step 2).
   ⚠ **Do NOT assume resume picks up the `dev` head** — that is an unverified platform claim, and
   if resume restores the *previously deployed image* the window reopens OLD code against the NEW
   schema (every organize erroring on the dropped `on_conflict` index). **Explicitly deploy the
   intended commit** with a verified-real command:

   ```bash
   render deploys create srv-d976aess728c738pskk0 --commit <A-IV merge SHA> --wait --confirm
   ```

   Then confirm the deployed commit SHA equals A-IV's merge commit before calling the window closed.
5. **Verify (all four, in order — this is what "verify" means):**
   (a) `GET /health` → 200 (the real route — `main.py:124`, `render.yaml:10`; there is NO `/healthz`,
   and using it would fail verification and trigger an unnecessary lossy rollback);
   (b) `select count(*) from public.reel_place_mentions where user_id is null`
   → 0; (c) one real OTP → save → Organize run completes and its mentions rows carry the
   organizing user's `user_id`; (d) a `/generate-trip` from that organized place succeeds —
   i.e. `authorize_place_ids` still authorizes, which is the surface the backfill claims to
   preserve.
6. **Rollback if any of (a)–(d) fails:** revert A-IV's merge commit on `dev` (auto-deploy
   restores the old code) **and** apply the prepared down-migration (A-IV Step 3 ships it in the
   same PR). **The rollback is lossy in two named ways, both accepted:** the fan-out created
   several owner rows per `(reel_cache_id, place_id)`, so the down-migration must
   `DISTINCT ON (reel_cache_id, place_id)` before restoring the old PK (surviving row chosen by
   oldest `created_at`, deterministic); and orphan rows deleted in step 3 are not restorable —
   they are regenerable from the frozen extraction cache at zero provider spend, which is the
   Step 0 policy's justification for deleting them in the first place.

Expected window: single-digit minutes. Announce it to Zhi Hao before starting — the frontend
will 503 for its duration.

**Deferred (concrete trigger):** wire migrations into the deploy itself (Render
`preDeployCommand` running `supabase db push`, or a release job) **when the team stops applying
migrations by hand, or the first time a merge ships code ahead of its schema.** Until then the
manual protocol above is load-bearing and belongs in every migration task's PR body.

---

### Task A1: Extract `_process_item` + `_ground_and_persist` from `run_organize_job`

**Ships as PR A-I, alone.** **Severity/size:** enabler / **S–M** (~0.5 day incl. review; one
file, two extracted helpers, two new tests, zero behavior change). **Guardrails:** #3 (per-item
failure isolation preserved), #12 (claim semantics untouched).

**Files:**
- Modify: `backend/organizer.py:284-421` (`run_organize_job` — the per-item body at 314-406)
- Test: `backend/test_organizer_process_item.py` (new)

**Interfaces (later tasks build on these — keep signatures exact):**
- Produces:
  ```python
  async def _process_item(client, job_id: str, user_id: str, item: dict, *, scrape, extract, ground) -> None
  async def _ground_and_persist(client, reel: dict, cache_id: str | None, places: list[PlaceResult], *, ground) -> tuple[str, int]
  ```
  `_ground_and_persist` returns `(terminal, place_count)` where `terminal ∈ {"organized", "location_not_found"}`.
  `_process_item` owns: the saved_reel lookup, item status writes, quota reserve/consume/refund,
  cache hit/miss branch, the per-item `try/except` (failed marking + error event), and the
  organized/saved_reels terminal writes. `run_organize_job` keeps: claim, default injection of
  `scrape`/`extract`/`ground`, the item loop calling `_process_item` + `_update_job_counts`,
  final status, and the outer `except` → `_mark_organize_job_failed`.

**This is a behavior-preserving refactor.** The existing suite (585 tests) is the net; the new
tests pin the helper contracts so A2–A4 can target them.

- [ ] **Step 1: Write failing contract tests for the helpers**

```python
# backend/test_organizer_process_item.py
import pytest
from organizer import _ground_and_persist

@pytest.mark.asyncio
async def test_ground_and_persist_empty_grounded_is_location_not_found(fake_client):
    async def ground(place):
        return None
    terminal, count = await _ground_and_persist(fake_client, {"id": "r1"}, "cache-1", [make_place()], ground=ground)
    assert (terminal, count) == ("location_not_found", 0)

@pytest.mark.asyncio
async def test_ground_and_persist_persists_place_and_mention(fake_client):
    place = make_place()
    async def ground(p):
        return {"place": p, "country_code": "JP", "country_name": "Japan"}
    terminal, count = await _ground_and_persist(fake_client, {"id": "r1"}, "cache-1", [place], ground=ground)
    assert (terminal, count) == ("organized", 1)
    assert fake_client.tables["places"].inserted            # canonical row written
    assert fake_client.tables["reel_place_mentions"].upserted
```
Reuse/extend the existing fake-client fixtures from the current organizer tests (`make_place`
builds a complete `PlaceResult` with lat/lng/country/evidence/source_url — copy the pattern
already used in the organizer test module).

- [ ] **Step 2: Run — expect FAIL** (`ImportError: cannot import name '_ground_and_persist'`):
  `uv run pytest test_organizer_process_item.py -v --basetemp=.pytest-tmp`

- [ ] **Step 3: Extract the helpers.** Move lines 315-405 verbatim into `_process_item`; within
  it, move the ground→mention-rewrite→persist block (356-385 equivalent) into
  `_ground_and_persist`. Keep the `phase` variable, the exact quota-state machine, and the
  delete-then-insert mention behavior **unchanged in this task** (A3 fixes it — do not
  "fix while moving"). `run_organize_job` becomes:

```python
        items = (await client.table("organize_job_items").select("*").eq("job_id", job_id)
                 .eq("user_id", user_id).in_("status", ["queued", "processing"]).execute()).data or []
        for item in items:
            await _process_item(client, job_id, user_id, item, scrape=scrape, extract=extract, ground=ground)
            await _update_job_counts(client, job_id, user_id)
```

- [ ] **Step 4: Full suite green + evals green** (commands in Global Constraints). Zero
  behavioral diffs expected — any existing-test failure means the extraction changed behavior;
  fix the extraction, never the test.

- [ ] **Step 5: Commit** `refactor(organizer): extract _process_item/_ground_and_persist from run_organize_job`

**Fault-injection (reviewer):** in `_ground_and_persist`, swap the `location_not_found` return
for `"organized"` → Step-1 test 1 red. In `_process_item`, remove the inner `try/except` →
existing per-item-failure-isolation tests red. Restore.

---

### Task A2: Correct distributed leasing for BOTH job systems (ISSUES-B4 + the double-execution Major + the trip-side claim-erasure race)

**Severity/size:** **P1**, split across **two PRs** — **A-II** (organize side + the migration,
M) and **A-III** (trip side + the shared reaper, M). Roughly a day each including review.
Together they carry one migration, change a public `jobs.py` signature that `pipeline/runner.py`
consumes, add a background reaper to `lifespan`, and add ~13 tests including deterministic
barrier interleavings.

**Guardrails:** #12 (durable jobs: a deploy must never double-run *or* silently drop a run),
#3, #5/#6 (the new RPC is service-role only).

> **PR boundary (binding, not optional — this is finding 7's split):**
> **A-II** = Steps 1, 3, 4, 5 (migration, `organizer.py`, `append_organize_event` RPC, organize
> heartbeat) · **A-III** = Steps 2, 6, 7 (`jobs.py`, `runner.py`, trip heartbeat, the shared
> periodic reaper in `main.py`). The tests are already grouped along that line. **A-II landing
> alone leaves the trip-side race open**, so A-III must follow immediately and neither may be
> merged to `dev` before its own review gate passes. Both must land before A-IV starts —
> A-IV's maintenance window assumes leases already reclaim correctly.

#### What is actually broken (all verified against the code, not the report)

1. **Organize recovery erases live claims.** `recover_organize_jobs` accepts `stale_after_s`
   and never uses it (`organizer.py:263-281`) — it requeues **every** `processing` job. During
   a Render zero-downtime deploy the old instance is still working, so the new instance's
   pending-CAS then succeeds and two writers run one job (double Apify/OpenAI/Mapbox spend; the
   losing `_record_organize_event` insert collides on `organize_events_job_sequence_unique`
   inside the per-item `try`, marking successfully-organized items `failed`).
2. **Trip recovery is worse — it resurrects finished work.** `jobs.py:88-91` SELECTs stale
   `running` jobs with `.lt("locked_at", cutoff)` but UPDATEs with `.eq("id", r["id"])` and
   **no status guard**. Between the two statements the old worker can finish → `succeeded`;
   the update then flips `succeeded` → `retryable`, resurrecting a completed trip. A second
   interleaving erases a fresh `running` claim. The docstring's safety claim at `jobs.py:83-85`
   is **false for this path** — its idempotency argument covers *repeated* flips, not the
   resurrect. Fix the docstring, do not preserve it.
3. **Reclaim is not conditioned on the lease it observed.** Even with a staleness filter, two
   recovery instances interleave: A requeues, a worker claims and refreshes, then B's
   previously-selected row still matches `status='processing'` and erases the fresh claim.
4. **`lock_expires_at` is written but never read, and never renewed.** A legitimate organize
   lasting longer than the TTL becomes "stale" while still running.
5. **Recovery runs once, in `lifespan` (`main.py:63-79`).** After a crash, a job whose lock has
   not yet expired at boot is skipped and **nothing ever rechecks it** — it stays `processing`
   forever. That is a silent drop, which guardrail #12 forbids outright.
6. **No fencing.** An expired old worker can resume after a replacement claimed the job and
   write item/event/status rows underneath it.
7. **ISSUES-B4:** organize recovery dispatches `run_organize_job` with no semaphore
   (`main.py:76`), unlike the trip-side `_redispatch`.

**The design in one line:** a *lease* is `(status, lease_token, lock_expires_at)`; you own the
job only while your `lease_token` is the one on the row; every state transition is a CAS on
that token; a heartbeat renews it; a periodic reaper — not just boot — reclaims expired
leases; and event-sequence allocation moves into one serialized statement so correctness no
longer depends on distributed exactly-once execution at all.

**Files:**
- Create: `supabase/migrations/20260720090000_job_leases.sql`
- Modify: `backend/organizer.py` — `recover_organize_jobs`, the `run_organize_job` claim block, `_record_organize_event`, `_mark_organize_job_failed`, the final-status write, `_process_item` (lease-lost check)
- Modify: `backend/jobs.py` — `mark_job_running`, `mark_job_done`, `recover_inflight_jobs` (+ the false docstring)
- Modify: `backend/pipeline/runner.py` — thread the lease token from `mark_job_running` into both `mark_job_done` calls (lines 70, 99, 367)
- Modify: `backend/main.py` — `_redispatch_organize`, the periodic reaper task, `lifespan` shutdown
- Modify: `backend/test_jobs.py` (signature change), `backend/test_jobs_recovery.py`
- Test: `backend/test_organizer_lease.py` (new), `backend/test_job_lease_interleaving.py` (new), `supabase/tests/` pgTAP additions

**Interfaces (later tasks depend on these — keep exact):**
```python
# organizer.py
ORGANIZE_LEASE_TTL_S = 300        # short BECAUSE the heartbeat renews it → fast crash recovery
ORGANIZE_LEASE_RENEW_S = 60
class LeaseLost(RuntimeError): ...
async def recover_organize_jobs(client, *, now=None) -> list[dict]      # reclaim + return pending
async def _renew_organize_lease(client, job_id, user_id, token) -> bool # False = lease lost
async def _record_organize_event(client, job_id, user_id, event_type, message,
                                 payload=None, *, lease_token=None) -> None
# jobs.py
JOB_LEASE_TTL_S = 300
JOB_LEASE_RENEW_S = 60
async def mark_job_running(client, job_id: str) -> str | None   # was -> bool; now the TOKEN or None
async def mark_job_done(client, job_id: str, *, status: str, lease_token: str) -> None  # REQUIRED
async def _renew_job_lease(client, job_id: str, lease_token: str) -> bool               # False = lost
async def reclaim_expired_jobs(*, client=None, now=None) -> list[dict]   # renamed concept; see below
# main.py
REAP_INTERVAL_S = 120
async def _reap_loop(client) -> None
```

**`lease_token` is REQUIRED on `mark_job_done` — there is no unfenced form.** An earlier draft
allowed `lease_token=None` "for callers that never claimed"; that is exactly the fencing bypass
a stale worker would take. The only caller that can reach a terminal write without a token is
`runner._fail` when the run died *before* `mark_job_running` returned — and a run that never
owned the job **must not write the job's terminal state at all**. `_fail` therefore skips the
`mark_job_done` call entirely when it holds no token and leaves the row to the reaper. That is
both safer than the unfenced write and less code than threading an optional parameter.

**⚠ Consequence of that skip — a deterministic pre-claim failure now loops forever. Close it in
this task.** Leaving the row `pending` is right for a transient blip (the reaper redispatches and
the next attempt succeeds), but wrong for a *deterministic* pre-claim failure: a missing secret
raises before `mark_job_running` (e.g. `os.environ["APIFY_TOKEN"]` at
`backend/pipeline/runner.py:89`), `_reap_loop` redispatches every pending row each tick, and
trip-side `attempt_count` is never incremented (`jobs.py:68` — explicitly deferred), so **nothing
caps the retries**. Previously `_fail` terminal-failed it once; now the job loops eternally and
the trip flip-flops `generating` → `failed`. Required fix, cheapest form:

- **Validate required secrets at startup.** New `backend/config_validation.py`:

  ```python
  # ⚠ SUPABASE_JWT_SECRET is deliberately NOT here. ENV.md:15 — "SUPABASE_JWT_SECRET removed:
  # project uses asymmetric ES256 signing keys (JWKS), not a shared HS256 secret." Requiring it
  # would stop the app booting over a secret the project intentionally dropped.
  REQUIRED_SECRETS = (
      "OPENAI_API_KEY", "APIFY_TOKEN",
      "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",   # URL doubles as the JWKS source (ENV.md:13)
      "MAPBOX_SECRET_TOKEN",
  )

  def validate_required_secrets(env=None) -> None:
      """Raise RuntimeError naming every missing var. Config only — NO connectivity checks."""
      env = os.environ if env is None else env
      missing = [k for k in REQUIRED_SECRETS if not (env.get(k) or "").strip()]
      if missing:
          raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")
  ```

  **Placement is load-bearing:** call it in `lifespan` **BEFORE** the existing broad
  `try` at `main.py:70`. Inside that `try`, its bare `except Exception: pass` (`main.py:85-86`)
  would swallow the error and the app would boot broken — the exact opposite of fail-fast. That
  `try` must keep swallowing *DB* blips (a boot-time Supabase blip must degrade, not down the
  app); it must not swallow *config* errors.

  **Tests:** (a) missing var → lifespan raises, message names it; (b) all present → app starts and
  `/health` returns 200; (c) importing `main` with no env set still works (credential-free module
  import is an existing property — do not regress it).
- **Residual, stated honestly:** a *transient* pre-claim failure still retries indefinitely. That
  is the intended behavior (#12 restart-with-cache-reuse). **Deferred trigger:** add an attempt
  cap at claim the first time a job is observed redispatching more than ~10 times, which also
  requires making `attempt_count` incrementable (`jobs.py:68`).

- [ ] **Step 1: Failing tests — leases (organize side)**

```python
@pytest.mark.asyncio
async def test_unexpired_processing_job_is_not_reclaimed(fake_client):
    # lock_expires_at in the FUTURE → a live instance owns it mid-deploy; leave it alone
    seed_job(fake_client, status="processing", lease_token="t-old", lock_expires_at=in_minutes(4))
    assert await recover_organize_jobs(fake_client) == []
    assert fake_client.job_status("j1") == "processing"

@pytest.mark.asyncio
async def test_expired_lease_is_reclaimed_to_pending(fake_client):
    seed_job(fake_client, status="processing", lease_token="t-old", lock_expires_at=minutes_ago(1))
    assert [j["id"] for j in await recover_organize_jobs(fake_client)] == ["j1"]
    assert fake_client.job_status("j1") == "pending"

@pytest.mark.asyncio
async def test_claim_mints_a_fresh_token_and_preserves_started_at(fake_client):
    seed_job(fake_client, status="pending", started_at="2026-07-19T00:00:00+00:00")
    await run_organize_job("j1", "u1", client=fake_client, scrape=..., extract=..., ground=...)
    row = fake_client.job_row("j1")
    assert row["lease_token"] is not None
    assert row["started_at"] == "2026-07-19T00:00:00+00:00"   # first attempt's stamp survives

@pytest.mark.asyncio
async def test_legacy_null_token_processing_row_is_reclaimable(fake_client):
    # rows written before this migration have lease_token IS NULL — they must not be orphaned
    seed_job(fake_client, status="processing", lease_token=None, lock_expires_at=minutes_ago(1))
    assert [j["id"] for j in await recover_organize_jobs(fake_client)] == ["j1"]

@pytest.mark.asyncio
async def test_legacy_NULL_EXPIRY_processing_row_is_reclaimable(fake_client):
    """THE ROLLOUT-BOUNDARY ORPHAN. No production code has EVER written a non-null
    lock_expires_at (organize claim organizer.py:293-297 and trip claim jobs.py:70-72 both omit
    it; the only writes anywhere are None at organizer.py:251,:278,:412). So a job claimed by
    the OLD container during the A-II/A-III deploy overlap has lock_expires_at IS NULL, and
    `NULL < now()` is NULL — an expiry-only predicate skips it FOREVER. That is the silent drop
    #12 forbids, reintroduced by the very task meant to prevent it. Distinct from the test
    above: that one seeds a null TOKEN with a populated EXPIRY and would pass either way."""
    seed_job(fake_client, status="processing", lease_token=None,
             lock_expires_at=None, locked_at=minutes_ago(20))     # older than the TTL
    assert [j["id"] for j in await recover_organize_jobs(fake_client)] == ["j1"]

@pytest.mark.asyncio
async def test_legacy_null_expiry_row_INSIDE_ttl_is_not_reclaimed(fake_client):
    # the NULL branch must still respect the TTL — a live old-container job is not stolen
    seed_job(fake_client, status="processing", lease_token=None,
             lock_expires_at=None, locked_at=minutes_ago(1))
    assert await recover_organize_jobs(fake_client) == []

@pytest.mark.asyncio
async def test_trip_reclaim_clears_the_stale_lease_token(fake_client):
    """An expired-but-alive old worker must NOT be able to finalize a reclaimed job.
    mark_job_done fences on lease_token with NO status guard, so leaving the token in place
    lets the old worker's _fail flip `retryable` -> `failed`, cancelling the retry."""
    seed_trip_job(fake_client, status="running", lease_token="t1", lock_expires_at=minutes_ago(1))
    await reclaim_expired_jobs(client=fake_client)
    row = fake_client.job_row("j1")
    assert row["status"] == "retryable" and row["lease_token"] is None
    assert await mark_job_done(fake_client, "j1", status="failed", lease_token="t1") is False
    assert fake_client.job_row("j1")["status"] == "retryable"     # retry survives

@pytest.mark.asyncio
async def test_heartbeat_renews_the_lease_and_detects_loss(fake_client):
    seed_job(fake_client, status="processing", lease_token="mine", lock_expires_at=in_minutes(1))
    assert await _renew_organize_lease(fake_client, "j1", "u1", "mine") is True
    assert fake_client.job_row("j1")["lock_expires_at"] > now_iso()
    fake_client.set_job_field("j1", "lease_token", "someone-else")     # replaced underneath us
    assert await _renew_organize_lease(fake_client, "j1", "u1", "mine") is False

@pytest.mark.asyncio
async def test_fenced_writer_cannot_finalize_the_job(fake_client):
    # old worker resumes after a replacement claimed: its terminal write must no-op
    seed_job(fake_client, status="processing", lease_token="new-owner")
    await _mark_organize_job_failed(fake_client, "j1", "u1", lease_token="stale-owner")
    assert fake_client.job_status("j1") == "processing"      # untouched by the fenced writer

@pytest.mark.asyncio
async def test_organize_recovery_respects_recovery_semaphore():
    # >3 reclaimed organize jobs, each blocked on an event: max simultaneous ≤ 3, then
    # release → every job runs exactly once. Mirror the existing trip-side _redispatch
    # bound test; instrument a fake run_organize_job counting concurrent entries.
```

- [ ] **Step 2: Failing tests — leases (trip side) + deterministic interleavings.**
  These are the load-bearing ones Codex asked for. Each uses an `asyncio.Event` barrier that
  the fake client trips at a named point, so the interleaving is **deterministic, not timing-
  dependent** — no `sleep`, no flake.

```python
@pytest.mark.asyncio
async def test_recovery_does_not_resurrect_a_job_that_succeeded_mid_sweep():
    """Barrier: recovery SELECTs the stale row → the old worker completes (succeeded) →
    recovery's UPDATE lands. The status guard must make it a no-op.
    THIS IS THE jobs.py:88-91 BUG."""
    store = seed(jobs=[{"id": "j1", "status": "running", "lease_token": "t1",
                        "lock_expires_at": minutes_ago(1)}])
    client = BarrierClient(store, pause_after_select_on="jobs")
    sweep = asyncio.create_task(jobs.reclaim_expired_jobs(client=client))
    await client.selected.wait()                       # recovery has read the row
    await jobs.mark_job_done(client, "j1", status="succeeded", lease_token="t1")
    client.resume.set()
    await sweep
    assert store["jobs"]["j1"]["status"] == "succeeded"     # NOT resurrected as retryable

@pytest.mark.asyncio
async def test_recovery_does_not_erase_a_fresh_claim():
    """Barrier: recovery A reads the expired row → a worker claims fresh (new token) → A's
    UPDATE lands. The reclaim's `lock_expires_at < now` predicate must make it a no-op."""
    ... assert the row still holds the FRESH token and status 'running' ...

@pytest.mark.asyncio
async def test_reaper_does_not_reset_a_lease_the_heartbeat_just_renewed():
    """THE renewal/reaper race (Codex round 2, finding 1). The heartbeat deliberately keeps
    the SAME token, so a select-then-CAS reaper would still match it. Barrier: reaper reads
    the row as expired → the heartbeat renews (same token, future expiry) → the reaper's
    UPDATE lands. It must affect ZERO rows because `lock_expires_at < now` is re-evaluated
    against the renewed row, and the worker must NOT observe a lost lease."""
    store = seed(jobs=[{"id": "j1", "status": "running", "lease_token": "t1",
                        "lock_expires_at": minutes_ago(1)}])
    client = BarrierClient(store, pause_before_update_on="jobs")
    sweep = asyncio.create_task(jobs.reclaim_expired_jobs(client=client))
    await client.at_barrier.wait()
    assert await jobs._renew_job_lease(client, "j1", "t1") is True     # heartbeat wins the race
    client.resume.set()
    await sweep
    assert store["jobs"]["j1"]["status"] == "running"                  # NOT reset
    assert store["jobs"]["j1"]["lease_token"] == "t1"                  # lease intact
```
The `BarrierClient` fake must evaluate an update's full predicate (`status`, `lease_token`,
`lock_expires_at <`) against the row **at update time**, not at select time — that is what makes
this test meaningful. Pin that with a two-line fake-fidelity test of its own; a fake that
ignores `.lt()` would pass every assertion above while proving nothing.

```python

@pytest.mark.asyncio
async def test_fresh_crash_is_reclaimed_by_the_DELAYED_sweep_not_only_at_boot():
    """A job crashed with an unexpired lease is skipped at boot; after the TTL elapses the
    PERIODIC reaper must pick it up. Drive _reap_loop with an injected clock + a single
    iteration hook — never a real sleep."""
    ... assert reclaimed on the second reap tick, not the first ...

@pytest.mark.asyncio
async def test_lease_expiry_during_a_blocked_provider_call_aborts_the_run():
    """Item 1's `ground` blocks on a barrier; meanwhile the row's lease_token is replaced.
    The heartbeat must observe the loss and the item loop must raise LeaseLost BEFORE
    processing item 2 — and must not write item 2's terminal status."""

@pytest.mark.asyncio
async def test_old_worker_resuming_after_replacement_cannot_finalize_the_job():
    """Full old-vs-new sequence: old worker parked at a barrier, reaper reclaims, new worker
    claims and finishes, THEN the old worker resumes. Assert exactly the HARD-fenced set:
    the job's terminal state is the new worker's, event sequences are unique+gapless, and the
    old worker's event append raised AS409. Deliberately does NOT assert that no item row
    moved — item writes are bounded, not fenced (see the fencing table)."""

@pytest.mark.asyncio
async def test_mark_job_done_requires_a_token_and_a_stale_one_is_a_no_op():
    """Fencing bypass regression: mark_job_done has no unfenced form. A stale token leaves
    the replacement's terminal state intact; omitting the argument is a TypeError."""

@pytest.mark.asyncio
async def test_fail_without_a_lease_token_does_not_write_job_status():
    """A run that died BEFORE mark_job_running never owned the job: _fail must skip
    mark_job_done entirely and leave the row for the reaper (not flip it to failed)."""

@pytest.mark.asyncio
async def test_trip_heartbeat_renews_and_aborts_the_run_on_loss():
    """Trip-side mirror of the organize heartbeat: _renew_job_lease returns True while we
    own the lease; once the token is replaced it returns False, lease_lost is set, and the
    save block raises LeaseLost instead of writing the terminal trip status."""
```

- [ ] **Step 3: Run — expect FAIL** (no lease column, no token CAS, no heartbeat, no reaper, no semaphore path; the two trip-side interleavings fail against today's `jobs.py`).

- [ ] **Step 4: Migration** `20260720090000_job_leases.sql`

```sql
-- Leases: you own a job only while your lease_token is the one on the row.
alter table public.organize_jobs add column lease_token uuid;
alter table public.jobs
  add column lease_token uuid,
  add column lock_expires_at timestamptz;

-- Existing in-flight rows predate leases: give them a computed expiry so the reaper can
-- reclaim them (lease_token stays NULL; the reclaim CAS has an explicit `is null` branch).
update public.organize_jobs
   set lock_expires_at = coalesce(lock_expires_at, locked_at + interval '300 seconds')
 where status = 'processing';
update public.jobs
   set lock_expires_at = coalesce(locked_at + interval '300 seconds', now())
 where status = 'running';

create index organize_jobs_lease_reap_idx
  on public.organize_jobs (lock_expires_at) where status = 'processing';
create index jobs_lease_reap_idx
  on public.jobs (lock_expires_at) where status = 'running';
```

Plus the atomic-sequence + fence RPC. **This is what makes A6's invariant true rather than
asserted:** allocation is serialized by a row lock on the parent job, so it no longer depends
on there being exactly one live writer anywhere in the cluster.

```sql
create or replace function public.append_organize_event(
  p_job_id uuid, p_user_id uuid, p_lease_token uuid,
  p_event_type text, p_message text, p_payload jsonb default '{}'::jsonb
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_lease uuid;
  v_sequence integer;
begin
  -- One row lock serializes ALL event appends for this job: two concurrent callers cannot
  -- both compute the same MAX(sequence)+1, so organize_events_job_sequence_unique can no
  -- longer be violated by a legitimate racing writer.
  select lease_token into v_lease
    from public.organize_jobs
   where id = p_job_id and user_id = p_user_id
     for update;
  if not found then
    raise exception 'Organize job not found' using errcode = 'AS404';
  end if;
  -- FENCE: p_lease_token is REQUIRED — there is no unfenced form.
  -- An earlier draft allowed `p_lease_token is null` as an "unfenced caller (boot paths that
  -- legitimately have no lease yet)". No such caller exists: EVERY event writer runs after the
  -- claim returns (verified — organizer.py:422, :434, :455, :485, and _mark_organize_job_failed
  -- from run_organize_job's outer except; the claim early-returns at `if not claimed.data`).
  -- It was the same speculative unfenced form already deleted from mark_job_done, and left in
  -- it would be a standing bypass: a caller with no token writing to a row with no token
  -- (null IS NOT DISTINCT FROM null) sails straight through.
  if p_lease_token is null then
    raise exception 'Organize event requires a lease token' using errcode = 'AS400';
  end if;
  if v_lease is distinct from p_lease_token then
    raise exception 'Organize job lease superseded' using errcode = 'AS409';
  end if;
  select coalesce(max(sequence), 0) + 1 into v_sequence
    from public.organize_events where job_id = p_job_id;
  insert into public.organize_events (user_id, job_id, sequence, event_type, message, payload)
  values (p_user_id, p_job_id, v_sequence, p_event_type, p_message, coalesce(p_payload, '{}'::jsonb));
  return v_sequence;
end;
$$;

revoke all on function public.append_organize_event(uuid, uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.append_organize_event(uuid, uuid, uuid, text, text, jsonb)
  to service_role;
```
pgTAP: function exists, is `security definer` with empty `search_path`, `authenticated` has no
execute; `throws_ok` on `AS409` for a superseded token and `AS404` for an unknown job;
sequences are gapless across N appends.

- [ ] **Step 5: Implement — organize side**

```python
# organizer.py
ORGANIZE_LEASE_TTL_S = 300      # short on purpose: the heartbeat renews a live run, so a
ORGANIZE_LEASE_RENEW_S = 60     # SHORT ttl means a real crash is reclaimed in ~5 min, not 15.


class LeaseLost(RuntimeError):
    """Another worker holds this job's lease; this run must stop writing immediately."""


async def recover_organize_jobs(client, *, now=None) -> list[dict]:
    """Reclaim organize jobs whose LEASE HAS EXPIRED, then return pending jobs to dispatch.

    ONE atomic UPDATE, no select-then-CAS loop. `lock_expires_at < now` is evaluated by
    Postgres as part of the update's own predicate, so a heartbeat that renews the lease
    concurrently makes the row stop matching (READ COMMITTED re-checks the predicate against
    the updated row version) and the reclaim skips it. A select-then-update version CANNOT do
    this: it would compare a token it observed BEFORE the renewal, and since the heartbeat
    deliberately keeps the same token, the stale-but-matching token would let the reaper reset
    a live lease to pending. Collapsing to one statement removes that race and the
    null-token branch fork at the same time — legacy rows match on expiry alone.
    """
    now = now or datetime.now(timezone.utc)
    # LEGACY-NULL BRANCH IS LOAD-BEARING — do not simplify to `.lt("lock_expires_at", ...)`.
    # NO production code today writes a non-null lock_expires_at: the organize claim
    # (organizer.py:293-297) and the trip claim (jobs.py:70-72) never set it, and the only
    # writes anywhere are `None` (organizer.py:251, :278, :412). During the A-II/A-III deploy
    # overlap the OLD container can claim jobs right up to SIGTERM, leaving lock_expires_at
    # NULL. In SQL `NULL < now()` is NULL, not true — so an expiry-only predicate skips those
    # rows FOREVER, which is precisely the silent drop guardrail #12 forbids, reintroduced at
    # this task's own rollout boundary. Fall back to locked_at + TTL for those rows.
    legacy_cutoff = (now - timedelta(seconds=ORGANIZE_LEASE_TTL_S)).isoformat()
    reclaimed = (await client.table("organize_jobs").update({
        "status": "pending", "status_message": "Requeued after restart",
        "locked_at": None, "lock_expires_at": None, "lease_token": None,
    }).eq("status", "processing").or_(
        f"lock_expires_at.lt.{now.isoformat()},"
        f"and(lock_expires_at.is.null,locked_at.lt.{legacy_cutoff})"
    ).execute()).data or []
    if reclaimed:
        logger.info("organize_leases_reclaimed count=%d", len(reclaimed))
    return (await client.table("organize_jobs").select("id,user_id").eq("status", "pending")
            .order("created_at").execute()).data or []
```

**Why the reclaim and the heartbeat cannot both win.** Whichever transaction commits first
wins, in both orders, with no third outcome: if the heartbeat commits first, its new
`lock_expires_at` is in the future and the reaper's predicate no longer matches → the live
lease survives. If the reaper commits first, it nulls `lease_token`, so the heartbeat's
`.eq("lease_token", token)` matches zero rows → `_renew_organize_lease` returns `False` → the
worker learns it lost the lease. This is the property the interleaving test in Step 2 pins.

Delete the `initializing` sweep (lines 265-272) here — it is dead code: the
`create_saved_reels_organize_job` RPC inserts `'pending'` directly
(`20260719102000_saved_reels_active_item_guard.sql`), verified: nothing repo-wide writes
`status='initializing'`. (`_initializing_job_is_stale` itself is deleted in B6. Keep the
`'initializing'` value in the DB check constraint and the `OrganizeJobStatus` Literal —
removing those is frontend-visible churn for zero value.)

Claim block — select `"attempt_count,started_at"`, mint a token, and keep it for the run:

```python
    lease_token = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    claim_update = {
        "status": "processing", "status_message": "Finding places",
        "locked_at": now.isoformat(),
        "lock_expires_at": (now + timedelta(seconds=ORGANIZE_LEASE_TTL_S)).isoformat(),
        "lease_token": lease_token,
        "attempt_count": attempt_count,
    }
    if not (current.data if current is not None else {}).get("started_at"):
        claim_update["started_at"] = now.isoformat()     # first attempt's stamp is not overwritten
    claimed = await (client.table("organize_jobs").update(claim_update)
                     .eq("id", job_id).eq("user_id", user_id).eq("status", "pending").execute())
    if not claimed.data:
        return {"skipped": "job already claimed"}
```

Renewal + the heartbeat task:

```python
async def _renew_organize_lease(client, job_id: str, user_id: str, lease_token: str) -> bool:
    """Extend our lease. False means we LOST it (reaped + reclaimed by another worker)."""
    now = datetime.now(timezone.utc)
    result = await (client.table("organize_jobs").update({
        "lock_expires_at": (now + timedelta(seconds=ORGANIZE_LEASE_TTL_S)).isoformat(),
    }).eq("id", job_id).eq("user_id", user_id).eq("status", "processing")
     .eq("lease_token", lease_token).execute())
    return bool(result.data)


async def _heartbeat(client, job_id, user_id, lease_token, lost: asyncio.Event) -> None:
    while not lost.is_set():
        await asyncio.sleep(ORGANIZE_LEASE_RENEW_S)
        try:
            if not await _renew_organize_lease(client, job_id, user_id, lease_token):
                lost.set()                      # someone else owns the job now
                return
        except Exception:
            logger.warning("organize_lease_renew_failed job_id=%s", job_id)
            # A renewal BLIP is not a lost lease; keep working. Losing the lease requires an
            # authoritative 0-row CAS, not a transport error. If blips persist past the TTL
            # the reaper reclaims us and the next renewal returns 0 rows → lost.
```

Wire it in `run_organize_job` around the item loop, and check before each item:

```python
        lease_lost = asyncio.Event()
        beat = asyncio.create_task(_heartbeat(client, job_id, user_id, lease_token, lease_lost))
        try:
            for item in items:
                if lease_lost.is_set():
                    raise LeaseLost(f"organize job {job_id} lease superseded")
                await _process_item(client, job_id, user_id, item, lease_token=lease_token,
                                    scrape=scrape, extract=extract, ground=ground)
                await _update_job_counts(client, job_id, user_id)
        finally:
            lease_lost.set()
            beat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await beat
```

Fence every `organize_jobs` write in the run — the final-status update and
`_mark_organize_job_failed` both gain `.eq("lease_token", lease_token)`, and
`_mark_organize_job_failed` gains a `lease_token` keyword. `_record_organize_event` becomes a
thin wrapper over the RPC, passing `lease_token`, and treats `AS409` as a lost lease (log +
return, never crash a terminal path).

**What is hard-fenced vs. bounded — say it precisely, because the tests must assert the real
guarantee and not a stronger one.**

| Write | Table | Fencing |
|---|---|---|
| Event append | `organize_events` | **Hard** — the RPC rejects a superseded `p_lease_token` (`AS409`) |
| Final job status, `_mark_organize_job_failed` | `organize_jobs` | **Hard** — `.eq("lease_token", ...)` on the update |
| Item terminal status, `saved_reels.analysis_status`, mention replacement | `organize_job_items`, `saved_reels`, `reel_place_mentions` | **Bounded, not fenced** — see below |

A superseded worker parked inside one item's provider call can still land **that one item's**
terminal write, because the `lease_lost` check happens between items, not mid-item. The bound
is one `ORGANIZE_LEASE_RENEW_S` window (60 s) plus the in-flight provider call; the blast radius
is one item's status on a job that is being re-run from Phase 1 anyway. Closing it completely
means routing every item write through a fenced RPC — **deliberately deferred** with a concrete
trigger (register).

**Therefore the Step-2 test named `..._writes_nothing` asserts something false and is renamed**
to `test_old_worker_resuming_after_replacement_cannot_finalize_the_job`, asserting exactly the
hard-fenced set: the job's terminal state is the new worker's, event sequences are unique and
gapless, and the old worker's event append raised `AS409`. It must NOT assert that no item row
moved — that would be a test of a guarantee this task does not ship.

- [ ] **Step 6: Implement — trip side (`jobs.py` + `runner.py`)**

```python
async def mark_job_running(client, job_id: str) -> str | None:
    """Atomic CAS claim: pending/retryable -> running in ONE statement, minting this
    attempt's LEASE TOKEN. Returns the token iff THIS caller won, else None (already
    claimed → the caller must abort). The token fences every later write for this attempt."""
    lease_token = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    result = await (client.table("jobs").update(
        {"status": "running", "locked_at": now.isoformat(), "started_at": now.isoformat(),
         "lock_expires_at": (now + timedelta(seconds=JOB_LEASE_TTL_S)).isoformat(),
         "lease_token": lease_token,
         "completed_at": None, "error_message": None})
        .eq("id", job_id).in_("status", ["pending", "retryable"]).execute())
    return lease_token if result.data else None


async def mark_job_done(client, job_id: str, *, status: str, lease_token: str) -> bool:
    """running -> succeeded|failed, fenced on our lease so a superseded worker cannot
    overwrite the replacement's terminal state. The token is REQUIRED: an optional-token
    form is a fencing bypass, and a caller with no token never owned the job.

    RETURNS bool — True iff we still held the lease and the write landed. Callers MUST check
    it: `False` means we were superseded, and the caller must then suppress its terminal
    `generation_events` result too (see the terminal-result fence below). Returning None here
    would make the fence unobservable to the one caller that has to react to it."""
    result = await (client.table("jobs").update({"status": status, "completed_at": _now()})
                    .eq("id", job_id).eq("lease_token", lease_token).execute())
    return bool(result.data)
```

#### Terminal `generation_events` MUST be fenced — but ONLY terminal ones

**Scope concession, both directions.** The reviewer's blanket demand to fence every write site
was rejected and it agreed: per-item organizer writes, `saved_reels` status, normalized trip
persistence, and **non-terminal** progress events stay bounded-and-deferred for a zero-traffic
beta (jobs re-run from Phase 1 anyway, #12). But it isolated one case that genuinely differs, and
it is right: **a terminal `result` event is protocol state, not telemetry.**

Verified against the code:
- `backend/api/streaming.py:53` — the stream ends on the first row with `event_type == "result"`.
- The seen-set dedupes by row **`id`**, so a *second writer's* row is a different id and is NOT
  deduped.
- Both terminal paths emit one: `runner.py:64` (`"generation failed"`) and `runner.py:363`
  (`"generation complete"`).

**Failure scenario:** superseded worker W1's lease expires; the reaper reclaims; W2 claims and
starts. W1, still alive, hits its terminal path and appends a `result` row. The user's SSE session
**ends on W1's stale result** — showing a failure that isn't real, or a stale itinerary — and W2's
genuine result is never delivered. `mark_job_done`'s fence alone does not prevent this: it stops
W1 writing the *job* row, but nothing stops it writing the *event*.

**Fix — one transactional RPC, replacing the separate terminal `record_event` + `mark_job_done`
pair.** Atomic and lease-validated together, so the two cannot disagree:

```sql
-- CORRECTED 2026-07-19 after the A2 runbook pass. The first draft of this RPC (written in
-- response to Codex round 3, i.e. AFTER the last review gate, so nothing reviewed it) had
-- three errors that would each fail at FIRST EXECUTION:
--   1. `p_lease_token text` compared against `jobs.lease_token uuid` -> "operator does not
--      exist: uuid = text". plpgsql defers this to runtime, so `supabase db reset` alone does
--      NOT catch it — only a pgTAP execution test does.
--   2. Inserted a `user_id` column into `generation_events`, which HAS NO SUCH COLUMN
--      (verified: 20260701151718_trip_job_backbone.sql:55-62 — trip_id, event_type, stage,
--      message, payload, created_at only).
--   3. Missing `set search_path = ''` and the revoke/grant block that append_organize_event
--      correctly has. NOTE — an earlier draft of this comment claimed `supabase db lint` flags
--      mutable search_path on security definer. It does NOT: verified 2026-07-19 by removing
--      `set search_path = ''` and running `supabase db lint --local`, which reported "No schema
--      errors found". Only the pgTAP assertion catches it. Do not rely on lint for this.
-- SHIPS IN A-II's migration, not A-III: the arc table says A-III carries no DDL, and this is
-- additive and uncalled by old code, so folding it forward costs nothing.
create or replace function public.complete_trip_run(
  p_job_id uuid, p_trip_id uuid, p_lease_token uuid,
  p_status text, p_stage text, p_message text, p_payload jsonb
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  -- Fence FIRST: claim the terminal transition in one statement. A superseded worker fails
  -- here and writes NOTHING — that is what makes "no job write => no event write" true
  -- rather than merely probable.
  update public.jobs set status = p_status, completed_at = now()
   where id = p_job_id and lease_token = p_lease_token and status = 'running';
  if not found then return false; end if;

  insert into public.generation_events (trip_id, event_type, stage, message, payload)
  values (p_trip_id, 'result', p_stage, p_message, p_payload);
  return true;
end $$;

revoke all on function public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)
  to service_role;
```

`runner.py` calls it on BOTH terminal paths (success at :363, failure at :64) instead of the
current `record_event(...)` + `mark_job_done(...)` pair. **A `false` return means we were
superseded: log and return, emit nothing.** Non-terminal `record_event` calls are untouched.

**Tests:** (a) W1 expired + W2 claimed → W1's `complete_trip_run` returns false, `generation_events`
gains NO result row, job keeps W2's state; (b) the normal single-worker path still writes exactly
one result and completes the job; (c) a pre-claim transient failure (no token) writes no result;
(d) **fault injection** — drop the `lease_token` predicate from the RPC's `update` → test (a) goes
red → restore.

**Why an RPC and not two fenced statements:** a fenced UPDATE followed by a separate INSERT can
still interleave — W1's update could fail while its insert lands. One transaction is what makes
"no job write ⇒ no event write" true rather than probable.

```python


async def _renew_job_lease(client, job_id: str, lease_token: str) -> bool:
    """Extend our trip lease. False means we LOST it (reaped + reclaimed elsewhere)."""
    now = datetime.now(timezone.utc)
    result = await (client.table("jobs").update(
        {"lock_expires_at": (now + timedelta(seconds=JOB_LEASE_TTL_S)).isoformat()})
        .eq("id", job_id).eq("status", "running").eq("lease_token", lease_token).execute())
    return bool(result.data)


async def reclaim_expired_jobs(*, client=None, now=None) -> list[dict]:
    """Reclaim runs whose LEASE HAS EXPIRED (running -> retryable), then return reclaimable
    jobs. ONE atomic UPDATE — same reasoning as recover_organize_jobs: the expiry lives in
    the update's own predicate, so a concurrent heartbeat renewal makes the row stop matching
    and a concurrent completion is excluded by status='running'.

    The previous implementation updated by id alone, which had two live bugs: a worker that
    finished between the select and the update had its `succeeded` RESURRECTED as `retryable`
    (a completed trip re-runs and double-charges), and a freshly claimed `running` row was
    erased. `mark_job_running`'s CAS cannot fix either — it only guards the pending->running
    transition. Restart-with-cache-reuse, NOT resume (#12)."""
    client = client or await get_supabase_client()
    now = now or datetime.now(timezone.utc)
    # Legacy-NULL branch: same load-bearing reason as recover_organize_jobs — mark_job_running
    # (jobs.py:70-72) never wrote lock_expires_at, so any row claimed by the OLD container
    # during the deploy overlap has NULL and `NULL < now()` is NULL, not true. Without this
    # branch those rows are never reclaimed and the run is silently dropped (#12).
    legacy_cutoff = (now - timedelta(seconds=JOB_LEASE_TTL_S)).isoformat()
    # Clear the lease fields too — do NOT leave the stale token in place. If the row keeps its
    # token, an expired-but-still-alive old worker whose `_fail` fires between this reclaim and
    # the redispatch's claim will pass mark_job_done's `.eq("lease_token", t1)` fence (which has
    # no status guard) and flip `retryable` -> `failed`, cancelling the retry this reclaim just
    # scheduled. Nulling mirrors recover_organize_jobs; the heartbeat still detects loss via its
    # own `status='running'` CAS.
    reclaimed = (await client.table("jobs").update({
        "status": "retryable", "lease_token": None,
        "lock_expires_at": None, "locked_at": None,
    }).eq("status", "running").or_(
        f"lock_expires_at.lt.{now.isoformat()},"
        f"and(lock_expires_at.is.null,locked_at.lt.{legacy_cutoff})"
    ).execute()).data or []
    if reclaimed:
        logger.info("trip_leases_reclaimed count=%d", len(reclaimed))
    return (await client.table("jobs").select("id,trip_id,user_id")
            .in_("status", ["pending", "retryable"]).execute()).data or []
```
Keep `recover_inflight_jobs` as a thin deprecated alias only if something outside
`main.py`/tests calls it — **verified: nothing does**, so rename outright and update
`main.py:38,72` and `test_jobs_recovery.py`.

`runner.py`: line 99 becomes
```python
        lease_token = await mark_job_running(client, job_id) if job_id else None
        if job_id and lease_token is None:
            return {"skipped": "job already claimed by another run"}
```
and the success-tail `mark_job_done` (line 367) passes `lease_token=lease_token`. `_fail`
(line 70) gains `lease_token` in its module-private signature and **skips the `mark_job_done`
call when it is `None`** — a run that never claimed must not write the job's terminal state;
the reaper owns that row. Initialize `lease_token = None` before the `try` so the pre-claim
failure path has it in scope.

**The trip side gets a heartbeat too.** An earlier draft rejected it on the grounds that
measured trip runtime is 76.8 s cold / 13.9 s warm (memory: latency-optimization), far inside a
300 s TTL. That argument does not survive contact with the code: **the trip pipeline has no
upper time bound.** `Runner.run(agent, user_input, max_turns=12)`
(`backend/genagents/place_extractor.py:235`) sets **no timeout** on an agent loop that issues
`web_search` calls, and extraction is the dominant phase (39–72 % of runtime). Apify's client
allows 130 s *per reel* (`scrape/apify_direct.py:54`) — gathered, so ~130 s worst case, but
stacked on an unbounded extract. 76.8 s is a measurement, not a bound; one wedged upstream
connection puts a live run past 300 s, and the reaper would then reclaim a job that is still
writing. The heartbeat is ~15 lines reusing the organizer's `_heartbeat` verbatim against
`_renew_job_lease`, and it deletes a deferral-register row. Cheaper than being wrong.

Wire it exactly as the organize side does: one `lease_lost` `asyncio.Event`, a `_heartbeat`
task started right after the claim, cancelled in a `finally`.

**Which trip writes are fenced (and which are deliberately not):**

| Write | Site | Fencing |
|---|---|---|
| Job terminal status | `mark_job_done` (`runner.py:70`, `:367`) | **Hard** — required-token CAS |
| Terminal trip status + the normalized-persistence block | `_set_status` (`runner.py:46`), `persist_itinerary` (`runner.py:229`) | **Gated** — `if lease_lost.is_set(): raise LeaseLost` immediately before the save block and before the terminal `_set_status`. Bounded by one `JOB_LEASE_RENEW_S` (60 s), same contract as the organize item loop |
| `generation_events` appends | `record_event` (`runner.py:38`) | **Not fenced — justified.** Unlike `organize_events`, `generation_events` has **no unique sequence constraint** (verified: `20260701151718_trip_job_backbone.sql:55`, no unique index), so a duplicate append cannot fail a run or corrupt a row; the SSE stream already dedups by a seen-set cursor, so the worst case is a cosmetic duplicate line in the reasoning panel. Fencing it costs an RPC round-trip per event on the hot streaming path and buys nothing. Deferred with a trigger (register) |

The gating is in-process, not a DB CAS — it does not close a mid-write race, it bounds it. Say
so in the PR body; do not claim the trip side is "fully fenced".

- [ ] **Step 7: Implement — periodic reaper (kills the silent-drop, guardrail #12)**

```python
# main.py
REAP_INTERVAL_S = 120

async def _redispatch_organize(client, job: dict) -> None:
    """Bound organize re-dispatch with the same recovery semaphore as trips (ISSUES-B4)."""
    async with _RECOVERY_SEM:
        await run_organize_job(job["id"], job["user_id"], client=client)


async def _reap_loop(client) -> None:
    """Boot-time recovery is NOT enough: a job that crashed with an unexpired lease is
    skipped at boot and would otherwise stay `processing` forever (silent drop — #12).
    Reclaim on a timer instead. Concurrent reapers across instances are safe: every
    reclaim is a lease-token CAS."""
    while True:
        await asyncio.sleep(REAP_INTERVAL_S)
        try:
            for job in await reclaim_expired_jobs(client=client):
                _spawn(_redispatch(client, job))
            for job in await recover_organize_jobs(client):
                _spawn(_redispatch_organize(client, job))
        except Exception:
            logger.warning("reap_loop_iteration_failed", exc_info=True)
            # A DB blip must never kill the reaper — that would reinstate the silent drop.
```
In `lifespan`: replace the direct `run_organize_job(...)` task with `_redispatch_organize`,
factor the existing task-retention pattern into `_spawn`, start `_reap_loop` as a retained
task, and **cancel it after `yield`** (the current `lifespan` has no shutdown half — add a
`try: yield finally: cancel + await with suppress(CancelledError)`).

- [ ] **Step 8: Full gates, run once per PR** — backend suite + evals for both; the Supabase
  gate (`supabase db reset && supabase test db && supabase db lint --local`) in **A-II**, which
  owns the migration.
- [ ] **Step 9: Commits, grouped by PR** (one per seam, so a bisect lands somewhere useful):

  **A-II →** merge, apply migration first per the protocol, then continue on A-III:
  1. `feat(db): job leases — lease_token + lock_expires_at, fenced append_organize_event RPC`
  2. `fix(organizer): atomic expiry reclaim, renewal heartbeat, fenced writes (double-execution Major)`

  **A-III →** branch off `dev` after A-II merges:
  3. `fix(jobs): stop recovery resurrecting succeeded runs and erasing fresh claims (atomic reclaim)`
  4. `fix(runner): trip lease heartbeat + required fencing token on terminal writes`
  5. `fix(api): periodic lease reaper + semaphore-bounded organize redispatch (ISSUES-B4, silent-drop)`

**Fault-injection (reviewer — every one must be load-bearing):**

*A-II (organize side):*
1. Make `_renew_organize_lease` always return `True` → the lease-expiry-during-provider-call
   test goes red. Restore.
2. Remove the `p_lease_token` fence from `append_organize_event` → the
   old-worker-resumes-after-replacement test goes red. Restore.
3. Drop `.eq("lease_token", lease_token)` from the final-status update → the
   fenced-writer-cannot-finalize test goes red. Restore.

*A-III (trip side + reaper):*
4. Drop `.eq("status", "running")` from `reclaim_expired_jobs`' update → the resurrect
   interleaving test goes red. Restore.
5. Replace the atomic reclaim with a select-then-update loop that CASes on the observed token
   → `test_reaper_does_not_reset_a_lease_the_heartbeat_just_renewed` goes red. **This is the
   round-2 finding-1 regression guard — it must be run, not assumed.** Restore.
6. Give `mark_job_done` a `lease_token: str | None = None` default and drop the `.eq` → the
   fencing-bypass test goes red. Restore.
7. Make `_fail` call `mark_job_done` with a fabricated token when it has none → the
   never-owned-the-job test goes red. Restore.
8. Remove the `_redispatch_organize` semaphore `async with` → the concurrency bound goes red.
   Restore.

**Deferrals (concrete triggers):**
- Per-item fenced writes (an RPC for `organize_job_items` updates) — when a live incident shows
  a superseded worker's item write actually landing (the `organize_lease_renew_failed` warning
  plus a job whose item states disagree with its final counts is the signal).
- Fenced `generation_events` appends — when `generation_events` gains a uniqueness constraint,
  or a duplicate event is observed corrupting the reasoning panel rather than merely repeating
  a line.
- Split organizer-vs-trip semaphore budget — only when a measured boot backlog shows trip
  recovery starving organize recovery (ISSUES-B4's own recommendation).

---

### Task A3: Mention-rewrite Major — user-scope `reel_place_mentions` and replace one owner's set atomically

**Ships as PR A-IV, on its own, after A-II and A-III have merged.** Its deployment is a
**maintenance window**, not an ordinary merge — the six-step procedure is in the DEPLOY HAZARD
section above and is repeated as Step 6's checklist. An expand/contract split is impossible
here (the PK blocks the fan-out and dropping it breaks the deployed upsert); do not re-derive
one.

**Severity/size:** **P1 / L** (~2 days incl. review). It is a **destructive-backfill migration
on the repo's trust boundary**, plus a new transactional RPC, plus three Python call sites,
plus a view + a security-definer function rewrite, plus pgTAP. **Do not understate it.**
**Guardrails:** #1 (verified evidence must not be silently destroyed), #3 (a Mapbox brownout is
a partial failure, not a data-loss event), **#6 (owner checks — this table IS the check)**, #7.

`reel_place_mentions` is keyed `(reel_cache_id, place_id)` with **no user or saved-Reel
dimension** (`20260718130000_saved_reels_organize.sql:25-33`), granted to `service_role` only
(lines 171-172) — so all users who saved the same Reel share rows and RLS cannot help, because
the backend *is* `service_role`. Today the unscoped `delete().eq("reel_cache_id", ...)` runs
**before** checking `grounded`, so a flaky Mapbox run destroys another user's verified
evidence and `authorize_place_ids` then fails on places that user legitimately used.

**⚠ The earlier plan's fix was insufficient and is superseded.** Reordering to
upsert-first/prune-last still ran `delete ... where reel_cache_id = ? and place_id not in
(this run's ids)` — i.e. it still deleted **every user's** rows outside one run's result set.
A partial user-B rewrite still destroyed user-A-only mentions, and two concurrent organizers
still pruned each other. The user's decision (fixed): **add the user dimension and replace only
that owner's set in one transactional RPC.**

**Files:**
- Create: `supabase/migrations/20260720080000_reel_place_mentions_user_scope.sql`
- Modify: `backend/organizer.py` — `_ground_and_persist` (the A1 helper), `_persist_mention`, **`authorize_place_ids` (96-120)**
- Modify: `backend/geocode/mapbox_reverse.py::parse_reverse_country_response` (34-37)
- Test: `backend/test_organizer_mention_rewrite.py` (new), extend `backend/test_mapbox_reverse.py`, extend `supabase/tests/007_saved_reels_organize.sql`

**Interfaces:**
- `_ground_and_persist(client, reel, cache_id, places, *, ground)` gains `user_id` (it now
  writes an owner-scoped set). `_persist_mention` is **replaced** by one RPC call.
- `parse_reverse_country_response` returns `CountryResult` (never `None`) or raises;
  `reverse_country`'s return annotation becomes `CountryResult`.

#### Step 0 — the backfill policy (decide and record BEFORE writing the migration)

Existing rows carry no owner, and the owner is **not recoverable** — nothing records which
user's organize run created a given mention. So the migration must pick a documented policy.
**Policy (chosen, implement this):**

- **Fan out** each existing row to every user who has a `saved_reels` row for that
  `reel_cache_id` with `analysis_status = 'organized'`. Rationale: that set is exactly the set
  of users for whom `authorize_place_ids` (`organizer.py:106-107`) currently succeeds, so the
  *authorization* surface is preserved bit-for-bit.
- **Delete** rows whose `reel_cache_id` has **no** organized owner. Rationale: they are already
  unreachable — `authorize_place_ids` requires `analysis_status='organized'`, so no user can
  turn them into a trip — and they are **fully regenerable**: the next organize of that Reel
  re-derives them from the frozen extraction cache with **zero Apify/OpenAI spend** (cache hit)
  and, after A4, zero Mapbox spend too.
- **⚠ PRODUCT BEHAVIOR CHANGE — needs Zhi Hao's explicit sign-off BEFORE the migration is
  written, not after.** Two surfaces, and they are not the same:
  - *Authorization is preserved exactly.* `authorize_place_ids`' current permission set IS
    "has an organized saved Reel for this cache" (`organizer.py:96`), which is precisely the
    fan-out set; orphan deletion is authorization-neutral. Independently confirmed in Codex
    review round 2. **No user loses the ability to build a trip they could build today.**
  - *Visibility narrows.* `saved_reel_cards` joins mentions on `reel_cache_id` alone, with **no
    `analysis_status` filter** (`20260719103000_saved_reels_current_cache_signal.sql:36`), so a
    user who saved a Reel someone else organized currently *sees* those pins even when their own
    analysis is `location_not_found` / `failed` / `not_analyzed` — pins that
    `authorize_place_ids` would then reject, failing generation terminally. After this migration
    they see none until they organize it themselves. **This is strictly security-safe and it
    removes a see-it-but-cannot-use-it dead end, but it is a visible product change**: the card
    goes from "shows borrowed pins" to "shows nothing yet". B3 Step 3.2 makes the same
    tightening on purpose; A3 gets there first for the mention join.
  - **Gate:** post the two bullets above to Zhi Hao and get a yes before Step 3. If he wants
    borrowed pins to remain visible, that is a *view* change (surface someone-else-organized
    mentions as read-only/unselectable) and it is a separate task — the owner column and the
    RPC ship regardless.

- [ ] **Step 0 (implementer, before writing DDL):** run and record in the PR body —
  ```sql
  select count(*) as total,
         count(*) filter (where not exists (
           select 1 from public.saved_reels sr
            where sr.reel_cache_id = m.reel_cache_id and sr.analysis_status = 'organized')) as orphans
    from public.reel_place_mentions m;
  ```
  **If `orphans > 0` on a database with real user data, STOP and report before proceeding** —
  the delete is irreversible and the local `supabase db reset` gate proves the DDL, not the
  data policy. (On a fresh local reset both counts are 0; that is not evidence.)

- [ ] **Step 1: Failing tests**

```python
@pytest.mark.asyncio
async def test_failed_grounding_preserves_existing_mentions(fake_client):
    seed_mentions(fake_client, user_id="uA", cache_id="c1", place_ids=["p1", "p2", "p3"])
    async def ground(place):
        return None                                        # brownout: nothing grounds
    terminal, count = await _ground_and_persist(
        fake_client, {"id": "rB"}, "c1", [make_place()], user_id="uB", ground=ground)
    assert terminal == "location_not_found"
    assert fake_client.mention_place_ids("uA", "c1") == {"p1", "p2", "p3"}   # untouched

@pytest.mark.asyncio
async def test_rewrite_never_touches_another_users_mentions(fake_client):
    """THE Major. User A organized the same Reel and got p1,p2,p3. User B's run yields only
    p1 — A's set must be byte-identical afterwards."""
    seed_mentions(fake_client, user_id="uA", cache_id="c1", place_ids=["p1", "p2", "p3"])
    seed_mentions(fake_client, user_id="uB", cache_id="c1", place_ids=["p1", "p9"])
    ...  # B's run grounds to p1 only
    assert fake_client.mention_place_ids("uA", "c1") == {"p1", "p2", "p3"}   # untouched
    assert fake_client.mention_place_ids("uB", "c1") == {"p1"}               # B's p9 pruned

@pytest.mark.asyncio
async def test_crash_mid_persist_leaves_old_mentions_intact(fake_client):
    seed_mentions(fake_client, user_id="uB", cache_id="c1", place_ids=["p1", "p2"])
    fake_client.fail_on_insert("places", after=1)          # _persist_place raises on 2nd place
    with pytest.raises(Exception):
        await _ground_and_persist(...)
    assert {"p1", "p2"} <= fake_client.mention_place_ids("uB", "c1")   # RPC never ran

@pytest.mark.asyncio
async def test_authorize_place_ids_rejects_another_users_mention(fake_client):
    """The trust boundary is now the user column, not the shared cache row."""
    seed_mentions(fake_client, user_id="uA", cache_id="c1", place_ids=["p1"])
    seed_saved_reel(fake_client, user_id="uB", cache_id="c1", analysis_status="organized")
    with pytest.raises(PermissionError):
        await authorize_place_ids(fake_client, "uB", ["p1"])

@pytest.mark.asyncio
async def test_two_entries_resolving_to_the_same_place_id_do_not_fail_the_rpc(fake_client):
    """A Reel can name one venue twice; _persist_place then returns the SAME canonical id for
    both (the extractor does not dedupe — place_extractor.py:161). Without the RPC's
    DISTINCT ON, Postgres rejects the whole statement with 'ON CONFLICT DO UPDATE command
    cannot affect row a second time' and every organize of that Reel breaks."""
    fake_client.resolve_place_to("p1")                        # both entries → p1
    terminal, count = await _ground_and_persist(
        fake_client, {"id": "rB"}, "c1", [make_place(name="Ichiran"), make_place(name="Ichiran")],
        user_id="uB", ground=grounds_everything)
    assert (terminal, count) == ("organized", 2)              # grounding count is unchanged
    assert fake_client.mention_place_ids("uB", "c1") == {"p1"}    # one row, not a crash

def test_parse_empty_feature_collection_raises():
    with pytest.raises(RuntimeError):
        parse_reverse_country_response({"type": "FeatureCollection", "features": []})
```
The fake cannot reproduce Postgres's ON CONFLICT rejection, so the **duplicate case must also
be asserted in pgTAP against a real database** (below) — the Python test pins the call shape,
the pgTAP test pins the constraint behavior. Say which is which in the PR body rather than
presenting the green fake run as proof.

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Migration** `20260720080000_reel_place_mentions_user_scope.sql`

**One atomic migration, applied inside the maintenance window — this is the only shape that
works.** Order matters: the old PK must be dropped **before** the fan-out, or every fanned-out
row collides with its own source row. That drop is also exactly why old and new code cannot
coexist (the deployed `_persist_mention` upsert needs a unique index on
`(reel_cache_id, place_id)` for its `on_conflict` target), and therefore why the window exists
instead of an expand/contract split.

```sql
-- reel_place_mentions is the Saved Reels trust boundary (authorize_place_ids reads it, and
-- the backend is service_role so RLS cannot scope it). Give it an owner.
alter table public.reel_place_mentions add column user_id uuid;
alter table public.reel_place_mentions drop constraint reel_place_mentions_pkey;

-- Backfill: fan out to every user who ORGANIZED this Reel — exactly the set for whom
-- authorize_place_ids already succeeds, so the authorization surface is preserved.
insert into public.reel_place_mentions
  (user_id, reel_cache_id, place_id, evidence_quote, source_url, confidence,
   verification_version, created_at, updated_at)
select distinct sr.user_id, m.reel_cache_id, m.place_id, m.evidence_quote, m.source_url,
       m.confidence, m.verification_version, m.created_at, m.updated_at
  from public.reel_place_mentions m
  join public.saved_reels sr
    on sr.reel_cache_id = m.reel_cache_id
   and sr.analysis_status = 'organized'
 where m.user_id is null;

-- Unowned leftovers are unreachable (authorize_place_ids requires 'organized') and fully
-- regenerable from the frozen extraction cache. See the plan's Step 0 audit.
delete from public.reel_place_mentions where user_id is null;

alter table public.reel_place_mentions alter column user_id set not null;
alter table public.reel_place_mentions
  add constraint reel_place_mentions_user_fkey
  foreign key (user_id) references public.users(id) on delete cascade;
alter table public.reel_place_mentions
  add constraint reel_place_mentions_pkey
  primary key (user_id, reel_cache_id, place_id);
create index reel_place_mentions_cache_place_idx
  on public.reel_place_mentions (reel_cache_id, place_id);
```

**Ship the down-migration in the same PR** as `supabase/migrations/rollback/20260720080000_down.sql`
(kept out of the applied migrations directory so it never auto-runs). It is the maintenance
window's step-6 escape hatch and it must exist before the window opens, not be written under
pressure. It restores the old PK, which requires collapsing the fan-out:

```sql
-- Rollback: collapse owners back to one row per (cache, place). Lossy BY DESIGN — the fan-out
-- created N owner rows per pair; the oldest created_at wins, which is deterministic and matches
-- the pre-migration row. Orphans deleted on the way in are NOT restored; they are regenerable
-- from the frozen extraction cache at zero provider spend (Step 0 policy).
delete from public.reel_place_mentions m
 where exists (select 1 from public.reel_place_mentions k
                where k.reel_cache_id = m.reel_cache_id and k.place_id = m.place_id
                  and (k.created_at, k.user_id) < (m.created_at, m.user_id));
alter table public.reel_place_mentions drop constraint reel_place_mentions_pkey;
alter table public.reel_place_mentions drop constraint reel_place_mentions_user_fkey;
alter table public.reel_place_mentions alter column user_id drop not null;
alter table public.reel_place_mentions
  add constraint reel_place_mentions_pkey primary key (reel_cache_id, place_id);
-- plus: restore the pre-A3 saved_reel_cards view and can_select_verified_saved_reel_place
--       verbatim from 20260719103000 (drop + create, never CREATE OR REPLACE — 0216a0e).
```
`user_id` is left populated and nullable — harmless to the old code, which never selects it.
**Rehearse the rollback on a local `supabase db reset` before opening the window**; an untested
escape hatch is not one.

Atomic owner-scoped set replacement — **one transaction, so there is no window in which a
concurrent `authorize_place_ids` sees a half-written set**:

```sql
create or replace function public.replace_reel_place_mentions(
  p_user_id uuid, p_reel_cache_id uuid, p_verification_version text, p_mentions jsonb
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_place_ids uuid[];
begin
  if p_mentions is null or jsonb_typeof(p_mentions) <> 'array' then
    raise exception 'mentions payload must be a JSON array' using errcode = 'AS422';
  end if;

  -- DEDUPE BY place_id — load-bearing, not defensive tidiness. Two extracted entries can
  -- resolve through _persist_place to the SAME canonical place_id (the extractor does not
  -- dedupe: genagents/place_extractor.py:161, and today's sequential upserts tolerate it).
  -- A single INSERT ... ON CONFLICT DO UPDATE that touched that row twice fails outright with
  -- "ON CONFLICT DO UPDATE command cannot affect row a second time", so a Reel naming one
  -- venue twice would break every organize of it. `with ordinality` makes first-occurrence-wins
  -- deterministic rather than dependent on jsonb ordering.
  -- ONE statement: dedupe, upsert, and collect the surviving ids. A data-modifying CTE keeps
  -- this to a single pass (a two-statement form would not compile — CTEs do not outlive their
  -- statement).
  with input as (
    select (elem->>'place_id')::uuid as place_id, elem, ord
      from jsonb_array_elements(p_mentions) with ordinality t(elem, ord)
  ), deduped as (
    select distinct on (place_id) place_id, elem from input order by place_id, ord
  ), upserted as (
    insert into public.reel_place_mentions
      (user_id, reel_cache_id, place_id, evidence_quote, source_url, confidence, verification_version)
    select p_user_id, p_reel_cache_id, d.place_id, d.elem->>'evidence_quote',
           d.elem->>'source_url', coalesce((d.elem->>'confidence')::numeric, 0), p_verification_version
      from deduped d
    on conflict (user_id, reel_cache_id, place_id) do update
      set evidence_quote = excluded.evidence_quote,
          source_url = excluded.source_url,
          confidence = excluded.confidence,
          verification_version = excluded.verification_version,
          updated_at = now()
    returning place_id
  )
  select coalesce(array_agg(place_id), '{}'::uuid[]) into v_place_ids from upserted;

  -- Prune ONLY this owner's superseded rows. Other users' sets are untouched by construction.
  delete from public.reel_place_mentions
   where user_id = p_user_id
     and reel_cache_id = p_reel_cache_id
     and place_id <> all(v_place_ids);

  return cardinality(v_place_ids);
end;
$$;

revoke all on function public.replace_reel_place_mentions(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_reel_place_mentions(uuid, uuid, text, jsonb)
  to service_role;
```

Then realign the two dependents **in this same migration** (they join the table this migration
just re-keyed — shipping them apart is a broken intermediate state):

```sql
-- The mention must belong to the requesting user, not merely to a Reel they saved.
create or replace function private.can_select_verified_saved_reel_place(p_place_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.reel_place_mentions m
      join public.saved_reels sr
        on sr.reel_cache_id = m.reel_cache_id
       and sr.user_id = m.user_id                      -- NEW: owner-scoped
     where m.place_id = p_place_id
       and m.verification_version = 'mapbox-country-v1'
       and sr.user_id = (select auth.uid())
  );
$$;

drop view public.saved_reel_cards;                     -- never CREATE OR REPLACE (0216a0e)
create view public.saved_reel_cards as ...             -- copy 20260719103000 VERBATIM, adding
                                                       -- `and reel_place_mentions.user_id = saved_reels.user_id`
                                                       -- to the mention join, and nothing else
```
Re-grant after the drop: `revoke all ... from public, anon; grant select ... to authenticated, service_role;`

pgTAP additions to `supabase/tests/007_saved_reels_organize.sql`: new PK columns; `user_id` is
`not null` with the users FK; `authenticated` still has **no** privileges on the table;
`replace_reel_place_mentions` is `security definer` with empty `search_path` and executable only
by `service_role`; and two behavioural ones — **user A's rows survive a
`replace_reel_place_mentions` call made for user B on the same `reel_cache_id`**, and **a
payload containing the same `place_id` twice succeeds and writes exactly one row** (this is the
test that would fail without `DISTINCT ON`; the Python fake cannot catch it).

- [ ] **Step 4: Implement (Python).** `_ground_and_persist` persists places first (it needs the
  ids), then does **one** RPC call — no delete anywhere in Python:

```python
    grounded = [resolved for place in places
                if (resolved := await _maybe_await(ground(place))) is not None]
    if not grounded or not cache_id:
        return "location_not_found", 0            # never touch mentions on an empty grounding
    mentions = []
    for resolved in grounded:
        place_id = await _persist_place(client, resolved)
        place = resolved["place"]
        mentions.append({"place_id": place_id, "evidence_quote": place.evidence_quote,
                         "source_url": place.source_url, "confidence": place.confidence})
    # Duplicate place_ids are left in the payload ON PURPOSE — the RPC's DISTINCT ON is the
    # single place that handles them, so there is no second dedupe to drift out of sync.
    # ONE transaction: upsert this owner's set and prune only this owner's superseded rows.
    # A crash before this line leaves the previous verified set fully intact; a crash during
    # it rolls back. Other users' evidence is out of reach by construction (user_id is in
    # the PK and in the RPC's delete predicate).
    await client.rpc("replace_reel_place_mentions", {
        "p_user_id": user_id, "p_reel_cache_id": cache_id,
        "p_verification_version": LOCATION_VERIFICATION_VERSION, "p_mentions": mentions,
    }).execute()
    return "organized", len(grounded)
```
Delete `_persist_mention` and its `hasattr(table, "upsert")` fork outright (that fork was on
B6's list; the RPC removes it for free).

`authorize_place_ids` (96-120): add `.eq("user_id", user_id)` to the mentions select. The
`saved_reels` organized-check stays as defense in depth, but the owner column is now the
primary boundary. Add a comment saying exactly that.

In `mapbox_reverse.py`, replace the empty-features `return None` (35-36) with:

```python
    if not features:
        raise RuntimeError("Mapbox reverse-country returned no country for coordinate")
```
Keep `_ground_place`'s `country is None` guard as defense-in-depth. **Consequence (accepted,
document in the commit body):** a genuinely country-less coordinate (open ocean) now marks the
item `failed` (retryable) instead of `location_not_found`. That is the right bias: an
empty-but-valid FeatureCollection is far more likely a provider brownout than a real ocean
venue, and `failed` invites retry instead of freezing a wrong terminal state.

- [ ] **Step 5: Full gates** — backend suite + evals + `supabase db reset && supabase test db && supabase db lint --local`, **plus a rehearsed rollback** (apply the migration on a local reset, apply the down-migration, confirm the old PK and view are back and the deployed code's upsert works against them).

- [ ] **Step 6: The maintenance window.** Execute the six steps in the DEPLOY HAZARD section
  verbatim — drain → suspend → migrate → merge+resume → verify (a–d) → rollback on any failure.
  Do not start it without Zhi Hao's Step-0 product sign-off and a rehearsed rollback. Record the
  window's start/end times, the Step-0 audit counts, and the four verification results in the PR
  body; that record is the evidence the arc closeout checks.

- [ ] **Step 7: Commits**
  1. `feat(db): user-scope reel_place_mentions + transactional replace_reel_place_mentions RPC`
  2. `fix(organizer): replace only the owner's mention set; empty Mapbox FeatureCollection raises (cross-user destruction Major)`

**Fault-injection (reviewer):**
1. Drop `user_id = p_user_id` from the RPC's `delete` predicate → the
   `test_rewrite_never_touches_another_users_mentions` assertion goes red. Restore.
2. Drop `.eq("user_id", user_id)` from `authorize_place_ids` → the cross-user authorize test
   goes red. Restore.
3. Move the RPC call above the `_persist_place` loop → the crash-mid-persist test goes red.
   Restore.
4. Remove `distinct on (place_id)` from the RPC → the pgTAP duplicate-payload test goes red
   with `ON CONFLICT DO UPDATE command cannot affect row a second time`. Restore. (Against the
   Python fake this injection proves nothing — say so.)

**Deferral (concrete trigger):** per-mention provenance (recording *which organize job* wrote a
mention, so a future backfill has a real owner rather than a policy) — when a second writer of
`reel_place_mentions` is introduced, or when an incident requires attributing a mention to a
run. Noted in the spec's deferred-Codex-findings section already.

---

### Task A4: Write-through coordinate→country cache (Mapbox cost + quota-exempt loop)

**Ships in PR A-V** with A5 and A6. **Severity/size:** P2 / **M** (~1 day). Carries a migration
→ full Supabase gate + the apply-verify-merge protocol (its table is new, so old code is
unaffected by the migration landing first).
**Guardrails:** #7 (write-through: persist before return — **strictly**, see below), #1 (the
load-bearing `country_code` comparison still runs on EVERY organize — only the identical
provider question is skipped), #12 (DB-backed → survives restart).

Call math (verified): one billable permanent-geocode per complete place; worst case 50/organize
(5 reels × 10-place cap), ×2 on retry; **warm organizes are identical to cold** and are
quota-exempt (quota charges only on cache miss) — a user looping warm re-organizes of 5 cached
reels drives ~150 permanent calls/min bounded only by `BURST_LIMIT`. `reverse(lat,lng)→country`
is a pure function of frozen inputs (coordinates come from the extraction cache, frozen per
`EXTRACTOR_VERSION`). Do NOT use "existing mentions" as the skip condition (mutable
`extractor_version` makes mention-reuse version-coupled — review §2).

#### ⚠ Two corrections to the earlier draft (both were blocking Codex findings)

**1. The key is LOSSLESS — no rounding.** The earlier `(round(lat*1e4), round(lng*1e4))` key
buckets coordinates into ~11 m cells. Two points on **opposite sides of a border** can share a
cell; if the cached country happens to match the extractor's *claimed* country, the fail-closed
comparison in `_ground_place` passes for a coordinate Mapbox never verified. That weakens
guardrail #1 for zero benefit: **the warm path hits on byte-identical coordinates** — they come
from the frozen extraction cache, not from re-derivation — so rounding buys **no additional hit
rate whatsoever**. "Borders don't move" was never the relevant argument; the collision needs no
border to move.

Use `repr()`-based normalization: Python's float `repr` is the shortest string that
round-trips exactly (PEP 3141 / CPython ≥3.1), so it is lossless *and* stable across platforms.

```python
def _coord_cache_key(lat: float, lng: float) -> str:
    """Lossless, stable cache key. `+ 0.0` normalizes -0.0 to 0.0 so the two spellings of the
    same point share a row; every other distinct float gets its own row BY DESIGN — a cache
    hit must mean Mapbox verified THIS coordinate, not a neighbour ~11 m away."""
    return f"{lat + 0.0!r},{lng + 0.0!r}"
```

**2. The cache write is STRICT write-through — a failed write fails the item.** The earlier
draft wrapped `_store_cached_country` in `try/except: logger.warning(...)`, which directly
contradicts guardrail #7 ("caches are write-through — persist before returning"). Resolved in
favour of the guardrail, and the repo already sets the precedent: `cache_places` in
`run_organize_job` (`organizer.py:345`) is **not** wrapped — an extraction-cache write failure
propagates and fails the item today. A4 matches it exactly. The blast radius is bounded by
guardrail #3: one item fails, it is retryable, and the retry reuses the extraction cache. The
**read** side stays blip-tolerant (a read error is a MISS, never an item failure) — same
asymmetry B5(c) gives the extraction cache.

**Files:**
- Create: `supabase/migrations/20260720100000_geocode_country_cache.sql`
- Modify: `backend/organizer.py::_ground_place` (gains `client` param) + its call sites in `_ground_and_persist` / `run_organize_job` default injection
- Test: `backend/test_geocode_country_cache.py` (new), `supabase/tests/` pgTAP file

**Interfaces:**
- Produces:
  ```python
  GEOCODE_CACHE_TABLE = "geocode_country_cache"
  def _coord_cache_key(lat: float, lng: float) -> str                    # lossless; see above
  async def _lookup_cached_country(client, lat, lng) -> CountryResult | None
  async def _store_cached_country(client, lat, lng, country: CountryResult) -> None   # RAISES on failure
  async def _ground_place(client, place, *, verify_country=None) -> dict | None   # client is NEW first param
  ```
- The injectable `ground` seam in `run_organize_job` keeps arity `ground(place)`; the default
  becomes a closure binding `client`:
  `ground = ground or (lambda place: _ground_place(client, place))`.

- [ ] **Step 1: Failing tests**

```python
@pytest.mark.asyncio
async def test_second_ground_of_same_coordinate_skips_provider(fake_client):
    calls = 0
    async def verify(lat, lng, *, token):
        nonlocal calls; calls += 1
        return CountryResult(country_code="JP", country_name="Japan")
    p = make_place(lat=35.6586, lng=139.7454, country_code="JP")
    assert await _ground_place(fake_client, p, verify_country=verify) is not None
    assert await _ground_place(fake_client, p, verify_country=verify) is not None
    assert calls == 1                                     # warm path: zero provider calls

@pytest.mark.asyncio
async def test_provider_failure_is_never_cached(fake_client):
    async def verify(lat, lng, *, token):
        raise RuntimeError("Mapbox reverse-country failed: status 500")
    with pytest.raises(RuntimeError):
        await _ground_place(fake_client, make_place(), verify_country=verify)
    assert fake_client.tables[GEOCODE_CACHE_TABLE].rows == []

@pytest.mark.asyncio
async def test_cache_lookup_blip_falls_through_to_provider(fake_client):
    fake_client.fail_on_select(GEOCODE_CACHE_TABLE)        # read blip = MISS, never item failure
    ... assert provider called, place grounded ...

@pytest.mark.asyncio
async def test_cache_write_failure_fails_the_item(fake_client):
    """Strict write-through (#7): we do not return a verified result we failed to persist.
    Matches cache_places at organizer.py:345, which is likewise unwrapped."""
    fake_client.fail_on_upsert(GEOCODE_CACHE_TABLE)
    with pytest.raises(Exception):
        await _ground_place(fake_client, make_place(), verify_country=ok_verify)

@pytest.mark.asyncio
async def test_neighbouring_coordinate_does_not_hit_the_cache(fake_client):
    """Lossless key: ~11 m away is a DIFFERENT question, and may be a different country.
    This is the test that dies if anyone reintroduces rounding."""
    calls = 0
    async def verify(lat, lng, *, token):
        nonlocal calls; calls += 1
        return CountryResult(country_code="JP", country_name="Japan")
    await _ground_place(fake_client, make_place(lat=35.6586, lng=139.7454, country_code="JP"),
                        verify_country=verify)
    await _ground_place(fake_client, make_place(lat=35.65861, lng=139.74543, country_code="JP"),
                        verify_country=verify)
    assert calls == 2                                      # NOT deduped into one

def test_coord_cache_key_is_lossless_and_normalizes_negative_zero():
    assert _coord_cache_key(35.6586, 139.7454) != _coord_cache_key(35.65861, 139.74543)
    assert _coord_cache_key(-0.0, -0.0) == _coord_cache_key(0.0, 0.0)

@pytest.mark.asyncio
async def test_stale_verification_version_rows_are_ignored(fake_client):
    seed_cache_row(fake_client, coord_key="35.6586,139.7454", verification_version="mapbox-country-v0")
    ... assert provider IS called ...
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Migration** (service-role-only, same grant pattern as `reel_place_mentions` in
  `20260718130000` lines 165-172):

```sql
create table public.geocode_country_cache (
  coord_key text not null,              -- lossless repr() pair; see _coord_cache_key
  verification_version text not null,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  country_name text not null check (btrim(country_name) <> ''),
  created_at timestamptz not null default now(),
  primary key (coord_key, verification_version),
  -- Shape guard, not a parser: catches a malformed/empty key, not a wrong coordinate.
  constraint geocode_country_cache_coord_key_shape_check
    check (coord_key ~ '^-?[0-9][0-9.eE+-]*,-?[0-9][0-9.eE+-]*$')
);
alter table public.geocode_country_cache enable row level security;
revoke all on public.geocode_country_cache from public, anon, authenticated;
grant all on public.geocode_country_cache to service_role;
```
pgTAP: table exists, PK columns, RLS enabled, `authenticated` has no privileges, and the
shape check rejects `'garbage'`.

**Invalidation policy (state it, don't leave it implicit).** Rows key on
`LOCATION_VERIFICATION_VERSION` — **bump-to-invalidate**, the same lever that invalidates
`reel_place_mentions`, so the cache and the evidence it justified can never disagree about
which verification contract they were written under. There is deliberately **no TTL**: a fixed
coordinate's country changes only on a real border change or a provider correction, and both
are one-off events that warrant a version bump (which also re-verifies the mentions). `created_at`
exists for the audit query behind that trigger, not for expiry. Deferral + trigger in the register.

- [ ] **Step 4: Implement** (in `_ground_place`, after the completeness checks, before HTTP):

```python
    country = await _lookup_cached_country(client, place.lat, place.lng)
    if country is None:
        country = await verify_country(place.lat, place.lng, token=token)
        if country is not None:
            # STRICT write-through (#7): this raises on failure and fails the item, exactly
            # like cache_places at organizer.py:345. We never hand back a verified result we
            # could not persist. Guardrail #3 bounds it: one item fails, retryable, and the
            # retry reuses the extraction cache.
            await _store_cached_country(client, place.lat, place.lng, country)
```
`_lookup_cached_country` wraps its select in `try/except → return None` (a cache-read blip is a
MISS, matching the runner's blip tolerance). `_store_cached_country` uses
`upsert(..., on_conflict="coord_key,verification_version")` and is **not** wrapped.
A provider failure is never cached — the write is unreachable when `verify_country` raises.

- [ ] **Step 5: Suite + evals green; `supabase db reset && supabase test db && supabase db lint --local`.**
- [ ] **Step 6: Commit** `feat(organizer): write-through coordinate→country cache (lossless key) — closes warm-path Mapbox spend and the quota-exempt billable loop`

**Fault-injection:**
1. Make `_store_cached_country` also run on provider exception → failure-caching test red.
2. Bypass the lookup (always call provider) → skip-provider test red.
3. Reintroduce 4-dp rounding in `_coord_cache_key` → the neighbouring-coordinate test red.
4. Re-wrap `_store_cached_country` in `try/except: pass` → the write-failure test red.
Restore after each.

**Deferrals (concrete triggers):**
- Shared `httpx.AsyncClient` + `asyncio.gather` across per-place calls (latency only, zero cost
  impact) — when a measured organize shows Mapbox wall-time > 5 s on a warm-cache-miss run.
- A separate warm-organize quota — moot once this cache lands; resurrect only if the cache is
  ever reverted.
- Time-based cache expiry — when a provider correction or a border change is actually observed
  for a supported destination (audit with `select count(*) from geocode_country_cache where
  created_at < now() - interval '1 year'` to size the bump's cold-run cost first). Until then
  the version bump is the invalidation mechanism.

---

### Task A5: ISSUES-B1 — stream-token log exposure (decision gate: redact now, escalate if Render's edge logs the query string)

**Ships in PR A-V.** **Severity/size:** P2 / M (Branch A) → L if Branch B triggers.
**Guardrails:** #5, #6; BACKEND-PRINCIPLES "never leak a secret into any log line".

**User decision (fixed):** redact access logs NOW; the short-lived one-time stream token stays
deferred **behind this explicit trigger** —

> **Escalation trigger:** after Branch A is deployed, the sentinel probe shows
> `SENTINEL-B1-PROBE` (or any `token=` value) in ANY Render log-stream entry **not** emitted by
> the redacted `uvicorn.access` logger — i.e., a platform/edge request-log sink that app code
> cannot filter (those logs are generated outside the container). If that fires, Branch A is
> dead on arrival as a complete fix and Branch B is implemented immediately.

### ✅ PROBE ALREADY RUN — 2026-07-19T09:34:17Z. Result: **Branch A is viable. Branch B stays deferred.**

The external dependency described below is **resolved**: `astrail-backend` is already live
(`srv-d976aess728c738pskk0`, plan `starter`, `autoDeploy: yes` on `dev` commits), so the probe
needed no new deploy. Evidence:

| Sink | Sentinel `SENTINEL_PROBE_9f3a2b7c` | Verdict |
|---|---|---|
| `--type app` (uvicorn access log, in-container) | **PRESENT** — `"GET /saved-reels/organize/…/stream?token=SENTINEL_PROBE_9f3a2b7c HTTP/1.1" 401 Unauthorized` @ `09:34:18.387Z` | the leak Branch A fixes |
| `--type request` (Render platform/edge) | **ABSENT — no request-type logs exist at all** | escalation trigger does NOT fire |

Ruled out "absence of evidence": a `--type request` query with **no** text filter returned
empty, and sampling 200 recent entries with no type filter returned `type=app` × 200. This
service emits only `app` logs. Reproduce with:
`render logs -r srv-d976aess728c738pskk0 --type request --limit 3 -o json --confirm`

**Therefore Branch A (redact `uvicorn.access`) closes every sink observable on this service, and
A5 stays size M.** Two residual risks — both accepted, neither fires the trigger today:

1. This holds for the **starter** plan as configured now. A plan upgrade or a Render feature
   change could introduce an edge request-log sink. **Re-run the probe after any plan/tier
   change** — that is now the concrete escalation trigger, replacing "at first deploy".
2. Absence from the CLI proves Render does not *expose* request logs to us, not that nothing
   records them internally; and the JWT remains in browser history regardless. Redaction closes
   the measurable sink. Only Branch B removes the credential from URLs. **Trigger for Branch B:
   public beta / any external party gaining log access / a plan change that surfaces request
   logs** — whichever comes first.

**Files (Branch A):**
- Create: `backend/log_redaction.py`
- Modify: `backend/main.py` (install filter at import), `backend/pyproject.toml:17` + `render.yaml` (remove dead `sentry-sdk[fastapi]` + `SENTRY_DSN` — staged but `sentry_sdk.init` is called nowhere; an unwired dep whose only future is inheriting request-URL capture is an ISSUES-B1 leak path, not a feature)
- Test: `backend/test_log_redaction.py` (new)

- [ ] **Step 1 (probe procedure — first sub-step, written into the task so nobody skips it):**
  1. `curl -s "https://<render-backend>/generate-trip/stream/00000000-0000-0000-0000-000000000000?token=SENTINEL-B1-PROBE"` (404 expected) and the same against `/saved-reels/organize/<uuid>/stream`.
  2. Inspect the **full** Render log stream (`render logs <service>` via the CLI AND the dashboard's request-log view — not just app stdout), searching `SENTINEL-B1-PROBE`.
  3. Classify every hit by sink: app stdout (uvicorn format) vs platform request log (Render's edge format). Record the finding in the PR body.
  4. Pre-redaction, an app-stdout hit is EXPECTED (that's the bug Branch A fixes). A platform-sink hit fires the escalation trigger.

- [ ] **Step 2: Failing test**

```python
# backend/test_log_redaction.py
import logging
from log_redaction import TokenRedactionFilter

def _access_record(path: str) -> logging.LogRecord:
    # uvicorn.access logs: '%s - "%s %s HTTP/%s" %d' with args (addr, method, full_path, http, status)
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 0,
                             '%s - "%s %s HTTP/%s" %d',
                             ("1.2.3.4:1", "GET", path, "1.1", 200), None)

def test_token_query_param_is_redacted_from_access_log():
    record = _access_record("/generate-trip/stream/t1?token=SENTINEL-B1-PROBE&cursor=3")
    assert TokenRedactionFilter().filter(record) is True
    rendered = record.getMessage()
    assert "SENTINEL-B1-PROBE" not in rendered
    assert "token=REDACTED" in rendered
    assert "cursor=3" in rendered            # only the credential is touched
```

**MANDATORY second test — this is the load-bearing one, not an optional extra.** The test above
exercises the filter object directly, so it stays green even if `install()` is deleted from
`main.py` — i.e. it does not guard the thing that actually protects production. Write both:

```python
def test_installed_filter_redacts_through_the_real_uvicorn_access_logger(caplog):
    """Guards the WIRING, not the regex. Deleting `_install_log_redaction()` from main.py
    must turn this red — that is the whole point of it existing."""
    import main                                    # importing main runs install()
    logger = logging.getLogger("uvicorn.access")
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        logger.handle(_access_record("/generate-trip/stream/t1?token=SENTINEL-B1-PROBE"))
    assert "SENTINEL-B1-PROBE" not in caplog.text
    assert "token=REDACTED" in caplog.text
```
(If importing `main` in this module is awkward, call `log_redaction.install()` explicitly in the
test **and** add a grep-style assertion that `_install_log_redaction()` appears in `main.py` —
but the import form is preferred because it exercises the real wiring.)

- [ ] **Step 3: Implement**

```python
# backend/log_redaction.py
"""Redact bearer credentials from uvicorn access logs (ISSUES-B1, Branch A).

Browser EventSource cannot set Authorization, so stream routes accept ?token=<JWT>.
This filter is the app-side sink fix; Render platform/edge request logs are OUTSIDE
app control — the ISSUES-B1 sentinel probe decides whether the one-time-token escalation fires.
"""
from __future__ import annotations

import logging
import re

_TOKEN_RE = re.compile(r"(token=)[^&\s\"]+")


class TokenRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                _TOKEN_RE.sub(r"\1REDACTED", a) if isinstance(a, str) else a
                for a in record.args
            )
        if isinstance(record.msg, str):
            record.msg = _TOKEN_RE.sub(r"\1REDACTED", record.msg)
        return True


def install() -> None:
    logging.getLogger("uvicorn.access").addFilter(TokenRedactionFilter())
```
In `main.py`, near the top: `from log_redaction import install as _install_log_redaction` then
`_install_log_redaction()` (module import runs before uvicorn serves requests). Remove
`sentry-sdk[fastapi]` from `pyproject.toml` (+ `uv lock`) and the `SENTRY_DSN` entry from
`render.yaml` in the same commit — re-adding Sentry later must come with a
`before_send` URL scrubber, and this test file is the regression that catches it.

- [ ] **Step 4: Suite green; commit** `fix(b1): redact ?token= from uvicorn access logs; drop unwired sentry-sdk (leak path)`
- [ ] **Step 5 (at first deploy): run the Step-1 probe post-deploy.** No sentinel anywhere →
  ISSUES-B1 Branch A is complete; record it. Sentinel in a platform sink → open Branch B immediately.

**Branch B (planned now so the escalation is unblocked — implement ONLY if the trigger fires):**
- Migration `stream_tokens`: `id uuid pk, user_id uuid not null, resource_type text check (in ('trip','organize')), resource_id uuid not null, token_hash text not null unique, expires_at timestamptz not null, consumed_at timestamptz` — service-role-only grants (same pattern as A4). Durable, not in-memory (guardrail #12: restarts and multi-instance safe).
- `backend/stream_tokens.py`: `issue_stream_token(client, user_id, resource_type, resource_id) -> str` (secrets.token_urlsafe(32); store sha256; 60 s expiry) and `consume_stream_token(client, raw, resource_type, resource_id) -> str | None` (CAS: `update ... set consumed_at=now() where token_hash=... and consumed_at is null and expires_at > now()` returning `user_id` — single-use by construction).
- `main.py`: `POST /generate-trip/stream-token` + `POST /saved-reels/organize/{job_id}/stream-token` (header auth, `BURST_LIMIT`); both GET stream routes accept the one-time token via `?token=` FIRST, falling back to the existing JWT path during frontend rollout (remove fallback one release later).
- Frontend `lib/trip/api.ts::streamGeneration` + `lib/reels/api.ts::streamOrganize`: POST for a token, open EventSource with it; on reconnect, POST again.
- Regression tests: expiry, single-use (second consume → None → 404), ownership binding (token for trip A rejected on trip B), reconnect issues a fresh token, and the Branch-A sentinel-never-in-logs test re-run.

**Fault-injection (Branch A):** delete the `_install_log_redaction()` call from `main.py` → the
`caplog` wiring test goes red (the direct filter test stays green — that asymmetry is exactly
why both tests exist). Broaden `_TOKEN_RE` to also eat `cursor=` → the `cursor=3` assertion
goes red. Restore both.

---

### Task A6: ISSUES-B5 — pin the event-sequencing invariant (now that A2 made it TRUE)

**Ships in PR A-V.** **Severity/size:** P3 / S. **Depends on A2** (i.e. on A-II having merged),
and the dependency is the whole point: the earlier version of this task would have written down
a **falsehood**.

**What changed.** The original plan documented "MAX(sequence)+1 is safe because exactly ONE
live writer exists per job", resting on the pending-CAS claim plus a staleness gate. That claim
was false: nothing prevented a superseded worker from writing, and a `stale_after_s` filter
alone does not establish single-writer correctness — it only narrows the window. Rather than
document a weaker truth, **A2 removed the dependency on distributed exactly-once execution
entirely**: `append_organize_event` takes a `for update` row lock on the parent job, so
allocation is *serialized by the database*, and the lease-token fence rejects a superseded
writer outright. The invariant to pin is therefore a different, stronger, and actually-true one.

**Files:**
- Modify: `backend/organizer.py::_record_organize_event` (comment only — the body became an RPC call in A2)
- Test: extend the organizer lease/claim test module

- [ ] **Step 1: Tests.** Two of these are **characterization** (they pass against post-A2 code
  and exist to pin it); one is a genuine regression. Label them accordingly in the module
  docstring — do not report this task as RED→GREEN.
  - *(characterization)* Race two claims of one `pending` job (fake client with a real CAS):
    the loser returns `{"skipped": "job already claimed"}` and emits **zero** events; the
    winner's events have unique, gapless, ordered sequences.
  - *(characterization)* N concurrent `append_organize_event` calls holding the **same** valid
    lease produce N unique, gapless sequences with no `23505`.
  - *(regression, genuinely red without A2's fence)* A caller holding a **superseded** lease
    gets `AS409` and writes **no** event row.
- [ ] **Step 2: Replace the comment** above `_record_organize_event` with the true one:

```python
# LOAD-BEARING INVARIANT (ISSUES-B5): event sequences are allocated INSIDE
# append_organize_event, which takes `select ... for update` on the parent organize_jobs
# row. That row lock — not any assumption of a single live writer — is what makes
# MAX(sequence)+1 collision-free, and the p_lease_token fence is what stops a superseded
# worker writing at all. A second event producer is therefore SAFE to add, provided it
# goes through this RPC with a valid lease. Allocating a sequence anywhere else (or
# calling the RPC with p_lease_token=None outside a boot path) reopens
# organize_events_job_sequence_unique.
```
- [ ] **Step 3: Suite green; commit** `test(organizer): pin the serialized event-sequencing invariant (ISSUES-B5)`

**Fault-injection:** remove the `for update` from `append_organize_event` and run the
N-concurrent-append test against a real local Postgres (`supabase db reset` + a pgTAP or
integration variant) → duplicate-sequence / `23505` failures appear. Restore. (Against the
in-process fake this injection proves nothing — the fake has no true concurrency. Say so in
the PR body rather than claiming a green fake run as evidence.)

**Deferral (concrete trigger):** **REMOVED from the register — A2 implemented it.** Atomic
DB-side sequence allocation was previously deferred "until a second event producer exists";
it now ships as part of the lease design because the fence needed the same row lock anyway.

---

### Per-PR gate (A-I … A-V — each PR, not once per arc)

1. Per-task `astrail-reviewer` pass, **`model: sonnet`**, with that task's fault injections
   actually run (revert the guard → the named test goes red → restore). A fault injection that
   was reasoned about but not executed does not count.
2. The PR's own verification gates from Global Constraints (suite + evals; Supabase gate for
   A-II, A-IV, A-V).
3. For migration PRs: the apply-verify-merge protocol. For A-IV specifically: the maintenance
   window, with its record in the PR body.

### Arc A closeout (after A-V merges)

1. Final whole-arc `astrail-reviewer` pass, **`model: fable`** — every guardrail end-to-end
   across all five PRs' code + migration DDL; pay particular attention to the three migrations
   and to whether the lease fencing is actually load-bearing rather than
   documented-as-load-bearing. Explicitly re-check the three **bounded, not fenced** claims
   (organize item writes, the trip save block, `generation_events`) against the shipped code —
   these are the plan's named residual risks and are where a reviewer should be most skeptical.
2. gstack `/review` Codex cross-model pass (`codex exec -m gpt-5.6-sol`,
   `model_reasoning_effort="high"`) — run BOTH; different blind spots.
3. Live smoke (get the user's go before credit-spending runs): one real OTP → save →
   Organize (cold) → re-Organize (warm: assert **zero** new Mapbox calls) → two users
   organizing the same Reel, asserting neither one's mentions vanish → restart the backend
   mid-organize and confirm the job is reclaimed and re-run, not dropped.
4. Re-run the ISSUES-B1 sentinel probe against the redacted deployment (A5) — it must now be
   ABSENT from the `--type app` sink it was previously present in.
5. Re-evaluate `organizer.py` against the 800-line ceiling (deferral register).
6. Fast-forward `shaun` to `dev`.

---

# ARC B — Hygiene

**Branch:** `feat/saved-reels-arc-b-hygiene` off `dev` **after Arc A's final PR (A-V) merges** (B3 re-creates the
`saved_reel_cards` view and must copy A3's version). **Closeout:** after B6.

---

### Task B1: ISSUES-B6 mixed inputs · `pace` schema parity · duplicate-UUID validation

**Severity/size:** P3 / **S–M** (three small boundary fixes in one file, three commits).
**Guardrails:** #5 (validation at the boundary), **#4 (schema parity — this task repairs an
existing violation)**; prevents silent input loss (`runner.py`'s `if place_ids:` branch ignores
`reel_urls`).

All three sub-fixes touch `backend/api/schemas.py`, so they share a task and a review. (The
duplicate-UUID fix was filed as an Arc-B "minor"; it lives here rather than in B5 because it is
the same file, the same validator pattern, and the same reviewer context.)

**Files:**
- Modify: `backend/api/schemas.py` — `GenerateTripRequest.require_reel_or_place` (30-34), `GenerateTripRequest.pace` (20), `OrganizeSavedReelsRequest` (66)
- Modify: `frontend/lib/trip/backend-types.ts::GenerateTripRequest`
- Test: extend the `/generate-trip` schema/endpoint test module; `frontend/lib/trip/__tests__/backend-types.test.ts`

- [ ] **(a) Reject mixed `reel_urls` + `place_ids` (422).** Failing tests first: model-level
  `ValidationError` on both-populated; endpoint-level 422 via the FastAPI test client with a
  fake supabase client asserting **zero** side effects (no trip insert, no job, no quota RPC,
  no background task); keep/extend the existing reel-only and place-only happy-path regressions.

```python
    @model_validator(mode="after")
    def require_reel_or_place(self):
        if not self.reel_urls and not self.place_ids:
            raise ValueError("At least one Reel URL or canonical place ID is required")
        if self.reel_urls and self.place_ids:
            raise ValueError("Provide either Reel URLs or canonical place IDs, not both")
        return self
```
  (Pydantic validation rejects before the handler body runs — the zero-side-effect assertion is
  the proof, not an implementation burden.) The error surfaces through the existing 422 envelope.
  Commit: `fix(api): reject mixed reel_urls+place_ids with 422 (ISSUES-B6 — no silent input loss)`.
  *Fault-inject:* revert the second check → mixed-input test red.

- [ ] **(b) `pace` schema parity (guardrail #4 — existing violation on `dev`).**
  `GenerateTripRequest.pace` exists at `backend/api/schemas.py:20` and has **no** TypeScript
  mirror — verified: `pace` appears nowhere in `frontend/lib/trip/`. Add it to
  `frontend/lib/trip/backend-types.ts::GenerateTripRequest`:

```ts
  /** Mirrors backend GenerateTripRequest.pace (api/schemas.py). Deliberately `string`, not a
   *  union: the backend caps length rather than enumerating values, so an unrecognized pace
   *  is accepted (no breaking 422) — the TS type must not be stricter than the API. */
  pace?: string
```
  Failing test first, in `frontend/lib/trip/__tests__/backend-types.test.ts`. **It must be a
  compile-time type fixture, not a round-trip through the builder** — `toGenerateRequest`
  (`frontend/lib/trip/parse-inspiration.ts:90`) has no pace input and `BriefInput` has no pace
  field, so a builder round-trip cannot exercise `pace` without dragging the builder and the
  brief form into this task. Adding a UI pace control is a product change nobody has asked for;
  keep it out. The fixture:

```ts
  // Contract: mirrors backend GenerateTripRequest.pace. Goes red at COMPILE time if the field
  // is removed or retyped — `npm run typecheck` is the gate, not a runtime assertion.
  const withPace: GenerateTripRequest = { ...baseRequest, pace: 'relaxed' }
  expect(withPace.pace).toBe('relaxed')
```
  **This is a contract test — it must be the thing that goes red if `pace` is removed from the
  TS type.** Verify with `npm run typecheck` (the red signal is a TS error, so confirm the
  failure by typechecking before adding the field, not by reading a test runner's output).
  When the builder does gain a pace input, extend this to a round-trip then.
  Commit: `fix(types): mirror GenerateTripRequest.pace in backend-types (guardrail #4 parity)`.
  *Fault-inject:* delete `pace` from the TS type → typecheck/contract test red.

- [ ] **(c) Reject duplicate saved-Reel UUIDs at the boundary (422, not 500).**
  `OrganizeSavedReelsRequest` (`api/schemas.py:66`) accepts duplicates; the RPC rejects them
  with a generic `P0001` (`20260719102000_saved_reels_active_item_guard.sql:25-29`) whose
  message is `'Saved Reel organize request is invalid'`, but `organizer.py:76-82` maps only
  two *specific* message strings — so a direct API client gets a **500 instead of a 422**.
  (The frontend never sends duplicates, which is why this has not surfaced.) Validate at the
  boundary where it belongs:

```python
class OrganizeSavedReelsRequest(BaseModel):
    saved_reel_ids: list[UUID] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def reject_duplicate_ids(self):
        if len(set(self.saved_reel_ids)) != len(self.saved_reel_ids):
            raise ValueError("saved_reel_ids must not contain duplicates")
        return self
```
  **This compounds the exact-message-string fragility that B5(d) fixes** — note the linkage in
  both PR bodies. B1(c) stops the bad input reaching the RPC; B5(d) stops the *mapping* from
  depending on English prose. Neither replaces the other.
  Commit: `fix(api): reject duplicate saved_reel_ids with 422 instead of a 500 from the RPC`.
  *Fault-inject:* remove the validator → the duplicate-input test returns 500, red.

**Deferral (concrete trigger):** a merge contract (scrape Reels AND combine with authorized
places) — only when an approved product requirement for merged sources exists (none does).

---

### Task B2: ISSUES-B2 — reuse verified legacy places with null country

**Severity/size:** P3 / S. **Guardrails:** #1 (never infer country from name — the fill comes
from the Mapbox-verified result), #7 (the flywheel stays dedup-on-write).

**Files:**
- Modify: `backend/organizer.py::_persist_place` (177-193)
- Test: extend the `_persist_place` test module

- [ ] **Step 1: Failing tests** — (a) same-name row with `country_code IS NULL` within 500 m →
  its id reused AND the row updated with the verified `country/country_code/country_name`;
  (b) far (>500 m) null-country same-name row → NOT reused (fresh insert); (c) when both a
  code-matching and a null-country row are within the gate, the code-matching row wins.
- [ ] **Step 2: Implement** — two selects, code-match candidates first (deterministic
  preference; avoids `or_` so the fakes stay simple until B6):

```python
    matched = await (client.table("places").select("id,lat,lng").eq("name", place.name)
                     .eq("country_code", grounded["country_code"]).execute())
    legacy = await (client.table("places").select("id,lat,lng").eq("name", place.name)
                    .is_("country_code", "null").execute())
    for row in (matched.data or []) + (legacy.data or []):
        if (...same 500 m haversine gate as today...):
            await client.table("places").update({...same country fill as today...}).eq("id", row["id"]).execute()
            return row["id"]
```
The existing update already writes the country fields, so null-row reuse backfills for free.
Never infer country from the name alone (ISSUES-B2 recommendation).

- [ ] **Step 3: Suite + evals green; commit** `fix(organizer): reuse+backfill null-country legacy places within the 500m gate (ISSUES-B2)`

**Fault-injection:** drop the `legacy` select → test (a) red. Restore.

**Deferrals (concrete triggers):** batch backfill of legacy null-country rows — when a
production count shows `places.country_code IS NULL` rows > ~200 (audit query in the PR body).
The select-then-insert concurrent-dup race — stays deferred, matching the known `persist.py`
caveat (trigger: observed duplicate canonical rows in production).

---

### Task B3: Coordinate-echo hardening + EXTRACTOR_VERSION bump (+ read-surface alignment)

> **⚠ Cross-arc dependency — the one place Arc B depends on Arc A.** This task re-creates
> `saved_reel_cards`. **Copy the definition Arc A's A3 left behind** (the one carrying
> `and reel_place_mentions.user_id = saved_reels.user_id`), NOT the one in
> `20260719103000_saved_reels_current_cache_signal.sql`. Copying the wrong one silently
> un-scopes the mention join and reverts A3's Major. The `supabase db reset` gate catches a
> syntax error here; it will **not** catch this. Diff the two definitions before writing.

**Severity/size:** P3 / M — pulled out of the minors because it cascades: any change to
`keep_valid_places`' filtering REQUIRES an `EXTRACTOR_VERSION` bump (the comment at
`place_extractor.py:27-29` is the contract), which requires a new `saved_reel_cards` view
migration AND an edit to the tripwire test's `MIGRATION_PATH`. **Guardrails:** #1, #11 (the
P2-7 non-circular evidence contract), #4 (view change shipped with its test in one task).

**⚠ Deliberate deviation from the review:** the review says "scan path + query" universally.
That would reject every legitimate Google `/maps/place/` URL — Google embeds the venue's own
coordinates in the path (`/@35.65,139.74,17z` and `!3d…!4d…`), and the extractor prompt
explicitly allows stable `/place/` URLs (their independence proof is the embedded place id,
already enforced by `_GOOGLE_PLACE_ID_RE`). So: **path+query scanning with the 1e-3 tolerance
applies to non-Google hosts only**; Google hosts keep the existing place-id logic unchanged.
The review's own attack example (`/@35.65,139.74` on non-Google hosts) is exactly what this
covers.

**⚠ Cost consequence (state in the PR body):** bumping `EXTRACTOR_VERSION` invalidates every
extraction-cache row — each user's next organize per reel is a full cold run (Apify + OpenAI
spend + one quota charge). Deliberate: the evidence contract got stricter, so cached
extractions validated under the old contract must not be trusted.

**Files:**
- Modify: `backend/genagents/place_extractor.py::is_independent_source_url` (125-148) + `EXTRACTOR_VERSION` (29)
- Create: `supabase/migrations/20260720110000_saved_reels_cache_signal_v2.sql`
- Modify: `backend/test_saved_reels_cache_signal.py::MIGRATION_PATH` (7-12)
- Test: extend the `is_independent_source_url` test module

- [ ] **Step 1: Failing tests**

```python
def test_rounded_coordinate_echo_is_rejected():
    # LLM-style 4-decimal echo of 35.6586,139.7454 — passes today's 1e-6 check
    assert not is_independent_source_url(
        "https://venue.example.jp/map?lat=35.6586&lng=139.7454", 35.65861, 139.74543)

def test_path_embedded_coordinates_rejected_on_non_google_host():
    assert not is_independent_source_url(
        "https://someviewer.com/@35.6586,139.7454,17z", 35.6586, 139.7454)

def test_google_place_url_with_embedded_coords_still_accepted():
    url = ("https://www.google.com/maps/place/Tokyo+Tower/@35.6586,139.7454,17z/"
           "data=!3m1!4b1!4m6!3m5!1s0x60188bbd9009ec09:0x481a93f0d2a409dd")
    assert is_independent_source_url(url, 35.6586, 139.7454)   # place id = independence proof

def test_far_number_in_path_is_not_a_false_positive():
    assert is_independent_source_url("https://tabelog.com/tokyo/A1307/A130701/13024893/", 35.6586, 139.7454)
```

- [ ] **Step 2: Implement**

```python
_COORD_ECHO_TOLERANCE = 1e-3   # ~100 m: catches the 4–5-decimal rounding LLMs emit

def is_independent_source_url(url, lat, lng):
    if lat is None or lng is None or is_placeholder_url(url):
        return False
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()
    is_google_host = host.startswith("google.") or ".google." in host
    if is_google_host:
        # Legit /place/ URLs embed the venue's coordinates by design; the stable
        # place id is their independence proof (P2-7 option B).
        path = parsed.path.lower()
        if "/maps/search" in path or "/maps/place/" not in path:
            return False
        return _GOOGLE_PLACE_ID_RE.search(f"{parsed.path}?{parsed.query}") is not None
    corpus = unquote(parsed.path) + " " + unquote(parsed.query)
    numbers = [float(v) for v in _QUERY_NUMBER_RE.findall(corpus)]
    if (any(abs(v - lat) <= _COORD_ECHO_TOLERANCE for v in numbers)
            and any(abs(v - lng) <= _COORD_ECHO_TOLERANCE for v in numbers)):
        return False
    return True
```
Bump `EXTRACTOR_VERSION` to the implementation date (e.g. `"2026-07-20.1"`).

- [ ] **Step 3: The three-step bump procedure (document it as a comment above `EXTRACTOR_VERSION` — the review flags this as an undocumented tripwire):**
  1. Bump `EXTRACTOR_VERSION` in `place_extractor.py`.
  2. New migration re-creating the `saved_reel_cards` view: **copy the definition verbatim from
     the migration A3 shipped** (`20260720080000_reel_place_mentions_user_scope.sql` — NOT
     `20260719103000`, see the dependency box above), changing only the
     `extractor_version = '<new>'` literal — `drop view` + `create view` (0216a0e lesson: never
     `CREATE OR REPLACE` a view when anything but trailing columns could differ). Same
     migration additionally adds `and saved_reels.analysis_status = 'organized'` to BOTH the
     view's verified-place mention join AND `private.can_select_verified_saved_reel_place`
     (the review's read-surface MINOR).
     **Rationale narrowed by A3 — but still load-bearing.** A3 already stopped a user who
     merely *saved* someone else's organized Reel from seeing its pins (they own no mention
     rows). What remains is the *same-user stale-status* case: a user who organized
     successfully once, then re-organized and got `failed` / `location_not_found`, still owns
     their earlier mention rows and would still see pins that `authorize_place_ids` — which
     requires `analysis_status='organized'` (`organizer.py:106-107`) — rejects, failing
     generation terminally. Tightening the read surface to match authorization is the
     conservative pick; the alternative (relaxing `authorize_place_ids`) widens access and is
     rejected. **Product note for Zhi Hao:** after a failed re-organize, a Reel's pins
     disappear from the card until the next successful (cache-hit, Mapbox-cached, quota-free)
     organize.
  3. Update `MIGRATION_PATH` in `backend/test_saved_reels_cache_signal.py` to the new file, and
     update its exact-join-literal assertion to the new join text.
- [ ] **Step 4: Full gates:** backend suite + evals (**this is the flagged task — if
  `evals/` moves at all, STOP: the offline eval must not depend on live extractor filtering; a
  moved anchor means an import leak to investigate, not a number to update**), plus
  `supabase db reset && supabase test db && supabase db lint --local`, plus pgTAP additions:
  saved-not-organized user sees no places in `saved_reel_cards` and
  `can_select_verified_saved_reel_place` returns false for them.
- [ ] **Step 5: Commit** `fix(extractor): 1e-3 coordinate-echo tolerance + path scanning on non-Google hosts; EXTRACTOR_VERSION bump + view realignment`

**Fault-injection:** revert tolerance to 1e-6 → rounding test red. Point `MIGRATION_PATH` at
the old migration → the version-parity tripwire itself goes red (proves the tripwire works).
Restore.

---

### Task B4: ISSUES-B3 — null embeddings are a deliberate, tested MVP state

**Severity/size:** P3 / S (documentation + contract test; **no embedding writer** — ISSUES-B3's
recommendation: never add a blocking OpenAI call to the organizer critical path for this).

> **This is a CHARACTERIZATION test, not TDD.** The assertion below **passes against today's
> code** — `_persist_place` already omits `embedding`. Its value is pinning a deliberate
> decision so a future change has to argue with it, not proving new behavior. Do **not** run it
> expecting RED, and do **not** report it as RED→GREEN. (The repo is strict about TDD;
> mislabeling a passing test as a failing one erodes the signal that makes the discipline
> worth having.) Its fault-injection is correspondingly inverted: add an `embedding` key to the
> insert payload → the test goes red, proving the assertion is real and not vacuous.

**Files:**
- Modify: `backend/organizer.py::_persist_place` (comment), `.claude/docs/ARCHITECTURE.md` (flywheel section)
- Test: extend the `_persist_place` test module

- [ ] **Step 1: Characterization test (expect GREEN — see the note above)**

```python
@pytest.mark.asyncio
async def test_organizer_place_insert_omits_embedding_deliberately(fake_client):
    """Contract (ISSUES-B3): null embedding is a DECISION, not an accident. Organizer places
    join the pgvector flywheel via the future shared embedding producer, never via a
    blocking OpenAI call here. If this test bothers you, you are building that producer."""
    await _persist_place(fake_client, grounded_fixture())
    payload = fake_client.tables["places"].last_insert
    assert "embedding" not in payload
```
- [ ] **Step 2: Comment + ARCHITECTURE.md note** (organizer places carry `embedding = NULL`;
  exact-name+geo matching only; zero production embedding writers exist repo-wide — verified).
- [ ] **Step 3: Suite green; commit** `test(organizer): characterize the null-embedding MVP contract (ISSUES-B3)`

**Fault-injection (inverted, because the test starts green):** add `"embedding": [0.0]` to
`_persist_place`'s insert payload → the test goes red. Restore.

**Deferral (concrete trigger):** the bounded backfill/producer ships **when semantic place
matching is scheduled on the board** (the first feature that queries
`places_embedding_hnsw_idx`), built as a shared producer used by BOTH `organizer._persist_place`
and `persist._find_or_create_place` — not before, and never inline in the organize loop.

---

### Task B5: Grouped minors (five small fixes, one task, separate commits)

**Severity/size:** P3 / S each. Sub-fix (d) carries a migration → this task runs the full
Supabase gate. Each sub-fix: failing test → implement → suite green → commit.

**Files:** `backend/main.py`, `backend/organizer.py`, one new migration, matching tests.

- [ ] **(a) Rate-limit `POST /saved-reels`** — the only new mutating endpoint without
  `BURST_LIMIT` (unbounded authenticated row creation). Add `@limiter.limit(BURST_LIMIT)` +
  the `request: Request, response: Response` params + switch the dep to
  `get_current_user_id_stashed` (slowapi keys on `request.state.user_id`; the other endpoints
  are the template). Test: 4th call in a minute → 429 with the standard envelope.
  Commit: `fix(api): burst-limit saved-reel capture`.
  *Fault-inject:* remove the decorator → red.
- [ ] **(b) Honest final status message + constant** — `run_organize_job` final block: replace
  both hardcoded `"Organization failed"` strings (411/414 pre-A1; re-locate after A1's
  extraction and A2's fencing edits) with
  `ORGANIZE_FAILURE_MESSAGE`; and when `final_status == "succeeded"` with
  `organized_items == 0` (all `location_not_found`), set `status_message = "No locations found"`
  instead of `"Organized"` (a zero-place job must not read as organized). `final_status` values
  themselves are unchanged (frontend contract; message content is non-breaking — SSE shape
  untouched). **Wording flag for Zhi Hao** in the PR. Test: 4 failed + 1 location_not_found →
  `succeeded` + `"No locations found"`.
  Commit: `fix(organizer): honest zero-place status message; use ORGANIZE_FAILURE_MESSAGE`.
- [ ] **(c) Cache-read blip tolerance** — wrap the `get_cached_places` call in `_process_item`
  in `try/except Exception: places = None` (treat as MISS — the trip runner's exact behavior;
  today a read blip fails the item). Note the accepted trade-off in a comment: a blip on a
  cached reel triggers a fresh charged scrape — consistent with the runner, and cheaper than a
  failed item. Test: `fail_on_select("reel_cache")` fake → item still processes as a MISS.
  Commit: `fix(organizer): tolerate extraction-cache read blips as MISS`.
  *Fault-inject:* remove the try/except → red.
- [ ] **(d) Stop matching Postgres errors by message string** — `create_organize_job` (76-82)
  matches exact English text; a wording tweak turns 409 into 500. **Pairs with B1(c):** that
  task stops duplicate IDs *reaching* this mapping; this task stops the mapping depending on
  English prose at all. Neither substitutes for the other — after both, an unmapped `P0001`
  still means "some other validation the RPC rejects", which is why the third invalid-request
  branch (`20260719102000:22`) must ALSO get a SQLSTATE, not just the two the plan first named.
  New migration re-creating `create_saved_reels_organize_job` (copy from `20260719102000`,
  changing ONLY the `raise exception ... using errcode` lines): conflict → `errcode 'AS409'`,
  not-found → `errcode 'AS404'`, invalid-request → `errcode 'AS422'` (custom 5-char SQLSTATEs;
  A2 and A3 already use this convention). Python matches `exc.code` — message text no longer
  load-bearing (same PR both sides, no skew window); `AS422` maps to 422.
  pgTAP: `throws_ok` asserting all three SQLSTATEs. Full Supabase gate.
  Commit: `fix(organizer): match organize-job errors by SQLSTATE, not message text`.
  *Fault-inject:* change the SQL message text only → tests stay green (that's the point);
  change a SQLSTATE → the matching test goes red.
- [ ] **(e) Reconcile dangling quota reservations at recovery** — a lost refund leaves a
  terminal item `charge_state='reserved'` forever (quota unit leaked). Append to
  `recover_organize_jobs` (after A2's reclaim sweep — note this now also runs on every
  `_reap_loop` tick, not only at boot, which is strictly better): select `organize_job_items` with
  `analysis_charge_state = 'reserved'` and terminal status (`organized`/`location_not_found`/
  `failed`), call `refund_organize_item_analysis` per row (`organized` items with a dangling
  *reserved* state were never consumed — the refund releases the unit; consumption is a
  separate CAS on `reserved` so there is no double-release), best-effort per row
  (`try/except: logger.warning`). Test: seeded dangling reservation refunded at recovery;
  `consumed` and `not_charged` rows untouched.
  Commit: `fix(organizer): sweep dangling reserved quota charges at recovery`.
  *Fault-inject:* drop the terminal-status filter → the consumed/untouched assertion red.

**Deferral (concrete trigger):** the hardcoded analysis-quota literal `5` in the SQL functions
(vs env-driven `DAILY_TRIP_QUOTA`) — parameterize **when product changes the reel-analysis
quota or introduces tiers**; folding it into (d)'s migration now would widen a two-line diff
into a quota re-review for zero present value.

---

### Task B6: Test-double honesty + dead-code removal

**Severity/size:** refactor / M. Production must never branch on whether a **fake** implements
a method — that hides real supabase-py API drift (review §3). Do this AFTER all behavior tasks
so the fake-interface work lands once.

> **Carried in from B2's review (2026-07-20) — collapse `_persist_place`'s two selects here.**
> B2 made canonical-place reuse null-country-aware by issuing TWO selects unconditionally
> (`.eq("country_code", …)` then `.is_("country_code", "null")`) and concatenating the results.
> The plan mandated that shape deliberately — it avoids `or_` so the fakes stay simple *until
> this task*. Cost, confirmed: `_persist_place` runs once per grounded place, so an organize of
> N places issues up to **2N** selects instead of N. Latency only, never correctness — the
> single shared distance gate and the single shared update site mean the two branches cannot
> diverge. **B6 is the natural moment to fix it**, because adding `or_` to the fake is already
> this task's business: once it exists, the two selects collapse into one
> `or(country_code.eq.<code>,country_code.is.null)`. Keep the ordering preference — a
> country-code match must still win over a null-country row, since it is already
> Mapbox-verified — and keep `test_persist_place_prefers_the_country_code_match_over_a_null_country_row`
> green, which is what pins that.

**Files:**
- Modify: `backend/organizer.py` (delete `_maybe_await` (39-40) + all call sites; delete `_initializing_job_is_stale` (43-52). Note: `_persist_mention` and its `hasattr(table, "upsert")` fork were already deleted by **A3**, which replaced them with the `replace_reel_place_mentions` RPC — verify they are gone rather than re-deleting them)
- Modify: `backend/api/streaming.py::stream_organize_events` (88) — drop `hasattr(query, "gt")`; always `.gt("sequence", cursor_sequence)` when a cursor is set
- Modify: every test fake these forks were protecting — fakes now implement `upsert`, `gt`, `not_.in_`, `is_`, and async `execute` for real (one shared fake-table helper if the modules currently roll their own; do NOT build a fake framework — extend the existing pattern)
- Create: `supabase/migrations/20260720120000_drop_superseded_reel_quota_functions.sql`:

```sql
drop function if exists public.reserve_daily_reel_analysis(uuid, date);
drop function if exists public.refund_daily_reel_analysis(uuid, date);
```
  (Superseded by the exactly-once item-level RPCs; zero Python callers — verified repo-wide.
  **Implementer: re-verify signatures against `20260718130000` before writing the drop**, and
  grep `supabase/tests/` for pgTAP references to update.)

- [ ] **Step 1:** grep-based failing guard test: assert `hasattr(` does not appear in
  `organizer.py` / `api/streaming.py` and `_maybe_await` is gone (a crude but honest tripwire
  that the forks stay dead).
- [ ] **Step 2:** make the fakes real, delete the forks, delete the dead helpers, `await` the
  injected `scrape`/`extract`/`ground` seams directly (they must now BE async — fix any sync
  test lambdas).
- [ ] **Step 3:** full backend suite + evals + full Supabase gate.
- [ ] **Step 4: Commit** `refactor(backend): fakes implement the real client interface; delete dead initializing path + superseded quota functions`

**Fault-injection:** re-introduce one `hasattr` fork → tripwire red. Restore. Keep the
`OrganizeJobStatus` `"initializing"` Literal and the DB check constraint — harmless, and
removing them is frontend-visible churn for zero value.

---

### Arc B closeout

> ## ⛔ STEP 0 — APPLY `20260720130000` BEFORE THE MERGE. NOT OPTIONAL.
>
> B5(d) replaced Postgres error matching by message string with custom SQLSTATEs.
> `_ORGANIZE_JOB_ERRORS` maps **only** `AS409`/`AS404`/`AS422` and re-raises everything else.
> The deployed database still raises `P0001`.
>
> ```
> merge before applying  →  deployed Postgres raises P0001
>                        →  not in the map  →  re-raised
>                        →  api/errors.py's bare-Exception handler returns a generic 500
>                        →  EVERY 409 ("already organizing") and EVERY 404 (bad/cross-owner id)
>                           on POST /saved-reels/organize becomes an opaque 500, for the whole
>                           skew window. Mainline paths, not edge cases.
> ```
>
> **Nothing in this repo enforces the order.** `render.yaml` has `autoDeploy: true` with no
> pre-deploy migration hook, and `.github/workflows/rls-tests.yml` only runs `supabase db start`
> against a fresh ephemeral Postgres — CI never touches the deployed project.
>
> **A code fallback was considered and REJECTED.** `rate_limit.py` has a precedent (catching
> `PGRST202` and failing closed), but it does not transfer: there the function genuinely does not
> exist yet, so the signal is unambiguous. Here the function exists in BOTH versions
> (`create or replace`), and after the migration `P0001` is deliberately overloaded to mean "some
> other validation" — so a `P0001`-plus-message fallback would be correct during the window and
> **silently wrong afterwards**, misclassifying new P0001s into 409/404. That is precisely the
> fragility B5(d) exists to remove, reintroduced on a timer. Fail-loud-500 for a controlled
> window beats fail-quiet-wrong forever.
>
> **Order:**
> 1. Apply `supabase/migrations/20260720130000_organize_job_error_codes.sql` to the deployed
>    Supabase (plus `…120000_saved_reels_cache_signal_v2` if Arc A's closeout did not).
> 2. Confirm the **currently deployed** code still works against it — it does; the migration is
>    additive and old code matches on message text, which is unchanged.
> 3. Only then merge and let auto-deploy ship the code.
> 4. Smoke it: a duplicate organize of an already-active Reel must return **409, not 500**. If it
>    returns 500, the migration did not land.


1. Final whole-branch `astrail-reviewer` pass, **`model: fable`**.
2. gstack `/review` Codex cross-model pass — run BOTH.
3. Verify B3's view migration actually copied A3's user-scoped join (diff the two view
   definitions; this is the one thing the Supabase gate cannot catch).
4. Live smoke: one organize on a Reel whose extraction predates B3's `EXTRACTOR_VERSION` bump,
   confirming the expected cold re-run and the new coordinate-echo filtering.
5. PR to `dev` with review trail; merge; fast-forward `shaun`.

---

# ARC C — Frontend (Zhi Hao)

**Branch:** `feat/saved-reels-arc-c-frontend` off `dev`. Independent of Arcs A and B; can run in
parallel with either. **Closeout:** after C2's task list is agreed (C2 is open-ended by design).

---

### Task C1: ISSUES-B7 — `CN → China` presentation mapping (frontend)

**Severity/size:** cosmetic / S. **Owner: Zhi Hao** (decision already made; implementable by
`astrail-developer` with his sign-off on wording). **Locked:** store Mapbox's canonical
`People's Republic of China` untouched — never mutate verified provider evidence; `CN` stays
the grouping/identity key; mapping lives ONLY in the presentation layer.

**Files:**
- Modify: `frontend/lib/reels/organize.ts`, `frontend/components/reels/CountryTrays.tsx:28`
- Test: `frontend/lib/reels/__tests__/organize.test.ts`, `frontend/components/reels/__tests__/VerifiedPlacesMap.test.tsx` (fixtures currently expect `China` — align them with the live pair)

- [ ] **Step 1: Failing test** — feed the exact live pair through grouping:

```ts
const trays = groupPlacesByCountry([
  { country_code: "CN", country_name: "People's Republic of China", /* …place fields… */ },
])
expect(trays).toHaveLength(1)
expect(trays[0].country_code).toBe("CN")                                  // identity key
expect(trays[0].country_name).toBe("People's Republic of China")          // stored canonical, untouched
expect(countryDisplayLabel(trays[0])).toBe("China")                       // presentation only
```
- [ ] **Step 2: Implement**

```ts
// organize.ts — product-owned display overrides; stored provider names are never mutated
// (ISSUES-B7).
const COUNTRY_DISPLAY_OVERRIDES: Record<string, string> = { CN: "China" }

export function countryDisplayLabel(
  tray: Pick<CountryTray, "country_code" | "country_name">,
): string {
  return COUNTRY_DISPLAY_OVERRIDES[tray.country_code] ?? tray.country_name
}
```
`CountryTrays.tsx:28`: `{countryDisplayLabel(tray)}`. Keep the existing `country_name` sort
(stable, canonical); no backend/schema change of any kind.

- [ ] **Step 3:** `npm test && npm run typecheck && npm run build`; commit
  `fix(reels): map CN to product label China in the presentation layer (ISSUES-B7)`

**Fault-injection:** make the override mutate `tray.country_name` instead → the
stored-canonical assertion red. Restore.

**Deferral (concrete trigger):** a locale-aware country-name formatter — when a second locale
ships (none is planned for v1).

---

### Task C2: Frontend polish track — "still feels AI-generated" (process task, frontend-owned)

**Owner: Zhi Hao. Independent of every backend task; needs his input on direction before any
pixel moves.** Do NOT guess design fixes from the reference filenames.

- [ ] **Step 1:** run gstack `/design-review` against the live app, covering the 7 routes that
  have current-state screenshots in `frontend/reference/current/` (01-landing → 07-settings) —
  it hunts visual inconsistency, spacing, hierarchy, and AI-slop patterns.
- [ ] **Step 2:** convert its findings into concrete, individually-testable frontend tasks
  (each with the component file, the change, and a before/after screenshot), reviewed with Zhi
  Hao before implementation.
- [ ] **Step 3:** implement via the normal loop (`astrail-developer` opus per task,
  `astrail-reviewer` sonnet gates), `npm test && npm run typecheck && npm run build` per task.

That is the whole track — the findings, not this plan, define the task list.

---

## Deferral register (everything deferred, each with its trigger)

**Moved OUT of deferral (now in scope — do not re-defer them):** per-attempt fencing tokens,
lease renewal heartbeat **on both job systems** (the trip-side heartbeat was deferred in the
round-1 amendment and is now in scope — `Runner.run` has no timeout, so trip runtime has no
upper bound), periodic (non-boot) reaping, atomic event-sequence allocation, and user-scoped
mention replacement with a true atomic swap. All are Arc A, tasks A2 and A3.

| Deferral | Trigger |
|---|---|
| Coordinate-to-venue identity verification (reverse `types=poi` + name match / second source) | First observed live case of a verified-country pin on the wrong venue (HANDOFF: country containment is verified; the exact dot trusts research) |
| `_persist_place` / `persist.py` select-then-insert concurrent-dup race | Observed duplicate canonical rows in production |
| ISSUES-B3 embedding producer/backfill | Semantic place matching scheduled on the board |
| Per-item fenced writes (RPC for `organize_job_items` updates) | A live incident shows a superseded worker's item write landing — signal: `organize_lease_renew_failed` warnings plus a job whose item states disagree with its final counts |
| Fenced `generation_events` appends | `generation_events` gains a uniqueness constraint, or a duplicate event is observed corrupting the reasoning panel rather than merely repeating a line (today: no unique index, and SSE dedups by seen-set cursor) |
| Per-mention provenance (which organize job wrote a mention) | A second writer of `reel_place_mentions` is introduced, or an incident requires attributing a mention to a run |
| Time-based expiry for `geocode_country_cache` | An observed provider correction or border change affecting a supported destination (version bump is the mechanism until then) |
| One-time stream token (ISSUES-B1 Branch B) | **MANDATORY GATE: before public beta** — implement it then regardless of probe results. Earlier if any of: the sentinel appears in a Render platform-log sink after Branch A deploys · the service plan/tier changes (re-run the probe) · any external party gains log access. Rationale: redaction closes the *observable* sink; it does not prove Render keeps no internal record, and the JWT stays in the URL and in browser history either way. Deferral is a pre-beta posture, not a fix |
| Shared AsyncClient + gathered Mapbox calls | Measured Mapbox wall-time > 5 s on a warm-cache-miss organize |
| Split organizer/trip recovery semaphores | Measured boot-backlog starvation between the two |
| Env-parameterized analysis quota (SQL literal `5`) | Product changes the reel-analysis quota or adds tiers |
| Legacy null-country batch backfill | Production `country_code IS NULL` count > ~200 |
| Locale-aware country display names | A second locale ships |
| `organizer.py` package split | **Never for v1** — review verdict: not warranted (421 lines, in budget). Note A1's extraction and A2's lease code push it past 500; re-evaluate against the 800-line ceiling at Arc A closeout, not before |
| Direct `reel_urls` trip path gets Mapbox country verification | Out of Saved-Reels scope by design (extractor-claimed country is trusted there); revisit when reel-path trips surface a wrong-country place in evals or live QA |

---

## Post-arc documentation (after all three arcs merge)

Update `.claude/docs/ARCHITECTURE.md` (job leases + the reaper, the country cache, the
`EXTRACTOR_VERSION` bump procedure, the ISSUES-B3 null-embedding contract, and the fact that
`reel_place_mentions` is now owner-scoped), EMDEE shared vault (DECISIONS LOG + ROADMAPS
snapshot — the lease design and the mention-scoping backfill policy are both decisions worth
recording), and memory; hand Codex the board-card updates.

---

## What changed in revision 2 (2026-07-19, post-Codex-round-2 — FAIL 6.2/10)

Round 2 scored diagnosis 8.5 but risk management 4.5 and feasible-first 5.0: the round-1
amendment bought correctness by adding machinery. **This revision is net-simplifying** — the
only additions are the trip heartbeat (~15 lines, and it deletes a deferral row) and the
rollback migration; everything else replaces something larger.

| Codex round-2 finding | Resolution | Net effect on plan size |
|---|---|---|
| **1a. `mark_job_done(lease_token=None)` is a fencing bypass** | The token is **required**; there is no unfenced form. `_fail` **skips** the terminal write when it holds no token (a run that never claimed must not finalize) rather than threading an optional parameter | **smaller** — one branch deleted |
| **1b. A2 rejects a trip heartbeat without argument** | **Heartbeat added.** The rejection rested on 76.8 s / 13.9 s measurements, but `Runner.run(..., max_turns=12)` (`genagents/place_extractor.py:235`) sets **no timeout** on a `web_search` agent loop, and Apify allows 130 s/reel (`scrape/apify_direct.py:54`) — that is a measurement, not a bound. Reuses the organize `_heartbeat` verbatim | +15 lines, −1 deferral row |
| **1c. Renewal/reaper race** (reaper reads expired → heartbeat renews same token → reaper's CAS still matches) | Both reclaims collapse from select-then-CAS-loop into **one atomic `UPDATE … WHERE status=? AND lock_expires_at < now`**. Postgres re-evaluates the predicate against the renewed row, so the race cannot occur; the null-token branch fork disappears with it. New interleaving test + a fault injection that restores the loop | **much smaller** — a loop, a fork and a CAS deleted from two functions |
| **1d. Fencing token not threaded to every write site** | Each site verified individually and given an explicit verdict in two tables (organize + trip): **hard-fenced** = events RPC, job status, `mark_job_done`; **bounded, not fenced** = item/`saved_reels` writes and the trip save block (gated on `lease_lost`); **deliberately unfenced** = `generation_events` (no unique constraint — verified `20260701151718_trip_job_backbone.sql:55` — and SSE dedups; fencing costs an RPC per event on the streaming path for a cosmetic gain), deferred with a trigger. The test asserting an old worker "writes nothing" was **false** and is renamed to assert only the hard-fenced set | neutral — prose replaces prose |
| **2. A3's expand/contract split is impossible** | Confirmed and **deleted**. Today's PK `(reel_cache_id, place_id)` blocks the fan-out until it is dropped, and dropping it breaks the deployed `_persist_mention` upsert's `on_conflict` target (`organizer.py:219`) — old and new code cannot coexist against either schema. Replaced with a **six-step maintenance window** (drain → suspend service → single atomic migration → merge+resume → four-point verify → rollback), plus a rehearsed down-migration shipped in the same PR | **smaller** — two migrations become one; A3a/A3b prose deleted |
| **3. RPC fails on duplicate canonical `place_id`** | `DISTINCT ON (place_id)` with `WITH ORDINALITY` inside the RPC (one statement, data-modifying CTE), so the single dedupe lives where the constraint lives. Python test for call shape + **pgTAP test for the constraint** (the fake cannot reproduce the Postgres error) + a fault injection | +8 lines |
| **4. A5 deferral weakened in the register** | Register now reads **"MANDATORY GATE: before public beta"**, with the probe/plan-change/external-access triggers as *earlier* escalations. Consistent with the prose | neutral |
| **5. Stale "backend is not deployed"** | Fixed in the revision-1 table's last row (the only remaining instance) | neutral |
| **6. B1 parity test can't work as written** | `toGenerateRequest` (`parse-inspiration.ts:90`) has no pace input and `BriefInput` no pace field. Switched to a **compile-time type fixture** rather than pulling the builder + brief form into a hygiene task | **smaller** |
| **7. Arc A is over-packaged as one PR** | Arc A becomes **five sequential PRs** (A-I … A-V) with sizes, dependencies and per-PR migration protocol. A2 splits along its existing test seam into A-II/A-III; A3 gets its own PR because its deployment is half its work | restructure |
| *Codex conceded: A1 before A2 is right* | Rebuttal prose cut from 6 lines to 3 — the point is settled, not argued | **smaller** |
| *Codex confirmed: the backfill preserves `authorize_place_ids` exactly* | Recorded in Step 0. But it does **not** preserve `saved_reel_cards` visibility for save-but-never-organized users (the view has no `analysis_status` filter — `20260719103000_saved_reels_current_cache_signal.sql:36`). Security-safe, but a **product change now gated on Zhi Hao's explicit sign-off before the migration is written** | +12 lines (a real gap) |

---

## What changed in revision 1 (2026-07-19, post-Codex-round-1 — FAIL 5.8/10)

| Codex finding | Resolution |
|---|---|
| **1. Lease/recovery design still permits double execution and silent orphaning** | A2 rewritten as a full lease design: lease-token CAS reclaim conditioned on the observed lease, renewal heartbeat, periodic reaper (kills the silent drop), fencing token on job-status and event writes, atomic serialized sequence allocation. Size raised M → **L**. |
| **2. Task 3 still destroys cross-user data** | A3 rewritten around a `user_id` column + new PK on `reel_place_mentions`, a documented fan-out/delete backfill policy with a pre-flight audit, a transactional `replace_reel_place_mentions` RPC, and realigned `saved_reel_cards` + `can_select_verified_saved_reel_place`. `authorize_place_ids` now scopes on the owner column. Size raised M → **L**. |
| **3. Rounded cache key can falsely bless a country; writes not write-through** | A4 uses a lossless `repr()`-based key (rounding bought zero hit-rate on the warm path), and `_store_cached_country` is **strict** write-through — a failed write fails the item, matching `cache_places` at `organizer.py:345`. Invalidation policy stated explicitly (version bump, no TTL, with a deferral trigger). |
| **4. Trip recovery has a worse claim-erasure race** | Folded into A2. `recover_inflight_jobs` → `reclaim_expired_jobs` with a `status='running'` + lease-token CAS; the false docstring at `jobs.py:83-85` is replaced, not preserved; `mark_job_running` returns a token and `mark_job_done` is fenced; `runner.py` threads it. |
| **5. Existing schema-parity violation overlooked (`pace`)** | The blanket parity claim is corrected in Global Constraints and B1(b) adds the TS mirror + contract test. |
| *NB: duplicate-ID boundary validation* | B1(c), with the B5(d) linkage spelled out. |
| *NB: strengthen concurrency fault injection* | A2 Step 2 adds four deterministic barrier interleavings (no sleeps): recovery-select → fresh claim → recovery-update; succeeded-mid-sweep; delayed re-sweep after a fresh crash; lease expiry during a blocked provider call; old worker resuming after replacement. |
| *NB: Task 5 caplog test optional* | Now **mandatory** in A5, with the install-deletion fault injection named. |
| *NB: mislabelled "failing" tests* | A6 and B4 are labelled **characterization** tests with inverted fault injection; neither claims RED→GREEN. |
| *NB: split the arc* | Three arcs (A/B/C), each with its own branch, closeout and PR. |
| *Move A2 before A1* | **Rejected, with reasons** — see "Task order and why". The amended A2 does touch `_process_item`, so the refactor is a real dependency. (The original rejection also cited "the backend is not deployed"; that was **wrong** — `astrail-backend` IS live on `srv-d976aess728c738pskk0`, starter plan, `autoDeploy: true` on `dev`, with no production traffic. The dependency argument stands without it, and Codex withdrew the suggestion in round 2.) |

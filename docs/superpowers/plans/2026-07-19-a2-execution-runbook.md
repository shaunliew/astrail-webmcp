# A2 Execution Runbook — A-II in full, A-III sketch

> Companion to `2026-07-19-saved-reels-followups.md` Task A2 (plan lines ~324–1123). It does NOT
> restate or replace that spec — the spec survived three Codex `gpt-5.6-sol` rounds
> (5.8 → 6.2 → 6.8), a Fable pre-gate, and a final fix pass, and its design decisions are settled.
> This decomposes *what it specifies* into independently-committable, independently-green
> increments, because a ~1-day task landing a migration + CAS claim + heartbeat + reaper +
> fencing tokens + an RPC as one lump is how this goes wrong.
>
> Produced by a Fable pass, 2026-07-19, after A1 merged. Baseline verified against post-A1 code.

## Baseline at time of writing (the A2 spec predates A1 — see §4)

- `_ItemContext(frozen=True)` — `client, job_id, user_id, scrape, extract, ground` — `organizer.py:286-304`
- `_process_item(ctx, item) -> bool` with the `if processed:` counts-guard at `organizer.py:474-477`
- `jobs` has `locked_at`/`attempt_count`, **no** `lock_expires_at`/`lease_token`
- `organize_jobs` has `lock_expires_at`, **no** `lease_token`
- `generation_events` has **no `user_id` column** (`20260701151718_trip_job_backbone.sql:55-62`)
- Tests: **590 passed, 7 skipped**; evals 49 passed, frozen anchor `mean_intra_day_travel_m = 6229.0`

## Verdict on the spec's 9-step ordering: INTERLEAVE per seam

Steps 1–3 write ~20 failing tests across two job systems before any implementation. That is a spec
*grouping*, not an execution order. A multi-day red tree means no intermediate commit is
bisectable, and a Step-1 test written against imagined code (several are already stale post-A1)
isn't discovered wrong until Step 5/6.

Execute tests-then-impl per increment below. **TDD discipline is fully preserved** — every guard is
still born red inside its own increment. The only loss is reviewing all failing tests as one batch;
the per-task reviewer recovers that by diffing test content against the spec's Step 1/2 listings at
PR review. Test *content* stays verbatim from the spec; only the schedule changes.

## A-II increments — branch `feat/organize-job-leases` off A1's merge commit

### I1 — Migration `20260720090000_job_leases.sql` + pgTAP

**Lands.** Spec Step-4 DDL verbatim: `organize_jobs.lease_token uuid`; `jobs.lease_token uuid` +
`jobs.lock_expires_at timestamptz`; the two backfill UPDATEs; two partial reap indexes;
`append_organize_event` RPC with revoke/grant. **Plus `complete_trip_run`** (corrected — see §6.1–6.3):
`p_lease_token uuid`, no `user_id` in the insert, `set search_path = ''`, revoke/grant. New pgTAP
`supabase/tests/008_job_leases.sql`: function exists, security definer + empty search_path,
`authenticated` lacks execute, `throws_ok` AS404/AS409, gapless sequences over N appends.

**Why first.** Every later increment reads these columns and I5 calls the RPC. The
migration-before-merge protocol also needs the file finalized early so the deployed-Supabase apply
isn't serialized behind all the code work.

**Gate.** `supabase db reset && supabase test db && supabase db lint --local` green; backend suite
untouched (590/7); evals green. **Never red** — pure DDL + pgTAP.

**Fault injection.** Comment out the `v_lease is distinct from p_lease_token` fence → AS409
`throws_ok` red → restore. Same for AS404 and the search_path assertion.

**Rollback.** Trivial pre-apply (delete file). Post-apply to deployed Supabase: still cheap —
columns additive/nullable, old code never reads them. **Old-code compat confirmed:** deployed
inserts to `jobs` omit the new columns (NULL); organize completion writes `lock_expires_at: None`
to a column that already exists; nothing calls the new RPCs; backfill only touches in-flight rows.

### I2 — Atomic expiry reclaim in `recover_organize_jobs`

**Lands.** One-statement reclaim per spec: `.eq("status","processing").or_(expired, legacy-null-
with-stale-locked_at)`, nulling `lease_token`/`lock_expires_at`/`locked_at`;
`ORGANIZE_LEASE_TTL_S = 300`; signature `(client, *, now=None)` — compatible with `main.py:76`'s
positional call, so no `main.py` change in A-II. Delete the dead `initializing` sweep (keep
`_initializing_job_is_stale`; B6 deletes it). New `backend/test_organizer_lease.py` with the spec's
five reclaim tests: unexpired-not-reclaimed, expired-reclaimed, legacy-null-token,
legacy-NULL-EXPIRY (the rollout-boundary orphan), null-expiry-inside-TTL.

**PLUS the fake-fidelity work, written FIRST.** The fake must evaluate `.lt()`, `.is.null` and
`.or_()` **at update time against the current row**, with its own fidelity test. Without it every
later race test passes vacuously. Note the current fake (`test_saved_reels_organize.py:51-56`) has
**no `.or_()` at all**, and its `lt` is `row.get(k) < v` — which raises `TypeError` on a NULL
`lock_expires_at`. Postgres evaluates `NULL < value` to NULL (row does NOT match); the fake must
mirror that. A careless patch to `row.get(k, "") < v` would make NULL rows always match and
invert the legacy-orphan test.

**Why here.** The reclaim predicate is the semantic foundation — I4's "reclaim and heartbeat cannot
both win" property is a statement *about this predicate*. Zero dependency on claim/token code, so
it can precede I3.

**Gate.** Red-by-design at start (5 tests), green at commit; full suite + evals. Existing recovery
tests in `test_saved_reels_organize.py` need seeds updated to carry expired leases — legitimate;
call it out in the commit message.

**Fault injection.** Simplify the predicate to `.lt("lock_expires_at", now)` only →
`test_legacy_NULL_EXPIRY_processing_row_is_reclaimable` red. (Dropping `.eq("status","processing")`
reddens nothing in A-II — its load-bearing test is trip-side, A-III; note in the PR body.)

**Rollback.** Trivial revert, no schema involvement.

### I3 — Claim mints the lease token; `_ItemContext` gains it

**Lands.** `run_organize_job` claim per spec: select `"attempt_count,started_at"`, mint uuid4, write
`lease_token` + `lock_expires_at`, preserve the first `started_at`. **`lease_token: str` becomes the
seventh `_ItemContext` field** — the A1-aware form of the spec's stale `lease_token=` parameter.
Ctx construction at `organizer.py:470` passes it. Test:
`test_claim_mints_a_fresh_token_and_preserves_started_at`.

**Why here.** I4 renews *this* token and I5 fences on *this* token — neither can be written or
honestly tested first. Follows I2 only to keep the two risky edits to the same functions in
separable diffs.

**Gate.** Red-by-design (1–2 tests) → green; full suite + evals.

**Fault injection.** Unconditionally set `started_at` in the claim update → preserves-started_at
assertion red.

**Rollback.** Trivial revert.

### I4 — `_renew_organize_lease` + `_heartbeat` + `LeaseLost` loop gate

**Lands.** Renewal CAS (`.eq` status processing + lease_token); `_heartbeat` (transport blip = log
and keep working; only an authoritative 0-row CAS sets `lost`); `LeaseLost`; loop wiring **merged
with the A1 shape** — `lease_lost.is_set()` check before each item, `_process_item(ctx, item)`
unchanged, and **KEEP the `if processed:` guard** on `_update_job_counts`. The spec's snippet omits
it; verbatim transcription reintroduces the orphan-counts bug A1 fixed. Heartbeat cancelled in
`finally`.

Tests: `test_heartbeat_renews_the_lease_and_detects_loss`;
`test_lease_expiry_during_a_blocked_provider_call_aborts_the_run` (barrier on `ground`, token
replaced underneath, assert LeaseLost before item 2 and no item-2 terminal write). Drive with
`ORGANIZE_LEASE_RENEW_S` monkeypatched near-zero or an injected sleep — **never real 60s sleeps**.
Assert task cancellation in at least one test so the beat can't leak.

**Why here.** Needs I3's token; must precede I5 because I5's old-worker test needs a run that can
lose a lease mid-flight.

**Gate.** Red-by-design → green; full suite + evals.

**Fault injection (spec #1).** `_renew_organize_lease` returns True unconditionally →
blocked-provider test red.

**Rollback.** Trivial revert; only I5's tests depend on it.

> ### ⛔ I4 IS UNSAFE ALONE — I5 IS LOAD-BEARING, NOT NEXT-IN-SEQUENCE
>
> **Empirically reproduced 2026-07-19** (two concurrent `run_organize_job` calls against the real
> `organizer.py`): a superseded worker's lease-loss abort **force-fails a legitimately-leased
> replacement**. Observed — worker B claims with a valid token, organizes item 1, then:
> `status='failed'`, `organized_items=1`, item 2 left `queued`. B's own token was never superseded.
>
> Chain: A's `LeaseLost` reaches the outer `except Exception` → `_mark_organize_job_failed`, which
> is **unfenced** → writes `status='failed'` → B's own renewal CAS requires
> `.eq("status","processing")` → matches zero rows → B reads it as lease loss → B aborts.
>
> Two reasons this is worse than "the same defect with a different value":
> 1. **New failure channel.** The renewal CAS's `status` predicate turns *any* write to `status` —
>    including an unrelated unfenced cleanup — into an implicit "you lost your lease" signal for
>    whoever legitimately holds it. Pre-I4 no worker could reach into another's control flow at all.
> 2. **I4 makes a theoretical race fire reliably.** A worker stuck in a blocked provider call
>    previously had *no exit path*, so it never reached any terminal write. I4 gives it a guaranteed
>    exit one renewal interval after being superseded — so the unfenced write now fires with
>    near-certainty in exactly the deploy-overlap scenario A2 exists to survive.
>
> **I5 closes it completely** (`.eq("lease_token", ...)` makes A's write match zero rows).
> **Therefore: never merge I4 to `dev` or deploy it independently of I5.** With `autoDeploy: true`
> on `dev`, merging I4 alone ships it. This belongs verbatim in the A-II PR body.
>
> **Reachability — what actually has to hold.** A plain crash (OOM, SIGKILL) does **NOT** trigger
> this: it stops the heartbeat instantly, so by the time anyone reclaims there is no zombie left to
> race. It needs a *survives-past-supersession* zombie, which in practice means a Render rolling
> deploy: the old container takes SIGTERM, its organize run (a FastAPI `BackgroundTasks` task,
> `main.py:283`) keeps executing through the grace period, is genuinely mid a slow provider call
> (Apify / Mapbox / OpenAI all plausibly run tens of seconds), *and* its heartbeat has been quiet
> long enough that the new container's boot sweep sees `lock_expires_at` already expired. A real but
> non-trivial conjunction. At zero traffic it mostly threatens a dev's own smoke test straddling a
> deploy; post-onboarding it scales with `deploy frequency × concurrent organizes × P(slow provider
> call in flight)` — and this repo's own history documents Apify as flaky/slow under load, which
> raises that last term.
>
> **Which user-facing surfaces actually show the false failure.** A client *already streaming*
> disconnects on W2's genuine "Organized" event, because `stream_organize_events`
> (`api/streaming.py:101-107`) returns on the FIRST `result`-type event by `sequence` — so it never
> renders W1's later "Organization failed". But a **new connection, a page refresh, or the polling
> `GET /saved-reels/organize/{job_id}`** (which reads the job row directly, not the event log) all
> show `failed` for a job that succeeded. (Sequence assignment is itself `max(existing)+1`
> select-then-insert, non-atomic — separately I5's to fix.)
>
> *Minor, same review:* I3's review argued I4 would be orthogonal to its `CancelledError` test
> because "I4 uses cooperative signalling, not real cancellation". **That premise is now false** —
> I4 does call `beat.cancel()`. The test still passes, but for a narrower reason: the real
> cancellation is scoped to the *heartbeat task*, never to the main run's coroutine, so it cannot
> collide with a `CancelledError` raised synchronously inside `ground()`. Do not lean on the
> outdated "I4 has no real cancellation" claim in a later increment.

### I5 — Fenced organize writes + RPC-backed `_record_organize_event`

**Lands.** Final-status update and `_mark_organize_job_failed` gain `.eq("lease_token", ...)` (plus a
`lease_token` kwarg on the latter; `run_organize_job`'s outer `except` passes it).
`_record_organize_event(..., *, lease_token=None)` becomes a thin wrapper over
`client.rpc("append_organize_event", ...)`, treating AS409 as lease-lost (log + return, **never**
crash a terminal path). Call sites pass `ctx.lease_token`.

Fake gains `rpc("append_organize_event")` emulation **including raising AS409 for a superseded
token** (extend the existing fake-rpc pattern at `test_saved_reels_organize.py:90,250`) plus a
fidelity test that the fake actually rejects a stale token.

Tests: `test_fenced_writer_cannot_finalize_the_job`;
`test_old_worker_resuming_after_replacement_cannot_finalize_the_job` (assert exactly the
hard-fenced set; do NOT assert item rows untouched).

`_update_job_counts` stays **deliberately unfenced** — same "bounded" bucket as item writes (it
recomputes from live statuses). State this in the PR body so the reviewer doesn't flag it as a miss.

**Why last (code).** Touches every write site; needs the token (I3), a losable lease (I4), and the
RPC (I1). Highest-churn increment — every event insert reroutes through `rpc`, so most existing
organize-test fake updates land here. Budget accordingly.

**Gate.** Red-by-design → green; full suite + evals.

**Fault injection (spec #2, #3).** Remove the RPC's token fence → old-worker test red (doubles as
proof the fake's AS409 path is load-bearing). Drop `.eq("lease_token", ...)` from the final-status
update → fenced-writer test red.

**Rollback.** Easy pre-merge. Post-merge it is the one increment whose revert changes runtime write
paths (events return to racy MAX+1) — still safe: that is exactly what runs in production today.

### I6 — Gate + merge protocol (no code)

Full sequence: backend suite → evals → Supabase gate → **live-verify the reclaim query shape** (run
the exact `.or_()` reclaim against LOCAL Supabase via a scratch script with seeded rows — the
offline fake cannot prove PostgREST accepts the filter string; see §5) → reviewer fault-injection
pass → apply migration to **deployed** Supabase → confirm deployed old code still healthy
(`/health` + one organize smoke) → merge → auto-deploy → post-deploy smoke: one organize
end-to-end, and Render logs show no `organize_leases_reclaimed` against live runs.

**Rollback.** Revert the merge commit on `dev`; schema stays (harmless, additive).

### Commit boundaries

**Five commits, one per increment I1–I5** (I6 is the merge, not a commit). The spec's Step-9
two-commit grouping (migration / everything-organizer) is too coarse for bisect. If fewer are
wanted: fold I3 into I4 (claim + heartbeat are one story). **Never** fold I2 (the semantic pivot)
or I5 (the churn-heavy one).

## Silent half-work inventory — and the LIVE proof each needs

The category that makes A2 dangerous rather than merely large. Each of these passes a naive test
while doing nothing at all.

| Guard | Half-work mode | Proof it is LIVE, not merely present |
|---|---|---|
| **Heartbeat (I4)** | Task created but never scheduled, or never fires; every *direct-call* renewal test still passes | The barrier-driven blocked-provider test IS the liveness proof — only a *running* beat can observe the replaced token and abort the loop. Keep it barrier-driven, never a direct `_renew_organize_lease` call |
| **Reclaim predicate (I2)** | Fake ignores `.lt`/`.is.null`/`.or_` → all five reclaim tests pass vacuously | Fake-fidelity test, written FIRST in I2: predicates evaluated at update time against the current row |
| **RPC fence (I5)** | Fake's `rpc()` never raises AS409 → the wrapper's lease-lost handling is dead code under test | Fake raises AS409 on a stale token + fidelity test; fault-injection #2 (remove the real fence → test red) proves the test depends on it |
| **The whole reclaim, in production** | PostgREST rejects or mis-parses the `or=` filter → 400 APIError → **swallowed by lifespan's broad `except` (`main.py:85-86`)** → recovery silently no-ops forever = the exact #12 silent drop A2 exists to fix | Offline tests CANNOT prove this. I6's local-Supabase probe of the literal query, plus a post-deploy kill-one-run smoke (deliberately kill an organize mid-run in the zero-traffic window, watch `organize_leases_reclaimed` requeue it) |
| **Reaper (A-III)** | Loop task GC'd, or the first await raises pre-loop, or every iteration errors into the warning log forever | Retained-task pattern + the spec's two-tick injected-clock test + the same deliberate kill-smoke after A-III deploys; periodically check logs for `reap_loop_iteration_failed` |

## What A1 invalidated in the A2 spec

- Step 5's loop snippet `_process_item(client, job_id, user_id, item, lease_token=..., scrape=..., ...)`
  — the signature is now `_process_item(ctx, item) -> bool`. The token becomes an `_ItemContext`
  field; the dataclass's own docstring (`organizer.py:292-296`) says exactly this.
- Step 5's heartbeat wiring snippet **omits the `if processed:` guard** on `_update_job_counts` (now
  `organizer.py:476-477`). Verbatim transcription reintroduces the orphan-counts bug A1 fixed.
  **Merge the snippet with the A1 shape; do not replace.**
- A1's "Interfaces" block (positional `client, job_id, user_id` signatures) is superseded. Baseline
  is 590/7, not 585.

## The single riskiest moment + mitigation

**The A-II merge boundary itself** — the minutes where the migration is applied to deployed
Supabase, the old container still claims organize jobs with NULL `lease_token`/`lock_expires_at`,
and Render overlaps old and new containers on auto-deploy. Three failure modes converge:

1. The **legacy-NULL orphan** — mitigated by the spec's load-bearing legacy branch, pinned by
   `test_legacy_NULL_EXPIRY_processing_row_is_reclaimable`.
2. **Old-code-vs-new-schema** — confirmed safe (additive, nullable, unread).
3. **The `.or_()` filter silently no-oping in real PostgREST while every offline test is green.**
   `now.isoformat()` yields `+00:00`; a mis-encoded `+` in the `or=` query string either 400s (→
   swallowed at boot → recovery never recovers, invisible until the first crash that matters) or
   matches nothing.

**Mitigations:** emit `Z`-suffixed timestamps (`.replace("+00:00", "Z")`); I6's local-Supabase probe
of the literal query; do apply → merge → smoke in one sitting with the deliberate kill-one-run
check immediately after.

## Spec errors found on their own merits (independent of A1)

1. **`complete_trip_run` is DDL scheduled into a "no DDL" PR.** The arc table says A-III ships no
   migration, yet the spec introduces `create or replace function complete_trip_run` there.
   **Resolved:** folded into A-II's migration (additive, uncalled by old code).
2. **`complete_trip_run` failed at first execution, twice.** (a) `p_lease_token text` compared
   against `jobs.lease_token uuid` → `operator does not exist: uuid = text`; plpgsql defers this to
   runtime, so `supabase db reset` alone does NOT catch it — only pgTAP execution tests do. Now
   `uuid`. (b) It inserted `generation_events(trip_id, user_id, …)` — **the table has no `user_id`
   column**. Dropped. **Both fixed in the plan, commit `817021f`.**
3. **`complete_trip_run` lacked `set search_path = ''` and the revoke/grant block** that
   `append_organize_event` correctly has. `supabase db lint` flags mutable search_path on security
   definer, and it is a real privilege gap. **Fixed in `817021f`.**
4. **Two tests are misfiled across the PR boundary.**
   `test_trip_reclaim_clears_the_stale_lease_token` (in Step 1's "organize" group) exercises
   `reclaim_expired_jobs`/`mark_job_done` — that is A-III.
   `test_organize_recovery_respects_recovery_semaphore` (also Step 1) exercises
   `_redispatch_organize` — Step 7, A-III. Writing them in A-II leaves them permanently red inside
   a "green" PR. **Move both to A-III.**
5. **A-II opens one NEW organize gap until A-III lands** — state it in the A-II PR body. Reclaim
   becomes expiry-gated but is still boot-only, so a crash inside the 300s TTL leaves a job
   `processing` until the next boot after expiry; pre-A-II behavior requeued everything at boot.
   The trip-side resurrect/erase races and deploy double-run remain exactly as live as today (no
   regression, no fix). Acceptable at zero traffic with A-III following immediately.
6. **A-III sequencing constraint:** `config_validation.py` + its lifespan placement MUST ship in the
   same PR as the `_fail` token-skip — the skip is what opens the infinite pre-claim-failure loop
   the validator closes. Watch-item: any test entering lifespan via `with TestClient(...)` will now
   need env fixtures, without regressing credential-free module import.

## A-III sketch (branch off A-II's merge; do not deep-plan yet)

1. **`jobs.py`** — token-returning `mark_job_running`; bool-returning fenced `mark_job_done`;
   `_renew_job_lease`; `reclaim_expired_jobs` as an outright rename (verified: only `main.py:38,72`
   plus tests import `recover_inflight_jobs`); docstring fix; `BarrierClient` + fidelity test; the
   four interleavings plus the two misfiled tests from §6.4.
2. **`runner.py`** — thread the token; `_fail` skips `mark_job_done` when tokenless; both terminal
   paths route through `complete_trip_run`; trip heartbeat + `lease_lost` gates before the save
   block and the terminal `_set_status`.
3. **`config_validation.py`** + lifespan placement (same PR, per §6.6).
4. **`main.py`** — `_spawn`; `_redispatch_organize` under `_RECOVERY_SEM`; `_reap_loop` (two-tick
   injected-clock test); lifespan shutdown half (`try: yield / finally: cancel`).

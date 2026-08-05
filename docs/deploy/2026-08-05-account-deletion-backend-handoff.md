# Account deletion — backend deploy handoff (2026-08-05)

> PR #61 merged as `d47842a` and deployed **dark** on Render. Migrations applied to prod and
> verified; the gate is proven shut on the live service. Go-live is **held** behind four items.
> Backend review + rollout by Shaun; engine + frontend by Zhi Hao.
>
> Companion to `2026-08-03-entitlements-deploy-handoff.md`. The section below the line is written
> as a paste-ready kickstart for Zhi Hao's next Claude Code session.

## State at a glance

| | |
|---|---|
| PR | #61, squash-merged as `d47842a` on `dev` |
| Migrations | `20260805000000` + `20260805010000` applied to prod, ledger repaired, zero drift |
| Deploy | `astrail-backend` + `astrail-telegram-ingest` both cleared `assert_schema` preDeploy, live |
| Gate | `_DELETION_EXECUTION_READY=False` — **proven shut live** (control 200, both POSTs 503) |
| RESEND | unset in Render, **deliberately** — it is a second fail-closed lock, not a config chore |
| Board | `Both P1: account deletion` → **In progress** (not Done — no user can delete an account yet) |
| Review | 3 passes, adjudicated → PR #61 comment `#issuecomment-5186016827` |

## Verification performed (2026-08-05)

Recorded because several of these are reusable methods, not one-off checks.

- **Verified the objects, not the ledger.** `supabase migration repair --status applied` writes the
  history row and does **not** execute SQL, so a repair without an apply leaves a lying ledger.
  Confirmed directly: 3 `users` columns (all 6 rows defaulted `active`, no stray timestamps),
  `account_deletion_log` (RLS on, 0 policies, anon/authenticated hold no SELECT/INSERT), all 3 RPCs
  (`SECURITY DEFINER`, `search_path=""`, anon/authenticated denied, service_role only), sweep index.
- **The gate-blind migration.** `20260804000000_reserve_replay_on_exhausted` is RPC-body-only, so
  `assert_schema` is structurally blind to it and the deploy would go green either way. Confirmed
  applied by reading `pg_get_functiondef`, not by trusting the gate.
- **PostgREST privilege pin, verified for the first time.** All three RPCs return `401 / 42501` to an
  anon client using a *valid* uuid — denial precedes the function body, so the uuid never matters.
  Probe safely with an **invalid** uuid: if the pin holds you get `42501`, and if it somehow didn't,
  the uuid cast fails `22P02` before the body runs, so the probe can never mutate a row.
- **`22P02` confirmed** for `claim_account_for_deletion` — the exact answer `assert_schema` requires.
  Had it differed, every future deploy of **both** services would abort (fail-closed but stuck).
- **Gate proven shut with a positive control.** Unauthenticated probes cannot prove this: auth runs
  before the gate, so everything returns 401 either way. The check that works uses a real user JWT
  plus the deliberately-ungated `GET /account/deletion/status` as a control — it must return 200,
  which establishes that the token, auth, and routing all work, and *that* is what makes the 503s
  attributable to `_DELETION_EXECUTION_READY`. Result: control 200
  (`{"account_status":"active","deletion_scheduled_for":null}` — the deployed code reading the new
  columns, i.e. end-to-end schema↔code integration), both POSTs 503 `deletion_unavailable`. Throwaway
  user provisioned and deleted per `backend/scripts/smoke_http.py::_provision_user`; zero residue.

## Operational gotchas worth not re-deriving

- **`supabase db query -f` sometimes rejects multi-statement files** (`cannot insert multiple
  commands into a prepared statement`). Do **not** hand-split a file lacking `IF NOT EXISTS` — a
  partial apply has no clean retry. Use the dashboard SQL editor, which submits the file as one
  transaction. A clean rejection is harmless: the file is atomic, so the DB is byte-identical.
- **`set lock_timeout` must live inside the migration file.** Issued as its own `db query` call it is
  a different session and does nothing.
- **A single-key Render env-var PUT does not reliably trigger a redeploy**, and a process only picks
  up new env on restart. The dashboard showing a value ≠ the container having it.
- **`autoDeployTrigger: checksPass` held the rollout** until CI went green on the new `dev` commit —
  the merge did not start a build. `assert_schema` was the second line of defence, not the only one.

---

# Kickstart for Zhi Hao

👋 **Zhi Hao — account-deletion backend is MERGED and DEPLOYED DARK. Your turn.** Paste into a fresh Claude Code session on the astrail repo.

## Step 0 — read the full review first, before touching anything

Shaun's confirming pass is posted as a comment on PR #61. **Read it in full before you start on the fixes** — it has the file-level detail, the failure scenarios, and the reasoning behind each severity call that this summary compresses:

👉 https://github.com/MalaysiaKaki/astrail/pull/61#issuecomment-5186016827

Or pull it straight into your session:

```bash
gh pr view 61 --json comments --jq '.comments[-1].body'
```

~11k chars, three review passes. It explains *why* Codex's DO-NOT-MERGE didn't block the merge but does gate the flip. Don't work from the summary below alone — the comment is the authoritative artifact.

## What changed while you were away

PR #61 is **merged** (`d47842a` on `dev`) and **live on Render** — both `astrail-backend` and the `astrail-telegram-ingest` worker cleared the `assert_schema` preDeploy. It shipped in the correct schema-first order:

- **Both migrations applied to prod Supabase** (`20260805000000` + `20260805010000`), ledger repaired, **zero drift**. Don't re-apply them.
- Verified against the DB rather than the ledger — `migration repair` writes history without executing SQL, so a repair-without-apply would have left a lying ledger.
- **PostgREST pin verified live**: all three RPCs return `401 / 42501` to an anon client using a *valid* uuid.
- **Gate proven SHUT on the live service** with a real user JWT plus a positive control: ungated `GET /account/deletion/status` → **200**, both POSTs → **503 `deletion_unavailable`**.
- Post-deploy state clean: 0 log rows, 0 non-active users, 6 users untouched.

## The review — three passes, and they disagreed

`astrail-reviewer`/fable (engine) → **SHIP**. `astrail-reviewer`/opus (SQL + deploy gate) → **APPLY WITH CAVEATS**. Codex cross-model → **DO-NOT-MERGE, 3/10**.

Adjudicated by sending Codex's unique findings back to the reviewer that read the engine: **1 confirmed, 2 overstated, 1 wrong.** Codex's score conflated the *gate flip* with the *merge* — everything it found is unreachable while `_DELETION_EXECUTION_READY=False`.

## Your lane — 4 things block the gate flip

Yours because you wrote the engine. Do NOT flip `_DELETION_EXECUTION_READY` until all four land and Shaun re-reviews.

1. **F1 — stale log row eats a re-requested grace.** `_mark_purged`/`_backoff` update the log row with **no `outcome` guard**. Cancel + immediate re-request landing in the ms between the sweep's select and its claim → the stale row forces the account back to `deleting` and it hard-deletes on the OLD schedule, skipping the fresh 7 days. **Found independently by two models.** Fix: `.eq("outcome","pending")` and abort when the update matches nothing. Trade-off to weigh — with that fix the account sits `deleting` until the new row comes due, so a second cancel 409s meanwhile.
2. **F2 — dual sweeper double-sends the completion email.** `_mark_completed`'s terminal write is unconditional by id. Data-safe (the second auth-delete 404s = success) but both racers email. Fix: CAS-send-once guarded on `.eq("outcome","deleting")`.
3. **Durable scheduled-notice email.** *The one Codex caught that both Claude passes missed.* That "cancel by {date}" mail **replaced reauthentication** in your design — yet lookup failure, timeout, and a Resend 500 are all swallowed while the endpoint still 200s, and **nothing is written to `account_deletion_log`** (no `notified_at`, `last_error` untouched). Only signal is a type-only log line. For the stolen-session case the email exists for, a transient failure is a 7-day silent countdown nobody can notice. Fix: stamp the log row on send failure and let the sweep retry while `outcome='pending'` and unnotified — the retry machinery already exists.
4. **Two regression tests**, for F1 and F2. Codex claimed the fakes are why these stay green; that's wrong — the `_Query` update fake genuinely applies its eq/in predicates, so an F1 test is writable *today*: seed the log row `cancelled` + users `pending_deletion` + `claim=True`, call `_erase_pass_a`, assert the row stays `cancelled`. Fails now, passes after the fix.

**Recommended, not blocking:** add `and scheduled_for <= now()` inside `claim_account_for_deletion` so Postgres time decides the point of no return. Grace expiry currently uses the process clock and the claim RPC never rechecks — a forward-skewed host shortens the promised cancel window by exactly the skew. Overstated as a blocker (the promise is date-granular, so it needs *hours* of skew), but it's two words of SQL.

## Also yours — the frontend half

Delete-card and honest `/privacy` copy are still on `zh` behind `NEXT_PUBLIC_DELETION_ENABLED`. **Full go-live needs the frontend too** — the backend can sit deployed dark indefinitely, but no user can delete an account until your side ships.

Heads-up for when `zh` merges: its `assert_schema` manifest requires the 7 hotel-hub-map columns from `20260804120000`. Already applied in prod (verified), so that gate will pass.

## Go-live sequence — joint, still held

**RESEND is a second, independent lock — not a config chore.** `main.py` checks `_DELETION_EXECUTION_READY` at :772 and `resend_configured()` at :776, both before any DB round-trip, and the second **fails closed**: flip execution-ready without RESEND and the endpoint refuses to start a grace it can't warn the user about. Nothing is set in Render yet, deliberately.

Order when you go live, together:

1. Set `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (`Astrail <no-reply@send.astrail.xyz>`) in the Render dashboard
2. **Verify the running process actually has them** — a single-key Render env-var PUT does not reliably trigger a redeploy, and a process only picks up new env on restart
3. The 4 fixes above + Shaun's re-review
4. Flip `_DELETION_EXECUTION_READY=True` — **a code commit + redeploy, not a dashboard toggle**
5. Live `/qa` E2E → frontend flag + `/privacy`

**Don't do solo:** flip the gate, set the RESEND secret, or re-run the migrations. Board card `Both P1: account deletion` is now **In progress** and carries this list.

## Baselines to hold

Backend **1565 pass / 12 skip**; pgTAP **20 files / 762 tests PASS**; evals 49, anchor 6229.0.

Operational gotcha for anyone touching prod SQL: `supabase db query -f` sometimes rejects multi-statement files (`cannot insert multiple commands into a prepared statement`). If that happens, **do not hand-split** a file lacking `IF NOT EXISTS` — a partial apply has no clean retry. Use the dashboard SQL editor.

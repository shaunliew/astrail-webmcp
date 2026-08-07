# Account-deletion go-live blockers — F1 / F2 / C2 / C5 (handoff to Shaun)

**Date:** 2026-08-07 · **Author:** Zhi Hao (frontend/owner) · **Owner to action:** Shaun (backend + Supabase + prod)
**Branch:** `dev` (these commits are ON `dev`, which no longer deploys — production is `main`).
**Blocks:** board card `Both P1: account deletion`, switches 1 & 2.

## What this is

The four go-live blockers from **PR #61**'s backend-owner confirming pass
(`issuecomment-5186016827`), built + reviewed + tested on `dev`. The delete engine stays
**GATED OFF** (`_DELETION_EXECUTION_READY=False`) — nothing here runs on the live service until
you flip it. This clears the *code* side of switches 1 & 2; the switches themselves are still
yours.

| Fix | What | Commit |
|---|---|---|
| **F1** | Guard the id-only log writes (`_mark_purged`/`_backoff`/`_mark_failed`) on the expected `outcome`, abort on no-match — a cancel+re-request race can no longer resurrect a cancelled deletion / bypass the fresh 7-day grace. +2 regression tests. | `0cce53a` |
| **F2** | CAS-send-once on `_mark_completed` (`.eq("outcome","deleting")` + send only if matched) — two overlapping sweepers no longer double-send the completion email. +1 regression test. | `695ac20` |
| **C2** | Durable + visible scheduled-notice: new `notified_at` column, `_send_email` returns bool and logs the real Resend status+body (secret-safe), request stamps on success, **sweep re-sends unnotified pending rows**. +7 tests. | `7a7d3a5` |
| **C5** | `claim_account_for_deletion` also requires `deletion_scheduled_for <= now()` — Postgres time (not a stale row / process clock) decides the point of no return. Closes F1 at the root. +pgTAP +tests. | `5a33436` |
| Task 1 | sign-in OTP sender copy `astrail.app` → `astrail.xyz` (parked domain → verified sender). Frontend, my lane. | `6d97732` |

## ⚠️ Schema-first — apply BOTH new migrations to prod BEFORE promoting `dev`→`main`

`assert_schema` (the preDeploy gate) **now hard-requires the `notified_at` column**
(`REQUIRED_SCHEMA["account_deletion_log"]`). So if `dev`→`main` promotes the code before the
migration is applied to prod, the Render deploy **correctly aborts at the gate** (fail-safe, but a
stuck deploy). Order:

1. **Apply migration `20260807000000_account_deletion_notice_durability.sql`** — `alter table
   account_deletion_log add column if not exists notified_at timestamptz` (+ `set lock_timeout='3s'`
   + comment). Metadata-only, sub-ms on a tiny/new table, no rewrite.
2. **Apply migration `20260807000100_account_deletion_claim_scheduled_guard.sql`** — `create or
   replace function claim_account_for_deletion` adding the `deletion_scheduled_for <= now()`
   conjunct + re-issued revoke/grant. The two migrations are independent (either order works), but
   apply in timestamp order.
3. **Run pgTAP** `019_account_deletion.sql` (now 28 assertions incl. the `notified_at` column) +
   `020_claim_account_for_deletion.sql` (now 12 assertions incl. the C5 future-scheduled-cannot-claim
   proof).
4. **Then** promote `dev`→`main` (the code deploy).

> **Multi-statement caveat (per PR #61's escape-hatch note).** `20260807000000` is 3 statements
> (`set lock_timeout` + `alter` + `comment`). If you apply via `supabase db query --linked -f` and
> it rejects a multi-statement file (`cannot insert multiple commands into a prepared statement`),
> apply the file through the **Supabase dashboard SQL editor** (one transaction) — do NOT hand-split
> it. `20260807000100` is `create or replace` + revoke/grant (all idempotent), forgiving either way.
> `supabase db push` (the migration runner) also handles both cleanly — that's what validated them
> locally (`supabase db reset` → both applied, exit 0). Your call on mechanism; the ordering + the
> gate dependency are the load-bearing parts.

If the claim RPC 404s as `PGRST202` right after applying, that's the schema cache, not a failed
migration: `notify pgrst, 'reload schema';`.

## Verification (all green, local)

- **Backend suite:** `uv run pytest -q` → **1860 passed, 13 skipped**.
- **pgTAP (real local Postgres, `supabase db reset` + `supabase test db`):** Files=22, **Tests=821,
  Result: PASS** — incl. `019 ok` (28) and `020 ok` (12).
- **Frontend (CI-equivalent `npm ci` + `npm test` + `tsc --noEmit`):** tsc clean, **563 passed /
  77 files**.
- **Reviews:** `astrail-reviewer`/fable (SHIP-WITH-NITS) + gstack `/review` Codex cross-model (2×P1, 3×P2) — **all P1/P2 + both Important findings folded** (allowlisted Resend error logging so no recipient can leak via the body; the `notified_at` stamp bound to the originating row's `scheduled_for`; NULL-recipient skip; one shared send+stamp timeout budget; this handoff committed; rollback down-scripts authored). One P2 documented-and-deferred below.

### Rollback
Down-scripts exist for both new migrations: `supabase/migrations/rollback/20260807000000_down.sql`
(drops `notified_at`) and `.../20260807000100_down.sql`. **C5's rollback is NOT `drop function`** —
it re-applies the original `20260805010000` claim body (dropping it bricks the assert_schema
liveness probe + strips the claim). Both carry the assert_schema-coupling warning and apply via
`supabase db query --linked -f` (the S3 correction — no psql).

### Known residual (accepted, not a blocker)
The scheduled notice is **send-then-mark**, so two narrow races remain by design: (1) the request-time
send and a sweep tick can both send within the stamp-write window → a duplicate "cancel by {date}"
notice; (2) a cancel landing between the sweep's select and its send → one notice arriving just after
cancellation. Both are preferred over the alternative (mark-then-send loses a notice on a send
failure — worse for a safety-net email). A per-notice claim/lease would close them; deferred as P2
given beta scale (few users, 120s ticks) and non-security impact.

## Go-live switches — still HELD for you (unchanged by this batch)

1. Set `RESEND_API_KEY` / `RESEND_FROM_EMAIL` in Render (proven value; the C2 visibility work means a
   wrong sender is now *loud*, not silent).
2. Flip `_DELETION_EXECUTION_READY=True` (a code commit + redeploy).
3. Live `/qa` → then the frontend flag `NEXT_PUBLIC_DELETION_ENABLED` (Zhi Hao) + honest `/privacy`.

**Zhi Hao will NOT** set `NEXT_PUBLIC_DELETION_ENABLED`, touch `_DELETION_EXECUTION_READY` /
`_CLEAR_RECONCILIATION_READY`, edit `render.yaml` / Render env, or `supabase db push` — those are yours.

## Still-open doc follow-ups from PR #61 (not code — flagging so they aren't lost)

- **S5:** no code path writes `account_status` except the three RPCs, so a terminally-`failed` /
  stuck-`deleting` row has no route back. Document a manual-SQL recovery in the runbook before
  go-live. (Not addressed here — needs your runbook.)
- **S3:** the rollback files say `psql -1`; the team has no psql. Change to
  `supabase db query --linked -f`. (Rollback-doc fix, your lane.)

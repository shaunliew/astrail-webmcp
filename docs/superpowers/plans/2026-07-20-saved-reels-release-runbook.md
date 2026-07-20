# Saved Reels release runbook (Arcs A + B)

> The ordered, human-executed sequence for shipping Arcs A and B to the deployed stack.
> **`autoDeploy` is now `false`** (`render.yaml`) — merging no longer deploys, which is what makes
> this sequence executable at all. Read that file's comment for why.

## Why this document exists

A cross-model review found the deploy protocol was **not executable as written**. The standard
instruction — *apply migrations → confirm the currently-deployed code still works → then merge* —
assumes merge and deploy are separate events. With `autoDeploy: true` they were the same event, so
there was no gap to verify in. Worse, two of these migrations are actively incompatible with the
currently-running code, in opposite directions.

`/health` performs **no schema check**. A code-first deploy against the old schema stays **green**
while jobs silently fail to start. Do not treat a green health check as evidence the release landed.

## The seven migrations, in stamp order

`20260720150000` was added late by the itinerary-fencing fix — if you were told "six", this is the
seventh.

| # | Migration | Arc | Hazard |
|---|---|---|---|
| 1 | `20260720090000_job_leases` | A | additive |
| 2 | `20260720100000_reel_place_mentions_user_scope` | A | **⛔ MAINTENANCE WINDOW** — drops the `(reel_cache_id, place_id)` conflict key the deployed upsert targets. Old and new code cannot both work against either schema. Down-migration: `rollback/20260720100000_down.sql` |
| 3 | `20260720110000_geocode_country_cache` | A | additive |
| 4 | `20260720120000_saved_reels_cache_signal_v2` | B | cosmetic skew — cards read "Not analyzed yet" until the code lands |
| 5 | `20260720130000_organize_job_error_codes` | B | **both orderings 500** — see below |
| 6 | `20260720140000_drop_superseded_reel_quota_functions` | B | safe — verified zero runtime callers on `dev` |
| 7 | `20260720150000_fenced_trip_itinerary_replace` | A | additive — new `replace_trip_itinerary` RPC |

### The two that bite

**#2 — user-scoping.** Fans one mention row out to N users, which requires dropping the primary key
the deployed `_persist_mention` upsert names in its `on_conflict`. There is no ordering that keeps
both code versions working; the expand/contract split was attempted and is structurally impossible.
Hence the window. Zero production traffic makes it cheap, but it is a deliberate human action.

**#5 — SQLSTATE.** Deployed code (`dev:backend/organizer.py:78-81`) matches `exc.code == "P0001"`.
The migration makes the function raise `AS409`/`AS404`/`AS422`, and the new code maps only those.
So **either** ordering returns 500 on every 409 and 404 on the organize path, for the length of the
window. With `autoDeploy: false` the window is now yours to control rather than however long you
take to notice.

## Sequence

```
0. PRE-FLIGHT
   - confirm no organize or trip-generation job is in flight
   - note the current deploy SHA so you can roll back to it
   - `supabase db dump` or take a PITR marker — #2 is destructive

1. SUSPEND
   - pause the Render service (this is the maintenance window)
   - traffic is zero today, but suspension is what makes #2 safe, not the traffic level

2. APPLY MIGRATIONS 1-7 IN STAMP ORDER
   - stop at the first failure; do not continue past an error
   - after #2, spot-check that reel_place_mentions rows carry user_id

3. DEPLOY
   - merge PR #44 (Arc A), then PR #45 (Arc B) — #45 is stacked on #44
   - trigger the Render deploy MANUALLY (autoDeploy is off)
   - wait for the deploy to go live before resuming

4. RESUME + SMOKE
   - unpause the service
   - `/health` green is necessary but NOT sufficient — it does not check schema
   - duplicate-organize an already-active Reel  → expect 409, NOT 500   (proves #5 landed)
   - 4× POST /saved-reels within a minute       → expect the 4th to 429  (proves the burst limit)
   - organize one Reel end-to-end               → places persist, pins render
   - confirm a second user cannot see the first user's pins  (proves #2 landed)

5. IF ANYTHING FAILS
   - re-suspend before investigating; a half-migrated schema with live code is the worst state
   - #2's rollback is `rollback/20260720100000_down.sql` — but see the warning below
```

## ⚠️ The rollback is not currently safe

A cross-model review found that `rollback/20260720100000_down.sql` **restores the unscoped join** —
so rolling back #2 re-opens the cross-user evidence leak that #2 exists to close. It must be made
fail-closed (retain the `user_id` equality in both the predicate and the view; leave
`user_id IS NULL` rows hidden rather than visible) **before** this release is attempted, or you have
no safe abort path.

**Do not run step 2 until that fix has landed.**

## After the release

Re-enabling `autoDeploy` requires a real pre-deploy migration gate — a Render `preDeployCommand`
running `supabase migration up`, or a startup check that fails `/health` on schema drift. Until one
exists, deploys stay manual. The trigger is recorded in `render.yaml` beside the setting.

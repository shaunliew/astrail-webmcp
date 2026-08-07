# Runbook: manual account deletion (beta window)

During the beta the self-serve deletion engine is **gated OFF** (`_DELETION_EXECUTION_READY=False`
in `backend/main.py`), so account deletion is **manual**. The privacy policy
(`frontend/app/privacy/page.tsx`) promises: email us, we action erasure **within 30 days**, and it
**erases your remembered preferences (including your mem0 memory)**. This runbook is how you keep
that promise.

## Do NOT delete from the Supabase dashboard

Deleting `auth.users` in the dashboard cascades every Postgres row (the FK chain is complete) but
does **nothing** to mem0. The user's preference text stays in mem0 forever, silently breaking the
"erases your mem0 memory" promise. There is no DB→mem0 hook. **Always use the script below** — it
purges mem0 first, then does the same auth cascade the dashboard would.

## Steps

1. **Get the user_id.** From the deletion-request email, find the account in the Supabase dashboard
   (Authentication → Users) and copy the user's UUID. (Or pass `--email` and let the script resolve
   it; `--user-id` is the unambiguous path.)

2. **Dry-run first** (touches nothing — prints the current status + the plan):
   ```bash
   cd backend
   uv run --env-file .env python -m scripts.delete_account --user-id <uuid> --dry-run
   ```

3. **Execute.** Without `--yes` the script makes you retype the user_id to confirm:
   ```bash
   uv run --env-file .env python -m scripts.delete_account --user-id <uuid>
   ```
   Order is **mem0 purge (confirmed-or-abort) → auth cascade**. If mem0 cannot be confirmed empty
   the script raises and never touches auth, so a partial state is safe to re-run (idempotent).

4. **Record it.** Note the date actioned against the request so the 30-day window is auditable.

## Why mem0 first

`auth.users` delete cascades all Postgres rows immediately. If auth went first, the account record
that drives the purge would be gone while the mem0 `user_id` still resolves — orphaning the memory.
Purging mem0 first (and requiring confirmation) means the irreversible cascade only runs once the
memory is provably gone. This is the same ordering the automated two-pass engine uses
(`backend/deletion_engine.py`); the script reuses that engine's primitives rather than reimplementing
them.

## Requirements

Run from `backend/` with the service env (`--env-file .env`): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` (the admin delete needs service-role), and `MEM0_API_KEY` (unset mem0 =
the purge cannot be confirmed and the script aborts before deleting — that is the safe failure).

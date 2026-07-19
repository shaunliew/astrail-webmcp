"""Fail-fast validation of the secrets the app cannot work without.

Called from `lifespan` BEFORE its broad `try` — placement is load-bearing. Inside that try,
`except Exception: pass` would swallow the error and the app would boot broken, which is the
exact opposite of fail-fast. The try must keep swallowing *DB* blips (a boot-time Supabase
blip should degrade, not down the app); it must not swallow *config* errors.

This closes the loop that `runner._fail`'s token skip opens. A run that dies before
`mark_job_running` returns holds no lease token and must not write the job's terminal state,
so the row is left to the reaper. For a transient blip that is right — the next attempt
succeeds. For a DETERMINISTIC pre-claim failure (a missing secret raising at
`os.environ["APIFY_TOKEN"]`) it is not: the reaper redispatches every pending row each tick
and trip-side `attempt_count` is never incremented, so nothing caps the retries. Refusing to
boot without the secrets is the cheapest close.

DEFERRED, with a trigger: a *transient* pre-claim failure still retries indefinitely, which
is the intended #12 restart-with-cache-reuse behaviour. Add an attempt cap at claim the first
time a job is seen redispatching more than ~10 times — that also requires making
`attempt_count` incrementable.
"""
from __future__ import annotations

import os

# ⚠ SUPABASE_JWT_SECRET is deliberately NOT here. `.claude/docs/ENV.md` records that it was
# REMOVED: the project verifies asymmetric ES256 tokens via JWKS (derived from SUPABASE_URL),
# not a shared HS256 secret. Requiring it would stop the app booting over a secret the project
# intentionally dropped — a validator causing the outage it exists to prevent.
REQUIRED_SECRETS = (
    "OPENAI_API_KEY", "APIFY_TOKEN",
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",   # URL doubles as the JWKS source
    "MAPBOX_SECRET_TOKEN",
)


def validate_required_secrets(env=None) -> None:
    """Raise RuntimeError naming EVERY missing var. Config only — NO connectivity checks.

    All-at-once because a validator that failed on the first missing name turns a fresh
    deploy into a fix-one-secret-per-restart loop. Blank and whitespace-only count as missing:
    on Render an unset var and one set to "" arrive identically, and a whitespace-only paste
    is the classic dashboard mistake.

    The error names variables, never values — a validator that echoed what it found would put
    a live credential in the boot log.
    """
    env = os.environ if env is None else env
    missing = [name for name in REQUIRED_SECRETS if not (env.get(name) or "").strip()]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

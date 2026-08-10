# Live-ops backend handoff — Shaun (2026-08-10)

> **Owner:** Shaun (FastAPI, Render, backend env) · **Prepared by:** Workstream A
> **Status:** code path inspected; Render configuration and Sentry delivery are **UNVERIFIED**.
> This note requests backend-owner action only. It does not authorize a deploy, env change, or production test.

## Stack check

Checked `.claude/docs/STACK.md` before acting. Its observability row says Sentry was removed on
2026-07-19 and may return only with a `before_send` URL scrubber because SSE URLs historically carried
`?token=<JWT>`. The current code has moved past that prose: `sentry-sdk>=2.0.0` is already in
`backend/pyproject.toml`, `backend/observability.py` has a fail-closed scrubber, and `backend/main.py`
initializes it. **Do not add a second integration.** Reconcile the stale STACK/ENV wording when the
backend owner verifies the current implementation.

## Ask 1 — arm and verify the existing backend Sentry path

1. Review `backend/observability.py` and `backend/test_observability.py`, especially removal of request
   headers/cookies/body/query strings and recursive token/key redaction.
2. In the existing backend Sentry project, create/copy the DSN. Set `SENTRY_DSN` and optionally
   `SENTRY_ENVIRONMENT=production` on **`astrail-backend` only** in Render. Do not copy the variable to
   unrelated services by habit.
3. Restart/redeploy the existing service so the process reads the env. Do not create another service
   against production Supabase and do not change `numInstances: 1`.
4. Induce one controlled, non-mutating exception through a backend-owner-approved verification seam.
   Confirm the Sentry event arrives, has the expected environment/release, and contains no query string,
   Authorization/Cookie header, request body, JWT, Supabase key, Mapbox key, Apify key, Resend key, or DSN password.
5. Remove any temporary verification seam before considering the task complete.

Completion evidence: event link/id + UTC timestamp + scrub inspection + deployed commit SHA. Until that
exists, backend Sentry remains **UNVERIFIED / shipped dormant**.

## Ask 2 — restore application INFO logs

The production command in `Dockerfile` starts Uvicorn without `--log-config`. Python's app logger is
`logging.getLogger(__name__)`; its `logger.info(...)` records are therefore not an operationally reliable
signal even though Uvicorn access logs appear. This hides signals including `sentry_initialised` and healthy
background-loop state.

Please add an explicit Uvicorn/Python logging config in Shaun's backend lane that:

- emits application INFO logs to stdout in production;
- preserves `uvicorn.error` and `uvicorn.access` levels;
- keeps `backend/log_redaction.py` attached so `?token=` cannot return to access logs;
- avoids duplicate handlers/duplicate lines;
- has a test proving a named app logger's INFO record is emitted and a token-bearing access URL is redacted;
- is verified in the existing Render service logs after rollout.

This is deliberately a handoff, not a backend edit. No Render, Supabase, database, seat, or deployment action
was taken by Workstream A.

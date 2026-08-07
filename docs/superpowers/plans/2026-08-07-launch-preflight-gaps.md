# Launch pre-flight gap fixes — plan (branch `fix/launch-preflight-gaps`, base `dev`)

Context: pre-launch re-audit of `dev` (2026-08-07) found ONE genuine P1 + a P2 cluster. This branch fixes
the code-side items; PostHog analytics + OG image are deferred (need a key/asset/product decision). Hold for
ZH's merge gate — do NOT push/merge. Base = `dev` (the launch branch).

Locked decisions: (1) Monitoring = Sentry-in-code + `before_send` scrubber, dormant unless `SENTRY_DSN` set.
(2) Scope = code-only now, defer PostHog + OG. (3) Merge = branch + hold for ZH.

Guardrails to honor: SSE termination contract, guardrail #3 (partial failure still renders), #11 (untrusted
reel content), write-through caches, no requirements.txt, schema parity (Pydantic↔TS↔SQL) if any schema moves.

---

## Task 1 — [P1] Error monitoring: Sentry in code + PII scrubber (dormant)

WHY: failures are stdout-only today; nobody is paged (slide 8 "Logging & Monitoring"). Sentry was removed under
ISSUES-B1 specifically over **default request-URL capture** (`backend/.env.example:108`), so re-adding it MUST
ship the scrubber that closes that hole, and stay OFF unless a DSN is provided.

- Re-add `sentry-sdk` to `backend/pyproject.toml` (drop the ISSUES-B1 removal comment; `uv lock`).
- New `backend/observability.py`: `init_sentry()` — no-op unless `SENTRY_DSN` env is set (mirror the Resend
  dormant pattern). Configure: `send_default_pii=False`, low `traces_sample_rate` (0 or 0.0 — errors only, no
  perf tracing), `environment` from an env var, and a `before_send`/`before_breadcrumb` that:
  - strips the query string from `request.url`/`transaction`/breadcrumb URLs (reuse the regex/logic in
    `log_redaction.TokenRedactionFilter`, `backend/log_redaction.py:36`, so redaction is defined once),
  - drops `request.headers` Authorization/cookie and any `?token=` value,
  - is unit-tested to prove a `?token=SECRET` URL never survives into the outgoing event.
- Call `init_sentry()` in `main.py` lifespan BEFORE the reaper starts (alongside `_install_log_redaction()`).
  Keep the FastAPI integration but rely on the scrubber (do NOT enable request-body capture).
- Wire explicit `capture_exception` at the load-bearing except-blocks that currently only `logger.warning`:
  `pipeline/runner.py` run_generation broad except (the `_fail` site), `main.py` `_reap_loop` + deletion sweep
  except-blocks, and the FastAPI global handler in `api/errors.py`. (These already log; add capture beside it.)
- Config surface: add `SENTRY_DSN` (+ `SENTRY_ENVIRONMENT`) to `.env.example` and both `backend/.env.example`
  and `render.yaml` (`sync:false`, commented "optional; enables error monitoring"). Add to
  `config_validation` as OPTIONAL (never fatal if unset).
- Tests: (a) `before_send` strips token/URL/auth header; (b) `init_sentry()` is a no-op with no DSN (no network,
  no client); (c) a `_fail`/handler path calls `capture_exception` when a client is configured (mock transport).

Risk: re-introducing the very PII leak it was removed for. Mitigation = the scrubber + `send_default_pii=False`
+ a test that fails if a token survives. Acceptance: suite green; dormant with no DSN; token never leaves.

## Task 2 — [P2] Frontend tests + typecheck as a CI merge gate

WHY: `render.yaml` auto-deploys on `checksPass`, but only backend pytest + pgTAP run on PRs; 555 frontend
tests + tsc gate nothing → a red frontend build can ship.

- New `.github/workflows/frontend-tests.yml`: on `pull_request` + push to `main`/`dev`, `npm ci` then
  `npm test` (vitest run) and `npx tsc --noEmit`. Node version pinned to match the repo.
- Fold the backend P3 lint gap in: add a `ruff check` step to `.github/workflows/backend-tests.yml`.
- Note in the PR body that branch-protection "required checks" must be toggled in GitHub settings (dashboard,
  not code) for the gate to actually block merges.

Risk: low. Acceptance: workflow validates + passes locally (`npm test`, `tsc --noEmit`, `ruff check` green).

## Task 3 — [DEFERRED to post-launch fast-follow, 2026-08-07]

DEFERRED per ZH after a Codex xhigh review flagged it as the highest-risk change to make in launch week.
Codex corrections to carry into the fast-follow: (a) the 300s lease is a RENEWABLE ownership lease, NOT a
pipeline deadline — do not derive budgets from it; use realistic per-stage durations. (b) Do NOT add
independent per-stage `wait_for` on top of the existing `_abort_when_lease_lost` cancellation — that risks
NESTED cancellation; wrap ONLY the extract call and leave enrichment under the existing lease-loss owner.
(c) Before building, verify the Agents SDK `run.py` does not swallow `CancelledError` (`except BaseException`)
so the timeout actually aborts the OpenAI/web-search call. Rationale for deferral: hung-extract is rare and the
300s lease reaper already re-dispatches; not worth destabilizing the core pipeline pre-launch.

### (original Task 3 spec, kept for the fast-follow)
## ~~Task 3 — [P2] Wall-clock timeout on the Agents-SDK runs (extract is the priority)~~

WHY: `max_turns` bounds turn count, not time; `extract_places` (WebSearchTool loop, `place_extractor.py:287`)
runs in the scrape+extract phase with NO `wait_for` and no lease-race, so a hung upstream parks a worker until
the 300s lease (throughput + `unexpected bills`, slide 5).

- Wrap each `Runner.run` in `asyncio.wait_for` with a per-stage budget UNDER the 300s lease TTL: extract
  ~120s (priority), narrator/restaurant/hotel_translate ~60s. Budgets as named constants.
- On `asyncio.TimeoutError`: extract → treat as a clean no-result → `_fail("extraction timed out")` (same
  terminal-result path the smoke test exercised, so the SSE stream still ends). Enrichment stages → degrade to
  the existing partial-failure `warning` path (guardrail #3), never crash the run.
- Check `lease_lost` around the extract gather (reliability audit: not checked until after extract today).
- Tests: a stubbed slow `Runner.run` (sleeps past the budget) → extract yields the terminal `_fail` result;
  an enrichment stage timeout → `saved_with_gaps`, itinerary still persists + terminal result emitted.

Risk: HIGHEST of the batch — a wrong budget or cancellation semantics could abort healthy runs or leak a
half-cancelled Runner. This is the task most worth Codex scrutiny (cancellation correctness, budget vs lease,
does `wait_for` actually cancel the underlying OpenAI HTTP call). Acceptance: existing pipeline tests still
green + new timeout tests pass; no reduction in successful-run behavior.

## Task 4 — [P2] Combined account-deletion operator runbook + script

WHY: during the gated-off deletion window, the only live path is manual; deleting via the Supabase dashboard
orphans mem0 PII and silently breaks the privacy promise ("erases your mem0 memory").

- CODEX CORRECTION: the repo already has a crash-safe TWO-PASS deletion engine (`deletion_engine.py`); a
  hand-rolled one-pass script would be WEAKER. The operator script must REUSE the engine's existing functions
  (the same `purge_account_memory` + auth-cascade path the engine drives), not reimplement a one-pass version.
- New `backend/scripts/delete_account.py`: given a user_id (or email→id lookup), invoke the existing engine
  path — `erasure.purge_account_memory(client, mem0, user_id)` THEN the same auth-cascade delete the engine
  uses (`client.auth.admin.delete_user(user_id, should_soft_delete=False)`). Idempotent, `--dry-run`, explicit
  confirmation prompt, structured output. Reuse `erasure`/`memory_clear`/`deletion_engine` code (do NOT reimplement).
- Short runbook `docs/runbooks/account-deletion.md` (or `.claude/docs/`): the manual 30-day process, the exact
  command, and the ordering rationale (mem0 first, then auth cascade).

Risk: low (operator tooling, off the request path). Acceptance: `--dry-run` prints the plan without deleting;
a smoke against a throwaway user erases both mem0 + auth (do NOT run against a real user).

## Task 5 — [P3] Hygiene batch

- `backend/api/schemas.py`: add `max_length` to `destination_hint`, `origin_city`, and `requested_places`
  (list length + per-item length); add a `@field_validator` on `start_date`/`end_date` (parse ISO, `end>=start`,
  a max-span cap) returning a clean 422 instead of a Postgres 500. (Schema parity: these are request-only
  fields; confirm no TS mirror needs a matching change.)
- `.env.example`: annotate `ALLOWED_ORIGINS=*` as dev-only, never a deployed value.
- `render.yaml`: add `RESEND_API_KEY` + `SENTRY_DSN` entries (`sync:false`) for provisioning visibility.
- Frontend `safeHref()` util → guard the 4 backend-URL `href` sinks (`EvidenceChip.tsx:24`,
  `RestaurantStrip.tsx:37`, `ReelInfoCard.tsx:155`, `CountryTrays.tsx:116`): non-http(s) → `#`. Defense-in-depth.
- `backend/pyproject.toml`: tighten `openai-agents` from `>=0.3.0` to a compatible range matching the
  lock-resolved version (code targets the ~0.17 Responses item shape).

Risk: low; mechanical. Acceptance: suite green; malformed date → 422 not 500; a `javascript:` href renders `#`.

---

## Execution order & workflow
1. Codex (xhigh) reviews THIS plan — focus Task 3 (cancellation/budget correctness) + Task 1 (scrubber completeness). Fold findings.
2. Implement task-by-task (astrail-developer) with a per-task astrail-reviewer gate; Task 3 gets extra scrutiny.
3. Run backend `uv run pytest -q` + frontend `npm test` after each task; keep both green.
4. Final whole-branch pass: astrail-reviewer (opus) + gstack /review (Codex cross-model).
5. STOP. Hand ZH a green branch + this plan's outcome. Do NOT push/merge. List the dashboard/env items ZH must set (SENTRY_DSN, required-checks toggle) to activate.

## Explicitly deferred (fast-follow, not this branch)
- PostHog analytics (needs key + event taxonomy sign-off).
- OG/social image (needs a design asset).
- DB hot-query index audit (slide 7) — verification pass, not a code fix.
- 0-place "hard fail vs soft empty-state" UX (product decision).

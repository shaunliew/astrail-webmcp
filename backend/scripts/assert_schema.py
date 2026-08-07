"""Pre-deploy schema-drift gate — fails the deploy when production lacks something this code needs.

Render runs this as `preDeployCommand` (see `render.yaml`). Exit 1 aborts the rollout and the
OLD code keeps serving, which is the entire point: with `autoDeployTrigger` on, THE MERGE IS
THE DEPLOY, so there is no window in which a human checks that the shipping code and the live
schema agree. `/health` performs no schema check, so without this gate a code-first deploy
against an old schema stays GREEN while jobs fail on the first write.

HOW IT PROBES. `supabase-py` speaks PostgREST, not SQL — there is no DSN, no psql and no
Supabase CLI in the image — so the only way to ask "does this column exist" is to select it:
`client.table(t).select("a,b").limit(0)`. `limit(0)` reads no rows, so this pulls no data; a
column PostgREST cannot resolve makes the request fail, an existing one returns `[]`.

WHAT IT CANNOT SEE. Columns only. A changed RPC signature, a dropped constraint, a renamed
conflict key or a changed SQLSTATE (`20260720130000_organize_job_error_codes` moved P0001 ->
AS4xx) are all invisible to a column probe. This gate narrows the window; it does not close it.
ONE exception: `_probe_claim_rpc` additionally proves the account-deletion `claim_account_for_deletion`
RPC (`20260805010000`) is LIVE — that migration adds only an RPC + a partial index, with no column
proxy in `REQUIRED_SCHEMA`, so a column-only gate would pass while every deletion sweep hit a missing
claim RPC. It proves existence + the service_role grant, still not the signature.

TWO DISTINCT VERDICTS, because the on-call response differs. "SCHEMA GATE FAILED" is drift —
production is behind this code, so apply the migration. "SCHEMA GATE MISCONFIGURED" is
`_validate_manifest` refusing to run a hollowed-out manifest — the database may be perfectly
healthy and the fix is in this file, not in Postgres.

Run by hand (from `backend/`, with the credentials in the environment):
    uv run --env-file .env python -m scripts.assert_schema
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys

# Third-party loggers pinned below INFO. NOT tidying: `httpx` logs `HTTP Request: GET <url>` at
# INFO and `realtime` logs `wss://…?apikey=<SERVICE_ROLE_KEY>` at DEBUG when the Supabase client
# is constructed — and this script runs with SUPABASE_SERVICE_ROLE_KEY in its environment, into
# a deploy log. A token was leaked and rotated on 2026-08-03 by exactly that mechanism. Same
# allow-list shape as `scripts/live_run.py::_configure_logging`; read that note before deleting
# an entry.
_NOISY_TRANSPORT_LOGGERS = ("httpx", "httpcore", "realtime")

# Bounded blip tolerance, matching `jobs.py::_heartbeat`'s reasoning: a transport error says
# nothing about the thing being asked, only that the question never arrived, so one flaky moment
# against PostgREST must not abort a healthy rollout. Sustained unreachability is the opposite —
# it is a gate that cannot run, and a gate that cannot run must fail CLOSED.
PROBE_ATTEMPTS = 3
RETRY_BACKOFF_S = 2.0

# Bounded so an unreachable host cannot stall the rollout on a hung socket instead of failing.
_CONNECT_TIMEOUT_S = 10.0

# The account-deletion claim RPC (20260805010000). Probed for LIVENESS because that migration adds
# only an RPC + a partial index — no column REQUIRED_SCHEMA can proxy — so migration 1 landing
# without migration 2 would pass a column-only gate and then wedge every deletion sweep on a
# missing claim RPC. The nil uuid is the safe probe argument: the RPC is
#   UPDATE users SET account_status='deleting' WHERE id=p_user_id AND account_status='pending_deletion'
# and the all-zeros uuid can name no real account, so it matches no row -> 0 updates -> returns
# false -> ZERO side effect, while still exercising the function body and the service_role grant.
# Names the migration that INTRODUCES the claim RPC + its sweep index (what an operator must apply
# if the liveness probe fails, and what a column-check can't proxy). C5 (20260807000100) only
# REPLACES the body, so the introducing migration stays the right operator hint.
_CLAIM_RPC_LABEL = "claim_account_for_deletion (20260805010000)"
# A deliberately INVALID uuid for the RPC-liveness probe (structural side-effect-freedom): PostgreSQL
# rejects the `p_user_id uuid` cast (SQLSTATE 22P02) BEFORE the function body runs, so the probe can
# NEVER execute the CAS UPDATE against ANY row — unlike a real (or nil) uuid, whose body DOES run and
# merely happens to match nothing. A missing function still surfaces as PGRST202 (PostgREST can't
# resolve the name+arg), so absence stays detectable while presence costs nothing.
_CLAIM_RPC_PROBE_ID = "schema-probe-not-a-uuid"

# ---------------------------------------------------------------------------------------------
# THE MANIFEST — what this code version requires of production.
#
# EXTEND IT IN THE SAME PR AS THE MIGRATION THAT INTRODUCES THE REQUIREMENT. A column added to
# a writer without being added here ships unguarded, which is the failure this file exists to
# prevent; a column named here that production does not have aborts EVERY deploy.
#
# Every entry below is a column the deployed code names in a `.table(...)` select/insert/update
# or filters on — derived from the code, not from the schema. Deliberately not exhaustive: the
# tables are the ones on the two live write paths (trip generation, Saved-Reels organize) plus
# the caches, and the columns are the ones those paths actually touch.
# ---------------------------------------------------------------------------------------------
REQUIRED_SCHEMA: dict[str, tuple[str, ...]] = {
    # --- durable jobs + trip generation (web service) ---
    # `charge_kind`/`charge_date`/`charge_refunded_at` (20260803120000) put the entitlement
    # charge ON the job. A column probe cannot see reserve_and_enqueue_trip_job or the extended
    # complete_trip_run, so these columns are the observable proxy for that RPC-bearing migration
    # having landed — deploying the entitlement code against a DB without them makes generate-trip
    # fail-closed (503) for everyone.
    "jobs": ("id", "trip_id", "user_id", "idempotency_key", "status", "lease_token",
             "lock_expires_at", "completed_at",
             "charge_kind", "charge_date", "charge_refunded_at"),
    "trips": ("id", "user_id", "status", "start_date", "end_date", "destination_hint",
              "budget_level", "origin_city", "preference_summary", "preference_sources",
              "title", "summary", "tradeoffs", "adult_count", "room_count"),
    "generation_events": ("id", "trip_id", "event_type", "stage", "message", "payload",
                          "created_at"),
    # `name_local` (20260720190000) is the live example of this gate's purpose: `persist.py`
    # writes it and `dedup.py` matches on it, so code ahead of that migration writes a column
    # production does not have. `country`/`country_code`/`country_name` are the verification
    # receipt the grounding path sets together (20260718130000's pair check).
    "places": ("id", "name", "name_local", "place_type", "lat", "lng", "city", "aliases",
               "source_summary", "country", "country_code", "country_name",
               "created_at", "updated_at"),
    "trip_places": ("trip_id", "place_id", "day_number", "sort_order", "source_type",
                    "evidence_json"),
    "trip_days": ("id", "trip_id", "day_number", "day_date", "title", "summary",
                  "weather_source", "weather_summary"),
    "transport_legs": ("id", "trip_id", "trip_day_id", "from_place_id", "to_place_id",
                       "leg_order", "transport_mode", "routing_provider", "routing_profile",
                       "status", "duration_seconds", "distance_meters", "warning"),
    "restaurant_suggestions": ("trip_id", "trip_day_id", "restaurant_place_id", "near_place_id",
                               "cuisine", "summary", "source_url", "evidence_json",
                               "preference_match_json"),
    # The 7 hotel-hub-map columns (20260804120000) are writer-used: persist_hotels' fenced
    # replace writes lat/lng/geo_status/route_score/rank/is_recommended/place_durations, so the
    # gate must probe them — code shipped ahead of that migration fails on the first hotel write
    # (the class that bit the entitlements arc). hotel_suggestions is NOT an anchor (Guardrail #3
    # makes hotels partial-failure-tolerant), so this only guards drift, never aborts on absence.
    "hotel_suggestions": ("trip_id", "base_place_id", "name", "area", "star_rating",
                          "price_snapshot", "status",
                          "lat", "lng", "geo_status", "route_score", "rank",
                          "is_recommended", "place_durations"),
    "feedback": ("trip_id", "user_id", "artifact_type", "artifact_id", "feedback_type",
                 "rating", "comment", "source_type", "generation_stage", "preference_source"),
    # `id` and `created_at` are the clear/write-back interlock (pipeline/memory_clear.py +
    # pipeline/preferences.py): `id` scopes the two id-only writes that retract or fail the
    # add-intent row, and `created_at` is the ONE Postgres clock both sides compare against
    # (the write-back guard's `.gt()` and the clear's in-flight cutoff). Drift dropping
    # either makes clears fail closed and the write-back abort learning — silently, since
    # both paths are best-effort by design.
    "memory_events": ("id", "user_id", "trip_id", "event_type", "learned_facts_json",
                      "created_at"),
    "traveler_profiles": ("id", "origin_city", "travel_style_tags", "preference_tags",
                          "preference_notes"),
    # --- write-through caches (guardrail #7) ---
    "reel_cache": ("id", "normalized_url", "extracted_places", "extractor_version",
                   "caption", "transcript", "expires_at"),
    "geocode_country_cache": ("coord_key", "verification_version", "country_code",
                              "country_name"),
    # The hotel FORWARD-geocode cache (20260805020000) — the write-through cache the hotel resolver
    # reads before translating/geocoding and upserts the found/miss result into. Every column below
    # is writer-used (lookup_many selects them; the upsert writes cache_key/status/lat/lng/
    # country_code/name_fingerprint/expires_at). Code shipped ahead of that migration fails on the
    # first cache read/write. Like geocode_country_cache it is NOT an anchor (the hotel feature is
    # partial-failure-tolerant, Guardrail #3), so this only guards drift, never aborts on absence.
    "hotel_geocode_cache": ("cache_key", "status", "lat", "lng", "country_code",
                            "name_fingerprint", "created_at", "expires_at"),
    # --- Saved Reels organize (web service AND the telegram-ingest worker) ---
    "saved_reels": ("id", "user_id", "normalized_url", "reel_cache_id", "analysis_status",
                    "analyzed_at", "retry_after"),
    # `user_id` (20260720100000) is the organize path's PRIMARY trust boundary — the table is
    # service-role-only, so its absence is a cross-user evidence leak, not a 500.
    "reel_place_mentions": ("user_id", "place_id", "reel_cache_id", "evidence_quote",
                            "source_url", "confidence", "verification_version"),
    "organize_jobs": ("id", "user_id", "status", "lease_token", "lock_expires_at",
                      "processed_count", "organized_count", "location_not_found_count",
                      "failed_count"),
    "organize_job_items": ("id", "job_id", "user_id", "saved_reel_id", "status", "place_count",
                           "error_message", "analysis_charge_state", "analysis_consumed_at"),
    "organize_events": ("id", "job_id", "user_id", "sequence", "event_type", "message",
                        "payload"),
    # `daily_reel_analysis_limit` (20260802120000) is read by `reserve_organize_item_analysis`.
    # A column probe cannot see an RPC's argument list, so this column is the observable proxy
    # for that migration having landed — the same migration installs the 3-arg function.
    # `plan`/`lifetime_trip_count`/`seat_requested_at` (20260803120000) back the free-trial +
    # beta-seat gate. Same proxy logic as the jobs charge columns above — the request_seat and
    # reserve_and_enqueue_trip_job RPC bodies are invisible to a column probe, so these columns
    # stand in for that migration having landed.
    # `account_status`/`deletion_requested_at`/`deletion_scheduled_for` (20260805000000) are the
    # soft-delete grace state; they are ALSO the observable proxy for that migration's two RPCs
    # (request_/cancel_account_deletion) having landed — a column probe can't see an RPC signature,
    # so the account-deletion endpoints would fail-closed against a DB missing them.
    "users": ("id", "daily_reel_analysis_limit", "plan", "lifetime_trip_count",
              "seat_requested_at", "account_status", "deletion_requested_at",
              "deletion_scheduled_for"),
    # FK-free audit + work-queue for account deletion (20260805000000). Task 3's sweep selects and
    # updates every column below, so their presence is the proxy for the whole deletion migration.
    # `notified_at` (20260807000000, C2) is the durable scheduled-notice stamp the sweep reads/writes
    # — pinned so a deploy of the notice-retry code can never race ahead of its column.
    "account_deletion_log": ("id", "user_id", "recipient_email", "requested_at", "scheduled_for",
                             "attempts", "next_attempt_at", "last_error", "purged_verified_at",
                             "completed_at", "outcome", "notified_at"),
}

# ANCHOR TABLES — the manifest's floor, and the only thing `_validate_manifest` can check
# without keeping a second copy of the schema. These are table NAMES, not a threshold, so adding
# one carries no false-positive risk; the rule for admitting the NEXT one is written down here so
# it gets decided by rule rather than by taste.
#
# SELECTION RULE — a table anchors iff BOTH:
#   (a) a core live path (trip generation, or Saved-Reels organize) cannot complete without
#       reading or writing it, AND
#   (b) this gate has a documented reason to probe it.
# Anything the product survives losing is deliberately NOT an anchor — weather, restaurant and
# hotel suggestions, feedback, memory. Guardrail #3 makes those partial-failure-tolerant, so
# demanding them here would abort deploys over columns a healthy trip never needs.
#
#   jobs, trips, trip_places, transport_legs
#       the durable-job row every run opens, what the run produces, and what Phase 3 writes.
#   places
#       no non-degenerate trip completes without a place row — and this is the table the module
#       docstring above cites as the gate's motivating example (`name_local`; the
#       `country`/`country_code`/`country_name` verification receipt). While it was not an
#       anchor, deleting its manifest entry silently disabled the exact protection this file
#       documents, which is how the rule and the stated purpose had drifted apart.
#   users
#       `daily_reel_analysis_limit` is the observable proxy for 20260802120000 having landed (a
#       column probe cannot see an RPC's argument list). A live probe on 2026-08-03 found that
#       column genuinely absent from production, so this table is load-bearing in fact rather
#       than in theory.
#
# STILL NOT SEEN: a narrowing that keeps all six — dropping `reel_cache`, say. Deriving the
# required set from a static scan of `.table("...")` call sites would close that rather than
# shrink it, and is deliberately deferred until a dropped non-anchor table actually bites: it
# means a parser, dynamic-name false positives, and another script that can itself rot.
ANCHOR_TABLES: tuple[str, ...] = ("jobs", "trips", "trip_places", "transport_legs", "places",
                                  "users")


def _validate_manifest(schema: dict[str, tuple[str, ...]]) -> list[str]:
    """Structural check on the MANIFEST, before any credential or socket. Empty list == valid.

    THE GATE PROTECTING THE GATE. `REQUIRED_SCHEMA` is Python, not SQL, so a PR that empties or
    narrows it touches no migration and CI has nothing to object to. The gate then probes
    nothing, prints `verified 0 columns across 0 tables`, exits 0, and waves through the exact
    drifted deploy it exists to abort — failing silently in the one direction that matters.

    STRUCTURAL, NOT A COUNT. A floor like `>= 158 columns` would abort the first deploy that
    legitimately DROPS a column, and a gate that blocks healthy deploys gets switched off. These
    rules only trip when the manifest has stopped describing this backend at all.
    """
    if not schema:
        return ["the manifest is EMPTY — it names no table, so this gate verifies nothing"]
    problems = [f"{table}: mapped to no columns — that probe asks the database nothing"
                for table, columns in schema.items() if not columns]
    problems += [f"anchor table '{table}' is absent from the manifest"
                 for table in ANCHOR_TABLES if table not in schema]
    return problems


class _Unreachable(Exception):
    """The request never reached PostgREST, so no verdict about the schema exists."""

    def __init__(self, error_type: str) -> None:
        super().__init__(error_type)
        self.error_type = error_type


class _RpcDrift(Exception):
    """The RPC-liveness probe got a definitive NON-success answer (function absent, or any other
    server error such as a missing grant). Carries a pre-formatted, secret-free message: our own
    label + the SQLSTATE code, never the server text."""


class _MissingCredentials(Exception):
    """Names only — never values."""

    def __init__(self, names: list[str]) -> None:
        super().__init__(", ".join(names))
        self.names = names


def _configure_logging() -> None:
    """Root stays at WARNING and the noisy transports are pinned. See `_NOISY_TRANSPORT_LOGGERS`."""
    logging.basicConfig(level=logging.WARNING, format="  [log] %(name)s %(message)s")
    for name in _NOISY_TRANSPORT_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


async def _probe(client, table: str, columns: tuple[str, ...], *, attempts: int,
                 backoff_s: float, sleep) -> None:
    """One PostgREST probe, retried on TRANSPORT failure only.

    The two error shapes mean opposite things and `postgrest` keeps them apart for us: a non-2xx
    response raises `APIError` (the server ANSWERED — a verdict, never a blip), while a
    connection failure propagates as the underlying httpx exception. Its own `send_with_retry`
    retries 503/520 *responses* and never a transport error, so this loop is not duplicating it.
    """
    from postgrest.exceptions import APIError

    last_error_type = "unknown"
    for attempt in range(attempts):
        try:
            await client.table(table).select(",".join(columns)).limit(0).execute()
            return
        except APIError:
            raise
        except Exception as exc:                      # noqa: BLE001 — deliberately broad
            # TYPE ONLY. The text of a transport error carries the request URL, and the
            # service-role key rides in it as `?apikey=…`.
            last_error_type = type(exc).__name__
            if attempt + 1 < attempts:
                await sleep(backoff_s * (attempt + 1))
    raise _Unreachable(last_error_type)


async def _identify_drift(client, table: str, columns: tuple[str, ...], *, attempts: int,
                          backoff_s: float, sleep) -> str:
    """Re-probe column by column to say exactly what is missing, using OUR names.

    Never the server's message: PostgREST's text is the precise answer, but echoing a server
    string into a deploy log is how credentials escape, and the manifest already knows every
    name worth printing. Runs only on the failure path, so the extra requests cost nothing on a
    healthy deploy.
    """
    from postgrest.exceptions import APIError

    missing: list[str] = []
    for column in columns:
        try:
            await _probe(client, table, (column,), attempts=attempts, backoff_s=backoff_s,
                         sleep=sleep)
        except APIError:
            missing.append(column)
        except _Unreachable as exc:
            # The connection died mid-bisect. Drift is already established (the batch probe was
            # rejected), so this only costs precision — and it must not escape `run()`, whose
            # `except APIError` block is where this call sits.
            return (f"{table}: drift detected, but the database became unreachable while "
                    f"pinpointing which column ({exc.error_type})")
    if not missing:
        # The batch was rejected but each column resolves alone: something real changed that
        # this probe cannot name. Fail closed rather than explain it away.
        return (f"{table}: the column probe was rejected, but every column resolves "
                "individually — aborting rather than guessing")
    if len(missing) == len(columns):
        return (f"{table}: MISSING — every required column probe was rejected "
                "(table absent, renamed, or no longer exposed through PostgREST)")
    return f"{table}: missing column(s) {', '.join(missing)}"


async def _probe_claim_rpc(client, *, attempts: int, backoff_s: float, sleep) -> None:
    """RPC-LIVENESS probe for `claim_account_for_deletion` — the column loop cannot see an RPC.

    STRUCTURALLY side-effect-free: calls the RPC once with a deliberately INVALID uuid
    (`_CLAIM_RPC_PROBE_ID`). PostgreSQL evaluates a function call IN ORDER — resolve the name (else
    `PGRST202`), check the service_role EXECUTE grant (else `42501`), then CAST `p_user_id` to uuid
    (fails `22P02` on our invalid input) — so the CAS UPDATE body NEVER runs and no row can be touched.
    The only HEALTHY answer is therefore `22P02`: the function is present AND service_role can execute
    it, and it rejected our bad input before the body → pass. EVERYTHING ELSE FAILS CLOSED, naming the
    code: `PGRST202` = the function/signature is absent (migration 2 didn't land); `42501` = present
    but service_role lacks EXECUTE (migration 2's grant didn't land, so the sweep itself couldn't
    claim); any other code (e.g. `PGRST203` ambiguous overload) = the RPC is not present-and-callable
    as this code needs — never wave through a half-applied migration. Same retry discipline as
    `_probe`: a transport failure is retried and then fails closed as `_Unreachable`; a server answer
    is a verdict, never retried. Secret-safe: names our own label + the SQLSTATE code only, never the
    server message; transport errors log the TYPE only.
    """
    from postgrest.exceptions import APIError

    last_error_type = "unknown"
    for attempt in range(attempts):
        try:
            await client.rpc("claim_account_for_deletion",
                             {"p_user_id": _CLAIM_RPC_PROBE_ID}).execute()
            return  # accepted (unreachable in prod with a bad uuid, but = present + ran)
        except APIError as exc:
            code = getattr(exc, "code", None)
            if code == "22P02":
                # Healthy: present + service_role can execute it + rejected our invalid uuid at the
                # arg cast, BEFORE the body. Structurally side-effect-free → the one passing verdict.
                return
            if code == "PGRST202":
                raise _RpcDrift(f"{_CLAIM_RPC_LABEL}: RPC NOT FOUND (PGRST202) — migration 2 has "
                                "not landed; apply it, then redeploy") from None
            # FAIL CLOSED on every other answer — 42501 (service_role EXECUTE grant missing), a
            # PGRST203 ambiguous overload, or anything else: the RPC is not present-and-callable as
            # migration 2 defines it, so the sweep would break. Abort, naming the code.
            raise _RpcDrift(f"{_CLAIM_RPC_LABEL}: NOT callable — unexpected error code {code} (e.g. a "
                            "missing service_role EXECUTE grant); apply/repair migration 2, then "
                            "redeploy") from None
        except Exception as exc:                      # noqa: BLE001 — transport only; type name only
            last_error_type = type(exc).__name__
            if attempt + 1 < attempts:
                await sleep(backoff_s * (attempt + 1))
    raise _Unreachable(last_error_type)


async def _create_client():
    """Build a one-shot service-role client. Credentials are read HERE, never at import."""
    missing = [name for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
               if not os.environ.get(name)]
    if missing:
        raise _MissingCredentials(missing)
    # Imported inside the function: the repo's import-time invariant (no heavy SDK, no key, no
    # network at import), the same shape `scripts/live_run.py` uses.
    import httpx
    from supabase import acreate_client
    from supabase.lib.client_options import AsyncClientOptions

    options = AsyncClientOptions(httpx_client=httpx.AsyncClient(timeout=_CONNECT_TIMEOUT_S))
    return await acreate_client(os.environ["SUPABASE_URL"],
                                os.environ["SUPABASE_SERVICE_ROLE_KEY"], options=options)


async def run(client=None, *, schema: dict[str, tuple[str, ...]] | None = None,
              attempts: int = PROBE_ATTEMPTS, backoff_s: float = RETRY_BACKOFF_S,
              sleep=None) -> int:
    """Probe every manifest object. Returns a process exit code: 0 verified, 1 abort the deploy."""
    # FIRST, and above the SDK import: the manifest is a dict in this repo, so a broken one is a
    # gate MISCONFIGURATION that no credential and no round-trip can diagnose. Reporting
    # "SUPABASE_URL not set" or a drift verdict for it aims the operator at the wrong system.
    #
    # The subject is the SHIPPED manifest, never the `schema=` a caller injects: production
    # reaches this through `main() -> run()` with no arguments, and `schema=` exists only so a
    # test can drive the probe loop with two columns instead of all 158. Validating the injected
    # one instead would force every such test to carry four anchor tables it does not use.
    problems = _validate_manifest(REQUIRED_SCHEMA)
    if problems:
        return _abort(problems, headline=_MISCONFIGURED_HEADLINE, hint=_MANIFEST_HINT)

    from postgrest.exceptions import APIError

    schema = REQUIRED_SCHEMA if schema is None else schema
    sleep = asyncio.sleep if sleep is None else sleep

    if client is None:
        try:
            client = await _create_client()
        except _MissingCredentials as exc:
            return _abort([f"cannot run: {', '.join(exc.names)} not set in this environment"],
                          hint=_CREDENTIAL_HINT)
        except Exception as exc:                      # noqa: BLE001 — type only, see `_probe`
            return _abort([f"cannot build a Supabase client: {type(exc).__name__}"],
                          hint=_CREDENTIAL_HINT)

    failures: list[str] = []
    for table, columns in schema.items():
        try:
            await _probe(client, table, columns, attempts=attempts, backoff_s=backoff_s,
                         sleep=sleep)
        except _Unreachable as exc:
            # One dead connection is ONE fact. Re-measuring it against every remaining table
            # multiplies the pre-deploy's runtime by the manifest size and learns nothing.
            failures.append(f"database UNREACHABLE after {attempts} attempts "
                            f"({exc.error_type}) while probing {table}")
            break
        except APIError:
            failures.append(await _identify_drift(client, table, columns, attempts=attempts,
                                                  backoff_s=backoff_s, sleep=sleep))

    # RPC-liveness probe — ONLY when every column probe passed (a drifted/unreachable DB already
    # aborts above, and there is no point probing an RPC on a database we can't read). Same retry
    # discipline as the column loop.
    if not failures:
        try:
            await _probe_claim_rpc(client, attempts=attempts, backoff_s=backoff_s, sleep=sleep)
        except _RpcDrift as exc:
            failures.append(str(exc))
        except _Unreachable as exc:
            failures.append(f"database UNREACHABLE after {attempts} attempts ({exc.error_type}) "
                            f"while probing {_CLAIM_RPC_LABEL}")

    if failures:
        return _abort(failures)
    print(f"schema gate OK — verified {sum(len(c) for c in schema.values())} columns "
          f"across {len(schema)} tables, plus the {_CLAIM_RPC_LABEL} RPC")
    return 0


_DRIFT_HEADLINE = ("SCHEMA GATE FAILED — aborting this deploy. The currently-deployed code "
                   "keeps serving.")
# A separate headline, not a longer failure line: the two aim the operator at different systems,
# and at 3am the first word is all that gets read.
_MISCONFIGURED_HEADLINE = ("SCHEMA GATE MISCONFIGURED — aborting this deploy. The GATE is "
                           "broken, not the database; production may be perfectly healthy.")

_DRIFT_HINT = ("Apply the pending migration(s) to production, then redeploy. If instead the "
               "manifest in scripts/assert_schema.py is what is stale, fix it in the same PR as "
               "the migration.")
_MANIFEST_HINT = ("This is NOT schema drift — do not touch the database. REQUIRED_SCHEMA in "
                  "backend/scripts/assert_schema.py no longer describes this backend; restore "
                  "the entries (git log that file) and redeploy.")
_CREDENTIAL_HINT = ("The gate could not run at all, so it aborts rather than wave the deploy "
                    "through. Both vars are declared `sync: false` in render.yaml and are set "
                    "in the Render dashboard.")


def _abort(failures: list[str], *, headline: str = _DRIFT_HEADLINE,
           hint: str = _DRIFT_HINT) -> int:
    print(headline, file=sys.stderr)
    for failure in failures:
        print(f"  - {failure}", file=sys.stderr)
    print(hint, file=sys.stderr)
    return 1


def main() -> int:
    _configure_logging()
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())

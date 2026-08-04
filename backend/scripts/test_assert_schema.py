"""Guards for the pre-deploy schema-drift gate.

`scripts/assert_schema.py` is the ONLY thing standing between a merge and a deploy once
`autoDeployTrigger` is on: Render runs it as `preDeployCommand`, and a non-zero exit aborts
the rollout so the OLD code keeps serving. Every assertion here is therefore about a decision
that reaches production — a gate that silently exits 0 is worse than no gate, because
`/health` performs no schema check and a code-first deploy against an old schema stays GREEN
while jobs fail.

FIDELITY OF THE FAKE (this repo has been burned by fakes more forgiving than the real client
— see the `fake-fidelity-hides-prod-bugs` lesson). What `FakeSupabase` models, and on what
evidence:

  VERIFIED from the installed postgrest 2.31 source
    `AsyncQueryRequestBuilder.execute` (`postgrest/_async/request_builder.py`) raises
    `postgrest.exceptions.APIError` for ANY non-2xx response, and lets transport failures
    propagate as the underlying httpx exception — its own `send_with_retry` retries
    *responses* (503/520 on GET/HEAD) and never a connection error. That is exactly the split
    the gate keys on, so the fake raises the REAL `APIError` class and a REAL
    `httpx.ConnectError`, never a stand-in.

  NOT VERIFIED HERE — asserted from PostgREST's documented behaviour, not from a live call
  (the task forbids running against the live database)
    * a `select` naming a column that does not exist answers non-2xx (Postgres 42703),
    * a request against a table missing from the schema cache answers 404 / `PGRST205`,
    * `limit=0` is a 200 with `[]` rather than an error.
  The first two are the gate's whole premise. The third is the one that could make the gate
  wrong in the SAFE direction: if `limit=0` errored, every deploy would abort loudly rather
  than pass silently. All three need one smoke against a real Supabase project before
  auto-deploy is switched on; that smoke is the human's, not this suite's.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from postgrest.exceptions import APIError

from scripts import assert_schema

# Looks like a real service-role key so a substring assertion is meaningful.
SENTINEL_KEY = "eyJhbGciOiJIUzI1NiJ9.CANARY-SERVICE-ROLE-KEY.dGVzdA"


class _FakeQuery:
    """One `client.table(t).select(...).limit(...)` chain."""

    def __init__(self, client: "FakeSupabase", table: str) -> None:
        self._client = client
        self._table = table
        self._select: str | None = None
        self._limit: int | None = None

    def select(self, columns: str):
        self._select = columns
        return self

    def limit(self, size: int):
        self._limit = size
        return self

    async def execute(self):
        return self._client._answer(self._table, self._select, self._limit)


class _Response:
    def __init__(self, data):
        self.data = data


class FakeSupabase:
    """Local stand-in for supabase-py's `AsyncClient` — see the module docstring on fidelity.

    `schema` is `{table: {column, ...}}`; a table absent from it is absent from the database.
    `transport_errors` fails that many `execute()` calls with a real `httpx.ConnectError`
    BEFORE consulting the schema, which is how a blip is modelled: the request never reached
    PostgREST, so no verdict exists.
    """

    def __init__(self, schema: dict[str, set[str]], *, transport_errors: int = 0,
                 transport_error_text: str = "connection refused") -> None:
        self.schema = schema
        self.calls: list[tuple[str, str | None, int | None]] = []
        self._transport_errors = transport_errors
        self._transport_error_text = transport_error_text

    def table(self, name: str) -> _FakeQuery:
        return _FakeQuery(self, name)

    def _answer(self, table: str, select: str | None, limit: int | None):
        self.calls.append((table, select, limit))
        if self._transport_errors > 0:
            self._transport_errors -= 1
            raise httpx.ConnectError(self._transport_error_text)
        if table not in self.schema:
            raise APIError({
                "code": "PGRST205",
                "message": f"Could not find the table 'public.{table}' in the schema cache",
                "hint": None, "details": None,
            })
        requested = [c for c in (select or "").split(",") if c]
        missing = [c for c in requested if c not in self.schema[table]]
        if missing:
            raise APIError({
                "code": "42703",
                "message": f"column {table}.{missing[0]} does not exist",
                "hint": None, "details": None,
            })
        return _Response([])


def schema_from_manifest(manifest=None) -> dict[str, set[str]]:
    """A database that satisfies the manifest exactly — the positive control's fixture."""
    manifest = manifest or assert_schema.REQUIRED_SCHEMA
    return {table: set(columns) for table, columns in manifest.items()}


async def _no_sleep(_seconds: float) -> None:
    """Collapse the retry backoff so the failure tests do not actually wait."""


# --------------------------------------------------------------------------------------
# The four guards, in the order the deploy meets them.
# --------------------------------------------------------------------------------------


async def test_missing_column_aborts_the_deploy_and_names_it(capsys):
    """The whole point: production lacks a column this code needs -> exit 1, said precisely.

    `places.name_local` is the concrete case — `20260720190000_place_name_local` added it and
    `pipeline/persist.py`'s insert writes it, so code shipped ahead of that migration writes a
    column that does not exist. The message must name BOTH halves: "something drifted" sends
    the operator to read 29 migrations.
    """
    db = schema_from_manifest()
    db["places"].discard("name_local")

    code = await assert_schema.run(FakeSupabase(db), sleep=_no_sleep)

    assert code == 1
    out = capsys.readouterr()
    combined = out.out + out.err
    assert "places" in combined
    assert "name_local" in combined
    # Only the ACTUAL offender: naming every column of the table is the same as naming none.
    assert "place_type" not in combined


async def test_verified_schema_exits_zero(capsys):
    """POSITIVE CONTROL. Without it, `return 1` unconditionally passes every other test here."""
    client = FakeSupabase(schema_from_manifest())

    code = await assert_schema.run(client, sleep=_no_sleep)

    assert code == 0
    out = capsys.readouterr().out
    # The confirmation has to carry the count, otherwise a manifest silently emptied to `{}`
    # reads identically to a full verification.
    assert str(len(assert_schema.REQUIRED_SCHEMA)) in out
    assert str(sum(len(c) for c in assert_schema.REQUIRED_SCHEMA.values())) in out
    # Every manifest table was really probed, each with `limit(0)` and its full column list.
    assert [c[0] for c in client.calls] == list(assert_schema.REQUIRED_SCHEMA)
    for table, select, limit in client.calls:
        assert limit == 0, "limit(0) reads no rows — the probe must not pull data"
        assert select == ",".join(assert_schema.REQUIRED_SCHEMA[table])


async def test_transient_connection_error_is_retried_then_passes(capsys):
    """A blip is not drift. One failed connection then success -> the deploy proceeds.

    Same reasoning as `jobs.py::_heartbeat`: a transport error says nothing about the thing
    being asked, only that the question did not arrive. Aborting every rollout on one flaky
    moment against PostgREST is its own outage.
    """
    manifest = {"trips": ("id", "user_id")}
    client = FakeSupabase(schema_from_manifest(manifest), transport_errors=1)
    slept: list[float] = []

    async def record_sleep(seconds: float) -> None:
        slept.append(seconds)

    code = await assert_schema.run(client, schema=manifest, sleep=record_sleep)

    assert code == 0
    assert len(client.calls) == 2, "the failed probe must be retried, not skipped"
    assert slept, "a retry with no backoff hammers a database that is already struggling"
    assert "verified" in capsys.readouterr().out


async def test_sustained_connection_failure_fails_closed(capsys):
    """Unreachable is NOT a pass. Bounded retries, then abort the deploy.

    Failing OPEN here is the one outcome that defeats the gate entirely: a DB the pre-deploy
    cannot reach would wave through the exact code-vs-schema mismatch it exists to catch.
    """
    manifest = {"trips": ("id",)}
    client = FakeSupabase(schema_from_manifest(manifest), transport_errors=999)

    code = await assert_schema.run(client, schema=manifest, sleep=_no_sleep)

    assert code == 1
    assert len(client.calls) == assert_schema.PROBE_ATTEMPTS, "retries must be bounded"
    combined = "".join(capsys.readouterr())
    assert "unreachable" in combined.lower()
    assert "ConnectError" in combined, "the operator needs the failure TYPE to diagnose"


async def test_no_credential_reaches_stdout_or_stderr(capsys):
    """SUPABASE_SERVICE_ROLE_KEY must not survive into the deploy log, on ANY path.

    A token was leaked and rotated on 2026-08-03 by exactly this mechanism — an exception
    whose text carried the URL, printed whole. THREE shapes, because they print through three
    different branches and fault injection proved the first two do not cover the third: a
    transport error (its text carries the querystring), an `APIError` on every column (the
    "table missing" branch, which discards the per-column list), and an `APIError` on ONE
    column of several — the only branch that formats per-column detail into the report.
    """
    leaky = f"connect to https://proj.supabase.co/rest/v1/trips?apikey={SENTINEL_KEY}"
    manifest = {"trips": ("id", "user_id", "status")}

    def _assert_clean():
        combined = "".join(capsys.readouterr())
        assert SENTINEL_KEY not in combined
        assert "apikey" not in combined
        return combined

    unreachable = FakeSupabase(schema_from_manifest(manifest), transport_errors=999,
                               transport_error_text=leaky)
    assert await assert_schema.run(unreachable, schema=manifest, sleep=_no_sleep) == 1
    _assert_clean()

    class LeakyAPIError(FakeSupabase):
        """Every probe is rejected with a message carrying the key."""

        def _answer(self, table, select, limit):
            self.calls.append((table, select, limit))
            raise APIError({"code": "42703", "message": leaky, "hint": leaky, "details": leaky})

    assert await assert_schema.run(LeakyAPIError({}), schema=manifest, sleep=_no_sleep) == 1
    _assert_clean()

    class LeakyOnOneColumn(LeakyAPIError):
        """Only `status` is missing — the branch that names individual columns in its report."""

        def _answer(self, table, select, limit):
            if "status" in select.split(","):
                return super()._answer(table, select, limit)
            self.calls.append((table, select, limit))
            return _Response([])

    assert await assert_schema.run(LeakyOnOneColumn({}), schema=manifest, sleep=_no_sleep) == 1
    combined = _assert_clean()
    assert "status" in combined, "the offending column must still be named"


# --------------------------------------------------------------------------------------
# Supporting invariants
# --------------------------------------------------------------------------------------


async def test_missing_table_is_reported_as_the_table_not_a_column_list(capsys):
    """A table absent from PostgREST's schema cache fails every column probe. Saying "these 15
    columns are missing" would send the operator hunting for 15 migrations that do not exist."""
    db = schema_from_manifest()
    db.pop("geocode_country_cache")

    assert await assert_schema.run(FakeSupabase(db), sleep=_no_sleep) == 1

    combined = "".join(capsys.readouterr())
    assert "geocode_country_cache" in combined
    assert "coord_key" not in combined


async def test_connection_lost_mid_bisect_still_aborts_cleanly(capsys):
    """Drift is established, then the connection dies while pinpointing the column.

    That second failure is raised inside `run()`'s own `except APIError` block, where an
    escaping exception would leave the operator a traceback instead of a verdict.
    """

    class DiesOnTheSecondProbe(FakeSupabase):
        def _answer(self, table, select, limit):
            self.calls.append((table, select, limit))
            if len(self.calls) == 1:
                raise APIError({"code": "42703", "message": "nope",
                                "hint": None, "details": None})
            raise httpx.ConnectError("gone")

    manifest = {"trips": ("id", "user_id")}
    code = await assert_schema.run(DiesOnTheSecondProbe({}), schema=manifest, sleep=_no_sleep)

    assert code == 1
    combined = "".join(capsys.readouterr())
    assert "trips" in combined
    assert "ConnectError" in combined


async def test_unreachable_stops_immediately_instead_of_retrying_every_table():
    """One dead connection is one fact, not twenty. Re-measuring it per table multiplies the
    pre-deploy's runtime by the manifest size for no new information."""
    client = FakeSupabase({}, transport_errors=999)

    assert await assert_schema.run(client, sleep=_no_sleep) == 1

    assert len(client.calls) == assert_schema.PROBE_ATTEMPTS


# --------------------------------------------------------------------------------------
# The manifest guard — the gate that protects the gate.
#
# `REQUIRED_SCHEMA` is Python, not SQL. A PR that empties or narrows it touches no migration,
# so CI (which runs pytest and pgTAP) has nothing to object to; the gate then probes nothing,
# prints `verified 0 columns across 0 tables`, exits 0, and waves every drifted deploy through.
# `test_manifest_is_well_formed` below catches that at TEST time — these catch it at RUN time,
# which is the only place that helps if the same PR also edits the test.
# --------------------------------------------------------------------------------------

_DRIFT_HINT_PHRASE = "Apply the pending migration"


def _anchored(extra: dict[str, tuple[str, ...]] | None = None) -> dict[str, tuple[str, ...]]:
    """A minimal manifest that SATISFIES the guard, so a test can break exactly one rule.

    Every negative test below pairs this with a fake database that satisfies it too, so that
    with the guard removed the run reaches `return 0`. A fixture the probe loop would reject
    anyway cannot tell a working guard from a deleted one.
    """
    manifest = {table: ("id",) for table in assert_schema.ANCHOR_TABLES}
    manifest.update(extra or {})
    return manifest


async def test_empty_manifest_aborts_without_touching_the_database(monkeypatch, capsys):
    """The headline case: a manifest emptied to `{}` verifies nothing, so it must not pass.

    `client.calls == []` is the load-bearing half. Without the guard this exact run exits 0
    after zero probes — the gate reports success precisely because it checked nothing.
    """
    monkeypatch.setattr(assert_schema, "REQUIRED_SCHEMA", {})
    client = FakeSupabase({})

    code = await assert_schema.run(client, sleep=_no_sleep)

    assert code == 1
    assert client.calls == [], "a manifest that verifies nothing must not reach the database"
    combined = "".join(capsys.readouterr())
    assert "manifest" in combined.lower()
    assert "EMPTY" in combined


async def test_invalid_manifest_is_reported_before_the_credential_check(monkeypatch, capsys):
    """ORDERING. The guard reads one dict in this repo — it needs no credential and no socket,
    so it runs first. Reversed, the operator is told to go fix the Render dashboard while the
    actual defect is a file in this repository."""
    monkeypatch.setattr(assert_schema, "REQUIRED_SCHEMA", {})
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    code = await assert_schema.run(sleep=_no_sleep)

    assert code == 1
    combined = "".join(capsys.readouterr())
    assert "manifest" in combined.lower()
    assert "SUPABASE_URL" not in combined, "the credential check must not preempt the guard"


async def test_table_mapped_to_no_columns_aborts(monkeypatch, capsys):
    """`{"places": ()}` selects the empty string — a probe that asks the database nothing and
    can never fail. Narrowing a table to zero columns is how the manifest gets hollowed out one
    entry at a time rather than all at once.

    `places` deliberately, now that it is an anchor: presence is not protection, and the anchor
    rule cannot see this case at all (the key is right there). Only the zero-column rule can.
    """
    manifest = _anchored({"places": ()})
    monkeypatch.setattr(assert_schema, "REQUIRED_SCHEMA", manifest)
    client = FakeSupabase(schema_from_manifest(manifest))

    code = await assert_schema.run(client, sleep=_no_sleep)

    assert code == 1
    assert client.calls == []
    assert "places: mapped to no columns" in "".join(capsys.readouterr())


def test_the_anchor_set_is_pinned_to_a_literal():
    """SELF-ERASURE GUARD, and the reason this test exists at all.

    `test_missing_anchor_table_aborts_and_names_which` derives its cases FROM `ANCHOR_TABLES`,
    so deleting an entry also deletes the case that would have caught the deletion — the suite
    shrinks to five green params and reports nothing. Fault injection confirmed exactly that:
    removing `places` from the tuple was GREEN across the whole file until this literal existed.

    So the anchor set is pinned here, where narrowing it is a diff a reviewer has to approve.
    Widen it by the selection rule documented above the constant, never by taste.
    """
    assert assert_schema.ANCHOR_TABLES == (
        "jobs", "trips", "trip_places", "transport_legs", "places", "users")


@pytest.mark.parametrize("anchor", assert_schema.ANCHOR_TABLES)
async def test_missing_anchor_table_aborts_and_names_which(monkeypatch, capsys, anchor):
    """The non-empty and zero-column rules both pass on a manifest narrowed to one healthy
    table, so the anchors are what makes "narrowed" detectable at all. Naming the anchor
    matters: the fix is to restore that entry, not to audit all sixteen.

    Every anchor is proven individually — a six-param test in which two params cannot fail
    would assert coverage it does not have.
    """
    manifest = {t: c for t, c in assert_schema.REQUIRED_SCHEMA.items() if t != anchor}
    monkeypatch.setattr(assert_schema, "REQUIRED_SCHEMA", manifest)
    client = FakeSupabase(schema_from_manifest(manifest))

    code = await assert_schema.run(client, sleep=_no_sleep)

    assert code == 1
    assert client.calls == []
    assert f"anchor table '{anchor}' is absent" in "".join(capsys.readouterr())


def test_the_memory_events_columns_the_clear_interlock_needs_are_pinned():
    """`id` and `created_at` are load-bearing for POST /settings/memory/clear, and nothing
    else in this file would notice them going missing.

    `id` scopes the two id-only writes (`_retract_add_intent`, `_mark_intent_failed`) —
    without it an unscoped UPDATE/DELETE hits every audit row the user has. `created_at` is
    the ONE Postgres clock both sides compare against: the write-back guard's
    `.gt("created_at", trips.created_at)` and the clear's in-flight cutoff. Drift dropping
    either passes a manifest that never asked for it, and then clears fail closed while the
    write-back aborts learning.

    Same self-erasure shape as `test_the_anchor_set_is_pinned_to_a_literal`: the fake DB is
    derived FROM the manifest (`schema_from_manifest`), so deleting a column also deletes the
    probe that would have caught the deletion.
    """
    assert {"id", "created_at"} <= set(assert_schema.REQUIRED_SCHEMA["memory_events"])


def test_the_shipped_manifest_passes_the_guard():
    """POSITIVE CONTROL. Without it, `return ["broken"]` unconditionally passes every negative
    test above — while aborting every deploy this gate is supposed to let through.

    `test_verified_schema_exits_zero` is the end-to-end half: it drives the real manifest all
    the way to exit 0, so the guard cannot pass here and still block the happy path.
    """
    assert assert_schema._validate_manifest(assert_schema.REQUIRED_SCHEMA) == []


async def test_misconfiguration_reads_differently_from_drift(monkeypatch, capsys):
    """The two reports drive OPPOSITE on-call responses — apply a migration to production, or
    revert a file in this repo — so an operator must never have to guess which one they are
    looking at. Asserted in both directions: each report carries a marker the other lacks."""
    monkeypatch.setattr(assert_schema, "REQUIRED_SCHEMA", {})
    assert await assert_schema.run(FakeSupabase({}), sleep=_no_sleep) == 1
    misconfigured = "".join(capsys.readouterr())

    monkeypatch.undo()
    drifted = schema_from_manifest()
    drifted["places"].discard("name_local")
    assert await assert_schema.run(FakeSupabase(drifted), sleep=_no_sleep) == 1
    drift = "".join(capsys.readouterr())

    assert "MISCONFIGURED" in misconfigured and "MISCONFIGURED" not in drift
    assert _DRIFT_HINT_PHRASE in drift and _DRIFT_HINT_PHRASE not in misconfigured
    # The misconfiguration report must send the operator at this repo, not at the database.
    assert "scripts/assert_schema.py" in misconfigured


def test_manifest_is_well_formed():
    """A typo here aborts EVERY deploy (a manifest column that does not exist probes as drift),
    and a mangled entry corrupts the select string it is joined into."""
    assert assert_schema.REQUIRED_SCHEMA, "an empty manifest verifies nothing"
    for table, columns in assert_schema.REQUIRED_SCHEMA.items():
        assert columns, f"{table} has no required columns"
        assert len(set(columns)) == len(columns), f"{table} repeats a column"
        for column in columns:
            # `,` would smuggle two columns into one entry; whitespace/`*`/`(` are PostgREST
            # select-syntax, and none of them can name a real column.
            assert column and not (set(column) & set(", \t*()")), f"{table}.{column}"


def test_transport_loggers_are_pinned_below_info():
    """`httpx` logs `HTTP Request: GET <url>` at INFO and `realtime` logs
    `wss://…?apikey=<SERVICE_ROLE_KEY>` at DEBUG. This script runs with the service-role key in
    its environment, so the allow-list pin from `scripts/live_run.py::_configure_logging` is
    load-bearing, not tidying."""
    import logging

    saved = {name: logging.getLogger(name).level
             for name in assert_schema._NOISY_TRANSPORT_LOGGERS}
    root = logging.getLogger()
    root_level, root_handlers = root.level, root.handlers[:]
    root.handlers.clear()
    try:
        assert_schema._configure_logging()
        assert root.level == logging.WARNING
        for name in assert_schema._NOISY_TRANSPORT_LOGGERS:
            assert not logging.getLogger(name).isEnabledFor(logging.INFO), name
    finally:
        root.handlers[:] = root_handlers
        root.setLevel(root_level)
        for name, level in saved.items():
            logging.getLogger(name).setLevel(level)


def test_import_reads_no_environment_variable():
    """Import-keyless (repo invariant): reading credentials at import time makes the module
    unimportable in the credential-free test suite, and `main()` is where the read belongs.

    A fresh interpreter with a recording `os.environ` — checking only that the import does not
    CRASH would pass for an `os.environ.get(...)` at module scope, which is the same defect.

    Underscore-prefixed names are excluded because CPython's own import machinery reads them:
    `import asyncio` pulls in `subprocess`, which reads `_PYTHON_SUBPROCESS_USE_POSIX_SPAWN`.
    No application or credential variable in this repo is spelled that way, so the filter costs
    the assertion nothing.
    """
    backend = Path(__file__).resolve().parents[1]
    code = (
        "import os\n"
        "reads = []\n"
        "class Spy(dict):\n"
        "    def __getitem__(self, k):\n"
        "        reads.append(k); return dict.__getitem__(self, k)\n"
        "    def get(self, k, default=None):\n"
        "        reads.append(k); return dict.get(self, k, default)\n"
        "os.environ = Spy(os.environ)\n"
        "from scripts import assert_schema\n"
        "app_reads = [k for k in reads if not k.startswith('_')]\n"
        "assert not app_reads, f'read env at import: {app_reads}'\n"
        "print('NO_ENV_READ')\n"
    )
    env = {k: v for k, v in os.environ.items()
           if k not in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")}
    result = subprocess.run([sys.executable, "-c", code], cwd=backend, env=env,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "NO_ENV_READ" in result.stdout


@pytest.mark.parametrize("missing", ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])
async def test_absent_credential_fails_closed_without_naming_its_value(monkeypatch, capsys,
                                                                      missing):
    """No credentials in the pre-deploy environment is not "nothing to check" — it is a gate
    that cannot run, and a gate that cannot run must abort the deploy."""
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", SENTINEL_KEY)
    monkeypatch.delenv(missing)

    code = await assert_schema.run(sleep=_no_sleep)

    assert code == 1
    combined = "".join(capsys.readouterr())
    assert missing in combined
    assert SENTINEL_KEY not in combined

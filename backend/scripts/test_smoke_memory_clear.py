"""Unit tests for the PURE half of the live memory-clear smoke.

The smoke itself is destructive — it provisions a real Supabase user and calls the real
mem0 account — so nothing here executes its main flow and nothing here touches the network.
What IS tested is everything the script decides *with*: the account-wipe scope guard, the
burst-limit pacing arithmetic, and the response-assertion helpers.

The assertion helpers earn their own tests because a smoke's verdict is only worth what its
assertions are: `_clear_succeeded` accepting "any 2xx", or `_prefs_is_empty` reading an
`unavailable` payload as "no facts", would report a green run over exactly the lie this
endpoint exists to remove.
"""
from __future__ import annotations

import importlib
import inspect

import pytest

from scripts import smoke_memory_clear as smoke


class _FakeMem0:
    """Records calls, and models the REAL blast radius rather than being forgiving.

    On the live `AsyncMemoryClient`, `delete_all()` with no `user_id` deletes EVERY memory
    in the account. A fake that quietly recorded that call would let a test pass over the
    one mistake that cannot be undone, so an unfiltered call raises here instead.
    """

    def __init__(self) -> None:
        self.deletes: list[tuple[tuple, dict]] = []
        self.adds: list[tuple[object, dict]] = []

    async def delete_all(self, *args, **kwargs):
        if not kwargs.get("user_id"):
            raise AssertionError("unfiltered delete_all() — account-wide destructive")
        self.deletes.append((args, kwargs))

    async def add(self, messages, **kwargs):
        if not kwargs.get("user_id"):
            raise AssertionError("unfiltered add() — unscoped write")
        self.adds.append((messages, kwargs))


# --- the account-wipe scope guard -----------------------------------------------------


@pytest.mark.parametrize("user_id, provisioned", [
    (None, "u1"),                 # never provisioned / lost
    ("", "u1"),                   # blank
    ("   ", "u1"),                # whitespace only — strips to blank
    ("u1", ""),                   # no run-owned id recorded
    ("u1", None),
    ("u2", "u1"),                 # a real id, but not THIS run's
    ("", ""),                     # BOTH blank — the case equality alone would wave through
    ("  ", None),
])
def test_scope_guard_refuses_anything_but_this_runs_user(user_id, provisioned):
    """The guard is three LAYERED refusals, and the layering is deliberate.

    The ownership check (`uid != owned`) is the primary one and is individually
    attributable — deleting it reddens the `("u2", "u1")` case and both wrapper tests below.
    The two blank checks are the backstop for the case ownership cannot see: when BOTH sides
    are blank, `"" == ""` holds and a bare equality check would return `""` — the exact value
    that turns `delete_all(user_id="")` into an account-wide wipe. They are jointly, not
    individually, attributable on that fixture (removing either one leaves the other
    catching it), and that is disclosed here rather than dressed up as three separate proofs.
    """
    with pytest.raises(RuntimeError):
        smoke._require_scoped_user_id(user_id, provisioned=provisioned)


def test_scope_guard_returns_the_stripped_id_when_it_matches():
    assert smoke._require_scoped_user_id("  u1  ", provisioned="u1") == "u1"


async def test_delete_all_is_never_issued_for_an_id_this_run_did_not_provision():
    """The single most destructive call in the script, proven by the ABSENCE of the call.

    Both halves are asserted on purpose. `pytest.raises(RuntimeError)` alone would still
    pass with the guard deleted — the fake raises `AssertionError` on an unfiltered delete —
    and an empty call list alone would pass against a function that did nothing at all.
    Together they pin exactly: refused, and refused BEFORE the call was built.
    """
    fake = _FakeMem0()

    with pytest.raises(RuntimeError):
        await smoke._mem0_delete_all(fake, user_id="", provisioned="u1")
    with pytest.raises(RuntimeError):
        await smoke._mem0_delete_all(fake, user_id="someone-else", provisioned="u1")

    assert fake.deletes == []


async def test_delete_all_is_scoped_to_the_provisioned_user():
    """The positive control: the delete IS issued, and carries the user_id filter.

    Without this the refusal tests above would pass against a `_mem0_delete_all` that never
    calls mem0 under any circumstances.
    """
    fake = _FakeMem0()

    await smoke._mem0_delete_all(fake, user_id="u1", provisioned="u1")

    assert fake.deletes == [((), {"user_id": "u1"})]


async def test_add_is_scoped_and_refused_off_scope():
    fake = _FakeMem0()

    with pytest.raises(RuntimeError):
        await smoke._mem0_add(fake, user_id="u2", provisioned="u1", text="t")
    assert fake.adds == []

    await smoke._mem0_add(fake, user_id="u1", provisioned="u1", text="t")

    messages, kwargs = fake.adds[0]
    assert messages == [{"role": "user", "content": "t"}]
    assert kwargs["user_id"] == "u1"


# --- target selection -----------------------------------------------------------------


def test_target_defaults_to_the_in_process_app(monkeypatch):
    monkeypatch.delenv("SMOKE_BASE_URL", raising=False)
    monkeypatch.delenv("BACKEND_URL", raising=False)

    deployed, base, label = smoke._resolve_target()

    assert deployed is False
    assert base is None
    assert "in-process" in label


def test_target_accepts_either_env_var_and_strips_the_trailing_slash(monkeypatch):
    monkeypatch.delenv("SMOKE_BASE_URL", raising=False)
    monkeypatch.setenv("BACKEND_URL", "https://astrail-backend.onrender.com/")

    deployed, base, label = smoke._resolve_target()

    assert (deployed, base) == (True, "https://astrail-backend.onrender.com")
    assert base in label                       # the operator can see WHERE, not just "deployed"

    # SMOKE_BASE_URL is the repo's own name and must win over the alias.
    monkeypatch.setenv("SMOKE_BASE_URL", "https://other.example.com")

    assert smoke._resolve_target()[1] == "https://other.example.com"


def test_fingerprint_never_reveals_the_secret():
    """The key is printed so the operator knows WHICH mem0 account is about to be written
    to. A substring check is the assertion that matters — a "looks hashed" check would pass
    for a value that merely appended the key."""
    secret = "m0-supersecret-key-value"

    fp = smoke._fingerprint(secret)

    assert secret not in fp
    assert len(fp) == 12
    assert fp == smoke._fingerprint(secret)              # comparable across runs
    assert fp != smoke._fingerprint(secret + "x")
    assert smoke._fingerprint(None) == smoke._fingerprint("") == "unset"


# --- burst-limit pacing ---------------------------------------------------------------


def test_pace_waits_only_once_the_burst_budget_is_spent():
    spent = {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1000"}

    # Budget left -> no wait, whatever the reset time says.
    assert smoke._pace_seconds({"x-ratelimit-remaining": "2", "x-ratelimit-reset": "1000"},
                               now=900.0) == 0.0
    # Spent -> wait until the window resets, plus a second of slack. Header case is the
    # server's choice, so the lookup must not care.
    assert smoke._pace_seconds(spent, now=960.0) == pytest.approx(41.0)
    # A reset already in the past must never produce a negative sleep.
    assert smoke._pace_seconds(spent, now=1100.0) == 0.0


@pytest.mark.parametrize("headers", [
    {},                                                   # no headers at all
    {"x-ratelimit-remaining": "0"},                       # spent, but no reset to aim at
    {"x-ratelimit-remaining": "nope", "x-ratelimit-reset": "1000"},
    {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "later"},
])
def test_pace_degrades_to_no_wait_when_the_headers_are_unusable(headers):
    """Pacing is an optimisation; the 429 retry is the net. Guessing a sleep from a payload
    we could not parse would stall the smoke for a reason it cannot explain."""
    assert smoke._pace_seconds(headers, now=960.0) == 0.0


def test_pace_and_retry_after_are_both_clamped():
    """A hostile or misconfigured Retry-After must not park the smoke indefinitely."""
    assert smoke._pace_seconds({"x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999"},
                               now=0.0) == smoke._MAX_PACE_WAIT_S
    assert smoke._retry_after_seconds({"Retry-After": "99999"}) == smoke._MAX_PACE_WAIT_S
    assert smoke._retry_after_seconds({"retry-after": "12"}) == 12.0
    assert smoke._retry_after_seconds({}) == 0.0
    assert smoke._retry_after_seconds({"retry-after": "soon"}) == 0.0


# --- response assertions --------------------------------------------------------------


def test_clear_success_is_exactly_200_cleared_true():
    ok, detail = smoke._clear_succeeded(200, {"cleared": True})
    assert ok is True
    assert "200" in detail


@pytest.mark.parametrize("status, body", [
    (200, {"cleared": False}),                            # the shape the arc exists to reject
    (200, {}),                                            # 200 with no verdict at all
    (200, {"ok": True}),
    (200, "not json"),
    (204, {"cleared": True}),                             # right body, wrong status
    (503, {"error": {"code": "memory_unavailable", "message": "…"}}),
    (503, {"error": {"code": "memory_clear_unknown", "message": "…"}}),
    (500, {"error": {"code": "internal_error"}}),
])
def test_clear_success_rejects_everything_else(status, body):
    ok, _ = smoke._clear_succeeded(status, body)
    assert ok is False


def test_clear_failure_detail_carries_the_error_code():
    """`memory_unavailable` and `memory_clear_unknown` are DIFFERENT failures — one says
    nothing was deleted, the other says the outcome is unconfirmed. A detail line that
    printed only the status would make a paste-into-the-PR run unable to tell them apart."""
    _, unavailable = smoke._clear_succeeded(503, {"error": {"code": "memory_unavailable"}})
    _, unknown = smoke._clear_succeeded(503, {"error": {"code": "memory_clear_unknown"}})

    assert "memory_unavailable" in unavailable
    assert "memory_clear_unknown" in unknown


def test_prefs_facts_separates_unreadable_from_empty():
    """`None` (could not read) and `[]` (read fine, nothing stored) are different answers.

    Collapsing them is the ambiguity SettingsPreferencesResponse.status exists to remove,
    and it is the failure that would let step 3 report "memory is gone" during a mem0
    outage.
    """
    assert smoke._prefs_facts(200, {"status": "ok", "facts": []}) == []
    assert smoke._prefs_facts(200, {"status": "ok", "facts": [{"memory": "likes ryokan"}]}) \
        == ["likes ryokan"]
    assert smoke._prefs_facts(200, {"status": "unavailable", "facts": []}) is None
    assert smoke._prefs_facts(200, {"status": "disabled", "facts": []}) is None
    assert smoke._prefs_facts(200, {"status": "ok", "facts": "nope"}) is None
    assert smoke._prefs_facts(503, {"error": {"code": "x"}}) is None


def test_prefs_is_empty_only_on_a_readable_ok_payload_with_no_facts():
    ok, detail = smoke._prefs_is_empty(200, {"status": "ok", "facts": []})
    assert ok is True
    assert "facts=[]" in detail

    assert smoke._prefs_is_empty(200, {"status": "ok",
                                       "facts": [{"memory": "survivor"}]})[0] is False
    # The one that matters: "memory is broken" must NOT read as "your memory is gone".
    unavailable_ok, unavailable_detail = smoke._prefs_is_empty(200, {"status": "unavailable",
                                                                     "facts": []})
    assert unavailable_ok is False
    assert "unavailable" in unavailable_detail


def test_unauthorized_requires_the_shared_error_envelope():
    assert smoke._unauthorized(401, {"error": {"code": "unauthorized"}})[0] is True
    # A bare FastAPI `detail` body is a contract regression the status code cannot see.
    assert smoke._unauthorized(401, {"detail": "Not authenticated"})[0] is False
    assert smoke._unauthorized(401, {"error": {"code": "error"}})[0] is False
    assert smoke._unauthorized(200, {"cleared": True})[0] is False
    assert smoke._unauthorized(403, {"error": {"code": "unauthorized"}})[0] is False


def test_clear_markers_matches_only_the_endpoints_own_audit_rows():
    """Both filters are load-bearing, and each exclusion below is the ONLY row that would
    survive if its half were dropped."""
    rows = [
        {"event_type": "cleared", "trip_id": None, "id": "keep"},
        {"event_type": "cleared", "trip_id": "trip-1", "id": "drop-not-ours"},
        {"event_type": "learned", "trip_id": None, "id": "drop-wrong-type"},
        {"event_type": "failed", "trip_id": "trip-2", "id": "drop-both"},
        "not a row",
    ]

    assert [r["id"] for r in smoke._clear_markers(rows)] == ["keep"]
    assert smoke._clear_markers([]) == []


def test_import_needs_no_keys(monkeypatch):
    """Guardrail: importing the module must need no credentials and open no connection —
    httpx, mem0 and supabase are all imported INSIDE functions."""
    for var in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MEM0_API_KEY",
                "SMOKE_BASE_URL", "BACKEND_URL"):
        monkeypatch.delenv(var, raising=False)

    importlib.reload(smoke)

    assert inspect.iscoroutinefunction(smoke.main)        # the module really did reload
    # `main` is deliberately absent from this list: it is the script's OWN entrypoint, not
    # the FastAPI app module. These are the names that would exist only if the credential-
    # reading, network-opening imports had been hoisted to module scope.
    for banned in ("httpx", "mem0_client", "get_mem0_client",
                   "supabase_client", "get_supabase_client", "load_dotenv"):
        assert not hasattr(smoke, banned), f"{banned} is imported at module scope"

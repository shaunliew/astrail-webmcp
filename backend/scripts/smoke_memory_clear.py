"""Live smoke for POST /settings/memory/clear (plan T4, as amended by C6).

⚠️ DESTRUCTIVE + SPENDS mem0 CREDITS. Provisions a REAL Supabase user and calls the REAL
mem0 account. Run only with an explicit go.

A destructive endpoint cannot be live-verified like a read: there is no safe way to clear
a real user's memory and observe it. So this provisions a THROWAWAY Supabase user, seeds a
memory for that user alone, clears it, and deletes the user again. Every mem0 call is
explicitly scoped to that provisioned id — `delete_all()` / `delete_users()` with NO filter
delete the ENTIRE mem0 account, so `_require_scoped_user_id` refuses any call whose id is
blank or is not the one this run provisioned.

BEFORE YOU RUN THIS — two things changed on 2026-08-04:

1. **The route is GATED OFF** (`main.py`'s `_CLEAR_RECONCILIATION_READY = False`). Steps 2
   and 4 will get `503 memory_unavailable` and the run will fail, correctly. Enable the
   constant locally to exercise the endpoint, and only flip it in production in the PR
   that lands durable reconciliation.

2. **Cleanup CANNOT reconcile an already-accepted PENDING add.** This script deletes the
   throwaway user's visible memories, reports success, then deletes the Supabase user —
   but mem0 may still have queued adds for that id, and they materialize afterwards,
   leaving provider-side data for an entity that no longer exists. Observed on 2026-08-03,
   when mem0's queue ran >17 minutes behind. **Do not run this against a shared live
   account again until it reconciles the `event_id`s its adds return** (or keeps the entity
   for later cleanup). If you do run it, re-check `list_entities` afterwards and delete any
   resurrected throwaway id by hand.

What it proves, step by step:
  1. a seeded memory becomes readable through GET /settings/preferences
  2. POST /settings/memory/clear -> 200 {"cleared": true}
  3. GET /settings/preferences   -> status "ok", facts []
  4. a SECOND clear also returns 200 {"cleared": true} — per plan C1, `cleared: true` is a
     POSTCONDITION ("your memory is now empty"), NOT "we deleted >=1 record", so clearing an
     already-empty account succeeding is CORRECT rather than a bug (measured idempotency, E4)
  5. a memory_events row exists for the user with event_type 'cleared' and trip_id NULL
  6. an unauthenticated POST -> 401
  7. a memory seeded AFTER the clear becomes readable again — i.e. learning still works
     after a clear. That is ALL it proves: `delete_all` does not delete the entity, so this
     says nothing about entity recreation, and a direct `mem0.add` bypasses
     persist_trip_memory entirely, so it exercises none of the write-back path.

Target: in-process app via ASGITransport by default; set SMOKE_BASE_URL (or BACKEND_URL) to
hit a DEPLOYED service over the real network. The target is printed loudly before anything
destructive happens.

Run:
    cd backend && uv run python -m scripts.smoke_memory_clear
    cd backend && SMOKE_BASE_URL=https://astrail-backend.onrender.com \
        uv run python -m scripts.smoke_memory_clear
Options (env): KEEP_USER=1   # leave the throwaway user + its mem0 memories for inspection
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import time
import uuid

PASS, FAIL = "PASS ✅", "FAIL ❌"
_results: list[tuple[str, bool, str]] = []

# Distinctive on purpose: mem0 DISTILLS what it stores, so the prose that comes back is not
# guaranteed to be this string. The assertions therefore key on "the throwaway user has at
# least one fact" (it starts with exactly zero), and the text is printed so the operator can
# eyeball the round-trip.
_SEED_TEXT = "Travel preferences: quiet ryokan stays, slow mornings, and filter coffee."
_RESEED_TEXT = "Travel preferences: window seats and vegetarian food."

_VISIBILITY_TIMEOUT_S = 30.0   # add returns PENDING in ~570ms; readable ~4-8s later
_POLL_INTERVAL_S = 2.0
_MAX_PACE_WAIT_S = 65.0        # one BURST_LIMIT window plus slack; never sleep longer


def _check(name: str, ok: bool, detail: str = "") -> None:
    _results.append((name, ok, detail))
    print(f"  [{PASS if ok else FAIL}] {name}{(' — ' + detail) if detail else ''}")


def _ensure_env() -> None:
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        from dotenv import find_dotenv, load_dotenv

        load_dotenv(find_dotenv(usecwd=True))


def _fingerprint(secret: str | None) -> str:
    """A comparable, non-reversible stand-in for a credential.

    The operator needs to know WHICH mem0 account is about to be written to — the live one
    holds real memories — but a smoke that prints an API key leaks it into scrollback and
    into whatever gets pasted into a PR. sha256[:12] answers "same key or not" and nothing
    else.
    """
    if not secret:
        return "unset"
    return hashlib.sha256(secret.encode()).hexdigest()[:12]


def _resolve_target() -> tuple[bool, str | None, str]:
    """(deployed, base_url, human label) from the environment.

    SMOKE_BASE_URL is the repo's existing name (scripts/smoke_generate.py,
    scripts/smoke_http.py); BACKEND_URL is accepted as an alias. Unset means the in-process
    app, which is the safe default: it still hits LIVE Supabase and LIVE mem0, but it cannot
    accidentally aim a destructive call at production traffic's service.
    """
    raw = (os.environ.get("SMOKE_BASE_URL") or os.environ.get("BACKEND_URL") or "").strip()
    if raw:
        base = raw.rstrip("/")
        return True, base, f"DEPLOYED service {base}"
    return False, None, "in-process app via ASGITransport (LIVE Supabase + LIVE mem0)"


def _require_scoped_user_id(user_id: str | None, *, provisioned: str | None) -> str:
    """The account-wipe guard. Returns the id, or raises — it never returns a blank.

    `mem0.delete_all()` with no filter deletes EVERY memory in the account, and
    `delete_users()` with no filter deletes every entity. A blank id reaching either is the
    whole blast radius, so this refuses blanks BEFORE any call is built. It also refuses an
    id that is not the one THIS run provisioned: the only user this script is ever permitted
    to touch is the throwaway it created seconds earlier, and a mis-wired variable must fail
    loudly rather than aim a delete at somebody real.
    """
    uid = (user_id or "").strip()
    owned = (provisioned or "").strip()
    if not uid:
        raise RuntimeError("refusing a mem0 call with a blank user_id — the no-filter form "
                           "is account-wide destructive")
    if not owned:
        raise RuntimeError("refusing a mem0 call: no provisioned throwaway user recorded "
                           "for this run")
    if uid != owned:
        raise RuntimeError("refusing a mem0 call scoped to a user this run did not provision")
    return uid


def _pace_seconds(headers, *, now: float) -> float:
    """Seconds to wait before the NEXT call, read from slowapi's X-RateLimit-* headers.

    BURST_LIMIT defaults to 3/minute. A poll that ignores it turns into a 429 storm and the
    429 gets reported as a failed assertion about the clear — a smoke that fails for a reason
    unrelated to the thing under test is worse than no smoke. `now` is a parameter rather
    than a `time.time()` call so this stays pure and its test does not sleep.

    Returns 0.0 whenever the headers are absent or unparseable: pacing is an optimisation,
    and the 429 retry is the actual net.
    """
    lower = {str(k).lower(): v for k, v in dict(headers).items()}
    try:
        if int(lower.get("x-ratelimit-remaining", "1")) > 0:
            return 0.0
        reset = float(lower["x-ratelimit-reset"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    return max(0.0, min(reset - now + 1.0, _MAX_PACE_WAIT_S))


def _retry_after_seconds(headers) -> float:
    """The Retry-After a 429 carries, clamped. 0.0 when absent or unparseable."""
    lower = {str(k).lower(): v for k, v in dict(headers).items()}
    try:
        return max(0.0, min(float(lower["retry-after"]), _MAX_PACE_WAIT_S))
    except (KeyError, TypeError, ValueError):
        return 0.0


def _clear_succeeded(status_code: int, body) -> tuple[bool, str]:
    """Exactly `200 {"cleared": true}` — the contract's only success shape.

    Deliberately not "any 2xx" and not "not a 500": the whole point of this endpoint is that
    it must never report a clear it did not verify, so a loose assertion here would accept
    precisely the lie the arc exists to remove. Failures are the 503 envelope, whose
    `error.code` is reported so `memory_unavailable` and `memory_clear_unknown` stay
    distinguishable in the output.
    """
    if status_code != 200:
        code = ""
        if isinstance(body, dict):
            code = str((body.get("error") or {}).get("code") or "")
        return False, f"{status_code}{(' code=' + code) if code else ''} body={str(body)[:160]}"
    ok = isinstance(body, dict) and body.get("cleared") is True
    return ok, f"200 body={str(body)[:160]}"


def _prefs_facts(status_code: int, body) -> list[str] | None:
    """The memory prose from a readable `status: "ok"` preferences payload, else None.

    None means "could not read the memory list" (a non-200, a `disabled`/`unavailable`
    status, or a shape we do not recognise) and is NEVER the same thing as `[]`, which means
    "read fine, nothing stored". Collapsing the two is the exact ambiguity
    SettingsPreferencesResponse.status exists to remove.
    """
    if status_code != 200 or not isinstance(body, dict) or body.get("status") != "ok":
        return None
    facts = body.get("facts")
    if not isinstance(facts, list):
        return None
    return [str(f.get("memory")) for f in facts if isinstance(f, dict)]


def _prefs_is_empty(status_code: int, body) -> tuple[bool, str]:
    """`status: "ok"` AND zero facts. An unreadable payload is a FAIL, not an empty list."""
    facts = _prefs_facts(status_code, body)
    if facts is None:
        status = body.get("status") if isinstance(body, dict) else None
        return False, f"{status_code} status={status!r} body={str(body)[:160]}"
    return not facts, f'200 status="ok" facts={facts}'


def _unauthorized(status_code: int, body) -> tuple[bool, str]:
    """401 AND the shared error envelope (api/errors.py maps 401 -> "unauthorized").

    Asserting the envelope too, because a 401 emitted as FastAPI's bare `{"detail": ...}`
    would be a contract regression the status code alone cannot see.
    """
    code = ""
    if isinstance(body, dict):
        code = str((body.get("error") or {}).get("code") or "")
    return status_code == 401 and code == "unauthorized", f"{status_code} code={code!r}"


def _clear_markers(rows) -> list[dict]:
    """The clear endpoint's own audit rows: event_type 'cleared' AND trip_id NULL.

    Both halves are load-bearing. `_write_clear_marker` always writes trip_id NULL, while a
    generation's write-back always carries a trip_id — so a 'cleared' row with a trip_id
    would not be one of ours, and a 'learned'/'failed' row is a different event entirely.
    """
    return [r for r in rows
            if isinstance(r, dict) and r.get("event_type") == "cleared"
            and r.get("trip_id") is None]


# --- network seams --------------------------------------------------------------------


async def _provision_user(httpx) -> tuple[str, str]:
    """Admin-create a throwaway confirmed user + mint its access token. Returns (id, token).

    The `on_auth_user_inserted` trigger mirrors it into public.users, which the
    memory_events FK needs.
    """
    base = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    anon = (os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
            or os.environ.get("SUPABASE_ANON_KEY") or key)
    email = f"memclear-smoke-{uuid.uuid4().hex[:12]}@example.com"
    pw = uuid.uuid4().hex + "Aa1!"
    async with httpx.AsyncClient(base_url=base, timeout=30) as g:
        cr = await g.post("/auth/v1/admin/users",
                          headers={"apikey": key, "Authorization": f"Bearer {key}"},
                          json={"email": email, "password": pw, "email_confirm": True})
        cr.raise_for_status()
        uid = cr.json()["id"]
        tk = await g.post("/auth/v1/token", params={"grant_type": "password"},
                          headers={"apikey": anon}, json={"email": email, "password": pw})
        if tk.status_code != 200:
            await g.delete(f"/auth/v1/admin/users/{uid}",
                           headers={"apikey": key, "Authorization": f"Bearer {key}"})
            raise RuntimeError(f"token mint failed {tk.status_code}: {tk.text[:160]}")
        return uid, tk.json()["access_token"]


async def _delete_user(httpx, uid: str) -> None:
    base, key = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    async with httpx.AsyncClient(base_url=base, timeout=30) as g:
        r = await g.delete(f"/auth/v1/admin/users/{uid}",
                           headers={"apikey": key, "Authorization": f"Bearer {key}"})
        print(f"  (deleted throwaway user {uid}: {r.status_code})")


async def _mem0_add(mem0, *, user_id: str, provisioned: str, text: str) -> None:
    """Seed one memory, scoped. Same call shape persist_trip_memory uses."""
    uid = _require_scoped_user_id(user_id, provisioned=provisioned)
    await mem0.add([{"role": "user", "content": text}], user_id=uid,
                   metadata={"source": "smoke_memory_clear"})


async def _mem0_delete_all(mem0, *, user_id: str, provisioned: str) -> None:
    """Delete this ONE user's memories. The scope guard runs before the call is built —
    deleting the throwaway user in Supabase does not cascade into mem0, so without this the
    smoke would leave an orphan entity in the live account on every run."""
    uid = _require_scoped_user_id(user_id, provisioned=provisioned)
    await mem0.delete_all(user_id=uid)


class _Caller:
    """The smoke's HTTP calls, kept inside the service's burst limit.

    BURST_LIMIT defaults to 3/minute, which a poll blows through in ten seconds; the
    resulting 429 would surface as a failed assertion about the clear. In-process the
    limiter storage is simply reset (precedent: scripts/smoke_http.py resets it for the same
    reason — the burst gate is not what this smoke tests). A DEPLOYED target has no such
    handle, so slowapi's X-RateLimit-* headers drive a proactive wait, with a Retry-After
    retry as the net.
    """

    def __init__(self, ac, *, token: str, deployed: bool) -> None:
        self._ac, self._token, self._deployed = ac, token, deployed
        self._wait_before_next = 0.0

    def _reset_local_limiter(self) -> None:
        if self._deployed:
            return
        import rate_limit

        rate_limit.limiter.reset()

    async def call(self, method: str, path: str, *, auth: bool = True) -> tuple[int, object, object]:
        """Returns (status_code, parsed_body_or_text, headers)."""
        self._reset_local_limiter()
        if self._wait_before_next:
            print(f"  (burst limit: waiting {self._wait_before_next:.1f}s before {method} {path})")
            await asyncio.sleep(self._wait_before_next)
            self._wait_before_next = 0.0
        headers = {"Authorization": f"Bearer {self._token}"} if auth else {}
        r = await self._ac.request(method, path, headers=headers)
        if r.status_code == 429:
            wait = _retry_after_seconds(r.headers) or _POLL_INTERVAL_S
            print(f"  (429 on {method} {path}; retrying once after {wait:.1f}s)")
            self._reset_local_limiter()
            await asyncio.sleep(wait)
            r = await self._ac.request(method, path, headers=headers)
        self._wait_before_next = _pace_seconds(r.headers, now=time.time())
        try:
            return r.status_code, r.json(), r.headers
        except Exception:  # noqa: BLE001 — a non-JSON body is itself evidence
            return r.status_code, r.text, r.headers


async def _poll_until_visible(caller: _Caller, *, what: str) -> tuple[list[str] | None, float]:
    """Poll GET /settings/preferences until at least one fact is readable.

    The throwaway user starts with exactly zero memories, so ANY fact is the one just
    seeded — which is why this does not try to string-match the seed text: mem0 distils what
    it stores and the prose that comes back is not guaranteed to be what went in.
    """
    started = time.monotonic()
    last = "no response"
    while time.monotonic() - started < _VISIBILITY_TIMEOUT_S:
        status, body, _ = await caller.call("GET", "/settings/preferences")
        facts = _prefs_facts(status, body)
        if facts:
            print(f"  ({what} visible after {time.monotonic() - started:.1f}s: {facts})")
            return facts, time.monotonic() - started
        last = f"{status} {str(body)[:120]}"
        await asyncio.sleep(_POLL_INTERVAL_S)
    print(f"  ({what} NOT visible within {_VISIBILITY_TIMEOUT_S:.0f}s; last={last})")
    return None, time.monotonic() - started


async def _memory_event_rows(uid: str) -> list[dict]:
    from supabase_client import get_supabase_client

    client = await get_supabase_client()
    res = await (client.table("memory_events")
                 .select("id,event_type,trip_id,created_at")
                 .eq("user_id", uid).execute())
    return list(getattr(res, "data", None) or [])


async def main() -> int:
    _ensure_env()
    import httpx

    from mem0_client import get_mem0_client

    deployed, base_url, label = _resolve_target()
    supabase_host = (os.environ.get("SUPABASE_URL") or "unset").replace("https://", "")
    print("=" * 78)
    print("  smoke_memory_clear — DESTRUCTIVE. Provisions a throwaway user and calls the")
    print("  REAL mem0 account. Every mem0 call is scoped to that one throwaway id.")
    print(f"  TARGET      : {label}")
    print(f"  SUPABASE    : {supabase_host}")
    print(f"  MEM0 KEY    : sha256[:12]={_fingerprint(os.environ.get('MEM0_API_KEY'))}")
    print(f"  KEEP_USER   : {os.environ.get('KEEP_USER') == '1'}")
    print("=" * 78)

    mem0 = await get_mem0_client()
    if mem0 is None:
        print("RESULT: FAIL ❌  no mem0 client (MEM0_API_KEY unset or construction failed)")
        return 2

    uid, token = await _provision_user(httpx)
    print(f"\n(provisioned throwaway user {uid})")
    try:
        # Built INSIDE the try: everything after the user exists must be covered by the
        # cleanup, including the in-process app import.
        if deployed:
            ac = httpx.AsyncClient(base_url=base_url, timeout=30)
        else:
            import main as app_module

            ac = httpx.AsyncClient(transport=httpx.ASGITransport(app=app_module.app),
                                   base_url="http://smoke", timeout=30)
        async with ac:
            caller = _Caller(ac, token=token, deployed=deployed)

            print("\n== 1. seed a memory and wait for the endpoint to report it ==")
            await _mem0_add(mem0, user_id=uid, provisioned=uid, text=_SEED_TEXT)
            seeded, _ = await _poll_until_visible(caller, what="seeded memory")
            _check("seeded memory becomes readable via GET /settings/preferences",
                   bool(seeded), f"facts={seeded}")

            print("\n== 2. clear ==")
            status, body, _ = await caller.call("POST", "/settings/memory/clear")
            _check('POST /settings/memory/clear -> 200 {"cleared": true}',
                   *_clear_succeeded(status, body))

            print("\n== 3. the read agrees the memory is gone ==")
            status, body, _ = await caller.call("GET", "/settings/preferences")
            _check('GET /settings/preferences -> status "ok", facts []',
                   *_prefs_is_empty(status, body))

            print("\n== 4. a second clear on an empty account ==")
            # Plan C1: `cleared: true` is a POSTCONDITION ("your memory is now empty"), NOT
            # "we deleted >=1 record" — so a second clear returning 200 is CORRECT, not a
            # bug, and E4 measured the SDK as idempotent on this path. Asserting the exact
            # success shape rather than "did not 500": "any non-500" would also accept a
            # 503, which is a real regression this step must be able to see.
            status, body, _ = await caller.call("POST", "/settings/memory/clear")
            _check('second clear -> 200 {"cleared": true} (C1 postcondition, E4 idempotent)',
                   *_clear_succeeded(status, body))

            print("\n== 5. the audit trail ==")
            rows = await _memory_event_rows(uid)
            markers = _clear_markers(rows)
            _check("memory_events has a 'cleared' row with trip_id NULL for this user",
                   bool(markers),
                   f"{len(markers)} of {len(rows)} rows; all="
                   f"{[(r.get('event_type'), r.get('trip_id')) for r in rows]}")

            print("\n== 6. auth ==")
            status, body, _ = await caller.call("POST", "/settings/memory/clear", auth=False)
            _check("unauthenticated POST /settings/memory/clear -> 401 enveloped",
                   *_unauthorized(status, body))

            print("\n== 7. learning still works after a clear ==")
            # C6 (which WITHDREW the original T4 step 9): this proves ONLY that a memory
            # added after a clear becomes readable again. It does NOT prove entity
            # recreation — `delete_all` does not delete the entity, so there is nothing to
            # recreate — and it does NOT exercise persist_trip_memory, which a direct
            # `mem0.add` bypasses entirely.
            await _mem0_add(mem0, user_id=uid, provisioned=uid, text=_RESEED_TEXT)
            relearned, _ = await _poll_until_visible(caller, what="post-clear memory")
            _check("a memory added AFTER the clear becomes readable "
                   "(learning still works; NOT a claim about entity recreation "
                   "or persist_trip_memory)",
                   bool(relearned), f"facts={relearned}")
    finally:
        if os.environ.get("KEEP_USER") == "1":
            print(f"\n  (KEEP_USER=1 -> left user {uid} and its mem0 memories for inspection)")
        else:
            # mem0 is NOT cascaded by the Supabase delete, so it goes first and explicitly
            # scoped. Best-effort: a cleanup failure must not mask the smoke's verdict, but
            # it MUST be visible or the live account silently accumulates orphans.
            try:
                await _mem0_delete_all(mem0, user_id=uid, provisioned=uid)
                print(f"\n  (deleted throwaway user's mem0 memories: {uid})")
            except Exception as e:  # noqa: BLE001
                print(f"\n  ⚠️  mem0 cleanup FAILED for {uid}: {type(e).__name__} — "
                      "delete it by hand")
            await _delete_user(httpx, uid)

    passed = sum(1 for _, ok, _ in _results if ok)
    total = len(_results)
    print(f"\nRESULT: {passed}/{total} checks passed", "✅" if passed == total else "❌")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

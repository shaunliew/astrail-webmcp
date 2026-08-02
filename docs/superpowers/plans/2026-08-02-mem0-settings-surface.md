# Backend mem0 Settings Surface — Implementation Plan (rev 3, scope split)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mem0 state observable and readable — a live read endpoint for the Settings facts list, a non-blocking mem0 signal on `/readiness`, and PRD §357 compliance. **No destructive endpoint.**

**Architecture:** One thin read route in `main.py` delegating to a new function in `pipeline/preferences.py`; a new non-networking status accessor in `mem0_client.py` that `/readiness` *observes* rather than triggers. No migration, no destructive path, no change to the generation critical path beyond dropping one string from the mem0 payload.

**Tech Stack:** FastAPI · Pydantic v2 · `mem0ai==2.0.10` · slowapi · pytest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-02-mem0-settings-surface-design.md`
**Branch:** `feat/mem0-settings-surface` from `origin/dev` @ `8d9dd39`
**Worktree:** `/Users/shaunliew/Documents/astrail-worktrees/mem0-settings`

---

## Why rev 3 is smaller — the scope split

Rev 1 scored **3.6/10 FAIL** (test quality 2.0). Rev 2 scored **3.9/10 FAIL** (deploy safety 2.5). Two rounds moved the number barely at all, and each round's fixes surfaced new problems elsewhere — the signature of a scope problem, not a detail problem.

Reading *where* the findings landed settles it. Across both rounds, nearly every P1 belonged to **`POST /settings/memory/clear`**: strict-vs-best-effort semantics, timeout-means-unknown, a verification read that could itself lie, the clear-vs-write-back race, and "a destructive endpoint cannot be live-verified." The GET, the readiness field, and the PRD fix were never the problem.

**Decision (user, 2026-08-02): split.** This arc ships the read and observability half. `POST /settings/memory/clear` moves to its own arc where the serialization design and destructive-endpoint testing get the treatment they need. Until then Zhi Hao's Clear button stays **honestly disabled** — which was already the recommended immediate frontend fix, and is strictly better than today's mock that fakes success.

**Dropped from rev 2 (moves to the clear arc):** `clear_memory`, `MemoryUnavailable`, `MemoryClearUnknown`, the `memory_events 'cleared'` audit row, the clear-vs-write-back race guard, and the `started_at` parameter (which existed only to serve that guard — so the Task-3/Task-7 signature-churn problem disappears with it).

### Round-2 findings that still apply, and how rev 3 answers them

| Finding | Answer |
|---|---|
| **P2.5 `/readiness` can block 8s per poll.** `mem0_client.py:73-77` leaves `_initialized=False` on failure *by design*, so every call retries the blocking constructor. Verified. | **Task 2:** new `mem0_status()` accessor reads module state and never constructs. `/readiness` observes, never triggers. |
| **P2.6 "Settings shows exactly what recall will use" is FALSE.** Verified: the GET uses `get_all` (first 100 stored); recall uses semantic `search(..., top_k=10)` and only when preferences are blank (`preferences.py:90-95`). Different sets. | Wording corrected everywhere to "stored mem0 memories". The claim is not made. |
| **P2.3 the limiter test proved nothing.** Same user + same ASGI IP returns 429 either way. | **Task 4:** adopt the established switch-users pattern at `test_main.py:487`. |
| **P2.2 no-op fakes.** `_FakeClientWithClears`'s `.eq()/.order()/.limit()` were no-ops, so the test passed with the query gutted. | The fake it belonged to is gone with the race guard. The **rule** is now a global constraint: a fake must record its arguments and a test must assert them. |
| **P1.4 live verification impossible.** `autoDeploy: false` — nothing is deployed on merge. | Final verification now names the manual Render deploy as an explicit, user-gated step. |
| **P2.8 quota trigger unobservable.** `3/minute` is per-process/per-user; nothing measures the ~1,000/month account budget, so "at 50%" cannot fire. | Deferral rewritten to be honest: no automatic trigger exists. Stated as a **manual** pre-rollout check with the instrumentation named. |
| **P2.7 async-`learned` rebuttal wrong.** Codex is right: `learned_facts_json` holds raw input while mem0 rewrites/consolidates; the ~8s lag makes absence ambiguous; GET and recall use different APIs. My rev-2 trigger was not reliable. | Rebuttal **withdrawn.** The deferral stands (user's call) but is now recorded as *accepted risk with no reliable trigger*, not as a solved problem. |
| **P2.9 spec contradicts the plan.** | Stale — the spec was corrected after that review started. Re-verified: `memory_clear_unknown` and `init_failed` are present. The spec needs a further pass for the split (see pre-flight). |

**Found by self-verification, not by either reviewer:** rev 2 passed `page_size` alone to `get_all`. `mem0ai` 2.0.10 only promotes pagination under `if "page" in params and "page_size" in params`, so it was silently ignored — and the test would still have passed, because it asserted against a permissive fake. Fixed and fault-injected in Task 1.

---

## Pre-flight

- [ ] **Board card.** CLAUDE.md: GitHub Project #1 is the source of truth and **Codex owns board mutations**. The backend half has no card. Hand Codex a request for a Shaun-owned card, set In progress. Do not create it directly.
- [ ] **Spec sync.** Update `docs/superpowers/specs/2026-08-02-mem0-settings-surface-design.md` to reflect the split: move §4.2's clear contract, the three-outcome timeout logic, and the concurrency section into a "deferred to the clear arc" section so implementers have one source of truth.

## Global Constraints

- **CONCURRENCY — a second Claude session is live** in the primary worktree on `feat/telegram-reel-ingest`. Work **only** in this worktree. Never `git add -A`. Never touch `backend/telegram_ingest/`.
- **Fakes must record, tests must assert.** A fake whose methods are no-ops (`return self`) makes its test unfailable — BUILD-LOOP's trap #4, and rev 2 shipped one. Every fake here records its call arguments and at least one test asserts them.
- **Guardrail #5/#6** — `Depends(get_current_user_id_stashed)`; `user_id` is token-derived, never client-supplied.
- **Guardrail #3** — the read degrades; nothing here can fail a trip.
- **Guardrail #1 — never fabricate.** The response carries only what mem0 returned. No synthesised `confidence`/`fact_key`.
- **Guardrail #4** — Pydantic + TS mirror in the same PR. No DB side.
- **Eval-safety** — `uv run pytest evals/ -q` green (frozen `6229.0`). Never construct a mem0 client at import.
- **No network, no real sleeps in tests.** Fake `asyncio.wait_for` for timeouts (pattern: `pipeline/test_preferences.py:114-126`).
- **mem0 API (verified live 2026-08-02):** `get_all(version="v2", filters={"AND":[{"user_id":uid}]}, page=1, page_size=N)` — **both** page keys required or pagination is silently dropped; a top-level `user_id=` raises `ValueError`.
- **Vocabulary:** `disabled` = no key · `unavailable` = a read errored/timed out · `init_failed` = key set, client construction failed · `configured` = key set and client built (**not** a connectivity claim).

---

### Task 1: `list_memory_facts()` — the live mem0 read

**Files:** Modify `backend/pipeline/preferences.py`; test `backend/pipeline/test_preferences.py`

**Interfaces:** Produces `async def list_memory_facts(mem0, user_id: str) -> tuple[str, list[dict]]` → `(status, facts)`, status ∈ `{"ok","disabled","unavailable"}`, fact = `{"id","memory","created_at"}`. Used by Task 4.

- [ ] **Step 1: Write the failing tests**

```python
_MEM0_PAGE = 1               # keep in sync with preferences._MEM0_PAGE
_MEM0_PAGE_SIZE = 100        # keep in sync with preferences._MEM0_PAGE_SIZE


class _FakeMem0GetAll:
    def __init__(self, rows=None, raises=False):
        self.rows, self.raises, self.calls = rows, raises, []

    async def get_all(self, **kwargs):
        self.calls.append(kwargs)          # recorded so tests can assert the real contract
        if self.raises:
            raise RuntimeError("mem0 down")
        return {"results": self.rows}


def test_list_memory_facts_returns_ok_and_maps_rows():
    from pipeline.preferences import list_memory_facts
    mem = _FakeMem0GetAll(rows=[
        {"id": "m1", "memory": "User prefers ramen", "created_at": "2026-07-07T03:08:44"},
        {"id": "m2", "memory": "  ", "created_at": "x"},        # blank -> dropped
        {"id": "m3", "memory": None, "created_at": "y"},        # non-str -> dropped
    ])
    status, facts = asyncio.run(list_memory_facts(mem, "u1"))
    assert status == "ok"
    assert facts == [{"id": "m1", "memory": "User prefers ramen",
                      "created_at": "2026-07-07T03:08:44"}]


def test_list_memory_facts_sends_v2_filter_and_both_pagination_keys():
    from pipeline.preferences import list_memory_facts
    mem = _FakeMem0GetAll(rows=[])
    asyncio.run(list_memory_facts(mem, "u1"))
    assert mem.calls[0]["version"] == "v2"
    assert mem.calls[0]["filters"] == {"AND": [{"user_id": "u1"}]}
    # BOTH keys required: mem0ai 2.0.10 client/main.py get_all only emits pagination query
    # params under `if "page" in params and "page_size" in params`. page_size alone is
    # SILENTLY IGNORED and the read comes back unbounded — and this fake would accept it,
    # so only asserting BOTH keys catches the real SDK's rule.
    assert mem.calls[0]["page"] == _MEM0_PAGE
    assert mem.calls[0]["page_size"] == _MEM0_PAGE_SIZE


def test_list_memory_facts_disabled_when_client_is_none():
    from pipeline.preferences import list_memory_facts
    assert asyncio.run(list_memory_facts(None, "u1")) == ("disabled", [])


def test_list_memory_facts_unavailable_on_error():
    from pipeline.preferences import list_memory_facts
    assert asyncio.run(list_memory_facts(_FakeMem0GetAll(raises=True), "u1")) == ("unavailable", [])


def test_list_memory_facts_unavailable_on_timeout(monkeypatch):
    from pipeline import preferences as prefs_mod
    seen = {}

    async def _timing_out_wait_for(coro, timeout):
        coro.close()
        seen["timeout"] = timeout      # RECORD, do not assert in here
        raise TimeoutError

    monkeypatch.setattr(prefs_mod.asyncio, "wait_for", _timing_out_wait_for)
    assert asyncio.run(prefs_mod.list_memory_facts(_FakeMem0GetAll(rows=[]), "u1")) \
        == ("unavailable", [])
    # Asserted OUT here, not inside the fake: an AssertionError raised inside the fake
    # lands in list_memory_facts's blanket `except Exception` and is swallowed, so the
    # function returns ("unavailable", []) anyway and the timeout pin can never fail.
    # (The same latent flaw exists at test_preferences.py:120-123 — do not copy it.)
    assert seen["timeout"] == 4


def test_list_memory_facts_empty_is_ok_not_an_error():
    # A legitimately empty memory is NOT a failure — the UI must distinguish "you have no
    # saved preferences" from "memory is broken".
    from pipeline.preferences import list_memory_facts
    assert asyncio.run(list_memory_facts(_FakeMem0GetAll(rows=[]), "u1")) == ("ok", [])


@pytest.mark.parametrize("payload", [None, {"results": None}, {"results": "nope"},
                                     {"results": ["a string", None, 42]}, {}, "not a dict"])
def test_list_memory_facts_survives_malformed_payloads(payload):
    # A degrading read must never 500 on a shape it did not expect.
    from pipeline.preferences import list_memory_facts

    class _Odd:
        async def get_all(self, **kw): return payload

    status, facts = asyncio.run(list_memory_facts(_Odd(), "u1"))
    assert status in ("ok", "unavailable")
    assert facts == []
```

- [ ] **Step 2: Run tests to verify they fail** — `cd backend && uv run pytest pipeline/test_preferences.py -k list_memory_facts -v` → `ImportError`

- [ ] **Step 3: Implement**

```python
# Bounded so one pathological account cannot pull an unbounded page into memory. We
# deliberately return only the first page rather than looping, which would multiply calls
# against the free-tier budget (see the pagination deferral).
#
# BOTH page AND page_size must be sent: mem0ai 2.0.10 (client/main.py, get_all) only
# promotes them to query params under `if "page" in params and "page_size" in params`;
# page_size alone falls through to the unpaginated POST and is silently ignored.
_MEM0_PAGE = 1
_MEM0_PAGE_SIZE = 100


async def list_memory_facts(mem0, user_id: str) -> tuple[str, list[dict]]:
    """This user's STORED mem0 memories, for GET /settings/preferences.

    NOTE the precise claim: these are the memories mem0 holds, read with `get_all` and
    capped at the first page. They are NOT identical to what any given generation recalls
    — recall uses a semantic `search(..., top_k=10)` and only runs when the user left
    preferences blank (build_preference_context). Do not describe this endpoint as showing
    "exactly what recall will use"; it is a superset, differently ordered.

    Read LIVE rather than from a cached table: a cache that drifts from mem0 is precisely
    what hid the 2026-08-02 diagnosis. Degrades per guardrail #3 — a None client, an
    error, a hang, or an unparseable payload yields a status the UI can render, never an
    exception. `status` separates 'no saved preferences' (ok, []) from 'memory is broken'
    (unavailable, []).

    mem0's prose is passed through verbatim. Callers must NOT synthesise
    fact_key/confidence to fit the older UserPreferenceFact shape — inventing data to
    satisfy a type is what guardrail #1 forbids.
    """
    if mem0 is None:
        return "disabled", []
    try:
        res = await asyncio.wait_for(
            mem0.get_all(version="v2", filters={"AND": [{"user_id": user_id}]},
                         page=_MEM0_PAGE, page_size=_MEM0_PAGE_SIZE),
            timeout=4)
        # Parsing lives INSIDE the guard: an unexpected shape must degrade, not 500.
        rows = res.get("results") if isinstance(res, dict) else res
        facts = [{"id": str(m.get("id") or ""),
                  "memory": m["memory"],
                  "created_at": str(m.get("created_at") or "")}
                 for m in (rows if isinstance(rows, list) else [])
                 if isinstance(m, dict)
                 and isinstance(m.get("memory"), str) and m["memory"].strip()]
    except Exception as e:   # noqa: BLE001 — error, TimeoutError, or an unparseable shape
        # Log the TYPE only — never the payload (it may carry user preference text).
        # An observability arc that degrades silently would repeat the very failure it
        # exists to fix: the user sees "unavailable" and the server records nothing about
        # why. Mirrors mem0_client.py:74's convention.
        print(f"[mem0] list_memory_facts unavailable: {type(e).__name__}", file=sys.stderr)
        return "unavailable", []
    return "ok", facts
```

`preferences.py` does not currently import `sys` — add it to the module imports.

- [ ] **Step 4: Run tests to verify they pass** — all green

- [ ] **Step 5: Fault-inject**

```bash
cd backend && find . -name __pycache__ -type d -not -path "./.venv/*" -exec rm -rf {} +
```
> **CORRECTED 2026-08-02 after the injections were actually run.** Cases 1 and 4 as originally written **stayed green** — `test_list_memory_facts_survives_malformed_payloads` accepts `status in ("ok","unavailable")` and `facts == []`, and the `try` and the row guard each independently produce one of those. The test proved "never 500s" but could not attribute it to either guard. Both were unfalsifiable in exactly the way BUILD-LOOP warns about. The fix is `test_list_memory_facts_keeps_valid_rows_beside_garbage_entries` (below), whose outcome the blanket `except` **cannot** fake, because that path returns `[]`.

Add this test alongside the others in Step 1:

```python
def test_list_memory_facts_keeps_valid_rows_beside_garbage_entries():
    # Makes the isinstance(m, dict) row guard LOAD-BEARING. Surviving a good row beside
    # bad ones is an outcome the blanket `except` cannot fake — it returns [].
    from pipeline.preferences import list_memory_facts
    mem = _FakeMem0GetAll(rows=["a string", None, 42,
                                {"id": "m1", "memory": "User prefers ramen",
                                 "created_at": "2026-07-07T03:08:44"}])
    status, facts = asyncio.run(list_memory_facts(mem, "u1"))
    assert status == "ok"
    assert facts == [{"id": "m1", "memory": "User prefers ramen",
                      "created_at": "2026-07-07T03:08:44"}]
```

1. Drop `page=_MEM0_PAGE` (keep `page_size`) → `test_..._sends_v2_filter_and_both_pagination_keys` must FAIL with `KeyError: 'page'`. **The fault a permissive fake alone cannot catch.** Restore.
2. Change `version="v2"` → `"v1"` → same test must FAIL. Restore.
3. Delete `isinstance(m, dict)` → `test_..._keeps_valid_rows_beside_garbage_entries` must FAIL (`AttributeError` swallowed → `("unavailable", [])`). **Verified red 2026-08-02.** Restore.
4. **The inner `try` is defense-in-depth, not solo-reddenable — and that is acceptable.** No single realistic payload makes it individually load-bearing once the row guards make parsing total. Removing the `try` *and* the row guard **together** raises an uncaught `AttributeError` (a 500 from the route) and reddens two tests. Do not delete the `try` to "simplify"; do not demand a solo-redden for it.

Clear `__pycache__`, re-run: green.

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/preferences.py backend/pipeline/test_preferences.py
git commit -m "feat(settings): list_memory_facts — live mem0 read that degrades, never 500s"
```

---

### Task 2: `mem0_status()` + the `/readiness` field

**Files:** Modify `backend/mem0_client.py`, `backend/main.py:208-217`, `backend/test_main.py:826`, `README.md:132`, `.claude/docs/ARCHITECTURE.md:122`; create `backend/test_settings_routes.py`

**Interfaces:** Produces `def mem0_status() -> str` in `mem0_client` → `"disabled" | "configured" | "init_failed" | "not_initialized"`. Used by Task 4's readiness handler.

**Why an accessor and not just calling `get_mem0_client()` (Codex P2.5, verified).** `mem0_client.py:73-77` deliberately leaves `_initialized = False` after a failed construction so a later call retries — correct for the trip path, wrong for a health probe. `/readiness` is polled by monitoring; calling the getter would retry an **8-second blocking constructor on every poll during a mem0 outage**, turning the observability fix into an outage amplifier. The probe must **observe** singleton state, never trigger initialization.

**Why `configured`, not `ok`.** Successful construction is memoized and returns without networking, so no stronger word is honest. A live probe per poll was rejected: it would burn the ~1,000/month budget.

**Why not `REQUIRED_SECRETS`:** it would contradict guardrail #3 and `mem0_client.py:51-54` (`None` means *disabled, never an error*); a mistyped key would down the whole backend when trips do not need mem0.

- [ ] **Step 1: Write the failing tests**

Append to `backend/pipeline/../test_mem0_client.py` (existing file):

```python
def test_mem0_status_disabled_without_key(monkeypatch):
    import mem0_client
    monkeypatch.delenv("MEM0_API_KEY", raising=False)
    assert mem0_client.mem0_status() == "disabled"


def test_mem0_status_configured_when_client_built(monkeypatch):
    import mem0_client
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    monkeypatch.setattr(mem0_client, "_client", object())
    assert mem0_client.mem0_status() == "configured"


def test_mem0_status_init_failed_after_a_failed_attempt(monkeypatch):
    import mem0_client
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    monkeypatch.setattr(mem0_client, "_client", None)
    monkeypatch.setattr(mem0_client, "_init_failed", True)
    assert mem0_client.mem0_status() == "init_failed"


def test_mem0_status_never_constructs_a_client(monkeypatch):
    # THE point of this accessor: /readiness is polled, and get_mem0_client() retries an
    # 8s blocking constructor after a failure. The probe must never trigger that.
    import mem0_client
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    monkeypatch.setattr(mem0_client, "_client", None)
    monkeypatch.setattr(mem0_client, "_init_failed", False)

    def _boom():
        raise AssertionError("mem0_status must not construct a client")

    monkeypatch.setattr(mem0_client, "_construct", _boom)
    assert mem0_client.mem0_status() == "not_initialized"      # observed, not triggered
```

- [ ] **Step 2: Run tests to verify they fail** — `cd backend && uv run pytest test_mem0_client.py -k mem0_status -v` → `AttributeError: module 'mem0_client' has no attribute 'mem0_status'`

- [ ] **Step 3: Implement in `backend/mem0_client.py`**

Add a module-level flag beside the existing globals:

```python
_init_failed = False    # True once a construction attempt has failed (see mem0_status)
```

Set it in `get_mem0_client`: `_init_failed = False` immediately before a successful memoize, and `_init_failed = True` inside the existing `except` (alongside `_client = None`). Add it to that function's existing `global _client, _initialized` statement (line 56).

Also add `_init_failed = False` to the `_reset()` helper in `backend/test_mem0_client.py` — it currently resets `_client`/`_initialized` only, so a failed-construction test would otherwise leak `_init_failed=True` into every later test in the process. No planned test is sensitive (they set it explicitly), but leaving module state half-reset is a latent ordering trap.

```python
def mem0_status() -> str:
    """Non-networking view of the memory singleton, for /readiness.

    OBSERVES state; never constructs. get_mem0_client() intentionally retries after a
    failure (it leaves _initialized False so a transient boot blip does not disable memory
    process-wide), which means calling it from a polled health probe would re-run an
    8-second blocking constructor on every poll during a mem0 outage.

    'configured' means a key is set and a client object exists — NOT that mem0 is
    reachable right now. Construction is memoized and does no network I/O on later calls,
    so any stronger word would assert something never tested.
    """
    # Bare truthiness DELIBERATELY, matching get_mem0_client's own check (line 62) rather
    # than being stricter. A whitespace-only key is truthy, so the getter WILL attempt
    # construction and fail — this must report `init_failed`, not `disabled`. A status
    # that contradicts what the getter actually does is worse than no status.
    if not os.environ.get("MEM0_API_KEY"):
        return "disabled"
    if _client is not None:
        return "configured"
    return "init_failed" if _init_failed else "not_initialized"
```

- [ ] **Step 4: Run tests to verify they pass** — 4 passed

- [ ] **Step 5: Wire `/readiness`** in `backend/main.py`:

```python
@app.get("/readiness")
async def readiness():
    """Deep readiness probe: confirms Supabase is reachable, and reports mem0's
    CONFIGURATION state. NOT the deploy gate (that is /health) — neither a DB blip nor a
    mem0 outage should fail a rolling deploy.

    Uses mem0_status(), which observes the singleton without constructing it: calling
    get_mem0_client() here would retry an 8s blocking constructor on every poll during a
    mem0 outage. mem0 is reported, never required — MEM0_API_KEY deliberately stays OUT of
    REQUIRED_SECRETS (guardrail #3). Before this field existed, an unset or mistyped key
    left the service fully green while memory silently did nothing, which is how the
    2026-08-02 'mem0 is not working' report became undiagnosable from the outside.
    """
    from mem0_client import mem0_status

    mem0_state = mem0_status()
    try:
        client = await get_supabase_client()
        await client.table("users").select("id").limit(1).execute()
        return {"ready": True, "mem0": mem0_state}
    except Exception:
        return JSONResponse(status_code=503, content={"ready": False, "mem0": mem0_state})
```

Create `backend/test_settings_routes.py` **with this header** (Task 4 extends the same file and adds `pytest` + `Request` imports plus an autouse fixture; that fixture only calls `limiter.reset()` and clears `dependency_overrides`, neither of which affects these two unauthenticated readiness tests):

```python
"""Keyless tests for the mem0 settings surface — no network, no DB.

Task 2 adds the /readiness coverage; Task 4 adds the GET /settings/preferences
coverage plus a shared _client() helper and an autouse reset fixture.
"""
import httpx
```

Then the tests:

```python
async def test_readiness_reports_mem0_state(monkeypatch):
    import main, mem0_client
    monkeypatch.setattr(mem0_client, "mem0_status", lambda: "configured")

    class _Supabase:
        def table(self, name):
            class _T:
                def select(self, *_a, **_k): return self
                def limit(self, *_a, **_k): return self
                async def execute(self): return None
            return _T()

    async def _sb(): return _Supabase()
    monkeypatch.setattr(main, "get_supabase_client", _sb)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.get("/readiness")
    assert r.status_code == 200
    assert r.json() == {"ready": True, "mem0": "configured"}


async def test_readiness_still_reports_mem0_when_db_is_down(monkeypatch):
    import main, mem0_client
    monkeypatch.setattr(mem0_client, "mem0_status", lambda: "init_failed")

    class _Boom:
        def table(self, name): raise RuntimeError("db down")

    async def _sb(): return _Boom()
    monkeypatch.setattr(main, "get_supabase_client", _sb)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.get("/readiness")
    assert r.status_code == 503
    assert r.json() == {"ready": False, "mem0": "init_failed"}
```

Update `backend/test_main.py:826` from `assert r.json() == {"ready": True}` to assert `r.json()["ready"] is True` **and** that `"mem0"` is present — keep it a real assertion, do not loosen it to nothing.

- [ ] **Step 6: Update the documented contract** (Codex P1.6 — stale docs mislead)

- `.claude/docs/ARCHITECTURE.md:122` — `200 {"ready":true}` → `200 {"ready":true,"mem0":"configured|disabled|init_failed|not_initialized"}` / `503 {"ready":false,"mem0":…}`. State that `configured` is a configuration claim, not a connectivity claim.
- `README.md:132` — same under `GET /readiness`.

- [ ] **Step 7: Fault-inject**

```bash
cd backend && find . -name __pycache__ -type d -not -path "./.venv/*" -exec rm -rf {} +
```
1. Change `mem0_status()` to call `get_mem0_client()` → `test_mem0_status_never_constructs_a_client` must FAIL. **This is the load-bearing guard of this task.** Restore.
2. Collapse `init_failed` into `not_initialized` → `test_mem0_status_init_failed_after_a_failed_attempt` must FAIL. Restore.
3. Move the `mem0_status()` call inside the Supabase `try` → `test_readiness_still_reports_mem0_when_db_is_down` must FAIL. Restore.

- [ ] **Step 8: Commit**

```bash
git add backend/mem0_client.py backend/test_mem0_client.py backend/main.py backend/test_main.py backend/test_settings_routes.py README.md .claude/docs/ARCHITECTURE.md
git commit -m "feat(settings): non-blocking mem0 state on /readiness + refresh docs"
```

---

### Task 3: Response schema + TypeScript mirror

**Files:** Modify `backend/api/schemas.py`, `frontend/lib/trip/backend-types.ts`; test `backend/api/test_schemas.py`

**DTO decision (user-decided after review):** facts are mem0's **prose**, tagged `source: 'mem0'`. Deliberately **not** `UserPreferenceFact` — that type carries `fact_key`, `fact_value`, `confidence`, `status`, none of which mem0 returns. Synthesising them would put a fabricated confidence number in front of the user (guardrail #1). `SettingsView` renders `fact.memory`; adapting it is part of Zhi Hao's card.

- [ ] **Step 1: Write the failing test**

```python
def test_settings_preferences_response_shape():
    from api.schemas import MemoryFact, SettingsPreferencesResponse
    r = SettingsPreferencesResponse(
        status="ok",
        facts=[MemoryFact(id="m1", memory="likes ramen", created_at="2026-07-07T03:08:44")])
    assert r.model_dump() == {
        "status": "ok",
        "facts": [{"id": "m1", "memory": "likes ramen",
                   "created_at": "2026-07-07T03:08:44", "source": "mem0"}],
    }


def test_settings_preferences_defaults_to_empty_facts():
    from api.schemas import SettingsPreferencesResponse
    assert SettingsPreferencesResponse(status="disabled").facts == []


def test_settings_preferences_rejects_unknown_status():
    import pydantic
    from api.schemas import SettingsPreferencesResponse
    with pytest.raises(pydantic.ValidationError):
        SettingsPreferencesResponse(status="probably_fine")
```

Add `import pytest` at the top if absent.

- [ ] **Step 2: Run test to verify it fails** — `ImportError`

- [ ] **Step 3: Implement**

```python
class MemoryFact(BaseModel):
    """One stored mem0 memory, verbatim.

    Deliberately NOT UserPreferenceFact: that shape carries fact_key/fact_value/
    confidence/status, none of which mem0 returns. Synthesising them to fit the type would
    be fabricating data (guardrail #1) — a made-up confidence number shown to a user — so
    the prose is passed through and the UI adapts. `source` is a constant, not an inference.
    """
    id: str
    memory: str
    created_at: str
    source: Literal["mem0"] = "mem0"


class SettingsPreferencesResponse(BaseModel):
    """GET /settings/preferences — the user's STORED mem0 memories (first page).

    Not the same set as any generation's recall, which uses a semantic search with
    top_k=10 and only when preferences are blank. `status` lets the UI tell 'you have no
    saved preferences' (ok, []) apart from 'memory is broken' (unavailable, []) — the
    ambiguity that made the 2026-08-02 report undiagnosable.
    """
    status: Literal["ok", "disabled", "unavailable"]
    facts: list[MemoryFact] = Field(default_factory=list)
```

- [ ] **Step 4: Run test to verify it passes** — 3 passed

- [ ] **Step 5: TS mirror (guardrail #4) — heredoc, NOT Edit**

```bash
cd /Users/shaunliew/Documents/astrail-worktrees/mem0-settings
cat >> frontend/lib/trip/backend-types.ts <<'EOF'

// --- Settings: mem0 preference memory (mirrors api/schemas.py) ---
// Deliberately NOT UserPreferenceFact: mem0 returns prose, not structured facts, and
// synthesising fact_key/confidence to fit that type would be inventing data.
// These are STORED memories — not identical to what a given generation recalls.
export type MemoryStatus = 'ok' | 'disabled' | 'unavailable'
export type MemoryFact = { id: string; memory: string; created_at: string; source: 'mem0' }
export type SettingsPreferencesResponse = { status: MemoryStatus; facts: MemoryFact[] }
EOF
git diff --stat frontend/lib/trip/backend-types.ts
```

Expected `1 file changed, 8 insertions(+)`. **Any deletions mean format-on-save rewrote the file — `git checkout` and retry.**

- [ ] **Step 6: Commit**

```bash
git add backend/api/schemas.py backend/api/test_schemas.py frontend/lib/trip/backend-types.ts
git commit -m "feat(settings): mem0 settings response schema + TS mirror (guardrail #4)"
```

---

### Task 4: `GET /settings/preferences`

**Files:** Modify `backend/main.py`; extend `backend/test_settings_routes.py`

**Interfaces:** Consumes Tasks 1 and 3.

- [ ] **Step 1: Write the failing tests**

```python
import httpx
import pytest
from fastapi import Request


class _Mem0:
    def __init__(self, rows=None):
        self.rows, self.read_calls = rows or [], []

    async def get_all(self, **kw):
        self.read_calls.append(kw)          # recorded; asserted below
        return {"results": self.rows}


def _client(monkeypatch, *, mem0, uid_box):
    import main, mem0_client

    async def _fake_mem0(): return mem0
    monkeypatch.setattr(mem0_client, "get_mem0_client", _fake_mem0)

    from rate_limit import get_current_user_id_stashed

    # Production stashes request.state.user_id (rate_limit.py:50) and the limiter keys on
    # it. A bare `lambda: "u1"` would silently key on IP, so the tests would not exercise
    # per-user limiting at all. uid_box makes the identity switchable mid-test
    # (pattern: test_main.py:487 test_burst_limit_is_per_user_not_shared).
    async def _override(request: Request) -> str:
        request.state.user_id = uid_box["uid"]
        return uid_box["uid"]

    main.app.dependency_overrides[get_current_user_id_stashed] = _override
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                             base_url="http://test")


@pytest.fixture(autouse=True)
def _reset():
    import main
    from rate_limit import limiter
    limiter.reset()
    yield
    main.app.dependency_overrides.clear()
    limiter.reset()


async def test_get_preferences_returns_facts(monkeypatch):
    mem = _Mem0(rows=[{"id": "m1", "memory": "likes ramen", "created_at": "2026-07-07"}])
    async with _client(monkeypatch, mem0=mem, uid_box={"uid": "u1"}) as c:
        r = await c.get("/settings/preferences")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "facts": [
        {"id": "m1", "memory": "likes ramen", "created_at": "2026-07-07", "source": "mem0"}]}
    # guardrail #6: scoped to the TOKEN's user, never anything client-supplied.
    assert mem.read_calls[0]["filters"] == {"AND": [{"user_id": "u1"}]}


async def test_get_preferences_degrades_to_200_when_memory_disabled(monkeypatch):
    async with _client(monkeypatch, mem0=None, uid_box={"uid": "u1"}) as c:
        r = await c.get("/settings/preferences")
    assert r.status_code == 200
    assert r.json() == {"status": "disabled", "facts": []}


async def test_get_preferences_requires_auth(monkeypatch):
    # No dependency override: the real auth dependency must reject before mem0 is touched.
    import main, mem0_client
    mem = _Mem0(rows=[])

    async def _fake_mem0(): return mem
    monkeypatch.setattr(mem0_client, "get_mem0_client", _fake_mem0)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.get("/settings/preferences")
    assert r.status_code == 401
    assert mem.read_calls == []          # mem0 never consulted for an anonymous caller


async def test_burst_limit_is_per_user_not_shared(monkeypatch):
    # Codex P2.3: four requests from ONE user 429 whether the limiter keys on the user or
    # the IP, so that proves nothing. Exhaust user A, then switch to user B on the SAME
    # client and prove B has a fresh bucket. (pattern: test_main.py:487)
    box = {"uid": "user-A"}
    async with _client(monkeypatch, mem0=_Mem0(rows=[]), uid_box=box) as c:
        a = [(await c.get("/settings/preferences")).status_code for _ in range(4)]
        box["uid"] = "user-B"
        b = (await c.get("/settings/preferences")).status_code
    assert a[:3] == [200, 200, 200]
    assert a[3] == 429                  # A exhausted 3/minute
    assert b == 200                     # B unaffected -> keyed on user, not IP
```

- [ ] **Step 2: Run tests to verify they fail** — 404s (route absent)

- [ ] **Step 3: Add the route**

Add `MemoryFact`, `SettingsPreferencesResponse` to the `api.schemas` import block in `main.py`, then insert after `/readiness`:

```python
@app.get("/settings/preferences", response_model=SettingsPreferencesResponse)
@limiter.limit(BURST_LIMIT)
async def get_settings_preferences(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True
    user_id: str = Depends(get_current_user_id_stashed),  # token-derived: guardrails #5 + #6
) -> SettingsPreferencesResponse:
    """PRD §18. The user's STORED mem0 memories, read live. Degrades rather than erroring
    (guardrail #3): `status` carries the bad news so an unrelated settings screen still
    renders. Not identical to a generation's recall — see list_memory_facts."""
    from mem0_client import get_mem0_client
    from pipeline.preferences import list_memory_facts

    status, facts = await list_memory_facts(await get_mem0_client(), user_id)
    return SettingsPreferencesResponse(
        status=status, facts=[MemoryFact(**f) for f in facts])
```

- [ ] **Step 4: Run tests to verify they pass** — 4 passed

- [ ] **Step 5: Fault-inject**

```bash
cd backend && find . -name __pycache__ -type d -not -path "./.venv/*" -exec rm -rf {} +
```
1. Hardcode the route's `user_id` to `"someone_else"` → `test_get_preferences_returns_facts` must FAIL on `read_calls`. Restore.
2. Remove `@limiter.limit(BURST_LIMIT)` → `test_burst_limit_is_per_user_not_shared` must FAIL. Restore.
3. Change the limiter's `key_func` to `get_remote_address` in `rate_limit.py` → the same test must FAIL on `b == 200`. **This is what proves the test measures per-user keying rather than just "some limit exists".** Restore.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/test_settings_routes.py
git commit -m "feat(settings): GET /settings/preferences — live mem0 read (PRD §18)"
```

---

### Task 5: PRD §357 — stop storing trip history as preference memory

**Files:** Modify `backend/pipeline/preferences.py`, `backend/pipeline/runner.py:545-554`, `backend/pipeline/test_preferences.py`, `backend/pipeline/test_runner.py:860-880`

**Interfaces:** Produces `distill_memory_text(ctx)` and `persist_trip_memory(client, mem0, *, user_id, trip_id, ctx)` — **`synopsis` removed**; `trip_synopsis` deleted.

**Why:** PRD §357 — *"Memory must not store raw full trip history as user preference data."* The payload is `f"Travel preferences: {text}. {synopsis}"`, so mem0 extracts two memories per trip. Live proof: `"User has planned a four-day trip to Tokyo, Japan with a balanced pace"` stored beside the real preference, and surfaced to a user on 08-01 as *"Using your saved travel preferences: …; User has planned a 20-day trip to Bangkok…"*. After Task 4 that becomes visible content on the Settings page.

**Every call site — exhaustively enumerated 2026-08-02 by `grep -rn "trip_synopsis\|synopsis" backend --include="*.py"`.** Rev 1 claimed four and was wrong; rev 2 repeated the claim. Do not trust a count — re-run that grep and confirm it comes back clean before calling this task done.

*Production code:*
- `preferences.py:71,75,78` — `distill_memory_text` signature, docstring, interpolation
- `preferences.py:104-111` — `trip_synopsis` (delete entirely)
- `preferences.py:115,121` — `persist_trip_memory` signature + its `distill_memory_text` call
- `preferences.py:15` — module docstring says the payload is "distilled prefs + a templated synopsis" (now false)
- `runner.py:546,548,554` — comment, import, call

*Tests — TWO whole tests need handling, not just argument edits:*
- `test_preferences.py:40,43,45,52` — `distill_memory_text(..., synopsis=…)` calls → drop the kwarg
- `test_preferences.py:165,178,187,199` — **`persist_trip_memory(..., synopsis=…)` calls** → drop the kwarg (rev 1 and rev 2 both missed these four)
- `test_preferences.py:48-52` — **`test_distill_never_leaks_synopsis_secrets`**: its premise is that distill only concatenates a caller-built synopsis. With the synopsis gone the test is meaningless as written. **Rewrite it** to assert the surviving guarantee — that the payload contains only `ctx.explicit_text` and no other caller-supplied content — rather than deleting the coverage.
- `test_preferences.py:204-215` — **`test_trip_synopsis_uses_real_itinerary_shape_and_destination`**: tests the function being deleted. **Delete this test**; its subject no longer exists.
- `test_runner.py:864,870,871,873` — comment + `_boom_synopsis` + the monkeypatch → repoint at `persist_trip_memory`

*Stale comments (no behaviour, but they will mislead the next reader):*
- `api/schemas.py:17` and `api/test_schemas.py:36` — both say the `pace` field "flows into … the mem0 synopsis". After this task it does not.

**Verified — the monkeypatch target is correct.** `runner.py:548` imports `persist_trip_memory` *inside* the function body (indented under the `try` at line 547), so patching `pipeline.preferences.persist_trip_memory` at the definition site takes effect at call time. A module-level import would have required patching the `runner` binding instead.

- [ ] **Step 1: Update tests**

Work the full call-site list above: drop `synopsis=` from all eight calls in `test_preferences.py` (lines ~40, 43, 45, 52 for `distill_memory_text`; ~165, 178, 187, 199 for `persist_trip_memory`), **delete** `test_trip_synopsis_uses_real_itinerary_shape_and_destination` (204-217 — it imports and calls `trip_synopsis` directly, so it has no `synopsis=` kwarg to drop and will simply break on the deleted symbol), and **rewrite** `test_distill_never_leaks_synopsis_secrets` (48-53) to assert the surviving guarantee.

**Dropping the kwarg is not sufficient at line 40.** Its expected value still contains the synopsis:

```python
# BEFORE (test_preferences.py:40-41) — expectation embeds the synopsis
assert distill_memory_text(explicit, synopsis="Planned a 3-day Tokyo trip.") \
    == "Travel preferences: loves ramen. Planned a 3-day Tokyo trip."
# AFTER — both the call AND the expectation change
assert distill_memory_text(explicit) == "Travel preferences: loves ramen"
```

Check every one of the eight for an expectation that embeds the synopsis, not just the argument.

The rewrite of the leak test:

```python
def test_distill_emits_only_the_users_own_words():
    # Was test_distill_never_leaks_synopsis_secrets. The synopsis it guarded is gone
    # (PRD §357), but the guarantee it protected still matters: the mem0 payload carries
    # the user's stated preference and NOTHING else a caller could smuggle in.
    from pipeline.preferences import distill_memory_text, merge_preferences
    ctx = merge_preferences(explicit_text="ramen, quiet days", pace="relaxed", memory_facts=[])
    assert distill_memory_text(ctx) == "Travel preferences: ramen, quiet days"
```

Then add:

```python
def test_distill_memory_text_excludes_trip_history():
    # PRD §357: distilled preference facts only — never trip history.
    from pipeline.preferences import distill_memory_text, merge_preferences
    ctx = merge_preferences(explicit_text="nice food", pace="balanced", memory_facts=[])
    assert distill_memory_text(ctx) == "Travel preferences: nice food"


def test_trip_synopsis_is_gone():
    # Deleted, not merely bypassed — an accepted-but-ignored parameter is a trap.
    import pipeline.preferences as p
    assert not hasattr(p, "trip_synopsis")
```

Rewrite `test_runner.py:860-880` to preserve its purpose (the runner tail must absorb a raise from the write-back) by patching a symbol that still exists:

```python
    from pipeline import preferences as prefs_mod

    async def _boom_write_back(*_a, **_k):
        raise RuntimeError("write-back boom")

    monkeypatch.setattr(prefs_mod, "persist_trip_memory", _boom_write_back)
```

> **Implementer check (Codex):** confirm the runner imports `persist_trip_memory` *inside* the function body (`runner.py:548`) so patching the definition site takes effect. If it were a module-level import, patch `runner`'s own binding instead. Verify by running the test with the runner's `try/except` around the write-back deleted — it must then fail.

Update that test's comment: the risk is now `persist_trip_memory` raising, not `trip_synopsis`.

- [ ] **Step 2: Run tests to verify they fail** — `TypeError: … missing keyword argument 'synopsis'` plus `test_trip_synopsis_is_gone`

- [ ] **Step 3: Implement**

```python
def distill_memory_text(ctx: PreferenceContext) -> str | None:
    """The mem0.add payload — ONLY when the user stated something NEW this trip
    (source=explicit). A memory-only or inferred trip has nothing new to learn, so we skip
    the write (saves the API call + free-tier quota, avoids duplicates).

    PRD §357: preference facts ONLY. The trip synopsis that used to be appended here made
    mem0 store a second, trip-history memory per trip ("User has planned a four-day trip
    to Tokyo…"), which surfaced to the user as a "saved travel preference" and would
    become visible content on the Settings screen. Do not reintroduce it.
    """
    if ctx.source != "explicit" or not ctx.explicit_text:
        return None
    return f"Travel preferences: {ctx.explicit_text}"
```

Delete `trip_synopsis`. Drop `synopsis` from `persist_trip_memory` and its `distill_memory_text` call. **Also delete the destination-derivation block at `runner.py:549-551`** (the `next((getattr(p, "city_or_region_guess"...` expression) — it exists solely to feed `trip_synopsis`, so once the call is gone `destination` is an unused local. Fix the now-false module docstring at `preferences.py:15` ("distilled prefs + a templated synopsis" → distilled prefs only). In `runner.py:545-554` drop the import, the argument, and the stale comment reference. Fix the stale comments at `api/schemas.py:17` and `api/test_schemas.py:36` that claim `pace` flows into the mem0 synopsis.

- [ ] **Step 3b: Prove no reference survives**

```bash
cd /Users/shaunliew/Documents/astrail-worktrees/mem0-settings
grep -rn "trip_synopsis" backend --include="*.py"
grep -rn "synopsis" backend --include="*.py" | grep -v "scripts/smoke_generate.py"
```
Expected: **no output** from the first. The second should be empty too — `smoke_generate.py:83-84` is excluded because its `itin.get("synopsis")` is an unrelated itinerary field, not the mem0 payload. Any other hit is an unfinished edit.

- [ ] **Step 4: Run the FULL suite** — `cd backend && uv run pytest -q` → all pass, **including `test_runner.py`**

- [ ] **Step 5: Verify eval-safety** — `cd backend && uv run pytest evals/ -q` → PASS (frozen `6229.0`, asserted at `evals/test_run_eval.py:82`). This changes only an LLM-prompt-adjacent payload, never `dedupe`/`assemble_itinerary`. **Do not chase the CLI's `8163.7` headline — different subject.**

- [ ] **Step 6: Fault-inject** — restore `. {synopsis}` → `test_distill_memory_text_excludes_trip_history` must FAIL. Restore (clear `__pycache__` first).

- [ ] **Step 7: Commit**

```bash
git add backend/pipeline/preferences.py backend/pipeline/runner.py \
        backend/pipeline/test_preferences.py backend/pipeline/test_runner.py \
        backend/api/schemas.py backend/api/test_schemas.py
git commit -m "fix(memory): store preference facts only, not trip history (PRD §357)"
```

---

## Final verification

- [ ] `cd backend && uv run pytest -q` — full suite green
- [ ] `cd backend && uv run pytest evals/ -q` — the `6229.0` anchor holds
- [ ] `git -C /Users/shaunliew/Documents/astrail status --short` — the **other session's** tree shows only their telegram files
- [ ] `git diff --stat origin/dev...HEAD` — no unexpected frontend style churn
- [ ] **Manual quota check before rollout** (see deferral 2): confirm current mem0 monthly usage in the dashboard. There is no automatic meter; this is a human step.
- [ ] **Live verification requires a manual Render deploy** (Codex P1.4). `render.yaml` sets `autoDeploy: false`, so merging deploys nothing. Sequence, **each step user-gated**: merge → trigger the Render deploy → `curl -s https://astrail-backend.onrender.com/readiness` (expect a `mem0` field) → authed `GET /settings/preferences`. This arc adds **no migration**, so there is no schema-ordering hazard.

## Deferrals

1. **`memory_events` marks `'learned'` on an unverified async `add()`.** Codex's objection is **accepted**: a live GET makes the discrepancy visible to a human but is not a reliable trigger — `learned_facts_json` stores the raw input while mem0 rewrites/consolidates it, the ~8s indexing lag makes immediate absence ambiguous, and the GET and recall use different APIs. My earlier rebuttal is withdrawn. **This is accepted risk with no automatic trigger:** operational evidence may record a `learned` that never landed. A real fix needs a `pending → confirmed/failed` lifecycle with a correlation id and a settling-window reconciliation job — which needs a migration, and therefore the manual deploy protocol. **Trigger: revisit with the clear arc**, which will already be touching this module.
2. **Account-wide mem0 quota.** `BURST_LIMIT` (`3/minute`) is per-process and per-user; nothing measures the ~1,000/month account allowance, so a "at 50%" trigger **cannot fire automatically** — stating otherwise would be a fake tripwire. **Mitigation now:** the manual dashboard check in Final Verification. **Trigger:** add a per-user TTL cache (invalidated on write-back) or an account-wide usage counter before the Settings page is exposed to more than the two current users.
3. **Pagination.** The GET returns the first 100 stored memories. **Trigger:** expose pagination when any user exceeds 100.
4. **Backfill-cleaning trip-history memories.** Codex is right that the repo contains no checked-in proof that `621ef3d1` is Shaun's test account — that mapping exists only in session evidence. Task 5 stops new ones. **Trigger:** confirm account ownership out-of-band, then clean only that account with explicit approval; or act when a user reports trip history on the Settings page.
5. **`user_preference_facts` writes.** **Trigger:** when the live read's latency or quota becomes a *measured* problem.
6. **The explicit/blank trigger asymmetry.** **Trigger:** a PRD §9 revisit.

## Out of scope

- **`POST /settings/memory/clear` — its own arc.** Needs a real clear/write serialization design, a verification read that cannot itself report a false success, and a strategy for testing a destructive endpoint against live data.
- **Frontend wiring** (Zhi Hao's card). **This backend PR must not be announced as fixing the reported defect** — `SettingsView.tsx:4` still imports `mock-api`, so the UI keeps showing fixture memories and a fake "Memory cleared." until that PR lands. The two PRs need a shared contract test or a coordinated landing, and the frontend must handle `status` = `disabled` / `unavailable`, not just `ok`.
- Anything under `backend/telegram_ingest/`.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 8.2/10, 0 P1, 2 P2 folded, 7 P3 (6 folded) |
| Outside Voice | Codex `gpt-5.6-sol` | Cross-model 2nd opinion | 3 | 2 FAIL → **UNAVAILABLE** | rev1 3.6/10, rev2 3.9/10; rev3 ×2 runtime error |
| Adversarial | `astrail-reviewer` (fable) | Codex fallback per gstack | 1 | CLEAR | verified every claim against real code |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | backend-only, not applicable |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | no UI in this arc (frontend is Zhi Hao's card) |

**Scores (rev 3, astrail-reviewer fable):** correctness 9 · completeness 7.5 · deploy-safety 9 · maintainability 8 · test quality 7.5 · **overall 8.2 — PASS** (≥7.0, no dimension ≤3).

**CODEX:** Rounds 1 and 2 ran and failed the plan (3.6, then 3.9) — both produced real, verified findings that drove rev 2 and then the rev-3 scope split. Round 3 was attempted **twice** against rev 3 and produced **no review either time**, dying on `codex_models_manager: failed to renew cache TTL: missing field 'supports_reasoning_summaries'` (codex-cli 0.144.4 manifest drift, exit 0 with no output — the "exit code 0 does not mean it did the work" trap from BUILD-LOOP). The cross-model gate is therefore **unavailable for rev 3**, not passed. gstack's documented fallback (fresh-context subagent) was used instead.

**CROSS-MODEL:** No tension to resolve — Codex never scored rev 3. Its rev-1/rev-2 findings were folded or explicitly answered in the plan's fold log, including one rebuttal I **withdrew** after re-reading its argument (the async-`learned` trigger was not reliably observable).

**Deploy-safety note:** the no-migration claim was independently verified — no task touches `supabase/migrations/`. Both surfaces are additive, `/health` (Render's actual gate) is untouched, and rollback is a plain revert. `autoDeploy: false` means live-verify needs a manual, user-gated Render deploy.

**VERDICT:** ENG CLEARED — ready to implement. Cross-model gate unavailable (tooling), substituted per gstack's documented fallback; re-run Codex on the finished diff at BUILD-LOOP step 6 if the CLI recovers.

**UNRESOLVED DECISIONS:**
- Codex round-3 on rev 3 never completed — the cross-model plan gate is substituted, not satisfied. Re-attempt on the code diff at step 6.
- Board card for the backend half does not exist yet (Codex owns Project #1 mutations) — pre-flight item, not blocking implementation.

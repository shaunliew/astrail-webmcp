# PLAN — `POST /settings/memory/clear`

> Date: 2026-08-03 · Owner: Shaun (backend) · Board: Phase 1, **Todo**, card
> "Backend: POST /settings/memory/clear" · Branch: `feat/settings-memory-clear` off `origin/dev` @ `154bfd8`
>
> Design input: `docs/superpowers/specs/2026-08-02-mem0-settings-surface-design.md` §4.1, §4.2, §4.2b
> (marked DEFERRED, retained deliberately as input to this arc). The read half of that spec shipped
> and is live on `dev`; this is the deferred destructive half.

## 0. Why this exists, in one paragraph

`/app/settings` is a live route wired to a mock. `frontend/lib/trip/mock-api.ts:73-77` — `clearMemory()`
is a no-op returning `{ok:true}`; `SettingsView.tsx:40` awaits it and `:81` renders **"Memory cleared."**
A user clicks Clear, is told their personal data is gone, and **nothing was deleted**. The backend
endpoint does not exist (verified: no `/settings/memory/clear` route, no `clear_memory` symbol anywhere
in `backend/`). Public beta is **2026-08-08**.

**The governing rule (spec §4.1), and it is the whole point:** the read endpoint *degrades*, the clear
*must never fake success*. A clear that lies is worse than an error, because the user believes their
data is gone when it is not.

> **Precise statement of that rule — read §8e C1 and C4 with it.** `cleared: true` asserts a
> **postcondition**: *this user's memory verified empty, and no in-flight write was observable*. It
> does **not** assert that ≥1 record was deleted — clearing an already-empty account legitimately
> succeeds. And it is **not** an absolute guarantee: C4 documents one accepted ~570 ms window in which
> an unobservable in-flight `add` may still land. Earlier drafts of this line said success requires
> "having deleted something"; that wording is superseded, and the qualified form above is the contract.

---

## 1. What the spec assumed vs. what measurement showed

The spec's §4.2 timeout design was, in its own words, written from reasoning rather than observation.
It was re-grounded this session against the **real `AsyncMemoryClient`** (mem0ai 2.0.10) — not the
mem0 MCP server, which is a different client and, being more forgiving, would have hidden this.

Probe: `scratchpad/sdk_probe.py`, throwaway ids `astrail-sdk-probe-*` only.

### E1 — **Neither delete method blocks until the deletion completes.** (the finding that drives this plan)

| SDK call | wall-clock of the call | server-side event latency |
|---|---|---|
| `delete_all(user_id=…)` | **374 ms** | ~830-880 ms (`DELETE_ALL`) |
| `delete_users(user_id=…)` | **365 ms** | ~827-877 ms (`DELETE_USER`) |

Both return roughly **460 ms before the deletion actually finishes**. Consequence:

> **"the call returned without raising" is NOT evidence that anything was deleted.**

This invalidates the two-outcome shape (return 200 on a clean return). It also invalidates the
`delete_users` variant specifically, see E2.

### E2 — `delete_users()`'s success payload is a client-side constant, not a server assertion

`mem0/client/main.py:1436-1446` issues the DELETE, calls `raise_for_status()`, **never reads the
response body**, and returns a hardcoded literal chosen by a Python ternary on whether a `user_id`
kwarg was *passed*:

```python
for entity in to_delete:
    response = await self.async_client.delete(f"/v2/entities/{entity['type']}/{entity['name']}/", params=params)
    response.raise_for_status()
...
return {"message": "Entity deleted successfully." if (user_id or ...) else "..."}
```

Spec §4.3 cites that exact payload as verification the clear worked. It is real, but it is **not
evidence**. Combined with E1, `delete_users` emits `"Entity deleted successfully."` while the job is
still running, and discards the `event_id` that would let us check.

`delete_all(user_id=…)` returns the **server's** payload, and that payload is self-describing:

```python
{'message': 'Delete in progress. This may take some time.', 'event_id': 'a4a512fd-…'}
```

**The API states outright that the work is incomplete.** Returning `{"cleared": true}` on receipt of
that message is definitionally the lie this arc exists to remove.

### E3 — Both no-argument forms are account-wide destructive

`delete_users()` with no filters enumerates `users()` and deletes **every entity in the account**.
`delete_all()` with no kwargs issues `DELETE /v1/memories/` with no params. A blank/None `user_id`
reaching either call wipes the whole mem0 account. `user_id` is token-derived so it should never be
blank — but the blast radius justifies an explicit guard (D2).

### E4 — Idempotent on the production code path

Measured through the real SDK, not the MCP:
- `delete_users` on an already-deleted entity → success, no raise
- `delete_users` on a **never-existed** id → `{'message': 'Entity deleted successfully.'}`, **no raise**
- `delete_all` on a never-existed id → success + `event_id`, no raise

⇒ **a second clear, or a retry, never 500s.** The installed docstring's "Raises `ValueError` if
specified entity not found" does not fire for a specific `user_id`; that path only exists in the
zero-filter `reset()`-style call.

### E5 — The verification read is fast and meaningful

`get_all` returned `count=0` at ~375 ms — i.e. reads reflect the deletion *before* the event reaches
`SUCCEEDED` (~880 ms). So a bounded verification read normally passes immediately and is a cheap,
honest signal.

### E6 — `get_event_status` is NOT on the Python SDK

`AsyncMemoryClient`'s public surface (verified by `dir()`) has no event/status method. The pollable
`DELETE_ALL` event is real and authoritative — reachable from the MCP — but the backend cannot poll it
without a raw HTTP call outside the SDK surface (stack-freeze concern, new failure surface).
**⇒ verification must be a `get_all` read, not an event poll.**

### E7 — Error taxonomy, duck-typed (no `mem0` import at module scope)

`client/utils.py:94-127` wraps every method with `@api_error_handler`:
- `httpx.HTTPStatusError` → typed `mem0.exceptions.*`, each carrying `error_code` (HTTP-derived ones
  get `error_code = f"HTTP_{status_code}"` and `debug_info["status_code"]`). **The server responded and
  rejected ⇒ nothing was deleted.**
- `httpx.RequestError` → `NetworkError` with `error_code` ∈ `NET_CONNECT` (connection never
  established ⇒ request never sent), `NET_TIMEOUT`, `NET_GENERIC` (⇒ may have been received).

Every mem0 exception exposes `.error_code` (`exceptions.py:58-80`), so classification needs **no
`import mem0`** — which matters, because `mem0_client.py` deliberately keeps `from mem0 import
AsyncMemoryClient` inside `_construct()` so the offline `#16` eval imports stay credential-free.

### Disagreement with the research subagent, recorded

The `astrail-researcher` pass recommended `delete_users` + collapsing to **two** outcomes, on the
grounds that `delete_users` "blocks until the server confirms deletion (vector+graph COMPLETED in the
same response cycle)". **E1 refutes that by measurement** (365 ms call vs ~850 ms event). Its
inference that "no `event_id` in the return ⇒ synchronous" is circular: the SDK discards the body
(E2), so the absence of an `event_id` is a property of the wrapper, not the server. Its **idempotency
finding (E4) is correct** and is adopted here, now re-verified on the SDK path. Both agents' MCP-only
probes additionally collided on the same `astrail-probe-clear-1` id concurrently, so several MCP
observations are unattributable; the E1-E5 numbers are single-owner and clean.

---

## 2. Decisions

| # | Decision | Grounding |
|---|---|---|
| **D1** | Call **`delete_all(user_id=…)`**, not `delete_users`. | E2 (honest payload + returns `event_id`), E6, and it is the documented "delete all for a user" call. Semantically we clear memories; we do not need to destroy the entity. mem0 recreates the entity transparently on the next `add()`, so a user who clears and later generates needs no special handling. |
| **D2** | **Refuse a blank `user_id`** before any delete call. | E3 — the no-filter form wipes the account. Defense in depth on a token-derived value. |
| **D3** | **Always verify** with a bounded read; never trust the call's return. | E1 + E2 — the call returns before completion and literally says "in progress". This *extends* spec rule "never report success without having deleted something" to the success path, which the spec applied only to the timeout path. |
| **D4** | Write the `'cleared'` audit row **BEFORE** the delete; a failed insert is **fatal** (503, delete not attempted). | The concurrency guard (D5) *reads that row*. The spec made the insert best-effort **after** the delete — but then a silently-failed insert leaves the guard unarmed and re-opens the exact hole it exists to close. Ordering it first means the guard is always armed before anything can be deleted, and a fatal insert failure is truthful: nothing was deleted. |
| **D5** | Concurrency guard: `persist_trip_memory` skips its `mem0.add` when a `'cleared'` event exists newer than **`trips.created_at`** for this trip. | Both sides are Postgres `now()` ⇒ one clock, no skew. `jobs.py:94-97` sets the repo precedent ("a claim that stamped this host's clock could mint a lease already expired by another instance's reckoning"). `trips.created_at` is slightly *earlier* than true generation start, so the guard fires slightly eagerly — the **fail-safe** direction (lose one learned memory rather than resurrect cleared data). |
| **D6** | Guard query is an **existence check** (`.eq(...).gt("created_at", ref)`), not "newest cleared event" (`.order(desc=True).limit(1)`). | The shared `_Table` fake has `.limit()` as a **no-op** and `.order(desc=True)` **raises** (`test_main.py:78-96`). A `.order/.limit` shape would be untestable; the existence shape needs one new fake method that genuinely filters. |
| **D7** | On **inability to determine** the guard's reference (trips read fails / row missing), **skip the write**. | Fail-safe: never resurrect cleared data. Logged to stderr so a systemic failure is observable rather than silently stopping all memory learning. |
| **D8** | Route returns `build_error_response(503, msg, code=…)` **directly**, not `raise HTTPException(503)`. | `_STATUS_CODE_SLUG` (`api/errors.py:19-28`) has **no 503 entry**, so a raised 503 would emit `code: "error"`. Two distinct codes on one status require the direct builder. |

**Guardrail #3 does NOT apply to the clear.** Best-effort/degrade is correct for enrich stages and
**wrong** for a destructive user-facing action. This is a deliberate, documented exception (spec §4.1,
§7). The read endpoint degrades; the clear fails loudly. Same subsystem, opposite posture, on purpose.

---

## 3. The contract

```
POST /settings/memory/clear          # auth required; user_id is token-derived (guardrails #5, #6)
  200 {"cleared": true}                                  # VERIFIED gone by a read
  503 {"error": {"code": "memory_unavailable",   "message": …}}   # CONFIRMED: nothing was deleted
  503 {"error": {"code": "memory_clear_unknown", "message": …}}   # outcome could not be confirmed
```

`memory_clear_unknown` tells the client to **refresh, not blind-retry** — a retry could erase facts
written since the first attempt. (Note E4 makes a retry *safe* at the mem0 level; the refresh guidance
is about not destroying newer data, not about crashing.)

**No `count` field** (YAGNI — `SettingsView.tsx:81` renders a fixed string). **No per-fact deletion** —
PRD §353 is a bulk action.

### Outcome mapping

| Situation | Detection | Outcome |
|---|---|---|
| mem0 client is `None` | before any call | `503 memory_unavailable` |
| blank/whitespace `user_id` | D2 guard | `503 memory_unavailable` (no call made) |
| audit-row insert fails | D4 | `503 memory_unavailable` (delete not attempted) |
| server responded with an error | `error_code` starts `HTTP_`, or `debug_info["status_code"]` present | `503 memory_unavailable` (rejected ⇒ nothing deleted); **skip the verify read** — same key would fail too |
| connection never established | `error_code == "NET_CONNECT"` | `503 memory_unavailable` (never sent) |
| our `wait_for` fired | `asyncio.TimeoutError` | → verify |
| ambiguous network error | `error_code` ∈ `NET_TIMEOUT`, `NET_GENERIC` | → verify |
| unrecognised exception | anything else | → verify (**never** assert "confirmed nothing deleted" for an error we do not understand — that is the reverse lie) |
| delete returned cleanly | — | → verify (E1: not evidence on its own) |
| **verify:** read `ok` and empty | `list_memory_facts` | `200 {"cleared": true}` |
| **verify:** read `ok`, facts remain | | `503 memory_clear_unknown` (likely mid-flight) |
| **verify:** read failed | status `unavailable` | `503 memory_clear_unknown` |

---

## 4. Tasks

### T1 — `clear_memory()` in `backend/pipeline/preferences.py`

```python
# module-level, beside the existing timeout constants
_CLEAR_TIMEOUT_S = 5     # ~13x the observed 374ms steady-state call


def _confirmed_not_deleted(e: Exception) -> bool:
    """True only when we KNOW the delete never took effect: the server responded with an
    error (it was received and rejected), or the connection was never established.

    Duck-typed on `.error_code` so this module never imports mem0 — mem0_client.py keeps
    `from mem0 import AsyncMemoryClient` inside _construct() so the offline #16 eval
    imports stay credential-free and network-free.

    Anything unrecognised returns False → we verify instead of asserting. Claiming
    "confirmed nothing was cleared" about an error we do not understand is the same
    class of lie as claiming success, pointing the other way.
    """
    code = getattr(e, "error_code", None)
    if code == "NET_CONNECT":
        return True                     # connection never established → never sent
    if isinstance(code, str) and code.startswith("HTTP_"):
        return True                     # server responded and rejected
    debug = getattr(e, "debug_info", None)
    return isinstance(debug, dict) and "status_code" in debug


async def clear_memory(client, mem0, *, user_id: str) -> str:
    """Delete this user's mem0 memories. Returns 'cleared' | 'unavailable' | 'unknown'.

    STRICT, not best-effort — the deliberate exception to guardrail #3 (spec §4.1). A
    clear that reports success without having deleted anything is worse than an error.

    Why a verification read even on the happy path: `delete_all` returns in ~374ms while
    the server-side DELETE_ALL event takes ~830-880ms, and its payload literally says
    "Delete in progress. This may take some time." A clean return is NOT evidence.
    """
    if mem0 is None:
        return "unavailable"                # nothing was sent, so nothing was deleted
    uid = (user_id or "").strip()
    if not uid:
        # `delete_all()` with no filter deletes EVERY memory in the account. user_id is
        # token-derived so this is unreachable — the blast radius earns the guard anyway.
        return "unavailable"

    # Audit row FIRST: persist_trip_memory's concurrency guard reads it, so it must be
    # armed before anything can be deleted. Fatal on failure — an unarmed guard would let
    # an in-flight generation silently un-clear what we are about to delete.
    try:
        await client.table("memory_events").insert({
            "user_id": uid, "trip_id": None, "event_type": "cleared",
            "learned_facts_json": [],
        }).execute()
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear aborted, audit insert failed: {type(e).__name__}", file=sys.stderr)
        return "unavailable"                # truthful: we never attempted the delete

    confirmed_failure = False
    try:
        await asyncio.wait_for(mem0.delete_all(user_id=uid), timeout=_CLEAR_TIMEOUT_S)
    except asyncio.TimeoutError:
        pass                                # outcome unknown — may still commit → verify
    except Exception as e:                  # noqa: BLE001
        confirmed_failure = _confirmed_not_deleted(e)
        print(f"[mem0] clear delete raised: {type(e).__name__}", file=sys.stderr)

    if confirmed_failure:
        # Record the failure beside the 'cleared' row so the audit trail is honest about
        # what happened. Best-effort: the outcome is already decided.
        try:
            await client.table("memory_events").insert({
                "user_id": uid, "trip_id": None, "event_type": "failed",
                "learned_facts_json": [],
            }).execute()
        except Exception:
            pass
        return "unavailable"

    status, facts = await list_memory_facts(mem0, uid)
    if status == "ok" and not facts:
        return "cleared"
    return "unknown"
```

**Tests** (`pipeline/test_preferences.py`, injected fakes, no network):
1. happy path → `"cleared"`, and `delete_all` called with `user_id=uid`
2. `mem0 is None` → `"unavailable"`, **no audit row written**
3. blank `user_id` (`""`, `"   "`) → `"unavailable"` and **`delete_all` never called** (assert on the fake's call list — this is the account-wipe guard)
4. delete raises a typed server error (`error_code="HTTP_401"`) → `"unavailable"`, `'failed'` row written, **verify read never issued**
5. delete raises `NetworkError(error_code="NET_CONNECT")` → `"unavailable"`
6. delete raises `error_code="NET_TIMEOUT"` **and the verify read comes back empty** → `"cleared"` (proves a timeout is not treated as failure — spec §4.2's core correction)
7. `asyncio.TimeoutError` and verify still shows facts → `"unknown"`
8. delete returns cleanly but verify still shows facts → `"unknown"` (**the E1 regression test**: proves a clean return alone is not accepted as success)
9. verify read itself fails → `"unknown"`
10. audit insert fails → `"unavailable"` and **`delete_all` never called**
11. unrecognised exception (plain `RuntimeError`) → falls through to verify, not to `"unavailable"`

### T2 — Route + schemas + TS mirror

`backend/api/schemas.py`:
```python
class MemoryClearResponse(BaseModel):
    """POST /settings/memory/clear — success only. Failures use the standard error
    envelope with code `memory_unavailable` or `memory_clear_unknown`."""
    cleared: Literal[True] = True
```

`backend/main.py` (beside `get_settings_preferences`):
```python
_CLEAR_FAILURE_MESSAGE = {
    "unavailable": "Memory could not be cleared. Nothing was deleted — please try again.",
    "unknown": "We could not confirm whether your memory was cleared. Refresh this page to "
               "see the current state; do not retry blindly.",
}


@app.post("/settings/memory/clear", response_model=MemoryClearResponse)
@limiter.limit(BURST_LIMIT)
async def clear_settings_memory(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True
    user_id: str = Depends(get_current_user_id_stashed),  # token-derived: guardrails #5 + #6
):
    """PRD §824. STRICT by design — the deliberate inverse of GET /settings/preferences,
    which degrades (guardrail #3). This must never report a clear it did not verify."""
    from mem0_client import get_mem0_client
    from pipeline.preferences import clear_memory

    client = await get_supabase_client()
    outcome = await clear_memory(client, await get_mem0_client(), user_id=user_id)
    if outcome == "cleared":
        return MemoryClearResponse()
    # Returned, not raised: _STATUS_CODE_SLUG has no 503 entry, so HTTPException(503)
    # would emit code "error" and collapse the two distinct failure codes into one.
    code = "memory_unavailable" if outcome == "unavailable" else "memory_clear_unknown"
    return build_error_response(503, _CLEAR_FAILURE_MESSAGE[outcome], code=code)
```

`frontend/lib/trip/backend-types.ts` — extend the existing settings block (guardrail #4; **no DB
side**, so two sides not three):
```ts
export type MemoryClearResponse = { cleared: true }
export type MemoryClearErrorCode = 'memory_unavailable' | 'memory_clear_unknown'
```
> **Write this via `Bash` heredoc, not `Edit`** — VS Code format-on-save applies Prettier defaults
> against this repo's single-quote/no-semicolon style. Check `git diff --stat` before committing.

**Tests** (`backend/test_settings_routes.py` — extend; it needs a Supabase fake, it has none today):
- 200 `{"cleared": true}` on success
- 503 + `error.code == "memory_unavailable"` when mem0 is `None`
- 503 + `error.code == "memory_clear_unknown"` on the unknown path
- **401 without auth, and mem0 is never touched** (assert the fake's call list is empty)
- burst limit is **per user, not per IP** (switch `uid_box` mid-test — the existing pattern at `test_settings_routes.py:118`; a single user 429ing proves nothing)
- the response body is the error **envelope** shape, not FastAPI's `detail`

### T3 — Concurrency guard in `persist_trip_memory`

Insert immediately before the `mem0.add`, as late as possible to minimise the window:

```python
async def _cleared_since_generation_start(client, *, user_id: str, trip_id: str) -> bool:
    """True if this user cleared memory after this generation's trip row was created.

    Generation takes 60-180s. A user who clears mid-generation would otherwise have the
    post-`result` write-back re-add a fact: the UI says cleared, the memory exists — the
    exact defect this arc removes.

    Both timestamps are Postgres `now()` (trips.created_at, memory_events.created_at), so
    there is ONE clock and no host/DB skew. Stamping this host's clock instead is the
    mistake jobs.py:94-97 already documents for the job lease.

    Returns True (skip the write) when the reference cannot be determined — fail-safe:
    losing one learned memory is benign, resurrecting cleared data is the bug.
    """
    try:
        trip = await client.table("trips").select("created_at") \
            .eq("id", trip_id).eq("user_id", user_id).maybe_single().execute()
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] write-back guard: trip lookup failed: {type(e).__name__}", file=sys.stderr)
        return True
    # maybe_single() returns a BARE None on zero rows (postgrest 2.31.0) — not a result
    # whose .data is None. Both shapes must read as "no reference".
    started_at = (trip.data or {}).get("created_at") if trip is not None else None
    if not started_at:
        print("[mem0] write-back guard: no trip reference; skipping write", file=sys.stderr)
        return True
    try:
        res = await client.table("memory_events").select("id") \
            .eq("user_id", user_id).eq("event_type", "cleared") \
            .gt("created_at", started_at).execute()
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] write-back guard: cleared lookup failed: {type(e).__name__}", file=sys.stderr)
        return True
    return bool(res.data)
```

and in `persist_trip_memory`, after the `mem0 is None` early return:

```python
    if await _cleared_since_generation_start(client, user_id=user_id, trip_id=trip_id):
        # The user cleared memory during this generation. Re-adding would silently
        # un-clear it. No audit row: nothing was learned and nothing failed.
        return learned
```

**Fake work required** (and this is where false coverage hides):
- `pipeline/test_preferences.py::_FakeClient.table` currently **asserts `name == "memory_events"`** and
  `_FakeTable` supports only `insert`. Extend to a small multi-table fake supporting
  `select`/`eq`/`gt`/`maybe_single`. **`.gt()` must genuinely filter** — a `return self` no-op is the
  `_Table.order` bug (BUILD-LOOP "tests that cannot fail" #4) and would make every guard test vacuous.
- `maybe_single()` must return a **bare `None`** on zero rows and **raise** on multiple, matching
  postgrest 2.31.0 (`test_main.py:135-139` documents this; a forgiving fake previously hid a real 500).

**Tests**:
1. no `'cleared'` row → write proceeds (`mem0.add` called, `'learned'` row written)
2. `'cleared'` row **newer** than `trips.created_at` → **`mem0.add` NOT called**, no audit row
3. `'cleared'` row **older** than `trips.created_at` → write proceeds (a clear before this trip must not suppress it — this is the test that makes `.gt()` load-bearing)
4. `'cleared'` row belonging to a **different user** → write proceeds (proves the `user_id` filter)
5. an event of a different `event_type` newer than the reference → write proceeds (proves the `event_type` filter)
6. trips lookup raises → write skipped (fail-safe)
7. trip row absent (`maybe_single` → bare `None`) → write skipped
8. `memory_events` lookup raises → write skipped

### T4 — Live-verify script `backend/scripts/smoke_memory_clear.py`

A destructive endpoint cannot be live-verified like a read (spec §5). Reuse
`smoke_generate.py`'s throwaway-user pattern (`_provision_user` / `_delete_user`, `KEEP_USER=1`):

1. admin-provision a throwaway Supabase user + JWT
2. seed a memory for that user via mem0 `add`, poll `GET /settings/preferences` until it appears
3. `POST /settings/memory/clear` → assert `200 {"cleared": true}`
4. `GET /settings/preferences` → assert `status: "ok"`, `facts: []`
5. `POST /settings/memory/clear` **again** → assert it does not 500 (E4 idempotency)
6. assert a `memory_events` row with `event_type='cleared'` exists for that user
7. unauthenticated `POST` → 401
8. delete the throwaway user (unless `KEEP_USER=1`)

> Runs against the live mem0 account + live Supabase ⇒ **requires the user's explicit go before
> execution.** Only ever operates on the throwaway id it provisions; never `621ef3d1-…`.

### T5 — Docs

- `.claude/docs/ARCHITECTURE.md` — add the endpoint to the route list.
- Amend the spec's §4.2/§4.3 with a pointer to this plan's §1 (the method choice and the
  always-verify correction supersede it).
- `docs/PRD.md` §1114 implementation-status note — Settings memory clear is no longer deferred.

**Out of scope (Zhi Hao's card):** `SettingsView.tsx` still imports from `mock-api`. Until his half
lands, the honest interim is a **disabled** Clear button — strictly better than a fake success.

---

## 5. Fault-injection matrix (BUILD-LOOP non-negotiable)

For each guard: `find . -name __pycache__ -type d -not -path "./.venv/*" -exec rm -rf {} +`, delete the
guard, confirm the named test reddens, restore. **Report any injection that comes back GREEN.**

| Guard | Delete this | Test that must redden | Why it is attributable |
|---|---|---|---|
| blank-uid refusal | the `if not uid` block | T1-3 | asserts `delete_all` was **never called**; no other path yields an empty call list with a blank uid |
| audit-before-delete | move the insert after the delete | T1-10 | asserts `delete_all` never called when the insert fails — impossible if the delete runs first |
| always-verify | `return "cleared"` right after the delete | T1-8 | fake's delete succeeds but the read still returns a fact; only the verify read can produce `"unknown"` here |
| `_confirmed_not_deleted` HTTP branch | `startswith("HTTP_")` clause | T1-4 | asserts the verify read was **not** issued; the fall-through path always issues it |
| timeout-is-not-failure | treat `TimeoutError` as confirmed failure | T1-6 | expects `"cleared"`, which the failure path cannot produce |
| `.gt()` in the guard | the `.gt(...)` clause | T3-3 | an older `'cleared'` row would then match and suppress the write; **the fixture's natural state must NOT already satisfy the assertion** (BUILD-LOOP trap #2) |
| `user_id` filter in the guard | the `.eq("user_id", …)` | T3-4 | another user's `'cleared'` row would match |
| `event_type` filter | the `.eq("event_type","cleared")` | T3-5 | a `'learned'` row would match |
| guard call site | the `if await _cleared_since_generation_start(...)` | T3-2 | `mem0.add` would be called |
| fail-safe on lookup error | `return True` in the `except` | T3-6 | the write would proceed |

**Attribution discipline (BUILD-LOOP trap #7 — it fired four times on the previous mem0 arc).** No
disjunctive assertions. Each test's expected value must be **unreachable from the other guards**. In
particular T1-8 must assert exactly `"unknown"`, never `in ("unknown","unavailable")` — those are
produced by different guards and a disjunction would make neither attributable.

---

## 6. Guardrail mapping

| Guardrail | How |
|---|---|
| #3 best-effort partial failure | **Deliberate exception, documented.** The clear is strict; the read still degrades. Four consecutive arcs built degrade-silently agents — that muscle memory would recreate the exact bug being fixed here. |
| #4 schema parity | Pydantic + TS mirror in the same PR. No DB side (no migration). |
| #5 auth on every endpoint | `Depends(get_current_user_id_stashed)` |
| #6 owner check | `user_id` is token-derived, never body/query/path. Ownership is structural — a user can only clear their own memory. `service_role` bypasses RLS, so the app-code path is the enforcement. |
| #7 write-through caches | N/A — no cache; the live read is the deliberate alternative. |
| #11 untrusted content | No reel text on this path. |
| #12 durable jobs | Unchanged. The guard only *suppresses* a best-effort write-back; it never fails a trip. |
| Eval-safety | No deterministic path touched. `preferences.py` still never imports `mem0` at module scope (E7). `uv run pytest evals/ -q` → 49, anchor `6229.0`. |
| Stack freeze | No new dependency. `mem0ai` + `slowapi` already present. |

---

## 7. Deferrals (each with a concrete trigger)

1. ~~**TOCTOU between the guard's read and `mem0.add`.**~~ — **CLOSED by C11 (§8f), 2026-08-04.**
   This deferral understated the window twice: it is not a "millisecond gap" but includes the guard
   query's own round-trip, bounded by the 30s HTTP timeout. Codex's cross-model code review raised it
   as a P1 DO-NOT-MERGE. The intent-first reorder closes it, and a barrier test now reproduces the
   interleaving — including reddening under the *insufficient* patch (intent written immediately
   before the add), so the test discriminates the real fix from the plausible-wrong one.
2. **No event-status polling.** `get_event_status` would be authoritative but is not on the SDK (E6).
   **Trigger:** mem0 ships it on `AsyncMemoryClient`, or verify-read false-`unknown`s become common.
3. **Bounded retry on the verification read.** A single read may run before propagation and report a
   false `unknown`. **Trigger:** observed `memory_clear_unknown` rate is non-trivial in production.
4. **Backfill-cleaning existing trip-history memories** — unchanged from the spec.
5. **`user_preference_facts` writes** — unchanged; trigger is measured latency/quota pressure.

---

## 8. Deployment reality (for the Codex cross-model gate)

- **Merging to `dev` now deploys.** `autoDeployTrigger: checksPass` + `preDeployCommand` running
  `backend/scripts/assert_schema.py`. Both CI workflows (~3 min) and the schema gate must pass.
- **This arc adds NO migration.** Verified independently, not taken from the spec:
  `memory_events.trip_id` is nullable (`20260701131304_identity_persona_foundation.sql:123`, no
  `not null`) and `event_type` CHECK at `:127` already permits **both** `'cleared'` and `'failed'`.
  ⇒ no `REQUIRED_SCHEMA` change, no deploy-ordering hazard, the column-drift probe is not engaged.
- **What is running right now:** `dev` @ `154bfd8` already serves `GET /settings/preferences` and
  `/readiness` with the `mem0` field.
- **NOT "purely additive" — corrected per C6.** An earlier draft of this line said it was. It is not.
  The new *route* has no caller on merge (the frontend still calls the mock), but the **write-back
  changes behaviour for every explicit-preference generation immediately**: after C11 (§8f) the common
  path performs **three** Supabase ops (the intent insert + the guard's two reads), the guard-fires
  path adds an insert+delete where it previously wrote nothing, a lookup failure *suppresses* learning
  (D7, fail-safe), and an **intent-insert failure now aborts the add entirely** — a DB blip costs one
  learned memory. Memory-only and inferred trips are unaffected: they return before any of this
  (`preferences.py`: `if not text` and `if mem0 is None` both precede it).
  Memory-only and inferred trips are unaffected — they return before the guard runs
  (`preferences.py`: `if not text` and `if mem0 is None` both precede it).
- **Rollback is CODE-ONLY, not a full rollback — corrected per C6.** `git revert` restores the
  previous write-back behaviour and renders already-written `'cleared'` rows inert. It **cannot
  restore mem0 memories that were successfully deleted** — those are gone permanently. Moot until the
  frontend calls the endpoint, but it is the reason this arc is gated on a live smoke rather than
  unit tests alone.
- **Ask explicitly for consequences beyond this boundary**: the frontend still calls the mock, so the
  endpoint has **no caller** on merge. Please flag anything that assumes a caller exists, and anything
  about the interaction between the new suppression branch and a *recovery re-run* of a trip
  (guardrail #12 restart-with-cache-reuse re-executes from Phase 1 with the ORIGINAL `trips.created_at`).
- Say plainly when you find nothing at a given severity.

---

## 8b. Amendments — Codex cross-model plan review, round 1 (2026-08-03)

> Codex `gpt-5.6-sol` scored the plan **4.5/10 — FAIL** (Correctness 2, Risk management 3), with
> **3 P1s**. It adjudicated the research disagreement in this plan's favour (**"D1 `delete_all` and
> D3 always verify are the right choices"**, E1/E2/E3 confirmed) and confirmed the no-migration
> claim, then found three real correctness holes. **Amendments below supersede the inline task code
> above where they conflict.**

### A1 — [P1] `HTTP_*` ⇒ "nothing deleted" is wrong for 5xx (the reverse lie)

**Verified against the SDK, not taken on faith:** `HTTP_STATUS_TO_EXCEPTION` (`exceptions.py:407-421`)
maps **500 / 502 / 503 / 504** — and **408** — to exception classes, so all of them arrive with
`error_code="HTTP_5xx"` and a `debug_info["status_code"]`. §3's rule classified every one of those as
"server rejected ⇒ nothing deleted".

**Failure scenario:** mem0 accepts and enqueues the deletion; a gateway then returns 504. The endpoint
replies `503 memory_unavailable` — *"Nothing was deleted"* — while the delete completes. That is the
reverse half of the lie this arc exists to remove.

**Only a failure proven to have had no effect may skip verification.** Replace `_confirmed_not_deleted`:

```python
def _status_code_of(e) -> int | None:
    debug = getattr(e, "debug_info", None)
    if isinstance(debug, dict) and isinstance(debug.get("status_code"), int):
        return debug["status_code"]
    code = getattr(e, "error_code", None)
    if isinstance(code, str) and code.startswith("HTTP_"):
        try:
            return int(code[5:])
        except ValueError:
            return None
    return None


def _confirmed_nothing_deleted(e: Exception) -> bool:
    """True ONLY when the delete provably had no effect.

    Safe to classify without verifying:
      * NET_CONNECT — the connection was never established, so nothing was sent.
      * 4xx except 408 — the server rejected the request before doing any work.

    NOT safe (must verify instead):
      * 5xx (500/502/503/504) — mem0 may have ACCEPTED and enqueued the delete before a
        gateway timed out. Reporting "nothing was deleted" here is the REVERSE lie, and
        exceptions.py:407-421 maps every one of these to an HTTP_* error_code.
      * 408 — ambiguous by definition.
      * NET_TIMEOUT / NET_GENERIC / asyncio.TimeoutError — the request may have landed.
      * anything unrecognised, e.g. a locally raised ValueError carrying no .error_code.
    """
    if getattr(e, "error_code", None) == "NET_CONNECT":
        return True
    status = _status_code_of(e)
    return status is not None and 400 <= status < 500 and status != 408
```

### A2 — [P1] `list_memory_facts` is a lossy reader and must not be the destructive verifier

`list_memory_facts` drops rows whose `memory` is non-string or blank and still returns `"ok"`
(`preferences.py:151-172`). **Failure scenario:** the delete has not completed and mem0 returns
`{"count": 1, "results": [{"id": "m1", "memory": null}]}` (shape drift, or a malformed stored record).
`list_memory_facts` → `("ok", [])` → the endpoint reports `200 {"cleared": true}` while a record
remains.

A **presentation** reader and a **destructive verifier** have opposite biases: presentation should drop
junk; verification must treat anything unparseable as *still there*. Reusing the former for the latter
was a DRY instinct applied across a semantic boundary. Add a dedicated strict check (this needs no
public `count` field — the non-goal stands):

```python
async def _memory_is_empty(mem0, user_id: str) -> bool:
    """STRICT emptiness check for the destructive path — deliberately NOT list_memory_facts.

    Returns True ONLY when the envelope is well-formed AND holds zero rows. Any error,
    any unrecognised envelope, and any surviving row all read as "not empty", because a
    row we cannot parse is a row that still EXISTS.
    """
    try:
        res = await asyncio.wait_for(
            mem0.get_all(version="v2", filters={"AND": [{"user_id": user_id}]},
                         page=1, page_size=1),
            timeout=_CLEAR_VERIFY_TIMEOUT_S)
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear verify unavailable: {type(e).__name__}", file=sys.stderr)
        return False
    if isinstance(res, list):
        return not res
    if not isinstance(res, dict):
        return False
    rows = res.get("results")
    if not isinstance(rows, list) or rows:
        return False                        # unrecognised envelope, or rows survive
    return res.get("count") in (None, 0)    # count is authoritative when present
```

`clear_memory`'s tail becomes `return "cleared" if await _memory_is_empty(mem0, uid) else "unknown"`.

### A3 — [P1] The async-`add()` race is multi-second, not "millisecond TOCTOU"

`persist_trip_memory` issues `mem0.add(...)`, which returns `{"status": "PENDING"}` in ~570 ms while the
memory takes **~4-8 s** to become readable (measured; `add` event latency 4038 ms this session).
The §4 T3 guard runs only *before* submission.

**Failure scenario:** a generation's `add()` returns PENDING → the user clears → `delete_all` plus the
verification read see an empty account → `200 {"cleared": true}` → the pending add then materializes
and the fact reappears. §7 deferral 1 called this a "millisecond TOCTOU"; it is a multi-second window,
and **T4 cannot detect it** because T4 waits for the seed add to become visible before clearing.

Fully preventing it needs ordering guarantees mem0 does not document. What the contract *can* do is
stop lying: detect a possibly-in-flight add and report `unknown` rather than `cleared`.

```python
_ADD_VISIBILITY_WINDOW_S = 15   # ~2x the observed 4-8s PENDING->readable latency


async def _add_possibly_in_flight(client, *, user_id: str, now_ref: str | None) -> bool:
    """True if a generation issued a mem0.add recently enough that it may still be
    materializing — in which case an empty verification read is not trustworthy.

    `now_ref` MUST be a Postgres-sourced timestamp (the audit insert's returned
    created_at), never datetime.now(): memory_events.created_at is Postgres `now()`, and
    mixing in this host's clock is the skew bug jobs.py:94-97 already documents. When no
    Postgres reference is available the check is SKIPPED and logged (see §7 deferral 6).
    """
    if not now_ref:
        print("[mem0] clear: no Postgres time reference; in-flight add check skipped",
              file=sys.stderr)
        return False
    try:
        res = await client.table("memory_events").select("id") \
            .eq("user_id", user_id).eq("event_type", "learned") \
            .gt("created_at", _minus_seconds(now_ref, _ADD_VISIBILITY_WINDOW_S)).execute()
    except Exception:                       # noqa: BLE001
        return True                         # cannot rule it out → never claim a confirmed clear
    return bool(res.data)
```

`now_ref` comes from the A4 audit insert's returned row (`res.data[0]["created_at"]`), so both sides of
the comparison are Postgres-origin. It is stale by the delete's duration (~0.4-5 s), which widens the
window slightly — the conservative direction.

Ordering in `clear_memory`: verify empty → **then** in-flight check → `cleared` only if both agree.

### A4 — [P2] A `'cleared'` marker left behind by a FAILED delete suppresses learning

D4 arms the guard by inserting `'cleared'` before the delete. If the delete then confirmably fails, the
endpoint truthfully says nothing was deleted — but the marker persists, and the guard (which matches
*any* later `'cleared'` row and ignores `'failed'`) suppresses the write-back for every in-flight
generation and for a recovery re-run. The audit trail then asserts both "cleared" and "failed".

Codex is explicit that keying on the original `trips.created_at` is otherwise **correct** for recovery
("recovery replays inputs submitted before the clear, so suppressing them is the safe direction") —
the defect is the marker's false semantics, not the timestamp. So **retract the marker** instead of
changing the key:

- capture the inserted row's `id` (and `created_at`, for A3) from the insert response;
- on `_confirmed_nothing_deleted`, **delete that row by id**, then insert the `'failed'` audit row;
- if the retraction delete fails, log and leave it — over-suppression is bounded (only generations
  whose `trips.created_at` precedes the marker) and is the fail-safe direction.

A pending-or-succeeded clear keeps suppressing, which is what we want; only a *confirmed failure*
retracts. No migration: this is an insert + a delete on an existing table.

### A5 — [P2] `pipeline/test_runner.py` has a SECOND Supabase fake the plan never touched

Verified: `test_runner.py:26` defines its own `_Table` with `eq`/`in_`/`gte`/`lte` and **no `.gt()`,
no `.maybe_single()`**, and its fixtures seed no `trips` row carrying `created_at`. Implementing T3
verbatim makes the guard's lookup raise `AttributeError`, D7 swallows it and skips the write-back — so
the existing write-back-failure test (`test_runner.py:838`) can no longer produce its expected
`'failed'` event. **T3 must extend that fake too and seed a `trips` row**, and add a test for an actual
recovery re-run against the original `trips.created_at`. (`select` there takes a single positional
`cols`, unlike `test_main.py`'s `*_cols` — match each fake's own signature.)

### A6 — [P2] Two rows of the §5 fault-injection matrix do not redden as claimed

- **`_confirmed_not_deleted` HTTP branch.** Deleting the `startswith("HTTP_")` clause does NOT redden
  T1-4: a faithful SDK exception also carries `debug_info["status_code"]`, so the fallback still
  returns True. Under A1 the two readers are one helper (`_status_code_of`) — fault-inject **the
  4xx/408 predicate in `_confirmed_nothing_deleted`**, and assert the verify read WAS issued.
- **Fail-safe on lookup error.** Deleting `return True` from the trip-lookup `except` leaves `trip`
  unbound → `UnboundLocalError`, so a red test proves only that the function crashed, not that the
  guard is load-bearing. **Fault-inject `return False` instead** and assert `mem0.add` becomes
  reachable.

Both are exactly BUILD-LOOP trap #7 in a new costume: an outcome reachable by more than one path is
not attributable to the guard under test.

### A7 — [P2] `get_supabase_client()` raising in the route yields 500, not a documented outcome

T2 awaits `get_supabase_client()` before entering `clear_memory`. If `acreate_client` raises, the
global handler emits `500 internal_error` — outside the documented contract — even though no delete
was attempted. Wrap it and map to `503 memory_unavailable` (truthful: nothing was deleted), with a test.

### A8 — [P2] T5's doc wording overstates what shipped

`SettingsView.tsx:38` still renders success unconditionally from the `mock-api` no-op, so on merge beta
users see the **same fake success**. T5 must NOT mark PRD §1114's "Settings memory clear" as no longer
deferred. Correct wording: **"backend endpoint shipped and verified; frontend wiring still pending
(Zhi Hao's card)."** Also record the cost this adds with no caller yet: every explicit-preference
write-back now pays **two extra Supabase reads** and skips learning when the lookup fails.

### A9 — [P3-ish] E7's wording is too broad

"Every mem0 exception carries `.error_code`" holds for `MemoryError` subclasses and HTTP/request-derived
errors, but a locally raised `ValueError` (e.g. `delete_users`' zero-filter path) passes through with no
`.error_code`. The unknown-exception fallback already handles it — the claim's wording is what needs
narrowing, not the code.

## 8c. Amendments — gstack eng review, round 1 (2026-08-03)

> `astrail-reviewer` (sonnet), independent context, scored **7.5 overall — VERDICT: Needs-fixes**
> (Correctness 7, Completeness 7, Risk 7, Test quality 7, Maintainability 8, Clarity 9). It
> re-ran both baselines itself (**1310 passed / 8 skipped**, **evals 49**) and spot-checked every
> line citation.
>
> **It independently found the SAME 5xx P1 as Codex** — two models, separate contexts, converging on
> one hole. A1 already fixes it. It also **verified two things this plan only claimed**:
>
> - **The guard is correct for a recovery re-run.** It traced that `trips` is INSERTed exactly once
>   in `POST /generate-trip` (`main.py` ~398) and **never re-inserted** on restart-with-cache-reuse —
>   only `.update()` touches the row. So `trips.created_at` is genuinely stable across a crash+restart
>   and D5's key holds. This was the dispatch brief's biggest suspected risk; it is not a risk.
> - **D2 is defense-in-depth, not decoration hiding a gap.** `get_current_user_id` (`auth.py:127-130`)
>   raises 401 before a blank/None `sub` could reach the route, so the guard is inert on the current
>   call path — which the plan already said of itself. Legitimate given the blast radius.

### A10 — [P2] The §5 fault-injection matrix is under-inclusive, and BUILD-LOOP calls it non-negotiable

Cross-checking §4's 11 T1 tests and 8 T3 tests against §5's 10 rows, **three guards have no row at all**.
A developer treating §5 as the literal checklist would believe coverage is complete without ever proving
these are load-bearing — and an un-injected guard cannot be "reported GREEN" either way. Add:

| Guard | Delete this | Test that must redden | Why it is attributable |
|---|---|---|---|
| `mem0 is None` early return | the `if mem0 is None` block | **T1-2** | asserts **no audit row is written**; every other path writes one before the delete |
| `NET_CONNECT` branch (distinct from the 4xx branch) | the `== "NET_CONNECT"` clause | **T1-5** | a `NET_CONNECT` error carries no `status_code`, so with the clause gone it falls through to verify → `"unknown"`, not `"unavailable"` |
| `if not started_at: return True` | that `if` block | **T3-7** | a genuinely separate path from the two `except` blocks: `maybe_single()` returns a **bare `None`** on zero rows *without raising* (postgrest 2.31.0, `test_main.py:135-139`), so no exception handler is involved |

**And a caveat the table's "delete this" phrasing cannot express.** T1-6 (NET_TIMEOUT → verify),
T1-7 (`asyncio.TimeoutError`), and T1-11 (unrecognised exception) are proven by the **absence of a
wrong branch**, not by deleting a present one — there is no line to remove. Prove them by *adding*
the wrong branch (classify the case as confirmed-failure) and watching the test redden. State this
explicitly rather than leaving three rows silently missing, which is how "the matrix is complete"
becomes a false claim.

### A11 — [P3] The `debug_info["status_code"]` branch: dead before A1, primary after it

The reviewer found (by grepping the whole package) that no path in mem0ai 2.0.10 raises a typed
exception with `debug_info["status_code"]` set but a non-`HTTP_` `error_code` — so as originally
ordered, that branch was unreachable defensive code.

**A1's restructure already resolves this**, and in the better direction: `_status_code_of` reads
`debug_info["status_code"]` **first** and falls back to parsing the `HTTP_` prefix.
`_handle_http_error` (`utils.py:30-34`) always builds `debug_info` with `status_code`, so the primary
branch is now the live one and the prefix parse is the insurance. Keep both; no change needed beyond
noting why.

### A12 — [P3] D1's entity-recreation rationale IS measured — cite it, and close the loop in T4

"mem0 recreates the entity transparently on the next `add()`" is not an assumption. The
`astrail-researcher` probe measured it directly: `add` → `delete_entities` → `add` again with the
**same** `user_id` → `PENDING` → `SUCCEEDED` (7.4 s), `list_entities` showing the id transparently
recreated with a new internal id and fresh `created_at`, and the memory readable. Cite that in D1
rather than asserting it.

Cheap loop-closer, since this is the specific rationale for choosing `delete_all` over `delete_users`:
**add a step 9 to T4** — after the clear, seed one more memory for the throwaway user and confirm it
becomes readable and that `persist_trip_memory`'s path does not record `'failed'`. One extra call,
and it converts D1's rationale from cited-measurement to end-to-end-verified.

## 8d. Amendments — gstack eng review, round 2 (2026-08-03, on the amended plan)

> Second `astrail-reviewer` pass, reading §8b (A1-A9) against the code. It cleared A4's technique
> (id-capture-from-insert-response is an established pattern — `main.py` ~398 does
> `(await client.table("trips").insert({...}).execute()).data[0]`) and found **no new correctness bug**
> in the retraction's race analysis. Four findings beyond both gates' earlier lists.

### A13 — [P2] There is a THIRD undisclosed deviation from the design spec

§1 calls out two deviations (D1 method choice, D4 audit ordering). There is a third, and it has been
silent through two gates: **spec §4.2 says the verify path returns `memory_unavailable` when memories
are still present** ("memories gone → success; memories present → `memory_unavailable`; verification
itself unclear → `memory_clear_unknown`"). This plan's §3 table maps **both** "facts remain" and "read
failed" to `memory_clear_unknown`, and never returns `memory_unavailable` from the verify path at all.

The deviation is **deliberate and, I believe, more correct than the spec's literal wording**: after an
ambiguous attempt, calling facts-remain "CONFIRMED nothing was deleted" is the same overclaim A1
exists to remove — the delete may simply not have finished (E1: the call returns ~460 ms before
completion). But an undisclosed deviation is a review hazard regardless of whether it is right.
**Record it in §1/§2 alongside D1 and D4.**

### A14 — [P1-lite] A3 misses the very case it was added for: a timed-out `add()` is recorded `'failed'`

`persist_trip_memory` (unchanged by this arc) does `except Exception: event_type = "failed"` on **any**
`mem0.add()` error *or timeout* — itself an unverified confirmed-failure claim, the exact class of bug
A1 fixes for `delete_all`. A3's `_add_possibly_in_flight` searches only `event_type == 'learned'`.

**Failure scenario:** a generation's `add()` exceeds the 5 s `wait_for`; mem0 nonetheless lands it. The
audit row says `'failed'`. The user clears. A3 finds no `'learned'` row, reports `cleared: true`, and
the add then materializes — the precise resurrection A3 was introduced to catch, in the case where an
add is *most* likely still in flight.

**Fix (closes it rather than documenting it):** match both types.

```python
        res = await client.table("memory_events").select("id") \
            .eq("user_id", user_id).in_("event_type", ["learned", "failed"]) \
            .gt("created_at", _minus_seconds(now_ref, _ADD_VISIBILITY_WINDOW_S)).execute()
```

`'failed'` means "an add was issued and we could not confirm it", which is exactly the uncertainty A3
must respect. Do **not** widen this to "any recent memory_event": that would match the endpoint's own
just-inserted `'cleared'` row and make every clear return `unknown`.

`.in_()` must be added to the `test_preferences.py` fake (and it must genuinely filter — `test_runner.py`'s
fake already has `in_`; match its semantics). Add a test: a recent `'failed'` row alone must yield
`unknown`, which no other guard can produce.

### A15 — [P2] The `UnboundLocalError` shape A6 fixed exists in the SECOND `except` too, and in T3-7

A6 corrected the fault-injection recipe for the trips-lookup `except`. **The `memory_events` lookup
(T3-8) has the identical shape** — `try: res = await …` / `except: return True` / `return bool(res.data)`
— so deleting its `return True` also leaves `res` unbound and crashes with `UnboundLocalError` rather
than letting the write proceed. A red test would prove only that the function crashed.

The same applies to **T3-7** (`if not started_at: return True`, added to the matrix in A10): deleting
that block lets `started_at=None` flow into `.gt("created_at", None)`, which is not a clean redirect to
"write proceeds" — and `.eq(col, None)` / `.gt(col, None)` is never valid against postgrest anyway.

**Rule for all three rows: fault-inject `return False`, then assert `mem0.add` becomes reachable.**
Never prove a guard by deleting a line whose removal crashes the function — a crash is not the guard's
absence, it is a different bug wearing the guard's name.

### A16 — [P2] A3 silently changes the preconditions of every test that expects `"cleared"`

T1-1 (happy path) and T1-6 (NET_TIMEOUT-is-not-failure) both assert `"cleared"`. After A1-A3, reaching
`"cleared"` requires `_memory_is_empty` **and** `not _add_possibly_in_flight`. Unless both fixtures
explicitly seed "no recent `'learned'`/`'failed'` row", they will start asserting `"unknown"` for a
reason unrelated to what each test is named for — the tests would still pass or fail, but no longer
for their stated cause.

**Every test expecting `"cleared"` must set up the empty-in-flight precondition explicitly**, and the
fixture must not satisfy it by accident (BUILD-LOOP trap #2: if the fixture's natural state already
satisfies the assertion, the assertion tests nothing).

### A17 — [P2] Extract the clear path to `backend/pipeline/memory_clear.py`

Line math after all amendments: 211 today + T1 (~76) + T3 (~35) + A1 (+~15) + A2 (+~20) + A3 (+~35)
+ A4 (+~15) ≈ **~407 lines** — past the 200-400 band this repo's style rules and the source spec both
cite, though under the 800 hard max. The clear path alone (`clear_memory`, `_status_code_of`,
`_confirmed_nothing_deleted`, `_memory_is_empty`, `_add_possibly_in_flight`, `_minus_seconds`) is now
about the size of the entire original file.

**Split along the seam that already exists** — the endpoint's logic vs. the write-back's:

- **new `backend/pipeline/memory_clear.py`** — `clear_memory` + its five helpers. `main.py`'s route
  imports from here.
- **`backend/pipeline/preferences.py` keeps** `persist_trip_memory` and
  `_cleared_since_generation_start` (the guard belongs with the write-back it guards), landing at
  ~250 lines.

Both end up comfortably in band, each with one job. This is a file move, not a design change — do it
as part of T1 rather than as a follow-up, since moving the code later costs a second review.

### Additions to §7 Deferrals

6. **No Postgres time reference ⇒ the in-flight-add check (A3) is skipped.** Occurs only if the audit
   insert response omits `created_at`. **Trigger:** the stderr line appears in Render logs.
7. **The A3 check reports `unknown`, it does not prevent the resurrection.** Preventing it needs
   ordering guarantees mem0 does not document. **Trigger:** a user reports a fact reappearing after a
   clear, or `'cleared'`/`'learned'` audit pairs show it happening.
8. ~~**A ~570 ms detection gap inside A3 — AND a wider variant (C4-bis).**~~ — **CLOSED by C11 (§8f),
   2026-08-04.** Both halves are fixed: the intent row is now written *before* the guard reads (so no
   add is ever unobservable), and an intent-insert failure **aborts the add** rather than letting a
   permanently-invisible add proceed. That second half is the C4-bis closure, and it is a deliberate
   behaviour change — a DB blip now costs one learned memory instead of risking a false `cleared`.
9. **`persist_trip_memory` still makes A1's mistake for `add()`.** It records `'failed'` on any
   `add()` error *or timeout* without verifying — an unverified confirmed-failure claim. A14 works
   *around* it (by treating `'failed'` as "possibly in flight") rather than fixing it. **Trigger:**
   the next arc that touches the write-back path; fix it there with A1's `_confirmed_nothing_deleted`.

## 8e. FINAL CONSOLIDATED DESIGN — Codex round 2 (3.5/10 FAIL) forced this

> **THIS SECTION IS THE IMPLEMENTATION TARGET.** It supersedes §4's inline code AND the A1-A17
> fragments. Codex R2's decisive finding: the amendments do not compose. A2 and A3 each supply a
> different tail for `clear_memory`; `_CLEAR_VERIFY_TIMEOUT_S` and `_minus_seconds` are never
> defined. Transcribed literally, `_memory_is_empty` catches a `NameError` → False and
> `_add_possibly_in_flight` catches one → True, making `"cleared"` **unreachable**. A plan that
> fails closed and silently is worse than one that fails loudly. Below is one complete algorithm.

### C1 — What `cleared: true` actually asserts (contract clarification)

Codex R2 P1: on a first-ever or second clear, `delete_all` is a no-op, verification finds zero rows,
and the endpoint returns `200 {"cleared": true}` having deleted nothing — which collides with the
literal rule *"never report success without having deleted something."*

**Resolution: `cleared: true` asserts a POSTCONDITION — "your memory is now empty."** Not "we deleted
≥1 record." Clearing an already-empty account legitimately succeeds; that is what the user asked for
and what the UI needs to render. The rule's real intent — *never report success while records remain*
— is preserved exactly. This is stated here because it is a genuine, deliberate reading of the
governing rule, and an unstated one would be a review hazard (cf. A13).

### C2 — The confirmed-failure bucket narrows to `NET_CONNECT` alone

Codex R2 P1: an HTTP status proves which exception class the SDK raised, **not** that the server had
no side effects. Concretely — a first request is accepted but its response is lost; the retry gets
**409 "deletion already in progress"**; A1 would call that "confirmed nothing deleted" while the first
deletion completes. **429** can come from a gateway and says nothing about application atomicity.
mem0 documents no 4xx atomicity guarantee.

So `_status_code_of` is **deleted entirely** (which also resolves A11's unattributed-fallback
finding), and everything except a proven-unsent request verifies. The extra read on a genuine 401 is
one cheap call, and it can only downgrade `unavailable` → `unknown`, never overclaim.

### C3 — The complete implementation

```python
# backend/pipeline/memory_clear.py   (A17: extracted so preferences.py stays ~250 lines)
"""POST /settings/memory/clear — the STRICT half of the mem0 settings surface.

Deliberate inverse of GET /settings/preferences: that read DEGRADES (guardrail #3), this
fails loudly. Guardrail #3 does NOT apply to a destructive user-facing action.
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta

_CLEAR_TIMEOUT_S = 5             # ~13x the measured 374ms steady-state delete
_VERIFY_TIMEOUT_S = 4            # matches list_memory_facts' existing read timeout
_ADD_VISIBILITY_WINDOW_S = 15    # ~2x the measured 4-8s PENDING -> readable latency


def _minus_seconds(ts: str, seconds: int) -> str | None:
    """Subtract from a POSTGRES-sourced ISO timestamp. None when unparseable — callers
    MUST treat None as 'no reference', never as 'no add in flight'."""
    try:
        return (datetime.fromisoformat(ts) - timedelta(seconds=seconds)).isoformat()
    except (TypeError, ValueError):
        return None


def _confirmed_nothing_deleted(e: Exception) -> bool:
    """True ONLY when the request provably never reached mem0.

    Narrowed to NET_CONNECT alone (Codex R2). An HTTP status tells us which exception
    class the SDK raised, NOT that the server had no side effects: a 409 can mean "a
    deletion is already in progress" — possibly OUR retried request — and a 429 can come
    from a gateway. Everything else VERIFIES rather than asserting.
    """
    return getattr(e, "error_code", None) == "NET_CONNECT"


async def _write_clear_marker(client, user_id: str) -> tuple[str | None, str | None]:
    """Insert the 'cleared' audit row BEFORE the delete so persist_trip_memory's guard is
    armed before anything can be deleted (D4). Returns (row_id, created_at).

    created_at is POSTGRES-sourced and is the ONLY clock comparable against
    memory_events.created_at — stamping this host's clock is the skew bug jobs.py:94-97
    already documents for the job lease.
    """
    try:
        res = await client.table("memory_events").insert({
            "user_id": user_id, "trip_id": None, "event_type": "cleared",
            "learned_facts_json": [],
        }).execute()
        row = (getattr(res, "data", None) or [{}])[0]
        return row.get("id"), row.get("created_at")
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear aborted, audit insert failed: {type(e).__name__}", file=sys.stderr)
        return None, None


async def _mark_marker_failed(client, marker_id: str) -> None:
    """Flip the marker to 'failed' in ONE statement.

    Codex R2: delete-then-insert is not atomic — retraction-succeeds/insert-fails loses
    the attempt from the audit trail entirely, and retraction-fails leaves a stale marker
    that keeps suppressing. A single UPDATE either records the truth or leaves the
    conservative 'cleared' marker, which over-suppresses in a bounded way rather than
    resurrecting cleared data. It also never destroys an audit record (spec §10).
    """
    try:
        await client.table("memory_events").update({"event_type": "failed"}) \
            .eq("id", marker_id).execute()
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear marker retraction failed: {type(e).__name__}", file=sys.stderr)


async def _memory_is_empty(mem0, user_id: str) -> bool:
    """STRICT emptiness check — deliberately NOT list_memory_facts, which drops
    unparseable rows and still reports "ok" (a presentation reader and a destructive
    verifier have opposite biases).

    True ONLY on a well-formed envelope proving zero rows. The SDK documents
    `count: int` + `results: list`; anything else is shape drift, and for a destructive
    verifier drift must never read as empty.
    """
    try:
        res = await asyncio.wait_for(
            mem0.get_all(version="v2", filters={"AND": [{"user_id": user_id}]},
                         page=1, page_size=1),
            timeout=_VERIFY_TIMEOUT_S)
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear verify unavailable: {type(e).__name__}", file=sys.stderr)
        return False
    if not isinstance(res, dict):
        return False                        # legacy/list envelopes are NOT established here
    rows, count = res.get("results"), res.get("count")
    # `type(count) is int` on purpose: bool subclasses int, and False == 0 would sneak
    # a drifted payload through as "empty".
    return isinstance(rows, list) and not rows and type(count) is int and count == 0


async def _add_possibly_in_flight(client, *, user_id: str, now_ref: str | None) -> bool:
    """True if a generation's mem0.add may still be materializing, in which case an empty
    verification read is not trustworthy (add returns PENDING in ~570ms; the memory
    becomes readable ~4-8s later).

    Matches BOTH 'learned' AND 'failed': persist_trip_memory records 'failed' on any add
    error OR TIMEOUT, and a timed-out add is exactly the case most likely to still land.

    Requires trip_id IS NOT NULL so this never matches the clear endpoint's OWN audit
    rows (trip_id NULL) — otherwise one previously failed clear would make every later
    clear report 'unknown' forever.
    """
    cutoff = _minus_seconds(now_ref, _ADD_VISIBILITY_WINDOW_S) if now_ref else None
    if cutoff is None:
        # Conservative, and deliberately NOT "skip the check": without a reference we
        # cannot rule out an in-flight add, and claiming a confirmed clear anyway is the
        # exact overclaim this endpoint exists to prevent.
        print("[mem0] clear: no usable Postgres time reference; assuming an add may be "
              "in flight", file=sys.stderr)
        return True
    try:
        res = await client.table("memory_events").select("id") \
            .eq("user_id", user_id).in_("event_type", ["learned", "failed"]) \
            .not_.is_("trip_id", "null") \
            .gt("created_at", cutoff).execute()
    except Exception:                       # noqa: BLE001
        return True                         # cannot rule it out -> never claim cleared
    return bool(getattr(res, "data", None))


async def clear_memory(client, mem0, *, user_id: str) -> str:
    """Delete this user's mem0 memories. Returns 'cleared' | 'unavailable' | 'unknown'.

    'cleared' asserts a POSTCONDITION — this user's memory is now empty (C1). It does NOT
    assert that >=1 record was deleted; clearing an already-empty account succeeds. What
    it never does is report success while records remain, or may remain.

    Why verification runs even on the happy path: delete_all returns in ~374ms while the
    server-side DELETE_ALL event takes ~830-880ms, and its payload literally says
    "Delete in progress. This may take some time." A clean return is NOT evidence.
    """
    if mem0 is None:
        return "unavailable"                # nothing sent, so nothing deleted
    uid = (user_id or "").strip()
    if not uid:
        # delete_all() with no filter deletes EVERY memory in the account. user_id is
        # token-derived so this is unreachable today; the blast radius earns the guard.
        return "unavailable"

    marker_id, now_ref = await _write_clear_marker(client, uid)
    if marker_id is None:
        return "unavailable"                # guard unarmed -> never attempt the delete

    try:
        await asyncio.wait_for(mem0.delete_all(user_id=uid), timeout=_CLEAR_TIMEOUT_S)
    except asyncio.TimeoutError:
        pass                                # may still commit -> verify
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear delete raised: {type(e).__name__}", file=sys.stderr)
        if _confirmed_nothing_deleted(e):
            await _mark_marker_failed(client, marker_id)
            return "unavailable"

    if not await _memory_is_empty(mem0, uid):
        return "unknown"
    if await _add_possibly_in_flight(client, user_id=uid, now_ref=now_ref):
        return "unknown"
    return "cleared"
```

The route (T2) additionally wraps `get_supabase_client()` per A7 and returns
`build_error_response(503, …, code=…)` per D8 — precedent already in `main.py:189`.

### C4 — The honest limit of this contract ~~(accepted not solved)~~ — **CLOSED by C11 (§8f)**

> **STATUS 2026-08-04: this section is SUPERSEDED.** C4 and C4-bis described a window in which an
> in-flight `add` was unobservable to a clear. **§8f (C11) closes it** by writing the add-intent row
> *before* the guard's snapshot, and by aborting the add when that row cannot be written. The text
> below is retained because it is the reasoning that led to C11 — read it as history, not as a live
> limitation. Deferrals 1, 7 and 8 are closed with it.

`persist_trip_memory` writes its audit row **after** `add()` returns, so there is a window — ~570 ms
typically, up to the 5 s add timeout — in which an add is in flight with **no row for
`_add_possibly_in_flight` to find**. Within that window a clear can verify empty, report `cleared`,
and the add can still land.

Closing it properly requires a **pre-add durable intent**: `persist_trip_memory` writing its audit row
*before* the add (the same inversion D4 applies to the clear), then updating it to `'failed'` on
error. That is ~10 lines, but it changes an **already-shipped generation path** and belongs in the arc
that next touches the write-back.

**So the contract's promise is precisely: `cleared` means the memory verified empty and no in-flight
add was observable.** It is not an absolute guarantee, and §1's "never report success" language must
be read against C1 + this paragraph rather than as an unqualified claim. Deferrals 7-9 carry the
triggers. **This is the one place the arc knowingly falls short of the governing rule, and it is
recorded rather than papered over.**

> **C4-bis — the window is wider on one path (found by the final whole-branch review, 2026-08-03).**
> `persist_trip_memory`'s audit insert is best-effort (`except Exception: pass`, pre-existing and
> unchanged by this arc). If `mem0.add()` **succeeds but that insert fails**, no `'learned'` row ever
> exists — so `_add_possibly_in_flight` has nothing to find at **any** time, not merely during the
> ~570 ms pre-insert gap. The false-`cleared` window on that path is the full add→readable latency,
> **~4-8 s**.
>
> It requires a coincidence: the clear's OWN marker insert to the same table must succeed seconds
> after the generation's insert to that table failed — i.e. a transient blip, not an outage (an
> outage fails the marker insert too, which returns `unavailable` and tells no lie).
>
> **Same root cause and same fix as C4:** a pre-add durable intent, which would additionally abort
> the add when its own intent row cannot be written. Still deferred — it changes an already-shipped
> generation path. **Deferral 8 is amended to cover this variant**, not just the timing gap.

### C5 — The test matrix is rewritten, not patched

A10's "only three guards missing" is obsolete now that C3 replaces the fragments. **T1's test list and
§5's matrix must be regenerated against C3**, with an attributable RED for each of:

`mem0 is None` · blank/whitespace uid (assert `delete_all` **never called**) · marker-insert failure
(assert `delete_all` **never called**) · `NET_CONNECT` → `unavailable` + marker flipped to `'failed'`
· **`HTTP_409` and `HTTP_429` → verify, NOT `unavailable`** (the C2 regression tests) · `HTTP_500`,
`HTTP_504`, `408` → verify · `asyncio.TimeoutError` + verify-empty + no in-flight → `cleared` ·
delete returns cleanly but verify non-empty → `unknown` (the E1 regression) · verify raises →
`unknown` · envelope not a dict → `unknown` · `results` non-empty → `unknown` · **`count` missing** →
`unknown` · **`count` non-zero with empty `results`** → `unknown` · in-flight `'learned'` row →
`unknown` · in-flight **`'failed'`** row → `unknown` (the A14 regression) · a `'learned'` row
**older** than the window → `cleared` (makes `.gt()` load-bearing) · a row with **`trip_id` NULL**
(another clear's marker) → `cleared` (makes the `trip_id` filter load-bearing) · another user's row →
`cleared` · `now_ref` missing → `unknown` · marker-flip failure leaves suppression intact.

**Fake fidelity for the four builder methods C3 introduces** (verified against postgrest 2.31.0 —
`not_`, `is_`, `in_`, `gt` all exist; `.is_(col, "null")` is already used in `persist.py:259`):

- `not_` is a **property** that sets `negate_next = True` and returns `self`. A fake whose `not_`
  returns `self` while `is_` ignores the flag **silently inverts the filter** — the in-flight check
  would then match only the clear's own markers and never a generation's, so A14/the `trip_id` filter
  would be exactly backwards while every test still passed. Implement `not_` + negation together or
  raise loudly (`test_saved_reels_organize.py:140` already raises on unsupported `is_` shapes — follow
  that pattern).
- `.gt()` and `.in_()` must genuinely filter. A `return self` no-op is the `_Table.order` bug
  (trap #4) and makes every window-boundary and event-type test vacuous.
- `.eq(col, None)` / `.gt(col, None)` are never valid against postgrest — use `.is_(col, "null")`.

**Injection discipline (A15, now applying to four sites):** `_cleared_since_generation_start`'s two
`except` blocks, its `if not started_at` branch, and `_add_possibly_in_flight`'s `except` all crash or
mis-redirect if the guard line is merely deleted. **Fault-inject `return False`** and assert the
production outcome flipped. Never a disjunctive assertion (trap #7). Every test expecting `"cleared"`
seeds the no-recent-add precondition explicitly (A16), and no fixture may satisfy an assertion by its
natural state (trap #2).

### C7 — The route, complete (closes Codex R3's P1; supersedes T2's code)

Codex R3 P1: 8e declared everything else non-authoritative but only supplied `memory_clear.py`.
A developer copying superseded T2 would import `clear_memory` from `pipeline.preferences` (wrong
module) and would have to invent A7's wrapper. Here it is in full.

```python
# backend/main.py — beside get_settings_preferences
_CLEAR_FAILURE_MESSAGE = {
    "unavailable": "Memory could not be cleared. Nothing was deleted — please try again.",
    "unknown": "We could not confirm whether your memory was cleared. Refresh this page to "
               "see the current state; do not retry blindly.",
}


@app.post("/settings/memory/clear", response_model=MemoryClearResponse)
@limiter.limit(BURST_LIMIT)
async def clear_settings_memory(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True
    user_id: str = Depends(get_current_user_id_stashed),  # token-derived: guardrails #5 + #6
):
    """PRD §824. STRICT by design — the deliberate inverse of GET /settings/preferences,
    which degrades (guardrail #3). Never reports a clear it did not verify."""
    from mem0_client import get_mem0_client
    from pipeline.memory_clear import clear_memory        # NOT pipeline.preferences (A17)

    try:
        client = await get_supabase_client()
    except Exception:                                     # noqa: BLE001 — A7
        # Without a client we cannot arm the guard, so nothing is deleted. Truthful AND
        # inside the documented contract; the global handler's 500 would be neither.
        return build_error_response(
            503, _CLEAR_FAILURE_MESSAGE["unavailable"], code="memory_unavailable")

    outcome = await clear_memory(client, await get_mem0_client(), user_id=user_id)
    if outcome == "cleared":
        return MemoryClearResponse()
    # Returned, not raised: _STATUS_CODE_SLUG (api/errors.py:19-28) has no 503 entry, so
    # HTTPException(503) would emit code "error" and collapse the two failure codes into
    # one. Precedent: main.py:189 does exactly this for the 429 handler.
    code = "memory_unavailable" if outcome == "unavailable" else "memory_clear_unknown"
    return build_error_response(503, _CLEAR_FAILURE_MESSAGE[outcome], code=code)
```

`api/schemas.py` adds:
```python
class MemoryClearResponse(BaseModel):
    """POST /settings/memory/clear — success only. Failures use the standard error
    envelope with code `memory_unavailable` or `memory_clear_unknown`."""
    cleared: Literal[True] = True
```

### C8 — The write-back guard, complete (closes the other half of R3's P1)

**This is the part whose omission would resurrect memory after a `cleared: true`.** It stays in
`preferences.py` (it belongs with the write-back it guards; only the clear path moved to
`memory_clear.py` per A17).

```python
# backend/pipeline/preferences.py
async def _cleared_since_generation_start(client, *, user_id: str, trip_id: str) -> bool:
    """True if this user cleared memory after this generation's trip row was created.

    Generation takes 60-180s. Without this, a mid-generation clear is undone by the
    post-`result` write-back: the UI says cleared, the memory exists.

    Both timestamps are Postgres `now()` (trips.created_at, memory_events.created_at), so
    there is ONE clock and no host/DB skew — stamping this host's clock is the mistake
    jobs.py:94-97 documents for the job lease. trips.created_at is stable across a
    recovery re-run: the row is INSERTed once in POST /generate-trip and only ever
    `.update()`d afterwards (verified), so restart-with-cache-reuse (guardrail #12)
    compares against the ORIGINAL start, which is the safe direction.

    Returns True (skip the write) whenever the reference cannot be determined — losing one
    learned memory is benign; resurrecting cleared data is the bug.
    """
    try:
        trip = await client.table("trips").select("created_at") \
            .eq("id", trip_id).eq("user_id", user_id).maybe_single().execute()
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] write-back guard: trip lookup failed: {type(e).__name__}", file=sys.stderr)
        return True
    # maybe_single() returns a BARE None on zero rows (postgrest 2.31.0) — not a result
    # whose .data is None. Both shapes must read as "no reference".
    started_at = (getattr(trip, "data", None) or {}).get("created_at") if trip is not None else None
    if not started_at:
        print("[mem0] write-back guard: no trip reference; skipping write", file=sys.stderr)
        return True
    try:
        res = await client.table("memory_events").select("id") \
            .eq("user_id", user_id).eq("event_type", "cleared") \
            .gt("created_at", started_at).execute()
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] write-back guard: cleared lookup failed: {type(e).__name__}", file=sys.stderr)
        return True
    return bool(getattr(res, "data", None))
```

Call site — inside `persist_trip_memory`, immediately after the existing `if mem0 is None: return
learned`, and as late as possible before the `mem0.add`:

```python
    if await _cleared_since_generation_start(client, user_id=user_id, trip_id=trip_id):
        # The user cleared memory during this generation. Re-adding would silently
        # un-clear it. No audit row: nothing was learned and nothing failed.
        return learned
```

### C9 — Fake work, both files, explicit (closes R3's "A5 has no authoritative home")

- **`pipeline/test_preferences.py`** — `_FakeClient.table` currently asserts
  `name == "memory_events"` and `_FakeTable` supports only `insert`. Rebuild as a small multi-table
  fake over a shared dict supporting `insert` (returning the row **with an `id` and a stamped
  `created_at`** — the DB supplies both as defaults and C3 reads them), `update`, `select`, `eq`,
  `in_`, `gt`, `not_`/`is_`, and `maybe_single`.
- **`pipeline/test_runner.py`** — a **separate** `_Table` (line 26) with `eq`/`in_`/`gte`/`lte` and
  **no `.gt()`, no `.maybe_single()`**; its `select` takes a single positional `cols` (unlike
  `test_main.py`'s `*_cols`). Add `gt` + `maybe_single` **and seed a `trips` row carrying
  `created_at`**, or the guard raises `AttributeError`, D7 swallows it, and the existing
  write-back-failure test at `test_runner.py:838` can no longer produce its `'failed'` event.
  Add a recovery-replay test against the original `trips.created_at`.
- Fidelity rules from C5 apply to every method added: genuine filtering, `not_`+negation together,
  `maybe_single()` bare-`None` on zero rows and **raise** on multiple.

### C6 — Corrections to the surrounding sections

- **A12 withdrawn as written.** `delete_all` does not delete the entity, so a post-clear `add` proves
  nothing about entity recreation; and a direct `mem0.add` bypasses `persist_trip_memory` entirely.
  **T4 step 9 becomes simply: "seed one more memory after the clear and confirm it becomes readable"**
  — i.e. learning still works after a clear. The entity-recreation claim in D1 rests on the
  researcher's measured `add → delete_entities → add` probe and should be cited as such, not re-proven
  here.
- **§8 "purely additive" is wrong and must be corrected.** With no frontend caller, deployment still
  changes **every explicit-preference write-back**: two extra Supabase reads, and a lookup failure now
  suppresses learning (D7). Say that plainly.
- **Rollback is code-only, not a full rollback.** `git revert` restores behaviour but **cannot restore
  deleted mem0 data**. Successfully cleared memories are gone permanently. State it.

### C10 — Test-matrix completions from Codex R3, and the last deferral

**Attribution corrections (fold into C5 — several of these are traps, not additions):**

- **The `trip_id IS NOT NULL` filter is vacuous as originally specified.** A normal clear marker is
  `event_type='cleared'` and is *already* excluded by `.in_(["learned","failed"])`, so removing the
  `trip_id` filter changes nothing. The fixture must be the one genuinely overlapping case:
  a **`'failed'` row with `trip_id = NULL`** — i.e. a clear marker that `_mark_marker_failed` flipped.
  Only that row makes the filter load-bearing.
- **`_mark_marker_failed` needs ≥2 markers in the fixture.** With a single row, deleting
  `.eq("id", marker_id)` would update every audit row and the test would still pass. Seed two and
  assert the other is untouched.
- **"Marker-flip failure leaves suppression intact" is not a fault-injection guard.** The marker stays
  `'cleared'` even if `_mark_marker_failed` is deleted outright, so there is no attributable endpoint
  outcome. Split it: assert `_mark_marker_failed` **does not raise** when the update fails, and treat
  persistent suppression as a state assertion, not a guard proof.
- **`HTTP_409` / `HTTP_429` / `HTTP_500` / `HTTP_504` / `408` tests must assert an exact outcome**, not
  merely "verifies". Each asserts the verification call happened **and** one exact result (e.g.
  verify-empty + no in-flight → `"cleared"`). "It verified" is satisfied by code that discards the
  result — a spy must CONTROL, not observe.
- **Blank-uid test needs a fake that ACCEPTS the marker insert.** A realistic UUID-rejecting fake would
  block `delete_all` naturally, so the account-wipe guard test would pass even with the guard deleted.
- **Missing cases:** `count=False` (proves `type(count) is int`, since `False == 0`); `results` present
  but not a list; `now_ref` present but **unparseable** (distinct from missing);
  `_add_possibly_in_flight`'s query raising; the C7 route-level `get_supabase_client()` failure;
  the C9 `test_runner.py` recovery-replay case.

**Deferral 10 — a confirmed-failed clear can transiently suppress one unrelated write-back.**
Between `_write_clear_marker` inserting the row and `_mark_marker_failed` flipping it, a generation
finishing in that gap reads `'cleared'` and skips learning — while the endpoint truthfully reports
`memory_unavailable`. The user's new preference is silently discarded. Fail-safe and bounded (one
generation, one fact, no deletion lie), but it is a real consequence beyond C4's blind interval.
**Trigger:** a `'failed'` clear marker coincides with a generation that learned nothing.

## 8f. C11 — INTENT-FIRST write-back (closes Codex's code-review P1, plus C4 and C4-bis)

> **Status: authorised by the user 2026-08-04 ("fix it now").** Codex's final cross-model code review
> returned **FAIL / DO-NOT-MERGE (5.6)** on one P1 that the fable whole-branch pass (9/10, MERGE)
> missed. This section supersedes C4/C4-bis and Deferral 8.

### The defect

`persist_trip_memory` reads the guard (`_cleared_since_generation_start`), **then** calls `mem0.add`.
A clear landing between those two steps is invisible to the clear *and* unblocked by the guard, so the
endpoint returns `cleared` and the add lands afterwards. The window is **not** C4's ~570 ms — it
includes the guard query's own round-trip, bounded by the shared 30 s HTTP timeout. The existing tests
are sequential and structurally cannot reproduce the interleaving.

Codex was explicit that the obvious patch is insufficient: *"Writing intent only immediately before
`mem0.add()` would still leave this race."* The intent must precede **the guard's snapshot**, because
that snapshot is what the clear races against.

### The fix — reorder to intent → guard → add

In `persist_trip_memory`, after the existing `if not text` / `if mem0 is None` early returns:

```python
    # INTENT-FIRST (C11). `_add_possibly_in_flight` can only see an in-flight add if a row
    # exists BEFORE the guard reads memory_events — the race is between the guard's READ
    # and the add, so an intent written just before mem0.add() would not close it.
    intent_id = await _write_add_intent(client, user_id=user_id, trip_id=trip_id, learned=learned)
    if intent_id is None:
        # Cannot record the intent -> do NOT add. An add nobody can observe is exactly the
        # false-`cleared` this fix removes (that is C4-bis). Losing one learned memory on a
        # DB blip is the fail-safe direction, consistent with D7.
        print("[mem0] write-back: intent row failed; skipping add", file=sys.stderr)
        return learned

    if await _cleared_since_generation_start(client, user_id=user_id, trip_id=trip_id):
        # The user cleared during this generation. Nothing was sent, so the intent must not
        # linger: a stale 'learned' row would make the NEXT clear report `unknown` for 15s.
        await _retract_add_intent(client, intent_id)
        return learned

    try:
        await asyncio.wait_for(
            mem0.add([{"role": "user", "content": text}], user_id=user_id,
                     metadata={"source": "generation", "trip_id": trip_id}),
            timeout=5)
    except Exception:                       # noqa: BLE001
        await _mark_intent_failed(client, intent_id)   # 'failed' still reads as may-have-landed
    return learned
```

Three small helpers, each a single statement wrapped in `try/except` (best-effort past the point of
no return, guardrail #3): `_write_add_intent` inserts `{user_id, trip_id, event_type: 'learned',
learned_facts_json}` and returns the row id (or `None`); `_retract_add_intent` DELETEs by id;
`_mark_intent_failed` UPDATEs `event_type` to `'failed'` by id.

### Why each choice

| Choice | Why |
|---|---|
| Intent row is `'learned'` from the start | `_add_possibly_in_flight` matches `'learned'` and `'failed'` with `trip_id IS NOT NULL`, so the row is visible to a concurrent clear the instant it exists. No new `event_type`, **no migration**. |
| Intent-insert failure **aborts the add** | This is the behaviour change that closes C4-bis. Today a successful add with a failed audit insert is permanently invisible to the clear. |
| Guard-fires ⇒ **DELETE** the intent | Nothing was sent, so there is no audit event to keep — this preserves today's exact behaviour (guard fires ⇒ no row). Flipping to `'failed'` instead would keep matching the in-flight check and cause a false `unknown` for 15 s. |
| Add-fails ⇒ flip to `'failed'` | Unchanged semantics: `'failed'` means "issued, outcome unconfirmed", which is precisely what the in-flight check must treat as may-still-land. |

**Crash between intent and add** leaves a `'learned'` row for an add that never happened. That is
conservative for the clear (reports `unknown`), and guardrail #12 re-executes the run. It is strictly
better than today, where a *successful* add can leave **no** row at all.

### Tests (each needs an outcome only that guard can produce)

1. intent row is written **before** the guard query — assert on the fake's ordered `ops` list, not just presence
2. intent-insert failure ⇒ **`mem0.add` NEVER called** (the C4-bis regression)
3. guard fires ⇒ add not called **and the intent row is gone** (not merely present-and-ignored)
4. add succeeds ⇒ exactly one `'learned'` row survives with `trip_id` set
5. add raises/times out ⇒ that row is `'failed'`, not deleted
6. retraction failure ⇒ swallowed, no raise out of `persist_trip_memory` (guardrail #3)
7. `_mark_intent_failed` / `_retract_add_intent` are **id-scoped** — seed ≥2 rows and assert the other is untouched
8. **the race itself**: a barrier-driven test where a clear is interleaved between the guard read and the add, proving the clear now observes the intent and returns `unknown`. Codex called out that no current test can reproduce this interleaving — this is the one that must exist.

**Injection discipline unchanged:** where deleting a line crashes rather than redirects, invert it
instead; a green deletion is not evidence a guard is inert (it fired twice already in this arc).

### Consequences to re-check after this lands

- C4, C4-bis and Deferral 8 are **closed** by this, not merely narrowed. Update them.
- Deferral 1 (the "millisecond TOCTOU") is also closed — that was this race, understated.
- The write-back now performs **three** Supabase ops in the common path (intent insert + guard's two
  reads) instead of two. Update §8's cost note.

## 8g. C12 — bound the write-back below the visibility window (closes Codex code-review R2's P1)

> Codex R2 on the code: **FAIL 5.9, DO-NOT-MERGE.** C11 narrowed the race but did not close it, and
> Codex **reproduced** the remainder against the real functions: `expired_intent_verdict='cleared'`,
> `add_landed=True`.

### The remaining defect

`_add_possibly_in_flight` only looks back `_ADD_VISIBILITY_WINDOW_S` (15 s). The write-back's own
Supabase calls are **unbounded** — they inherit the shared 30 s HTTP timeout (`supabase_client.py`).
So:

```
T+0    intent row committed
T+0..  guard's read starts and is SLOW (up to 30s, unbounded)
T+16   user clears -> cutoff is T+1 -> the intent at T is TOO OLD to see -> "cleared"
T+17   guard's stale pre-clear snapshot returns "no clear" -> add proceeds -> lands
```

The former P3 *"guard reads have no operation-level timeout"* was therefore never latency hygiene —
**it is the load-bearing half of this P1.**

### The fix — two independent bounds, so an intent can never age out while its own add is still pending

1. **Bound every write-back Supabase call** with `asyncio.wait_for`, so the worst-case time from
   intent-commit to add-issued is far below the visibility window:
   `_ADD_INTENT_TIMEOUT_S = 4` (intent insert) and `_GUARD_TIMEOUT_S = 4` **per guard read** (two of
   them) ⇒ **≤ 12 s** worst case, and a timeout takes the existing fail-safe path (skip the write /
   treat as "cleared present"), never a raise (guardrail #3).
2. **Widen `_ADD_VISIBILITY_WINDOW_S` from 15 → 30 s.** The window must cover the whole interval in
   which an add can still land, not just the measured materialization: pre-add budget (≤12 s) + the
   add call itself (≤5 s) + PENDING→readable (~4-8 s) ≈ **25 s**. 30 s leaves margin.

Cost: a clear within 30 s of a preference-bearing generation now reports `unknown` instead of
`cleared`. That is the conservative direction and clears are rare; `unknown` tells the user to
refresh, and the read endpoint will show the true state.

3. **`assert_schema.py`** — add `id` and `created_at` to the `memory_events` column tuple (line ~99).
   C11/C12 depend on both (`id` for the id-scoped retract/mark helpers, `created_at` for the guard's
   `.gt()` and the in-flight cutoff), but the pre-deploy gate does not check them. Drift removing
   either would pass the gate and then make clears fail closed and write-back abort learning.
   Production has both today, so this is a hazard guard, not a migration-order blocker.

### Tests

- **The aged-intent barrier** (Codex asks for it explicitly): an intent OLDER than the cutoff while the
  guard holds a pre-clear snapshot. Must yield `unknown`, and must **redden** if the window is narrowed
  back to 15 s or the guard bound is removed. This is the regression test for this exact P1.
- Each timeout is pinned by a test that asserts the **exact** value (fake `asyncio.wait_for`, record
  and assert OUTSIDE the fake — a blanket `except` in the caller would swallow an AssertionError raised
  inside it; `test_build_context_timeout_degrades_to_default` in this repo already documents that trap).
- Timeout on each of the three calls ⇒ the documented fail-safe outcome, never a raise.
- `assert_schema` gate test covers the two added columns if the file has a test seam.

### What this does NOT claim

Codex is right that this is still **expiry based on measured timing**, not a durable guarantee. An
absolute contract needs pending/reconciled state on the row (the `memory_events` CHECK already permits
`'updated'`/`'reconciled'`, both currently unused) or per-user serialization. **Deferred with a
trigger:** implement durable pending state if a `cleared` is ever observed followed by a resurrected
fact, or if mem0's PENDING→readable latency is measured above ~20 s.

## 9. Definition of done

- [ ] `uv run pytest -q` → **1310 + new** passed, 8 skipped (baseline measured this session: 1310/8)
- [ ] `uv run pytest evals/ -q` → **49 passed**, anchor `6229.0` unmoved
- [ ] Every row of §5 fault-injected; any GREEN injection reported, not silently fixed
- [ ] Per-task `astrail-reviewer` (sonnet) gate clean
- [ ] Final `astrail-reviewer` whole-branch pass on **fable** AND gstack `/review` Codex cross-model — **both**
- [ ] Live smoke (T4) green **after the user's explicit go**
- [ ] Docs + EMDEE + memory updated; board card handed to Codex

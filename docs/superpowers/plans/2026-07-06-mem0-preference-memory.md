# mem0 Preference Memory (Phase 1.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give returning users a personalized 2nd trip — read their remembered travel taste from hosted mem0 once per generation, inject it into the restaurant + narrator prompts, and write back distilled preferences after a successful trip — without ever letting memory fail, stall, or reshape a trip.

**Architecture:** A **retrieve-once / write-once** loop wrapped around the existing live runner. One `mem0.search()` at the start builds a single immutable `PreferenceContext`; that context's rendered text block is injected into the two LLM enrich agents that make subjective choices (restaurant ranking, narration tone); one best-effort `mem0.add()` fires after the trip is already saved. mem0 is a hosted `AsyncMemoryClient` singleton (mirrors `supabase_client`), and every mem0 edge is best-effort — a miss or outage degrades to inferred defaults, never an error. Personalization reaches the trip **only** through agent prompts, so the deterministic `dedupe`/`assemble_itinerary` path (the frozen #16 eval anchor) is untouched.

**Tech Stack:** FastAPI (Python ≥3.14, `uv`) · OpenAI Agents SDK · hosted mem0 Platform (`mem0ai` / `AsyncMemoryClient`) · async supabase-py (service-role) · SSE.

## Global Constraints

- **Stack frozen — hosted mem0 only.** Bump `mem0ai>=0.1.0` → `mem0ai>=2.0,<3.0` (installed is 2.0.10, v3 API). No new dependency, service, or tool beyond this floor bump. Never reintroduce a banned item.
- **Eval anchor held: `mean_intra_day_travel_m = 6229.0` must not move.** Memory NEVER touches `dedupe_places` or `assemble_itinerary`. Personalization reaches the trip ONLY via the restaurant + narrator **prompts**. The offline eval / `offline_harness` must remain credential-free and network-free.
- **mem0 is never on the critical path (guardrail #3).** Every mem0 call — `search`, `add`, and the construction ping — is wrapped in BOTH a try/except AND an `asyncio.wait_for` timeout: a hung hosted call must not stall generation (the read runs before scrape) or wedge the background task. Read miss/error/timeout → inferred defaults. Write-back is **`await`ed after the terminal `result` event** — never `asyncio.create_task` (an unreferenced task can be GC'd before it runs; the codebase retains task refs at `main.py:44-46` for exactly this reason). A mem0 outage/429/timeout must never fail or stall a trip; a trip completes identically whether mem0 is up, down, timing out, or unconfigured.
- **Client singleton, never at module import.** `mem0_client.get_mem0_client()` builds one `AsyncMemoryClient` lazily (its constructor does a BLOCKING network ping) and returns `None` when `MEM0_API_KEY` is unset or construction fails. Nothing the offline eval imports may construct it.
- **v3 API shape:** `search(query, filters={"user_id": <uuid>}, top_k=…)`; `add([{ "role": "user", "content": <text> }], user_id=<uuid>, metadata=…)`. `add()` is queued (returns `PENDING`, no synchronous memory id) → leave `mem0_memory_id` NULL; no ID reconciliation in v1.
- **Untrusted content (guardrail #11):** the `mem0.add` payload is ONLY the user's distilled free-text preferences + a templated one-line synopsis. NEVER raw reel caption/transcript, NEVER secrets, NEVER the full itinerary JSON.
- **Preference priority (PRD §9):** current explicit input **wins**; memory fills only when current input is blank; inferred defaults otherwise. `preference_source ∈ {"explicit","memory","inferred_default"}` (mirrors the existing TS `PreferenceSource`).
- **Owner check (guardrail #6):** every `trips` write filters on `id` AND `user_id`, even under service-role.
- **Additive contracts only.** The ONE SSE stage emitted — `preferences` — already exists in the TS `GenerationStage` union (`backend-types.ts:24`) with a `STAGE_LABEL` entry, so it is non-breaking. **No new SSE stage is introduced:** `memory_preference` is an `EvidenceKind`, NOT a `GenerationStage` — emitting it as a stage would break schema parity (guardrail #4) and render `undefined` in the progress UI. The post-generation memory receipt is **persisted** (`memory_events` + `trips.preference_summary`), not streamed. Zero migrations (all columns/tables exist). Zero frontend changes.

---

## Context — the seam is already built on two of three sides

| Layer | Status | Location |
|---|---|---|
| DB: `trips.preference_sources jsonb` + `trips.preference_summary text` | ✅ exists | `supabase/migrations/20260701151718_trip_job_backbone.sql:17-18` |
| DB: `user_preference_facts`, `memory_events` (+ `learned_facts_json jsonb`) | ✅ exists (RLS) | `supabase/migrations/20260701131304_identity_persona_foundation.sql:98-128` |
| TS: `PreferenceSource`, `preference_sources`, `preference_summary`, `UserPreferenceFact`, `preferences` on request, `GenerationStage` `preferences` (the only stage emitted) | ✅ exists | `frontend/lib/trip/backend-types.ts:15,163-164,192,214-223,24` |
| `UserPreferences` Pydantic contract | ✅ exists | `backend/models/prefs.py` |
| Env `MEM0_API_KEY` + `render.yaml` key + `mem0ai` dep | ✅ exists | `ENV.md:17`, `render.yaml:25`, `pyproject.toml:15` |
| **The backend wiring (this plan)** | ❌ none exists | `runner.py` has zero preference/memory code today |

## Non-goals / deferred (with triggers)

- **Settings endpoints (view / clear memory)** — deferred to a fast-follow that ships with Zhi Hao's settings UI (its only consumer). Trigger: the FE settings screen is being built. `mem0.delete_all(user_id)` remains a one-line admin call for beta "forget me" requests until then.
- **`user_preference_facts` writes** — deferred with the settings view (its reader). The receipt + audit live in `memory_events.learned_facts_json` for v1. Trigger: the settings-view endpoint needs a queryable per-fact store. *(If plan-review deems the audit insufficient without facts, promote this into Task 5.)*
- **`mem0_memory_id` reconciliation** (webhook/poller) — deferred; v3 `add()` gives no synchronous id. Trigger: app code needs to delete/update a specific mem0-side memory.
- **Structured fact parsing** (memory facts → `UserPreferences` fields) — deferred; v1 injects memory as a text block. Trigger: a feature needs typed per-field memory (e.g. budget slider prefill).
- **Merge-on-incomplete (PRD §9 deviation — Codex finding).** v1 uses **explicit-wins-wholesale**: ANY current free-text preference sets `source="explicit"` and memory is NOT blended in. PRD §9 says memory should fill when current prefs are blank OR *incomplete*. This is a **deliberate v1 simplification, named here** (it needs no field-level detection). Trigger: users report saved prefs (e.g. dietary restrictions) ignored when they type an unrelated preference → add field-level merge (fill only unset `UserPreferences` fields from memory), landing with structured fact parsing above.
- **Destination-scoped recall** — the `search` query stays generic (`"travel preferences for a trip"`), NOT destination-biased, because mem0 memories are **global taste** ("likes ramen", "relaxed pace"), not per-destination; a destination-biased query could miss general prefs. `build_preference_context` still accepts `destination_hint` for a future switch. Trigger: recall quality measurably improves with destination context.
- **Self-hosted OSS mem0 on pgvector** — not in v1 (stack froze hosted). Trigger: data-residency requirement or hosted cost/quota pressure → a DECISIONS LOG entry first.
- **`memory_use` eval check** stays PENDING — the deterministic baseline stays the parity anchor; the live 2nd-trip effect is verified by a documented `live_run.py` smoke, not the frozen offline eval.

## File structure

**Create:**
- `backend/mem0_client.py` — hosted mem0 singleton accessor (`get_mem0_client()`), mirrors `supabase_client.py`.
- `backend/test_mem0_client.py` — offline: no-key→None, construct-once.
- `backend/pipeline/preferences.py` — pure merge/render/distill + the two live best-effort edges (`build_preference_context`, `persist_trip_memory`).
- `backend/pipeline/test_preferences.py` — pure offline unit tests + best-effort edge tests with an injected fake mem0.

**Modify:**
- `backend/pyproject.toml` — bump `mem0ai` floor.
- `backend/models/prefs.py` — add `PreferenceSource` + `PreferenceContext`.
- `backend/api/schemas.py` — add `preferences: str | None` to `GenerateTripRequest`.
- `backend/main.py` — warm the mem0 singleton in `lifespan`; thread `req.preferences` into `run_generation` + the `create_trip` event payload.
- `backend/pipeline/runner.py` — read context early (timeout-guarded) + emit the `preferences` event + write `trips.preference_*`; inject the block into the restaurant/narration stages; `await` the best-effort write-back after the terminal `result` event.
- `backend/genagents/restaurant.py` — optional `preference_block` param → `build_label_input`.
- `backend/genagents/narrator.py` — optional `preference_block` param → `build_narrator_input`.
- `backend/pipeline/persist.py` — thread `prefs`/`preference_block` through `persist_restaurants` + `persist_narration`.
- `backend/pipeline/test_persist.py`, `backend/genagents/test_restaurant.py`, `backend/genagents/test_narrator.py`, `backend/pipeline/test_runner.py` — update injected fakes to accept the new optional param + assert injection/best-effort.
- `backend/scripts/live_run.py` — print the resolved preference source/block + receipt.

---

## Task 1: mem0 client singleton + dependency floor

**Files:**
- Modify: `backend/pyproject.toml:15`
- Create: `backend/mem0_client.py`
- Create: `backend/test_mem0_client.py`
- Modify: `backend/main.py:34-49` (warm in lifespan)

**Interfaces:**
- Produces: `get_mem0_client() -> AsyncMemoryClient | None` (awaitable; memoized; `None` = memory disabled).

- [ ] **Step 1: Bump the dependency floor**

In `backend/pyproject.toml`, change line 15:

```toml
    "mem0ai>=2.0,<3.0",
```

Then run `uv sync` (installed is already `2.0.10`; this only corrects the stale floor).

- [ ] **Step 2: Write the failing test** — `backend/test_mem0_client.py`

```python
"""Offline tests for the hosted mem0 singleton — no network, no real key."""
import asyncio

import mem0_client


def _reset():
    mem0_client._client = None
    mem0_client._initialized = False


def test_no_key_returns_none(monkeypatch):
    _reset()
    monkeypatch.delenv("MEM0_API_KEY", raising=False)
    assert asyncio.run(mem0_client.get_mem0_client()) is None


def test_construct_once_and_memoized(monkeypatch):
    _reset()
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    calls = {"n": 0}

    def fake_construct():
        calls["n"] += 1
        return object()

    monkeypatch.setattr(mem0_client, "_construct", fake_construct)

    async def go():
        a = await mem0_client.get_mem0_client()
        b = await mem0_client.get_mem0_client()
        return a, b

    a, b = asyncio.run(go())
    assert a is b is not None
    assert calls["n"] == 1


def test_construction_failure_disables_memory(monkeypatch):
    _reset()
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")

    def boom():
        raise RuntimeError("mem0 unreachable")

    monkeypatch.setattr(mem0_client, "_construct", boom)
    assert asyncio.run(mem0_client.get_mem0_client()) is None
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && uv run pytest test_mem0_client.py -q`
Expected: FAIL (`ModuleNotFoundError: No module named 'mem0_client'`).

- [ ] **Step 4: Implement** — `backend/mem0_client.py`

```python
"""Hosted mem0 (Platform) singleton — cross-trip preference memory recall/store.

Mirrors supabase_client.get_supabase_client(): a lazy, double-checked-lock
singleton. Returns None when MEM0_API_KEY is unset OR construction fails, so
memory cleanly NO-OPS (guardrail #3: a trip never depends on mem0).

The mem0 client constructor makes a BLOCKING network ping to validate the key
(even AsyncMemoryClient.__init__ uses the blocking `requests` lib), so:
  * NEVER construct at module import — the offline #16 eval imports must stay
    credential-free and network-free;
  * construct inside asyncio.to_thread so the one-time ping never blocks the
    event loop;
  * warm it once at app startup (main.lifespan) so the first trip doesn't pay it.
"""
from __future__ import annotations

import asyncio
import os
import sys

_client = None          # AsyncMemoryClient | None
_initialized = False
_lock = asyncio.Lock()


def _construct():
    """Blocking: build the hosted client (validates the key via a sync ping).

    Isolated + monkeypatchable so tests never import the real SDK or hit network.
    """
    from mem0 import AsyncMemoryClient

    return AsyncMemoryClient()   # reads MEM0_API_KEY from env


async def get_mem0_client():
    """Lazily build + memoize the hosted mem0 client, or None if unavailable.

    None means memory is DISABLED (no key, or mem0 unreachable at construction) —
    callers MUST treat None as 'no memory', never as an error.
    """
    global _client, _initialized
    if _initialized:
        return _client
    async with _lock:
        if _initialized:
            return _client
        if not os.environ.get("MEM0_API_KEY"):
            _client, _initialized = None, True     # no key: settled — memory disabled
            return _client
        try:
            # Timeout-bounded (Codex C6): a slow/hung hosted ping must not wedge boot or
            # the first trip. Memoize ONLY on success.
            _client = await asyncio.wait_for(asyncio.to_thread(_construct), timeout=8)
            _initialized = True
        except Exception as e:  # noqa: BLE001 — timeout / API error → disabled THIS attempt only
            print(f"[mem0] client unavailable this attempt, memory disabled: {type(e).__name__}",
                  file=sys.stderr)
            _client = None            # leave _initialized False → a later call RETRIES (Codex C7:
                                      # a transient boot blip must not disable memory process-wide)
    return _client
```

- [ ] **Step 5: Warm the singleton in lifespan** — `backend/main.py`

Inside the existing `lifespan` try-block (after the recovery sweep, before `yield`), add:

```python
        try:
            from mem0_client import get_mem0_client
            await get_mem0_client()   # warm once so the first trip skips the blocking ping
        except Exception:
            pass   # memory is best-effort; a warm failure must never down the app
```

(Keep it inside the outer `try/except: pass` — a mem0 blip at boot must not affect startup, identical to the DB-blip contract already documented at `main.py:36-48`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest test_mem0_client.py -q`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/pyproject.toml backend/uv.lock backend/mem0_client.py backend/test_mem0_client.py backend/main.py
git commit -m "feat(mem0): hosted client singleton + dependency floor bump"
```

---

## Task 2: PreferenceContext + pure merge/render/distill logic

**Files:**
- Modify: `backend/models/prefs.py`
- Create: `backend/pipeline/preferences.py` (pure helpers only in this task)
- Create: `backend/pipeline/test_preferences.py`

**Interfaces:**
- Produces:
  - `PreferenceSource = Literal["explicit","memory","inferred_default"]` and `PreferenceContext` (frozen) in `models/prefs.py`.
  - `merge_preferences(*, explicit_text, pace, memory_facts) -> PreferenceContext`
  - `preference_block(ctx) -> str | None` (text injected into agent prompts)
  - `distill_memory_text(ctx, *, synopsis) -> str | None` (payload for `mem0.add`; None unless source=="explicit")

- [ ] **Step 1: Add the models** — append to `backend/models/prefs.py`

```python
from dataclasses import dataclass, field


PreferenceSource = Literal["explicit", "memory", "inferred_default"]


@dataclass(frozen=True)
class PreferenceContext:
    """Resolved, immutable preference view for one generation. Personalization
    reaches the trip ONLY through preference_block() injected into enrich prompts —
    never through the deterministic dedupe/assemble path."""
    source: PreferenceSource
    explicit_text: str = ""            # the user's current free-text (may be "")
    memory_facts: list[str] = field(default_factory=list)  # recalled from mem0 (may be [])
    pace: str = "balanced"
    summary: str = ""                  # human one-liner (trips.preference_summary + receipt seed)
```

(`Literal` is already imported at `models/prefs.py:11`.)

- [ ] **Step 2: Write the failing test** — `backend/pipeline/test_preferences.py`

```python
"""Pure, offline tests for preference merge/render/distill (no mem0, no network)."""
from pipeline.preferences import (distill_memory_text, merge_preferences,
                                  preference_block)


def test_explicit_input_wins():
    ctx = merge_preferences(explicit_text="ramen, walkable days", pace="relaxed",
                            memory_facts=["prefers luxury"])
    assert ctx.source == "explicit"
    # explicit wins wholesale: memory is NOT injected when the user stated preferences
    block = preference_block(ctx)
    assert "ramen, walkable days" in block
    assert "luxury" not in block
    assert "your preferences" in ctx.summary.lower()


def test_blank_input_uses_memory():
    ctx = merge_preferences(explicit_text="", pace="balanced",
                            memory_facts=["likes ramen", "avoids theme parks"])
    assert ctx.source == "memory"
    block = preference_block(ctx)
    assert "likes ramen" in block and "avoids theme parks" in block
    assert "saved travel preferences" in ctx.summary.lower()


def test_blank_input_no_memory_infers_default():
    ctx = merge_preferences(explicit_text="  ", pace="balanced", memory_facts=[])
    assert ctx.source == "inferred_default"
    assert preference_block(ctx) is None   # nothing to inject
    assert "infer" in ctx.summary.lower()


def test_distill_only_writes_on_explicit():
    explicit = merge_preferences(explicit_text="loves ramen", pace="relaxed", memory_facts=[])
    assert distill_memory_text(explicit, synopsis="Planned a 3-day Tokyo trip.") \
        == "Travel preferences: loves ramen. Planned a 3-day Tokyo trip."
    mem = merge_preferences(explicit_text="", pace="balanced", memory_facts=["likes ramen"])
    assert distill_memory_text(mem, synopsis="x") is None   # nothing NEW to learn
    default = merge_preferences(explicit_text="", pace="balanced", memory_facts=[])
    assert distill_memory_text(default, synopsis="x") is None


def test_distill_never_leaks_synopsis_secrets():
    # synopsis is a templated string built by the caller; distill only concatenates —
    # this pins that raw reel text is never introduced here.
    ctx = merge_preferences(explicit_text="quiet trip", pace="relaxed", memory_facts=[])
    out = distill_memory_text(ctx, synopsis="Planned a 2-day Kyoto trip (relaxed pace).")
    assert "reel" not in out.lower() and "caption" not in out.lower()
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_preferences.py -q`
Expected: FAIL (`ModuleNotFoundError: No module named 'pipeline.preferences'`).

- [ ] **Step 4: Implement the pure helpers** — `backend/pipeline/preferences.py`

```python
"""Preference merge + memory read/write — the mem0 wiring (Phase 1.3).

PURE + LIVE split: merge_preferences / preference_block / distill_memory_text are
pure and offline-testable; build_preference_context (mem0.search) and
persist_trip_memory (mem0.add + memory_events + trips) are the live best-effort
edges (Task 3 / Task 5). mem0 is NEVER on the critical path (guardrail #3): a
miss/error yields inferred defaults on read and a swallowed no-op on write — a
trip never fails or stalls on memory.

Determinism / eval-safety: nothing here touches dedupe/assemble_itinerary (the
frozen 6229.0 anchor). Personalization reaches the trip ONLY through the enrich
agents' prompts (restaurant, narrator) via preference_block().

Untrusted content (guardrail #11): the mem0.add payload is ONLY distilled prefs +
a templated synopsis — never raw reel caption/transcript, never secrets.

NOTE (design): this is retrieve-once-per-generation / write-once-per-trip — the
OPPOSITE of the mem0 travel-assistant cookbook's per-turn add(raw_message). The
per-turn pattern is deliberately rejected (cost/latency/noise); do not "simplify"
toward it.
"""
from __future__ import annotations

from models.prefs import PreferenceContext


def merge_preferences(*, explicit_text: str | None, pace: str | None,
                      memory_facts: list[str]) -> PreferenceContext:
    """PRD §9 priority: explicit current input wins; memory fills only when blank;
    inferred defaults otherwise. Explicit wins WHOLESALE — memory is not blended in
    when the user stated preferences this trip."""
    explicit = (explicit_text or "").strip()
    facts = [f.strip() for f in (memory_facts or []) if f and f.strip()]
    pace = (pace or "balanced").strip() or "balanced"

    if explicit:
        source = "explicit"
        summary = f"Using your preferences: {explicit}"
    elif facts:
        source = "memory"
        summary = "Using your saved travel preferences: " + "; ".join(facts)
    else:
        source = "inferred_default"
        summary = ("No preferences provided — Astrail will infer a balanced first "
                   "draft from your Reels.")

    return PreferenceContext(source=source, explicit_text=explicit,
                             memory_facts=facts, pace=pace, summary=summary)


def preference_block(ctx: PreferenceContext) -> str | None:
    """The compact text injected into the restaurant + narrator prompts. Soft
    guidance only — the agents still choose from their grounded/assembled data."""
    parts: list[str] = []
    if ctx.source == "explicit" and ctx.explicit_text:
        parts.append(f"Stated preferences: {ctx.explicit_text}")
    elif ctx.source == "memory" and ctx.memory_facts:
        parts.append("Remembered preferences (used because none were entered this "
                     "trip): " + "; ".join(ctx.memory_facts))
    if ctx.pace and ctx.pace != "balanced":
        parts.append(f"Preferred pace: {ctx.pace}")
    return " | ".join(parts) or None


def distill_memory_text(ctx: PreferenceContext, *, synopsis: str) -> str | None:
    """The mem0.add payload — ONLY when the user stated something NEW this trip
    (source=explicit). A memory-only or inferred trip has nothing new to learn, so
    we skip the write (saves the API call + the free-tier quota, avoids duplicates).
    synopsis is a caller-built templated string (never raw reel text)."""
    if ctx.source != "explicit" or not ctx.explicit_text:
        return None
    return f"Travel preferences: {ctx.explicit_text}. {synopsis}"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest pipeline/test_preferences.py backend/models/test_prefs.py -q` (from repo root: `cd backend && uv run pytest pipeline/test_preferences.py models/test_prefs.py -q`)
Expected: PASS (existing `test_prefs.py` still green + 5 new).

- [ ] **Step 6: Commit**

```bash
git add backend/models/prefs.py backend/pipeline/preferences.py backend/pipeline/test_preferences.py
git commit -m "feat(mem0): PreferenceContext + pure merge/render/distill logic"
```

---

## Task 3: Live read — build the context in the runner + capture `preferences`

**Files:**
- Modify: `backend/pipeline/preferences.py` (add `build_preference_context`)
- Modify: `backend/api/schemas.py` (add `preferences`)
- Modify: `backend/main.py` (thread `preferences` → `run_generation` + `create_trip` payload)
- Modify: `backend/pipeline/runner.py` (read context early, emit `preferences` event, write `trips.preference_*`)
- Modify: `backend/pipeline/test_preferences.py`, `backend/pipeline/test_runner.py`

**Interfaces:**
- Consumes: `get_mem0_client()` (Task 1), `merge_preferences` (Task 2).
- Produces: `build_preference_context(mem0, user_id, *, explicit_text, pace, destination_hint) -> PreferenceContext`; `run_generation(..., preferences=None, mem0=None)`.

- [ ] **Step 1: Write the failing test** — append to `backend/pipeline/test_preferences.py`

```python
import asyncio


class _FakeMem0:
    def __init__(self, results=None, raises=False):
        self._results = results or []
        self._raises = raises
        self.searched = []

    async def search(self, query, *, filters=None, top_k=10):
        self.searched.append((query, filters, top_k))
        if self._raises:
            raise RuntimeError("mem0 down")
        return {"results": self._results}


def test_build_context_reads_memory_when_blank():
    from pipeline.preferences import build_preference_context
    mem = _FakeMem0(results=[{"memory": "likes ramen"}, {"memory": "avoids theme parks"}])
    ctx = asyncio.run(build_preference_context(mem, "user-1", explicit_text="",
                                               pace="balanced", destination_hint="Tokyo"))
    assert ctx.source == "memory"
    assert ctx.memory_facts == ["likes ramen", "avoids theme parks"]
    assert mem.searched and mem.searched[0][1] == {"user_id": "user-1"}


def test_build_context_skips_search_when_explicit():
    from pipeline.preferences import build_preference_context
    mem = _FakeMem0(results=[{"memory": "should not be read"}])
    ctx = asyncio.run(build_preference_context(mem, "user-1", explicit_text="ramen",
                                               pace="relaxed", destination_hint="Tokyo"))
    assert ctx.source == "explicit"
    assert mem.searched == []   # explicit wins → no wasted search / quota


def test_build_context_mem0_none_or_error_infers_default():
    from pipeline.preferences import build_preference_context
    a = asyncio.run(build_preference_context(None, "user-1", explicit_text="",
                                             pace="balanced", destination_hint=None))
    assert a.source == "inferred_default"
    b = asyncio.run(build_preference_context(_FakeMem0(raises=True), "user-1",
                                             explicit_text="", pace="balanced",
                                             destination_hint="Tokyo"))
    assert b.source == "inferred_default"   # a mem0 blip degrades, never raises
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_preferences.py -q`
Expected: FAIL (`build_preference_context` undefined).

- [ ] **Step 3: Implement the read edge** — append to `backend/pipeline/preferences.py`

```python
async def build_preference_context(mem0, user_id: str, *, explicit_text: str | None,
                                   pace: str | None, destination_hint: str | None
                                   ) -> PreferenceContext:
    """Retrieve-once. Only spends a mem0.search when memory would actually be USED —
    i.e. the user left preferences blank (explicit wins → skip the call + quota).
    A None client or any search error degrades to inferred defaults (guardrail #3)."""
    facts: list[str] = []
    if mem0 is not None and not (explicit_text or "").strip():
        query = f"travel preferences for {destination_hint or 'a trip'}"
        try:
            res = await mem0.search(query, filters={"user_id": user_id}, top_k=10)
            facts = [m.get("memory") for m in (res.get("results") or []) if m.get("memory")]
        except Exception:
            facts = []   # best-effort: a mem0 blip → inferred defaults, never fail the trip
    return merge_preferences(explicit_text=explicit_text, pace=pace, memory_facts=facts)
```

- [ ] **Step 4: Add the request field** — `backend/api/schemas.py`

```python
class GenerateTripRequest(BaseModel):
    reel_urls: list[str] = Field(min_length=1, max_length=5)
    start_date: str
    end_date: str
    destination_hint: str | None = None
    pace: str = "balanced"
    preferences: str | None = None
```

*(The TS `GenerateTripRequest` already declares `preferences: string | null` — this closes the FE/BE parity gap; no TS change.)*

- [ ] **Step 5: Thread it through main.py — including the recovery path** — `backend/main.py`

In the `create_trip` `record_event` payload (around `main.py:103-108`), add `"preferences": req.preferences,`. In the `background.add_task(run_generation, …)` call (around `main.py:128-131`), add `preferences=req.preferences,`.

**Recovery (guardrail #12 — plan-eng-review Finding 1):** `_redispatch` (main.py:162-164) reconstructs a crash-reclaimed run from the `create_trip` payload. It MUST also thread preferences, or a Render restart mid-run re-runs with `preferences=None` and silently re-personalizes the trip (source flips `explicit`→`memory`/`inferred_default`). Add `preferences=payload.get("preferences")` to the `run_generation(...)` call inside `_redispatch`.

- [ ] **Step 6: Read the context early in the runner** — `backend/pipeline/runner.py`

Extend the signature (runner.py:68-70):

```python
async def run_generation(trip_id, user_id, reel_urls, start_date, end_date,
                          *, job_id=None, pace="balanced", preferences=None,
                          client=None, scrape=None, extract=None, mem0=None,
                          weather=None, transport=None, restaurant=None,
                          narrator=None, hotel=None) -> dict:
```

After the claim guard + `_set_status(..., "generating")` (after runner.py:91), before Phase 1:

```python
        # PREFERENCES: retrieve-once memory read → one immutable PreferenceContext.
        # Best-effort (guardrail #3): a mem0 miss/outage degrades to inferred defaults.
        # Injected `mem0` (tests) overrides the singleton; None disables memory.
        from pipeline.preferences import build_preference_context
        if mem0 is None:
            from mem0_client import get_mem0_client
            mem0 = await get_mem0_client()
        pref_ctx = await build_preference_context(
            mem0, user_id, explicit_text=preferences, pace=pace,
            destination_hint=None)
        await record_event(client, trip_id, event_type="stage", stage="preferences",
                           message=pref_ctx.summary,
                           payload={"preference_source": pref_ctx.source})
```

Then, inside the save `try` right after `persist_itinerary` succeeds (after runner.py:196), write the trip-level preference record (owner-checked, guardrail #6):

```python
            try:
                await client.table("trips").update(
                    {"preference_summary": pref_ctx.summary,
                     "preference_sources": [pref_ctx.source]}
                ).eq("id", trip_id).eq("user_id", user_id).execute()
            except Exception:
                pass   # best-effort trip metadata; never fail the trip on it
```

- [ ] **Step 7: Write the failing runner test** — append to `backend/pipeline/test_runner.py`

Use the existing runner test harness/fakes in that file (a fake supabase client `c` + injected `scrape`/`extract`). Add a case asserting: a `preferences` stage event is recorded with the resolved source, and an injected raising `mem0` still yields `status` complete/saved_with_gaps (never `failed` for a memory reason). Mirror the existing `test_runner_uses_extraction_cache_*` construction; inject `mem0=_FakeMem0(...)`, `preferences=""`, and assert `_event_stages(c)` contains `"preferences"` and the trip is not failed.

Also add a **recovery-threading test (Finding 1):** a `create_trip` payload carrying `preferences="ramen"`, re-dispatched through `_redispatch`, calls `run_generation` with `preferences="ramen"` — assert the value is threaded (mirror any existing recovery/redispatch test; else a focused unit that stubs `run_generation` and checks the kwarg). Proves preferences survive a restart.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd backend && uv run pytest pipeline/test_preferences.py pipeline/test_runner.py api/ -q`
Expected: PASS (existing runner tests unchanged + new).

- [ ] **Step 9: Commit**

```bash
git add backend/pipeline/preferences.py backend/pipeline/test_preferences.py backend/api/schemas.py backend/main.py backend/pipeline/runner.py backend/pipeline/test_runner.py
git commit -m "feat(mem0): read memory once + capture preference_source per trip"
```

---

## Task 4: Inject the preference block into restaurant + narrator

**Files:**
- Modify: `backend/genagents/restaurant.py` (`build_label_input`, `suggest_restaurants`)
- Modify: `backend/genagents/narrator.py` (`build_narrator_input`, `narrate_trip`)
- Modify: `backend/pipeline/persist.py` (`persist_restaurants`, `persist_narration`)
- Modify: `backend/pipeline/runner.py` (pass the block into the two stages)
- Modify: `backend/genagents/test_restaurant.py`, `backend/genagents/test_narrator.py`, `backend/pipeline/test_persist.py`, `backend/pipeline/test_runner.py`

**Interfaces:**
- Consumes: `preference_block(ctx)` text (Task 2) via the runner.
- Produces: optional `preference_block: str | None = None` on `suggest_restaurants` / `narrate_trip`; optional `preference_block=None` on `persist_restaurants` / `persist_narration`.

- [ ] **Step 1: Restaurant injection** — `backend/genagents/restaurant.py`

Extend `build_label_input` (restaurant.py:114) to accept `preference_block: str | None = None`; when present, append one line before the POI list:

```python
    header = (f"City: {where}\nToday's stops: {stops}\n")
    if preference_block:
        header += (f"Traveller preferences (soft ranking guidance — still choose ONLY "
                   f"from the list below): {preference_block}\n")
    return (header + "Restaurants near these stops (choose from THIS list only):\n"
            + "\n".join(lines))
```

Extend `suggest_restaurants` (restaurant.py:181-183) with `preference_block: str | None = None` and pass it into `build_label_input(pois, [...], city=city, preference_block=preference_block)`. Add one clause to `LABEL_INSTRUCTIONS` (restaurant.py:45): *"If traveller preferences are provided, prefer cuisines that match them and de-prioritize avoided types — but ONLY from the provided list; never add, invent, or web-search."* Guardrail #1 stays structural (still a `poi_index` into the fixed Mapbox set).

- [ ] **Step 2: Narrator injection** — `backend/genagents/narrator.py`

Extend `build_narrator_input` (narrator.py:47) with `preference_block: str | None = None`; when present, append after the header lines:

```python
    if preference_block:
        lines.append(f"Traveller preferences (reflect in tone/framing only — NEVER "
                     f"re-plan or reorder): {preference_block}")
        lines.append("")
```

Extend `narrate_trip` (narrator.py:102-103) with `preference_block: str | None = None` → `build_narrator_input(days, city=city, preference_block=preference_block)`. Add one clause to `NARRATOR_INSTRUCTIONS`: *"If traveller preferences are given, let them color the voice (e.g. a relaxed pace reads unhurried) — but never add, drop, or reorder places/days."*

- [ ] **Step 3: Thread through persist.py**

`persist_restaurants` (persist.py:323): add `preference_block: str | None = None`; pass to the suggest call — `await suggest(day_places, city=city, preference_block=preference_block)` (persist.py:370).
`persist_narration` (persist.py:390): add `preference_block: str | None = None`; pass to `await narrate(days_input, city=city, preference_block=preference_block)`.

- [ ] **Step 4: Wire the runner stages** — `backend/pipeline/runner.py`

Compute the block once before the enrich gather:

```python
            from pipeline.preferences import preference_block
            pref_block = preference_block(pref_ctx)
```

In `_stage_restaurants`: `await persist_restaurants(client, trip_id, suggest=restaurant, preference_block=pref_block)`.
In `_stage_narration`: `await persist_narration(client, trip_id, user_id, narrate=narrator, preference_block=pref_block)`.

- [ ] **Step 5: Update injected-fake tests**

Existing tests inject fakes as `suggest(day_places, city=...)` / `narrate(days, city=...)`. Update those fakes to accept `preference_block=None` (or `**kwargs`) so the new pass-through call signature matches. Add:
- `test_restaurant.py`: `build_label_input(..., preference_block="Stated preferences: ramen")` contains the guidance line; omitting it leaves the prompt unchanged (byte-for-byte vs the pre-change golden).
- `test_narrator.py`: same for `build_narrator_input`.
- `test_persist.py`: a fake `suggest`/`narrate` receives the forwarded `preference_block`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest genagents/test_restaurant.py genagents/test_narrator.py pipeline/test_persist.py pipeline/test_runner.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/genagents/restaurant.py backend/genagents/narrator.py backend/pipeline/persist.py backend/pipeline/runner.py backend/genagents/test_restaurant.py backend/genagents/test_narrator.py backend/pipeline/test_persist.py backend/pipeline/test_runner.py
git commit -m "feat(mem0): inject preference block into restaurant + narrator prompts"
```

---

## Task 5: Write-back + persisted memory receipt (best-effort, awaited)

**Files:**
- Modify: `backend/pipeline/preferences.py` (add `persist_trip_memory` + `trip_synopsis`)
- Modify: `backend/pipeline/runner.py` (await the write-back after the terminal `result`; no live receipt event)
- Modify: `backend/pipeline/test_preferences.py`, `backend/pipeline/test_runner.py`

**Interfaces:**
- Consumes: `distill_memory_text` (Task 2), the resolved `pref_ctx` + assembled `itinerary`.
- Produces: `trip_synopsis(itinerary, pace) -> str`; `persist_trip_memory(client, mem0, *, user_id, trip_id, ctx, synopsis) -> list[str]` (returns the learned facts for the receipt).

- [ ] **Step 1: Write the failing test** — append to `backend/pipeline/test_preferences.py`

```python
class _FakeMem0Add(_FakeMem0):
    def __init__(self, add_raises=False):
        super().__init__()
        self.added = []
        self._add_raises = add_raises

    async def add(self, messages, *, user_id=None, metadata=None):
        if self._add_raises:
            raise RuntimeError("mem0 add failed")
        self.added.append((messages, user_id, metadata))
        return {"status": "PENDING", "event_id": "evt-1"}


class _FakeTable:
    def __init__(self, sink): self.sink = sink; self._row = None
    def insert(self, row): self._row = row; return self
    async def execute(self):
        self.sink.append(self._row); return type("R", (), {"data": [self._row]})()


class _FakeClient:
    def __init__(self): self.events = []
    def table(self, name):
        assert name == "memory_events"
        return _FakeTable(self.events)


def test_write_back_writes_event_and_adds_on_explicit():
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="loves ramen", pace="relaxed", memory_facts=[])
    mem, client = _FakeMem0Add(), _FakeClient()
    learned = asyncio.run(persist_trip_memory(
        client, mem, user_id="u1", trip_id="t1", ctx=ctx,
        synopsis="Planned a 3-day Tokyo trip (relaxed pace)."))
    assert learned == ["loves ramen"]
    assert client.events and client.events[0]["event_type"] == "learned"
    assert client.events[0]["trip_id"] == "t1"
    assert mem.added and mem.added[0][1] == "u1"


def test_write_back_swallows_add_error():
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="quiet trip", pace="relaxed", memory_facts=[])
    mem, client = _FakeMem0Add(add_raises=True), _FakeClient()
    # must NOT raise — write-back is best-effort
    asyncio.run(persist_trip_memory(client, mem, user_id="u1", trip_id="t1",
                                    ctx=ctx, synopsis="x"))
    assert client.events and client.events[-1]["event_type"] == "failed"


def test_write_back_noop_when_nothing_learned():
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="", pace="balanced", memory_facts=["likes ramen"])
    mem, client = _FakeMem0Add(), _FakeClient()
    learned = asyncio.run(persist_trip_memory(client, mem, user_id="u1", trip_id="t1",
                                              ctx=ctx, synopsis="x"))
    assert learned == [] and mem.added == []   # memory-only trip: nothing new to store
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_preferences.py -q`
Expected: FAIL (`persist_trip_memory` / `trip_synopsis` undefined).

- [ ] **Step 3: Implement the write edge** — append to `backend/pipeline/preferences.py`

```python
def trip_synopsis(itinerary, pace: str) -> str:
    """A templated one-line trip summary for the mem0.add payload — NO LLM, NO raw
    reel text. Derived only from the assembled itinerary's shape."""
    days = getattr(itinerary, "days", []) or []
    n = len(days)
    city = None
    for d in days:
        for p in (getattr(d, "places", None) or []):
            city = getattr(p, "city", None) or city
            if city:
                break
        if city:
            break
    where = city or "the destination"
    return f"Planned a {n}-day {where} trip ({pace} pace)."


async def persist_trip_memory(client, mem0, *, user_id: str, trip_id: str,
                              ctx: PreferenceContext, synopsis: str) -> list[str]:
    """Write-once, awaited AFTER the terminal `result` event so it's invisible to the
    stream yet can't be GC'd. Records a memory_events audit row and pushes mem0.add —
    BOTH best-effort (guardrail #3): a mem0 error OR TIMEOUT can't fail the (already
    saved) trip. Only writes when the user stated something NEW this trip
    (distill_memory_text is None otherwise). mem0_memory_id is left NULL — v3 add() is
    queued and returns no synchronous id (reconciliation deferred)."""
    text = distill_memory_text(ctx, synopsis=synopsis)
    learned = [ctx.explicit_text] if text else []
    if not text:
        return learned   # memory-only / inferred trip: nothing new to store or audit

    event_type = "learned"
    if mem0 is not None:
        try:
            # Timeout-bounded (Codex): a hung hosted add must not wedge the task.
            await asyncio.wait_for(
                mem0.add([{"role": "user", "content": text}], user_id=user_id,
                         metadata={"source": "generation", "trip_id": trip_id}),
                timeout=5)
        except Exception:
            event_type = "failed"   # add error OR TimeoutError → record for observability

    try:
        await client.table("memory_events").insert({
            "user_id": user_id, "trip_id": trip_id, "event_type": event_type,
            # Object shape to match the existing convention (supabase/tests/001_…:34-37).
            "learned_facts_json": [{"fact": f} for f in learned],
        }).execute()
    except Exception:
        pass   # audit is best-effort too

    return learned
```

- [ ] **Step 4: Await the write-back in the runner (after the terminal result)** — `backend/pipeline/runner.py`

**plan-eng-review Finding 2 + Codex.** A bare `asyncio.create_task` can be GC'd before it runs (the codebase retains task refs at `main.py:44-46` for exactly this reason), so the write-back is **`await`ed**, placed AFTER the terminal `result` event — the SSE stream closes on `result` (`streaming.py:61-62`), so the awaited write-back is invisible to the client and adds no user-visible latency. **No live `memory_preference` event is emitted** (it isn't a valid `GenerationStage`; the receipt is persisted in `memory_events` + `trips.preference_summary`, which the frontend renders from trip data).

Replace the success tail (runner.py:279-285) with:

```python
        await _set_status(client, trip_id, user_id, status)
        payload = {"itinerary": itinerary.model_dump()}
        await record_event(client, trip_id, event_type="result", stage="save",
                            message="generation complete", payload=payload)
        if job_id:
            await mark_job_done(client, job_id, status="succeeded")

        # WRITE-BACK — AFTER the terminal `result` (stream already ended → invisible),
        # AWAITED (not create_task → no GC risk); timeout-guarded + error-swallowing inside
        # persist_trip_memory, so a mem0 outage/hang can't fail the already-saved trip (#3).
        from pipeline.preferences import persist_trip_memory, trip_synopsis
        await persist_trip_memory(client, mem0, user_id=user_id, trip_id=trip_id,
                                  ctx=pref_ctx, synopsis=trip_synopsis(itinerary, pace))
        return payload
```

`pref_ctx`, `itinerary`, `pace`, `mem0` are all in scope from Task 3 / the existing runner body. This replaces the prior `_set_status → result → mark_job_done → return` tail; the `_fail` path is unchanged (a failed trip writes back nothing). The `preferences` READ event (Task 3) stays the only new SSE stage.

- [ ] **Step 5: Runner best-effort test** — append to `backend/pipeline/test_runner.py`

Add a case: injected `mem0` whose `add` raises (or times out) → the trip still reaches a terminal non-failed status, a terminal `result` event is emitted, and a `memory_events` row is written with `event_type="failed"` (the write-back error is swallowed inside `persist_trip_memory`; `test_write_back_swallows_add_error` in Task 5 Step 1 covers the unit). Assert the trip is not `failed` and the `result` event exists.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest pipeline/test_preferences.py pipeline/test_runner.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/pipeline/preferences.py backend/pipeline/runner.py backend/pipeline/test_preferences.py backend/pipeline/test_runner.py
git commit -m "feat(mem0): best-effort write-back + memory receipt event"
```

---

## Task 6: Config verify, smoke tooling, full-suite + eval parity

**Files:**
- Modify: `backend/scripts/live_run.py`
- Verify (no change expected): `render.yaml:25`, `backend/.env.example`, `backend/evals/checks.py`

- [ ] **Step 1: Confirm deploy + env wiring**

Verify `render.yaml` already declares `MEM0_API_KEY` (it does — line 25). Confirm `backend/.env.example` lists `MEM0_API_KEY=` (add the empty key line if missing — additive only). No `render.yaml` change expected.

- [ ] **Step 2: Extend the live smoke tool** — `backend/scripts/live_run.py`

Print, per run: the resolved `preferences` stage event (`preference_source` + summary) and the persisted `memory_events` 'learned'/'failed' row + `trips.preference_summary`, so a human can eyeball personalization without the DB.

- [ ] **Step 3: Confirm the eval stays PENDING (anchor held)**

Run: `cd backend && uv run pytest evals/ -q`
Expected: PASS, `mean_intra_day_travel_m = 6229.0` unchanged; `memory_use` still reported PENDING/skipped (no code in `evals/`/`offline_harness` imports mem0).

- [ ] **Step 4: Full suite**

Run: `cd backend && uv run pytest -q`
Expected: full suite green (all prior tests + the new mem0 tests); 5 skipped live tests remain skipped.

- [ ] **Step 5: Documented live 2-trip smoke (manual, not CI)**

With `MEM0_API_KEY` set, against dev Supabase:
1. **Trip 1** — same user, `preferences="I love ramen and quiet, walkable days; avoid theme parks"`. Expect: `preferences` event `source=explicit`; a `memory_events` 'learned' row + `trips.preference_summary` set; restaurants skew ramen/casual.
2. **Trip 2** — same user, `preferences` blank, same/similar reels. Expect: `preferences` event `source=memory` with recalled facts; narration reads relaxed; restaurants still skew ramen — *without* any current input.
3. Confirm a trip still completes with `MEM0_API_KEY` unset (memory disabled, `source=inferred_default`, no errors).

Record the trip ids + observed sources in the PR body (like the extraction-cache PR's cold/warm table).

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/live_run.py backend/.env.example
git commit -m "chore(mem0): live smoke output + env example"
```

---

## Eval-safety statement (the one thing a reviewer must re-verify)

`dedupe_places` and `assemble_itinerary` are **unchanged** by this plan. `preference_block` is injected ONLY into the restaurant + narrator **prompts** (live-only agents never run by the offline eval). No mem0 module is imported by `pipeline/offline_harness.py`, `pipeline/sources.py`, `evals/`, or anything on the credential-free offline path. Therefore `mean_intra_day_travel_m = 6229.0` is structurally untouched. `memory_use` stays PENDING.

## QA / verification required before PASS

- `uv run pytest -q` green; `uv run pytest evals/ -q` green with parity `6229.0`.
- gstack `/review` on the final diff.
- gstack `/qa` evidence for the SSE + full-flow change: the new `preferences` stage event appears in a real stream and the run terminates correctly with `[DONE]`; a trip completes with `MEM0_API_KEY` unset.
- The documented 2-trip live smoke (Task 6 Step 5) captured in the PR body.

## Rollback risk

Low. Zero migrations, zero frontend changes, purely additive backend. The whole feature no-ops when `MEM0_API_KEY` is unset (memory disabled). Reverting the branch removes the `preferences` request field, the `preferences` SSE event, and the prompt injection with no schema or contract to unwind. The only external side effect is rows in mem0's cloud (distilled prefs), removable via `mem0.delete_all(user_id)`.

---

## Review Amendments (plan-eng-review + Codex outside voice)

Folded into the tasks above after review. Each is a required change; where it augments an existing task, the task ref is noted.

**A1 — `import asyncio` in `pipeline/preferences.py` (Codex C6).** Both `build_preference_context` (search) and `persist_trip_memory` (add) now call `asyncio.wait_for`; add `import asyncio` to the module header.

**A2 — Timeout-guard the read (Task 3 · Codex C6).** In `build_preference_context`, wrap the search — the read runs BEFORE scrape, so a hang here would otherwise stall every generation:
```python
        try:
            res = await asyncio.wait_for(
                mem0.search(query, filters={"user_id": user_id}, top_k=10), timeout=4)
            facts = [m.get("memory") for m in (res.get("results") or []) if m.get("memory")]
        except Exception:
            facts = []   # a mem0 blip OR TIMEOUT → inferred defaults, never stall the trip
```

**A3 — mem0 injection sentinel (Task 3 · Codex C2).** `run_generation`'s `mem0=None` is ambiguous (is `None` "disabled" or "load the singleton"?). Use a module sentinel so tests never accidentally hit the network:
```python
_UNSET = object()   # module-level in runner.py
...
async def run_generation(..., mem0=_UNSET, ...):
    if mem0 is _UNSET:                      # not injected → resolve the real singleton
        from mem0_client import get_mem0_client
        mem0 = await get_mem0_client()
    # explicit mem0=None now unambiguously means "memory disabled" (tests pass None or a fake)
```
Update Task 3's runner-read snippet accordingly, and have offline runner tests pass `mem0=None` (or a fake) so a CI run with `MEM0_API_KEY` set never constructs the real client.

**A4 — Idempotency key must include `preferences` (Codex C1, P1).** `compute_idempotency_key` (`backend/jobs.py:24-27`) is currently `(user_id, reel_urls, start_date, end_date)`. Same reels+dates with CHANGED preference text would replay the OLD trip — so "explicit input wins" silently fails on a re-submit. Extend the key to the output-affecting request fields:
```python
def compute_idempotency_key(user_id, reel_urls, start_date, end_date,
                            *, preferences=None, pace="balanced", destination_hint=None) -> str:
    material = "|".join([user_id, ",".join(sorted(reel_urls)), start_date, end_date,
                         (preferences or ""), pace, (destination_hint or "")])
    # ...keep the existing hash impl on `material`
```
Update the caller in `main.py:75` to pass the new kwargs, and update the existing idempotency tests for the new signature. A retried POST with identical inputs still replays; a changed preference now correctly generates a new trip.

**A5 — `preferences` length cap (schemas.py · Codex C11).** User free-text goes verbatim to mem0's cloud. Bound it: `preferences: str | None = Field(default=None, max_length=2000)`. (Deferred: token/secret redaction — a trigger, not v1.)

**A6 — mem0 client retries a transient boot failure (Task 1 · Codex C7).** `get_mem0_client` memoizes `_initialized=True` ONLY on success (or no-key); a construction timeout/error leaves `_initialized=False` so the next call retries, instead of disabling memory for the whole process life. Add `test_transient_failure_then_success` to `test_mem0_client.py`: first `_construct` raises → returns `None` and `_initialized` stays `False`; a second call with a working `_construct` returns the client. (Code already updated in Task 1 Step 4.)

**A7 — v3 API contract test (Task 6 · Codex C8).** All unit tests use fakes returning `{"results": [...]}`. Add ONE `@pytest.mark.live` test (skipped unless `--run-live`, like the existing live tests) that does a real `AsyncMemoryClient().add(...)` then `.search(...)` round-trip for a throwaway `user_id` and asserts the response is a dict whose `results` is a list of dicts each carrying a `memory` string — so a real v3 shape drift is caught instead of silently degrading recall to `inferred_default`.

**A8 — `destination_hint` threading (Task 3 · Codex C9, minor).** Thread `destination_hint` from the request → `run_generation` → `build_preference_context` (it's already in the idempotency key per A4). Per the Non-goals note, the search query stays generic on purpose; the param is wired for a future switch, not used to bias the query in v1.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (backend-only, scope settled in interview) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 12 findings; 10 folded (C1–C8,C10,C11), 2 documented+deferred (C9,C12) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 findings (F1 recovery-threading, F2 terminal-tail lifecycle) — both folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (no UI in this backend plan) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **CODEX:** 12 findings, all adjudicated with the user. Folded: C1 idempotency-key includes `preferences` (P1), C2 mem0 injection sentinel (eval-safety), C6 `asyncio.wait_for` timeouts on search/add/construct (hang-safety), C4/C5 invalid `memory_preference` stage cut → receipt persisted to `memory_events`, C3 stale-prose sync, C7 boot-failure retry, C8 live v3 contract test, C10 `[{"fact":…}]` shape, C11 `preferences` length cap. Documented + deferred: C12 explicit-wins-wholesale PRD-§9 deviation, C9 destination-scoped recall.
- **CROSS-MODEL:** One tension, Codex won it — the Eng review claimed `memory_preference` was already a valid `GenerationStage`; it is an `EvidenceKind`. Conceded and corrected (the receipt is now persisted, not streamed as an invalid stage → schema parity preserved).
- **VERDICT:** ENG CLEARED — ready to implement. 3 P1s (idempotency replay, mem0 hang, memory GC/never-writes) were caught and fixed at the plan stage.

NO UNRESOLVED DECISIONS

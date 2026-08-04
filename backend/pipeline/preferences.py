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

Untrusted content (guardrail #11): the mem0.add payload is ONLY the user's own
distilled preference text — never raw reel caption/transcript, never secrets, and
(PRD §357) never trip history.

NOTE (design): this is retrieve-once-per-generation / write-once-per-trip — the
OPPOSITE of the mem0 travel-assistant cookbook's per-turn add(raw_message). The
per-turn pattern is deliberately rejected (cost/latency/noise); do not "simplify"
toward it.
"""
from __future__ import annotations

import asyncio
import sys

from models.prefs import PreferenceContext

# GENERIC on purpose (Non-goals "Destination-scoped recall"): mem0 memories are global
# taste, not per-destination, so destination_hint never gets interpolated in here.
_PREFERENCE_QUERY = "travel preferences for a trip"

# EVERY write-back Supabase call is bounded (C12), and these bounds are load-bearing rather
# than latency hygiene. Unbounded, they inherit the shared 30s HTTP timeout
# (supabase_client.py), so a slow guard read can outlast memory_clear's visibility window
# while holding a PRE-clear snapshot: the intent row ages out of the clear's view, the clear
# answers 'cleared', and then the read resumes and the add lands behind it. Codex reproduced
# exactly that (`expired_intent_verdict='cleared'`, `add_landed=True`).
#
# The budget: 4 (intent insert) + 4 + 4 (the guard's two reads) = 12s worst case from
# intent-commit to add-issued, +5s for the add itself and mem0's measured 4-8s
# PENDING -> readable — all inside memory_clear._ADD_VISIBILITY_WINDOW_S (30s). Widening
# either constant without widening that window reopens the race.
#
# A timeout takes the SAME fail-safe path as any other failure of that call (skip the add /
# assume a clear happened); nothing here may raise (guardrail #3).
_ADD_INTENT_TIMEOUT_S = 4    # the intent row's insert, and its retract/mark-failed writes
_GUARD_TIMEOUT_S = 4         # per guard read, and there are two of them


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


async def build_preference_context(mem0, user_id: str, *, explicit_text: str | None,
                                   pace: str | None, destination_hint: str | None
                                   ) -> PreferenceContext:
    """Retrieve-once. Only spends a mem0.search when memory would actually be USED —
    i.e. the user left preferences blank (explicit wins → skip the call + quota).
    A None client, a search error, OR a timeout all degrade to inferred defaults
    (guardrail #3): this read runs BEFORE scrape, so an unbounded hang would
    otherwise stall EVERY generation — asyncio.wait_for bounds it."""
    facts: list[str] = []
    if mem0 is not None and not (explicit_text or "").strip():
        # destination_hint accepted for a future destination-scoped switch; v1 query stays
        # generic (plan Non-goals "Destination-scoped recall")
        try:
            res = await asyncio.wait_for(
                mem0.search(_PREFERENCE_QUERY, filters={"user_id": user_id}, top_k=10),
                timeout=4)
            facts = [m["memory"] for m in (res.get("results") or [])
                     if isinstance(m.get("memory"), str) and m["memory"].strip()]
        except Exception:
            facts = []   # best-effort: a mem0 blip or timeout → inferred defaults, never fail the trip
    return merge_preferences(explicit_text=explicit_text, pace=pace, memory_facts=facts)


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
        #
        # ENVELOPE vs ROW, and why the distinction matters. An unrecognised ENVELOPE means
        # we could not read the response at all — that is `unavailable`. Coercing it to []
        # and returning "ok" would tell the user "you have no saved preferences" when the
        # truth is "memory is broken", which is the exact ambiguity `status` exists to
        # remove. Individual malformed ROWS inside a valid envelope are different: the
        # response WAS readable, so we drop the junk and report `ok` with what survived.
        rows = res if isinstance(res, list) else (res.get("results") if isinstance(res, dict) else None)
        if not isinstance(rows, list):
            raise ValueError("unrecognised mem0 get_all envelope")
        facts = [{"id": str(m.get("id") or ""),
                  "memory": m["memory"],
                  "created_at": str(m.get("created_at") or "")}
                 for m in rows
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


async def _cleared_since_generation_start(client, *, user_id: str, trip_id: str) -> bool:
    """True if this user cleared memory after this generation's trip row was created.

    Generation takes 60-180s. Without this, a mid-generation clear is undone by the
    post-`result` write-back: the UI says cleared, the memory exists.

    Both timestamps are Postgres `now()` (trips.created_at, memory_events.created_at), so
    there is ONE clock and no host/DB skew — stamping this host's clock is the mistake
    jobs.py documents for the job lease. trips.created_at is stable across a recovery
    re-run: the row is INSERTed once in POST /generate-trip and only ever `.update()`d
    afterwards (verified), so restart-with-cache-reuse (guardrail #12) compares against the
    ORIGINAL start, which is the safe direction.

    Returns True (skip the write) whenever the reference cannot be determined — losing one
    learned memory is benign; resurrecting cleared data is the bug. A read that OVERRUNS
    _GUARD_TIMEOUT_S is one of those cases (C12): an unbounded read is what let a stale
    pre-clear snapshot outlive the clear's visibility window and green-light the add.
    """
    try:
        trip = await asyncio.wait_for(
            client.table("trips").select("created_at")
            .eq("id", trip_id).eq("user_id", user_id).maybe_single().execute(),
            timeout=_GUARD_TIMEOUT_S)
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] write-back guard: trip lookup failed: {type(e).__name__}", file=sys.stderr)
        return True
    # maybe_single() returns a BARE None on zero rows (postgrest 2.31.0) — not a result
    # whose .data is None. Both shapes must read as "no reference".
    #
    # isinstance(_, dict) rather than a bare `.get`: this line sits OUTSIDE the try above,
    # so if postgrest ever shape-drifted `.data` to a list, the AttributeError would escape
    # persist_trip_memory entirely. runner.py's outer try would catch it, but guardrail #3
    # says nothing may raise out of here — this makes that claim literally true rather than
    # true-by-someone-else's-safety-net (final whole-branch review P3).
    _row = getattr(trip, "data", None) if trip is not None else None
    started_at = _row.get("created_at") if isinstance(_row, dict) else None
    if not started_at:
        print("[mem0] write-back guard: no trip reference; skipping write", file=sys.stderr)
        return True
    try:
        res = await asyncio.wait_for(
            client.table("memory_events").select("id")
            .eq("user_id", user_id).eq("event_type", "cleared")
            .gt("created_at", started_at).execute(),
            timeout=_GUARD_TIMEOUT_S)
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] write-back guard: cleared lookup failed: {type(e).__name__}", file=sys.stderr)
        return True
    return bool(getattr(res, "data", None))


async def _write_add_intent(client, *, user_id: str, trip_id: str,
                            learned: list[str]) -> str | None:
    """Insert the audit row BEFORE the add is attempted and return its id (None on failure).

    It is `event_type='learned'` with `trip_id` set FROM THE START, because that is exactly
    what memory_clear._add_possibly_in_flight matches ('learned' or 'failed', trip_id NOT
    NULL): the row is visible to a concurrent clear the instant it exists. A dedicated
    'intent' event_type would need a migration and would have to be added to that filter to
    do the same job.

    Bounded (C12): an insert that overruns _ADD_INTENT_TIMEOUT_S reads as "no intent" and so
    skips the add, which is the same fail-safe an insert error already took. The row may
    still have committed with only its response lost — that leaves an orphan 'learned' row
    for an add that never happened, which makes the next clear answer `unknown` rather than
    `cleared` for one _ADD_VISIBILITY_WINDOW_S. Over-suppressing is the safe direction, and
    it is the same trade the crash-between-intent-and-add case already accepts.
    """
    try:
        res = await asyncio.wait_for(
            client.table("memory_events").insert({
                "user_id": user_id, "trip_id": trip_id, "event_type": "learned",
                # Object shape to match the existing convention (supabase/tests/001_…:34-37).
                "learned_facts_json": [{"fact": f} for f in learned],
            }).execute(),
            timeout=_ADD_INTENT_TIMEOUT_S)
        return ((getattr(res, "data", None) or [{}])[0]).get("id")
    except Exception as e:                  # noqa: BLE001
        # Type only — a postgrest error can carry connection details.
        print(f"[mem0] write-back: intent insert raised: {type(e).__name__}", file=sys.stderr)
        return None


async def _retract_add_intent(client, intent_id: str) -> None:
    """DELETE the intent by id — the guard fired, so nothing was sent and there is no audit
    event to keep. This preserves the pre-C11 behaviour exactly (guard fires ⇒ no row).
    Flipping it to 'failed' instead would keep matching the in-flight check and make the
    next clear report a false `unknown` for a whole _ADD_VISIBILITY_WINDOW_S.

    Bounded like the insert (C12): a hung DELETE must not wedge the write-back task."""
    try:
        await asyncio.wait_for(
            client.table("memory_events").delete().eq("id", intent_id).execute(),
            timeout=_ADD_INTENT_TIMEOUT_S)
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] write-back: intent retraction failed: {type(e).__name__}", file=sys.stderr)


async def _mark_intent_failed(client, intent_id: str) -> None:
    """Flip the intent to 'failed' by id. 'failed' means "issued, outcome unconfirmed" —
    which is what the clear's in-flight check must treat as may-still-land, so the row is
    updated in place rather than deleted.

    Bounded like the other two (C12): failing to record the flip leaves the row 'learned',
    which the in-flight check ALSO matches — the conservative direction either way."""
    try:
        await asyncio.wait_for(
            client.table("memory_events").update({"event_type": "failed"})
            .eq("id", intent_id).execute(),
            timeout=_ADD_INTENT_TIMEOUT_S)
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] write-back: intent mark-failed failed: {type(e).__name__}", file=sys.stderr)


async def persist_trip_memory(client, mem0, *, user_id: str, trip_id: str,
                              ctx: PreferenceContext) -> list[str]:
    """Write-once, awaited AFTER the terminal `result` event so it's invisible to the
    stream yet can't be GC'd. Only writes when the user stated something NEW this trip
    (distill_memory_text is None otherwise).

    ORDER IS LOAD-BEARING: intent row -> guard -> add (C11). The audit row is written
    FIRST so a clear landing mid-write-back can observe it; the guard's own read is part
    of the race window, so an intent written just before the add would not close it.
    Nothing here may RAISE (guardrail #3 — the trip is already saved and streamed), but a
    failed intent insert does ABORT the add: an add nobody can observe is precisely the
    false-`cleared` this ordering exists to prevent."""
    text = distill_memory_text(ctx)
    learned = [ctx.explicit_text] if text else []
    if not text:
        return learned   # memory-only / inferred trip: nothing new to store or audit
    if mem0 is None:
        return learned   # memory disabled: nothing was actually sent to mem0, so no
                          # memory_events row either — preferences already live in
                          # trips.preference_summary (Task 3)

    # INTENT-FIRST (C11). `_add_possibly_in_flight` can only see an in-flight add if a row
    # exists BEFORE the guard reads memory_events — the race is between the guard's READ
    # and the add, so an intent written just before mem0.add() would not close it.
    intent_id = await _write_add_intent(client, user_id=user_id, trip_id=trip_id,
                                        learned=learned)
    if intent_id is None:
        # Cannot record the intent -> do NOT add. An add nobody can observe is exactly the
        # false-`cleared` this fix removes (that is C4-bis). Losing one learned memory on a
        # DB blip is the fail-safe direction, consistent with D7.
        print("[mem0] write-back: intent row failed; skipping add", file=sys.stderr)
        return learned

    if await _cleared_since_generation_start(client, user_id=user_id, trip_id=trip_id):
        # The user cleared during this generation. Nothing was sent, so the intent must not
        # linger: a stale 'learned' row would make the NEXT clear report `unknown` for a
        # whole _ADD_VISIBILITY_WINDOW_S.
        await _retract_add_intent(client, intent_id)
        return learned

    try:
        # Timeout-bounded (Codex): a hung hosted add must not wedge the task.
        await asyncio.wait_for(
            mem0.add([{"role": "user", "content": text}], user_id=user_id,
                     metadata={"source": "generation", "trip_id": trip_id}),
            timeout=5)
    except Exception:                       # noqa: BLE001
        await _mark_intent_failed(client, intent_id)   # 'failed' still reads as may-have-landed
    return learned

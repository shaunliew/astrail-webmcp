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


async def persist_trip_memory(client, mem0, *, user_id: str, trip_id: str,
                              ctx: PreferenceContext) -> list[str]:
    """Write-once, awaited AFTER the terminal `result` event so it's invisible to the
    stream yet can't be GC'd. Records a memory_events audit row and pushes mem0.add —
    BOTH best-effort (guardrail #3): a mem0 error OR TIMEOUT can't fail the (already
    saved) trip. Only writes when the user stated something NEW this trip
    (distill_memory_text is None otherwise)."""
    text = distill_memory_text(ctx)
    learned = [ctx.explicit_text] if text else []
    if not text:
        return learned   # memory-only / inferred trip: nothing new to store or audit
    if mem0 is None:
        return learned   # memory disabled: nothing was actually sent to mem0, so no
                          # memory_events row either — preferences already live in
                          # trips.preference_summary (Task 3)

    event_type = "learned"
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

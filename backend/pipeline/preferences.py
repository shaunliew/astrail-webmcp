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

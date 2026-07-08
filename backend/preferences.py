"""Compose trips.preference_summary from the traveler profile + per-trip notes.

Persist-only for now: NO agent consumes this text yet (that is the codebase's
deferred "Step 9", see pipeline/persist.py preference_match_json note). Keeping
the merge out of the pipeline also keeps guardrail #11 intact — profile text
never reaches a tool-call in this change.
"""
from __future__ import annotations


async def fetch_traveler_profile(client, user_id: str) -> dict | None:
    """Best-effort profile read; a missing row or DB blip returns None (never fails trip creation)."""
    try:
        res = await (
            client.table("traveler_profiles")
            .select("origin_city,travel_style_tags,preference_tags,preference_notes")
            .eq("id", user_id)
            .maybe_single()
            .execute()
        )
    except Exception:
        return None
    return None if res is None else res.data


def compose_preference_summary(
    profile: dict | None, trip_preferences: str | None
) -> tuple[str | None, list[str]]:
    """Merge profile prefs + per-trip notes into one summary string.

    Returns (summary, preference_sources). Sources vocabulary is an app-level
    convention mirrored in backend-types.ts PreferenceSource — 'memory' (stored
    profile) and 'explicit' (per-trip input). NOTE: trips.preference_sources is
    plain jsonb with NO DB CHECK constraint; nothing at the DB layer catches a
    typo'd source string.
    """
    parts: list[str] = []
    sources: list[str] = []
    if profile:
        profile_bits: list[str] = []
        style = ", ".join(profile.get("travel_style_tags") or [])
        interests = ", ".join(profile.get("preference_tags") or [])
        if style:
            profile_bits.append(f"Travel style: {style}.")
        if interests:
            profile_bits.append(f"Interests: {interests}.")
        if profile.get("preference_notes"):
            profile_bits.append(f"Notes: {profile['preference_notes']}")
        if profile_bits:
            parts.append(" ".join(profile_bits))
            sources.append("memory")
    if trip_preferences:
        parts.append(f"This trip: {trip_preferences}")
        sources.append("explicit")
    return ("\n".join(parts) or None), sources

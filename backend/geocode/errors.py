"""Shared, cycle-free typed exceptions for the geocode / hotel-resolution seam (plan decision #7).

An INFRA failure must never be silently recorded as a geocode "miss": a transient translator/Mapbox
outage that got negative-cached would hide a real hotel for the miss-TTL. These two exceptions make
the taxonomy explicit and are consumed across the whole chain (T1 localizer, T3 cache primitive,
T4 resolver, T5 persist wiring).

They live in their OWN leaf module — importing nothing from geocode.* or genagents.* — so both
packages can import them with no import cycle. Import-keyless: no Agents SDK, no openai, no httpx,
no supabase at import time.
"""
from __future__ import annotations


class ResolveError(Exception):
    """A hotel could not be resolved because of an INFRA failure — translator/OpenAI outage, an
    input-guardrail trip, a timeout, a 4xx/429/5xx, or a malformed 2xx from Mapbox.

    NEVER cached and NEVER treated as a geocode 'miss' (a transient outage must not become a
    negative-cached miss). It propagates so the caller preserves prior hotel rows rather than
    clobbering good coordinates with an all-unresolved rewrite (Guardrail #7 / plan decision #7).
    Only genuine valid-empty / unlocalizable outcomes are cacheable misses.
    """


class CacheError(Exception):
    """A cache WRITE (write-through persistence) failed.

    Raised so a durability failure is loud rather than silently dropping the write (Guardrail #7 —
    caches are write-through). Asymmetric with reads: a cache READ failure does NOT raise — it is
    logged and treated as a miss so resolution falls through to a live geocode (plan decision #7 / T3).
    """

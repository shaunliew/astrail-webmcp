"""Hotel-geocode cache primitive (T3) — the identity key, a lock-free bulk read, and a single-flight
`resolve_cached` that fronts one expensive resolve of a hotel identity into a coordinate.

This is the shared write-through cache for the hotel FORWARD-geocode seam (the ONE live Mapbox path
that is still uncached — reel places already reverse-verify through `geocode_country_cache`). It MIRRORS
that shipped precedent (`grounding._lookup_cached_country` / `_store_cached_country`): a versioned key,
strict re-validation on read, and — most importantly — the READ/WRITE asymmetry that makes a cache an
*optimization on the way in and a durability guarantee on the way out*:
  * a READ failure logs the error TYPE only and is treated as a MISS (fall through to the resolver);
  * a WRITE failure RAISES a typed `CacheError` (Guardrail #7 — caches are write-through).

Cache-opt-in via an injected `client`: `client is None` skips the cache entirely and just runs the
resolver, so the offline / eval path is byte-identical (no DB, no key). The `resolver` callback is the
WHOLE miss unit T4 supplies (translate -> JA-validate -> strict-geocode -> identity-gate); it returns a
`GeocodeResult` for a confirmed found, `None` for a valid-empty / unconfirmed miss, or RAISES
`ResolveError` on an infra failure (translator / Mapbox-network / malformed-2xx) — a `ResolveError` is
NEVER cached and NEVER a miss; it propagates so the caller preserves prior hotel rows.

LIVE-ONLY — like `genagents.hotel_translate`, this module MUST NEVER be imported by the offline eval /
offline_harness. It is reached only inside the LIVE `persist_hotels` branch (with a real, injected
Supabase client); importing it there would break eval-safety (T6 asserts it never enters sys.modules on
the offline path). Import discipline (Guardrail #9): nothing heavy at module scope — no Agents SDK, no
`openai`, no `httpx`, no supabase client — so `import geocode.cache` loads nothing that needs a key or
makes a call. Wall-clock (`datetime.now`) is used here for TTLs; it is safe precisely because this path
never runs on the deterministic offline eval (which passes `client=None` and never imports this module).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from geocode.errors import CacheError
from models.geocode import GeocodeResult

logger = logging.getLogger(__name__)

# Bump to invalidate EVERY cached hotel en masse (an algorithm change) — mirrors
# grounding's LOCATION_VERIFICATION_VERSION. Data drift (relocation / rebrand / ID-reuse) is covered
# separately by the bounded per-row TTL, not by this version.
STRATEGY_VERSION = "hotel-geocode-v1"

CACHE_TABLE = "hotel_geocode_cache"

# The row shape the read path validates + the write path persists (`created_at` defaults in the DB).
_SELECT_COLUMNS = "cache_key,status,lat,lng,country_code,name_fingerprint"

# Sentinel distinguishing a clean cached MISS (return None, do NOT resolve) from "no usable cached
# row" (absent / expired / malformed / fingerprint-mismatch -> fall through to the resolver).
_NO_CACHE = object()

# Per-key in-process single-flight locks (plan decision #8 / v4 #3 — this module is the SOLE owner).
# Bounded by the number of DISTINCT hotel identities seen (small — the whole point is cross-trip reuse,
# ~23 distinct hotels observed), on a single pinned web instance. Cleanup is deferred: removing a lock
# is racy while waiters may still hold a reference, and the footprint is one asyncio.Lock per hotel.
_key_locks: dict[str, asyncio.Lock] = {}


def _norm(value: object) -> str:
    """NFKC + casefold so compatibility forms and case variants of the same identity collapse."""
    return unicodedata.normalize("NFKC", str(value)).casefold()


def identity_key(provider: str, country_code: str, hotel_id: str) -> str:
    """The STABLE cache key for a hotel — computable BEFORE translation (plan decision #6).

    `STRATEGY_VERSION` + SHA-256 of canonical JSON `{provider, country, hotelId}` (NFKC + casefold).
    The JP Mapbox query is the *translated* name, which does not exist until after the cache read, so
    the key can never be the query — it is the hotel's stable Travala identity instead.

    `hotel_id` MUST be non-null / non-empty: a missing (or duplicate) id is not a stable identity, so
    the caller (T4) must resolve LIVE without caching. This raises rather than returning a bogus key,
    so a missing id can never silently poison a shared cache row — T4 gates on presence before calling.
    """
    if not hotel_id or not str(hotel_id).strip():
        raise ValueError(
            "identity_key requires a non-empty hotel_id; a missing id must resolve LIVE (no cache)"
        )
    canonical = json.dumps(
        {"provider": _norm(provider), "country": _norm(country_code), "hotelId": _norm(hotel_id)},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"{STRATEGY_VERSION}:{digest}"


class CacheRow(BaseModel):
    """Strict re-validation of a cached row on READ (plan decision #4 / v3 #10).

    Enforces the same coord<->status<->country_code invariant the T2 DB CHECK enforces, plus an
    uppercased 2-letter `country_code` — NOT the loose `GeocodeResult`. A row that fails these
    invariants is a READ-MISS (the caller re-resolves): like `grounding`'s
    `CountryResult(...) except ValidationError -> None`, a malformed / legacy / hand-edited row is
    never trusted and never raised on, so it can never smuggle a half-populated coordinate downstream.
    Extra DB columns (cache_key, created_at, expires_at, id) are ignored.
    """

    model_config = ConfigDict(extra="ignore")

    status: Literal["found", "miss"]
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    name_fingerprint: str | None = None

    @field_validator("country_code", mode="before")
    @classmethod
    def _uppercase_country(cls, value):
        return value.upper() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _coord_status_invariant(self):
        if self.status == "found":
            if self.lat is None or self.lng is None or self.country_code is None:
                raise ValueError("a 'found' row must carry lat, lng AND country_code")
        elif self.lat is not None or self.lng is not None or self.country_code is not None:
            raise ValueError("a 'miss' row must have lat, lng AND country_code all None")
        return self


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _validate_row(row: dict) -> CacheRow | None:
    """A validated `CacheRow`, or None for a malformed row (treated as a read-miss)."""
    try:
        return CacheRow.model_validate(row)
    except ValidationError:
        return None


def _key_lock(key: str) -> asyncio.Lock:
    """The single-flight lock for one key. Get-or-create is atomic on the event loop (no await between
    the read and the write), so concurrent callers of one key share the SAME lock object."""
    lock = _key_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _key_locks[key] = lock
    return lock


def _to_geocode_result(row: CacheRow) -> GeocodeResult:
    """A cached FOUND -> GeocodeResult. Only the geocode FACT (coord + country) is cached; the row was
    identity-gated when written, so the downstream (trip-specific) proximity gate re-runs on this coord."""
    return GeocodeResult(lat=row.lat, lng=row.lng, country_code=row.country_code)


async def lookup_many(client, keys) -> dict[str, CacheRow | None]:
    """One LOCK-FREE batched cache read — the initial cache pass for T4 (plan decision #8).

    Returns `{key: CacheRow}` for each un-expired, VALID row and `{key: None}` for a missing / expired /
    malformed one. Fingerprint matching is NOT done here (the caller compares `row.name_fingerprint`
    against the current hotel's) — this is purely the bulk read. Blip-tolerant like the single-key read:
    a read failure logs the error TYPE only and returns all-misses (fall through to resolve), never raises.
    """
    result: dict[str, CacheRow | None] = {key: None for key in keys}
    if not result:
        return result
    try:
        response = await (client.table(CACHE_TABLE)
                          .select(_SELECT_COLUMNS)
                          .in_("cache_key", list(result))
                          .gt("expires_at", _utcnow().isoformat())
                          .execute())
        rows = (response.data if response is not None else None) or []
    except Exception as exc:
        # Type only — never the exception text, which can carry a connection string (token safety).
        logger.warning("hotel_geocode_cache_read_failed op=lookup_many error=%s", type(exc).__name__)
        return result
    for row in rows:
        key = row.get("cache_key")
        if key in result:
            result[key] = _validate_row(row)
    return result


async def _read_one(client, key: str, expected_fingerprint):
    """Read the single un-expired row for `key`. Returns:

      * a `GeocodeResult` — a clean, fingerprint-matching FOUND hit;
      * `None`            — a clean, fingerprint-matching MISS hit (do NOT resolve);
      * `_NO_CACHE`       — no usable row (absent / expired / malformed / fingerprint-mismatch) -> resolve.

    Blip-tolerant: a read failure logs the TYPE and returns `_NO_CACHE` (fall through), never raises.
    """
    try:
        response = await (client.table(CACHE_TABLE)
                          .select(_SELECT_COLUMNS)
                          .eq("cache_key", key)
                          .gt("expires_at", _utcnow().isoformat())
                          .maybe_single()
                          .execute())
        row = response.data if response is not None else None
    except Exception as exc:
        logger.warning("hotel_geocode_cache_read_failed op=resolve_cached error=%s", type(exc).__name__)
        return _NO_CACHE
    if not row:
        return _NO_CACHE
    cached = _validate_row(row)
    if cached is None:
        return _NO_CACHE                                  # malformed -> read-miss
    if cached.name_fingerprint != expected_fingerprint:
        return _NO_CACHE                                  # ID-reuse / relocation (v4 #2) -> re-resolve
    return _to_geocode_result(cached) if cached.status == "found" else None


async def _write(client, key: str, result: GeocodeResult | None, expected_fingerprint,
                 hit_ttl_days: int, miss_ttl_days: int) -> None:
    """Write-through upsert of the resolve outcome. RAISES `CacheError` on failure (Guardrail #7).

    A `found` (GeocodeResult) gets `now()+hit_ttl_days` and its coord + uppercased country; a `miss`
    (None) gets `now()+miss_ttl_days` and all-None coords — the coord<->status invariant the DB CHECK
    also enforces. The fingerprint is stored so a later read can detect a hotel-identity change.
    """
    now = _utcnow()
    if result is None:
        row = {
            "cache_key": key,
            "status": "miss",
            "lat": None,
            "lng": None,
            "country_code": None,
            "name_fingerprint": expected_fingerprint,
            "expires_at": (now + timedelta(days=miss_ttl_days)).isoformat(),
        }
    else:
        row = {
            "cache_key": key,
            "status": "found",
            "lat": result.lat,
            "lng": result.lng,
            # Uppercase to satisfy the ^[A-Z]{2}$ DB CHECK; a found with no country is left to the
            # CHECK to reject loudly (the resolver only confirms a found when country matches).
            "country_code": (result.country_code or "").upper() or None,
            "name_fingerprint": expected_fingerprint,
            "expires_at": (now + timedelta(days=hit_ttl_days)).isoformat(),
        }
    try:
        await client.table(CACHE_TABLE).upsert(row, on_conflict="cache_key").execute()
    except Exception as exc:
        # Type only (token safety); RAISE so a durability failure is loud, not silently dropped.
        raise CacheError(f"hotel_geocode_cache write failed: {type(exc).__name__}") from None


async def resolve_cached(
    client,
    key: str,
    resolver: Callable[[], Awaitable[GeocodeResult | None]],
    *,
    expected_fingerprint,
    hit_ttl_days: int = 365,
    miss_ttl_days: int = 14,
) -> GeocodeResult | None:
    """Resolve one hotel identity -> coordinate through the write-through cache, with single-flight.

    Flow:
      * `client is None` -> cache disabled: just `await resolver()` (offline/eval byte-identical).
      * initial LOCK-FREE read (`_read_one`): a clean hit returns the cached found (GeocodeResult) or
        miss (None) immediately — no resolver, no lock.
      * on a read-miss -> the per-key single-flight lock (this module is its SOLE owner, v4 #3): acquire,
        RE-READ under the lock (double-checked — a prior waiter may have just filled it), else run the
        injected `resolver()` (the whole translate+geocode+gate unit) inside ONE lock hold and upsert its
        outcome. Two concurrent callers of one key pay for exactly ONE resolve.

    Failure taxonomy: `resolver()` returns a `GeocodeResult` (found, +hit_ttl_days) or `None` (valid-empty
    / unconfirmed miss, +miss_ttl_days); it RAISES `ResolveError` on infra failure — which is NOT cached,
    NOT a miss, and propagates untouched (nothing is written). Read/write asymmetry mirrors grounding: a
    cache READ failure -> log + treat as a miss (resolve); a cache WRITE failure -> raise `CacheError`.
    """
    if client is None:
        return await resolver()

    hit = await _read_one(client, key, expected_fingerprint)
    if hit is not _NO_CACHE:
        return hit

    async with _key_lock(key):
        hit = await _read_one(client, key, expected_fingerprint)
        if hit is not _NO_CACHE:
            return hit
        result = await resolver()          # ResolveError propagates: not cached, not a miss, no write
        await _write(client, key, result, expected_fingerprint, hit_ttl_days, miss_ttl_days)
        return result

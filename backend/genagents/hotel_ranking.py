"""Pure hotel geocode + rank orchestration for the Travala hotel-hub map feature.

`rank_hotels` turns raw Travala hotel dicts into `RankedHotel` records carrying the map columns
(`lat, lng, geo_status, route_score, rank, is_recommended, place_durations`). ALL IO is injected —
`geocode` (a token-bound `geocode.mapbox_forward.forward_geocode`) and `matrix` (a token-bound
`genagents.matrix.fetch_matrix`) — so the module is fully unit-testable with fakes and holds no
token. `import genagents.hotel_ranking` pulls only stdlib at module scope (the pure geo/price
helpers it reuses are imported lazily inside `rank_hotels`), so it is import-keyless and makes no
network call.

Determinism (eval-safety): no randomness, no wall-clock. Ranking sorts on
`(blended score desc, star desc, hotelId asc)` — a total order over the unique string hotelIds, so
the output is reproducible across runs regardless of dict/set iteration order.

Honest-failure (Guardrail #1): a hotel is only `placed` when the geocode is a real, in-country,
in-proximity hit; otherwise it is `unresolved` with NULL coords and never pinned. A coordinate is
never invented.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Mapping, Sequence

if TYPE_CHECKING:  # type-only; avoids importing httpx / pydantic at module scope
    from genagents.matrix import Matrix
    from models.geocode import GeocodeResult

# The Mapbox Matrix coordinate cap (sources + destinations share one list). Mirrors
# genagents.matrix._MAX_COORDS; trimming here keeps fetch_matrix from raising.
_MAX_COORDS = 25

# A geocoded point must be within this great-circle distance of the trip centroid to be `placed`.
_PROXIMITY_M = 60_000.0

# Blend weights: preference-proxy vs route-centrality. Equal split (locked design decision).
_W_PREF = 0.5
_W_CENT = 0.5

# budget_level → the target price position within the placed hotel set (0 = cheapest, 1 = priciest).
# "price fit" (C4): a budget traveller's ideal hotel sits at the cheap end, a luxury traveller's at
# the expensive end. Unknown/None → treat as budget-conscious (cheapest is most affordable).
_BUDGET_TARGET = {"budget": 0.0, "mid_range": 1.0 / 3.0, "premium": 2.0 / 3.0, "luxury": 1.0}


@dataclass(frozen=True)
class RankedHotel:
    """A ranked hotel = the raw Travala hotel dict + the seven `hotel_suggestions` map columns.

    Field names match the migration columns (schema parity, Guardrail #4). `hotel` is the untouched
    source dict (name/star/price/hotelId/address/…) the caller reads for the other row fields.

    Only the TOP 3 placed hotels are hub candidates: they carry rank (1..3), is_recommended on
    rank 1, route_score, and place_durations. A placed hotel ranked 4+ keeps its real geocoded coords
    (geo_status='placed') but rank/route_score are None, is_recommended is False, place_durations is
    empty — it is not a selectable hub. An `unresolved` hotel has None lat/lng/route_score/rank,
    is_recommended False, empty place_durations.
    """
    hotel: Mapping[str, Any]
    lat: float | None
    lng: float | None
    geo_status: str            # 'placed' | 'unresolved' (matches the geo_status CHECK)
    route_score: float | None  # mean duration (s) to ALL trip places; lower = more central. Top-3 only
    rank: int | None           # 1..3 hub-candidate position; None for placed hotels ranked 4+
    is_recommended: bool       # the rank-1 hub (the default-selected central hotel)
    place_durations: dict[str, float] = field(default_factory=dict)  # {place_id: duration_s}, top-3 only


# --- pure helpers (no IO) --------------------------------------------------------------------


def _all_unresolved(hotels: Sequence[Mapping[str, Any]]) -> list[RankedHotel]:
    """Every hotel as an honest `unresolved` record (NULL coords, no rank) — the shared result
    whenever nothing can be placed (no trip country, no centroid). Never invents a coordinate."""
    return [RankedHotel(hotel=h, lat=None, lng=None, geo_status="unresolved",
                        route_score=None, rank=None, is_recommended=False) for h in hotels]


def _minmax(values: dict[Any, float]) -> dict[Any, float]:
    """Min-max normalize to [0, 1]; an all-equal (or single) set maps to a neutral 0.5."""
    if not values:
        return {}
    lo, hi = min(values.values()), max(values.values())
    if hi == lo:
        return {k: 0.5 for k in values}
    span = hi - lo
    return {k: (v - lo) / span for k, v in values.items()}


def _coord(place: Mapping[str, Any], num) -> tuple[float, float] | None:
    """(lat, lng) for a place with real, finite numeric coords, else None.

    (0, 0) is the saved-with-gaps unresolved sentinel (mirrors the frontend `hasRealCoords`), NOT a
    real point in the Gulf of Guinea: a single (0, 0) place would otherwise drag the centroid
    thousands of km, mass-fail the 60km proximity gate, and mark every hotel unresolved.
    """
    lat, lng = num(place.get("lat")), num(place.get("lng"))
    if lat is None or lng is None:
        return None
    if lat == 0 and lng == 0:
        return None
    return (lat, lng)


def _centroid(places: Sequence[Mapping[str, Any]], num) -> tuple[float, float] | None:
    """Mean (lat, lng) over every coord-bearing place; None when none have coords."""
    pts = [c for p in places if (c := _coord(p, num)) is not None]
    if not pts:
        return None
    return (sum(la for la, _ in pts) / len(pts), sum(ln for _, ln in pts) / len(pts))


def _is_destination(place: Mapping[str, Any]) -> bool:
    """A routable Matrix destination = a real dayed place. Exclude the base hotel / any undayed
    place (a hotel must not be routed to itself — C5)."""
    if place.get("place_type") == "hotel":
        return False
    return place.get("day_number") is not None


def _destinations(places: Sequence[Mapping[str, Any]], num) -> list[tuple[str, tuple[float, float]]]:
    """Ordered [(place_id, (lat, lng))] of routable, coord-bearing destinations. Order is preserved
    so a Matrix column index maps back to the exact place_id it was submitted for (C5)."""
    out: list[tuple[str, tuple[float, float]]] = []
    for p in places:
        if not _is_destination(p):
            continue
        c = _coord(p, num)
        if c is None:
            continue
        out.append((str(p.get("place_id")), c))
    return out


def _affordability(placed: list[tuple[int, Mapping[str, Any]]], budget_level, num) -> dict[int, float]:
    """Price-fit sub-score in [0, 1] per placed hotel (keyed by input index).

    Reuses the price discipline of `pipeline.tradeoffs.build_hotel_comparisons`: rank within ONE
    price basis (prefer per-night, fall back to total) and ONE currency (the largest currency group,
    deterministic tiebreak on the currency string) so a foreign-currency row never distorts the
    ranking. Each hotel's price position (0 = cheapest … 1 = priciest) is scored by closeness to the
    budget_level target. Hotels with no comparable price get a neutral 0.5.
    """
    result: dict[int, float] = {idx: 0.5 for idx, _ in placed}

    priced: list[tuple[int, float, Any]] = []
    for key in ("pricePerNight", "totalPrice"):
        rows = [(idx, p, h.get("currency")) for idx, h in placed if (p := num(h.get(key))) is not None]
        if len(rows) >= 2:
            priced = rows
            break
    if len(priced) < 2:
        return result

    by_cur: dict[Any, list[tuple[int, float]]] = {}
    for idx, p, cur in priced:
        by_cur.setdefault(cur, []).append((idx, p))
    _cur, group = max(by_cur.items(), key=lambda kv: (len(kv[1]), str(kv[0])))
    if len(group) < 2:
        return result

    prices = [p for _, p in group]
    lo, hi = min(prices), max(prices)
    span = hi - lo
    target = _BUDGET_TARGET.get(budget_level, 0.0)
    for idx, p in group:
        pos = 0.5 if span == 0 else (p - lo) / span
        result[idx] = 1.0 - abs(pos - target)
    return result


# --- orchestration ---------------------------------------------------------------------------


async def rank_hotels(
    hotels: Sequence[Mapping[str, Any]],
    places: Sequence[Mapping[str, Any]],
    city: str | None,
    country_code: str | None,
    budget_level: str | None,
    *,
    geocode: Callable[..., Awaitable["GeocodeResult | None"]],
    matrix: Callable[..., Awaitable["Matrix | None"]],
) -> list[RankedHotel]:
    """Geocode + rank Travala hotels into `RankedHotel` records. Pure: `geocode` and `matrix` are
    injected (token pre-bound by the caller). See the module docstring for the honest-failure and
    determinism contracts.

    Args:
        hotels: raw Travala hotel dicts (name/star/pricePerNight/totalPrice/currency/hotelId/address).
        places: trip place dicts (place_id, lat, lng, place_type, day_number). Undayed / hotel-type
            places are excluded from Matrix destinations.
        city: geocode query suffix ("{address}, {city}").
        country_code: the trip's country (e.g. "JP"); the geocode country filter AND the in-country
            gate. When None, no hotel can pass the country gate → all unresolved (honest).
        budget_level: "budget" | "mid_range" | "premium" | "luxury" | None — the price-fit target.
        geocode: async (query, *, types, country, proximity_lng_lat) -> GeocodeResult | None.
        matrix: async (sources, destinations, *, annotations) -> Matrix | None. (lat, lng) points.
    """
    if not hotels:
        return []

    # Without a trip country the in-country gate rejects every hotel, so short-circuit BEFORE firing
    # N geocode calls (no wasted Mapbox requests). The all-unresolved result is identical to letting
    # the gate reject each hit — this only skips the futile network round-trips.
    if country_code is None:
        return _all_unresolved(hotels)

    from pipeline.geo import haversine_m  # lazy: keeps this module import-keyless / stdlib-only
    from pipeline.tradeoffs import _num as num  # reuse the finite-number helper (DRY, C4)

    centroid = _centroid(places, num)
    # Without a trip centroid the proximity gate is undefined → nothing can be honestly placed.
    if centroid is None:
        return _all_unresolved(hotels)
    clat, clng = centroid

    # Geocode every address-bearing hotel CONCURRENTLY (bounds added latency to ~1 RTT, not N).
    to_geocode: list[int] = []
    coros = []
    for idx, h in enumerate(hotels):
        address = h.get("address")
        if not address:
            continue  # no street address → cannot honestly geocode → unresolved
        query = ", ".join(part for part in (str(address), city) if part)
        to_geocode.append(idx)
        coros.append(geocode(query, types="address", country=country_code,
                             proximity_lng_lat=(clng, clat)))  # forward_geocode wants (lng, lat)
    results = await asyncio.gather(*coros, return_exceptions=True) if coros else []

    # Apply the honest gate: placed requires a hit, an in-country match, and an in-proximity point.
    geo_by_idx: dict[int, "GeocodeResult"] = {}
    for idx, res in zip(to_geocode, results):
        if isinstance(res, BaseException) or res is None:
            continue  # a raised geocode (sanitized) or a miss → unresolved (never surfaced/logged)
        if res.country_code is None:  # country_code None already returned early above
            continue
        if res.country_code.lower() != country_code.lower():
            continue
        if haversine_m(clat, clng, res.lat, res.lng) > _PROXIMITY_M:
            continue
        geo_by_idx[idx] = res

    placed_idx = [idx for idx in range(len(hotels)) if idx in geo_by_idx]

    # Matrix: sources = placed hotels, destinations = real dayed places (base excluded, order kept).
    dests = _destinations(places, num)
    dest_ids = [pid for pid, _ in dests]
    dest_coords = [c for _, c in dests]

    # Trim placed hotels out of the Matrix sources (lowest preference first) so
    # len(sources) + len(destinations) <= 25 — the exact cap fetch_matrix enforces.
    afford = _affordability([(idx, hotels[idx]) for idx in placed_idx], budget_level, num)
    star_by_idx = {idx: (num(hotels[idx].get("star")) or 0.0) for idx in placed_idx}

    def _pref_key(idx: int) -> tuple[float, float, str]:
        # lowest preference first when sorted ascending: worst affordability, then lowest star.
        return (afford[idx], star_by_idx[idx], str(hotels[idx].get("hotelId") or ""))

    # Fit within the Matrix coord cap (sources + destinations share ONE list, max _MAX_COORDS).
    # If destinations alone would fill the cap, trim them FIRST (keeping order) so at least one hotel
    # source can still route — dropped places just get no duration (still drawn as unlabeled spokes),
    # an honest degrade, never a crash. Then drop the lowest-preference hotels; the `matrix_src_idx
    # and` guard makes the loop unable to drain sources to empty (min([]) would ValueError).
    if len(dest_coords) > _MAX_COORDS - 1:
        dest_ids = dest_ids[: _MAX_COORDS - 1]
        dest_coords = dest_coords[: _MAX_COORDS - 1]
    matrix_src_idx = list(placed_idx)
    while matrix_src_idx and len(matrix_src_idx) + len(dest_coords) > _MAX_COORDS:
        matrix_src_idx.remove(min(matrix_src_idx, key=_pref_key))

    route_score: dict[int, float] = {}
    place_durations: dict[int, dict[str, float]] = {idx: {} for idx in placed_idx}
    if matrix_src_idx and dest_coords:
        src_coords = [(geo_by_idx[idx].lat, geo_by_idx[idx].lng) for idx in matrix_src_idx]
        mat = await matrix(src_coords, dest_coords, annotations="duration,distance")
        if mat is not None:
            for i, idx in enumerate(matrix_src_idx):
                row = mat.durations[i] if i < len(mat.durations) else []
                pd: dict[str, float] = {}
                for j, pid in enumerate(dest_ids):
                    v = row[j] if j < len(row) else None
                    fv = num(v)
                    if fv is not None:
                        pd[pid] = fv
                place_durations[idx] = pd
                # Centrality is a fair comparison only when the hotel reaches EVERY destination
                # (Codex P1): a hotel that reaches one stop and fails the rest must NOT out-rank one
                # that reaches them all. Partial reach → route_score None (ranked on preference
                # only); the reachable cells still ride in place_durations as valid spoke labels.
                if pd and len(pd) == len(dest_ids):
                    route_score[idx] = sum(pd.values()) / len(pd)

    # Preference proxy (normalized affordability + normalized stars), then blend with centrality.
    star_norm = _minmax(star_by_idx)
    pref_raw = {idx: 0.5 * afford[idx] + 0.5 * star_norm[idx] for idx in placed_idx}
    pref_norm = _minmax(pref_raw)
    cent_norm = _minmax({idx: route_score[idx] for idx in placed_idx if idx in route_score})
    # min-average duration is BEST → invert so the most-central hotel scores highest.
    cent_norm = {idx: 1.0 - v for idx, v in cent_norm.items()}

    score: dict[int, float] = {}
    for idx in placed_idx:
        if idx in cent_norm:
            score[idx] = _W_PREF * pref_norm[idx] + _W_CENT * cent_norm[idx]
        else:
            score[idx] = pref_norm[idx]  # centrality unmeasurable → rank on preference only

    # Deterministic order: score desc, star desc, hotelId asc (a total order over unique hotelIds).
    ordered = sorted(
        placed_idx,
        key=lambda idx: (-score[idx], -star_by_idx[idx], str(hotels[idx].get("hotelId") or "")),
    )

    # TOP-3 SHORTLIST (Goal + decision #5): only the top 3 placed hotels are hub CANDIDATES — they
    # carry a rank (1..3), is_recommended on rank 1, plus route_score + place_durations (the spoke
    # data the map draws for the chosen hub). Placed hotels ranked 4+ keep their REAL geocoded coords
    # (they placed fine — never relabel them unresolved) but rank=None / is_recommended=False /
    # route_score=None / no place_durations: they are not selectable hubs. Frontend contract: a hotel
    # is a hub candidate iff geo_status=='placed' AND rank is not None (rank in {1, 2, 3}).
    out: list[RankedHotel] = []
    for pos, idx in enumerate(ordered):  # placed hotels first, in blended-score order
        in_top3 = pos < 3
        out.append(RankedHotel(
            hotel=hotels[idx],
            lat=geo_by_idx[idx].lat, lng=geo_by_idx[idx].lng,
            geo_status="placed",
            route_score=route_score.get(idx) if in_top3 else None,
            rank=(pos + 1) if in_top3 else None,
            is_recommended=(pos == 0),
            place_durations=place_durations[idx] if in_top3 else {},
        ))
    for idx in range(len(hotels)):  # unresolved hotels after, in input order
        if idx in geo_by_idx:
            continue
        out.append(RankedHotel(
            hotel=hotels[idx], lat=None, lng=None, geo_status="unresolved",
            route_score=None, rank=None, is_recommended=False,
        ))
    return out

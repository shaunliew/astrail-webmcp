"""Live pipeline smoke tool — generate a REAL trip end-to-end and inspect what persisted.

Runs the full runtime pipeline (Apify scrape -> OpenAI extract -> Mapbox geocode ->
dedup/route -> Open-Meteo weather -> normalized persist) against the LIVE dev Supabase
DB, then prints the trip / places / trip_places / trip_days that landed. Use it to
manually confirm a real generation after backend changes.

SPENDS REAL CREDITS (Apify + OpenAI + Mapbox) and writes to the live DB. NOT a pytest
test (pytest stays keyless/offline) — run it by hand. Import stays keyless: the app
modules are imported inside the run body, never at module scope.

Requires backend/.env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APIFY_TOKEN,
OPENAI_API_KEY, MAPBOX_SECRET_TOKEN, ASTRAIL_TEST_USER_ID.

Usage (from backend/):
    uv run --env-file .env python -m scripts.live_run
    uv run --env-file .env python -m scripts.live_run --reels URL1,URL2 --start 2026-07-10 --end 2026-07-12
    uv run --env-file .env python -m scripts.live_run --pace packed --dest Japan
    uv run --env-file .env python -m scripts.live_run --cleanup            # delete the trip after (hermetic)
    uv run --env-file .env python -m scripts.live_run --inspect <trip_id>  # re-print an existing trip, no run
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as _dt
import logging
import os

# The ONLY logger this tool lifts to INFO, and why it is a list of one rather than the root
# logger: `pipeline.persist` emits the per-trip `trip_place_grounding` counters (see
# `_configure_logging`). Add a name here only after checking it cannot print a URL.
_VERBOSE_LOGGERS = ("pipeline.persist",)

# Third-party loggers pinned to WARNING so a future root-level change cannot re-leak. What each
# entry buys is documented once, at `telegram_ingest/worker.py`'s copy of this tuple — read it
# before deleting one. The reason this script needs its own copy is that the credential differs:
#
#   httpx     THE live leak here. Logs `HTTP Request: GET <url>` at INFO, and MAPBOX_SECRET_TOKEN
#             is IN that URL as `access_token=sk...` — the Search Box / Geocoding APIs have no
#             header auth, so `geocode/mapbox_forward.py` and `geocode/mapbox_reverse.py` must
#             pass it as a query param, and both go to lengths to keep it out of their own error
#             messages. One root logger at INFO undid all of it, on every geocode of a real run.
#   httpcore  DEBUG-only and carries no URL path today. Pinned pre-emptively.
#   realtime  `get_supabase_client()` constructs an `AsyncRealtimeClient` on every boot, which
#             logs `wss://…?apikey=<SERVICE_ROLE_KEY>` at DEBUG.
_NOISY_TRANSPORT_LOGGERS = ("httpx", "httpcore", "realtime")

# Default reels: the repo's real Japan demo set (evals/fixtures/japan_demo_reels.json).
_DEFAULT_REELS = [
    "https://www.instagram.com/reel/DYbmT-SNzVK/",
    "https://www.instagram.com/reel/DYM_I5IvLSv/",
]


def _default_dates() -> tuple[str, str]:
    """A near-term window (inside Open-Meteo's ~16-day forecast horizon so weather lands)."""
    today = _dt.date.today()
    return (today + _dt.timedelta(days=5)).isoformat(), (today + _dt.timedelta(days=7)).isoformat()


async def _inspect(client, trip_id: str) -> None:
    """Print the persisted trip exactly as the frontend would read it: day -> place -> weather."""
    trip_result = (
        await client.table("trips")
        .select("id,status,destination_hint,start_date,end_date,title,summary,"
                "preference_summary,preference_sources,created_at")
        .eq("id", trip_id).maybe_single().execute()
    )
    # maybe_single() returns a bare None on zero rows, so `.data` cannot be read inline --
    # doing so AttributeErrors past the `if trip is None` guard directly below.
    trip = trip_result.data if trip_result is not None else None
    if trip is None:
        print(f"no trip {trip_id}")
        return
    trip_created = trip.get("created_at")
    tps = (
        await client.table("trip_places").select("place_id,day_number,sort_order,source_type")
        .eq("trip_id", trip_id).execute()
    ).data
    tds = (
        await client.table("trip_days").select("day_number,day_date,weather_source,weather_summary,title")
        .eq("trip_id", trip_id).execute()
    ).data
    pids = [t["place_id"] for t in tps]
    places = (
        (await client.table("places")
         .select("id,name,place_type,lat,lng,country,country_code,country_name,created_at,updated_at")
         .in_("id", pids).execute()).data
        if pids else []
    )
    by_id = {p["id"]: p for p in places}
    print(f"\n=== TRIP {trip['id']}")
    print(f"    status={trip['status']} dest={trip['destination_hint']} "
          f"{trip['start_date']}..{trip['end_date']}")
    print(f"    trip_title={trip.get('title')!r}")
    print(f"    trip_summary={trip.get('summary')!r}")
    print(f"    trips.preference_summary={trip.get('preference_summary')!r} "
          f"preference_sources={trip.get('preference_sources')!r}")
    pref_stage_events = (
        await client.table("generation_events").select("message,payload")
        .eq("trip_id", trip_id).eq("stage", "preferences").execute()
    ).data
    print("=== preferences stage event:")
    for ev in pref_stage_events:
        source = (ev.get("payload") or {}).get("preference_source")
        print(f"    preference_source={source!r}  message={ev.get('message')!r}")
    # PERSISTED memory receipt (there is NO memory_preference SSE event — the receipt is
    # persisted to memory_events, not streamed; read it from the DB, not a stage event).
    mem_events = (
        await client.table("memory_events").select("event_type,learned_facts_json,created_at")
        .eq("trip_id", trip_id).execute()
    ).data
    print(f"=== memory_events (persisted receipt): {len(mem_events)}")
    for me in mem_events:
        print(f"    event_type={me.get('event_type')!r}  learned_facts_json={me.get('learned_facts_json')!r}")
    print(f"=== trip_places: {len(tps)} | places: {len(places)} | trip_days: {len(tds)}")
    for tp in sorted(tps, key=lambda x: (x["day_number"] or 0, x["sort_order"] or 0)):
        p = by_id.get(tp["place_id"], {})
        # `country` is a VERIFICATION RECEIPT, not a label: non-NULL means the coordinate was
        # reverse-geocoded AND agreed with the extractor's independent claim. NULL is the honest
        # answer for anything unverified, so print it explicitly rather than blanking it.
        country = p.get("country")
        cc, cn = p.get("country_code"), p.get("country_name")
        badge = f"{country} ({cc}/{cn})" if country else "country=NULL"
        # NEW vs REUSED is the difference between "this run wrote the country" and "the row
        # already had one". Without it a smoke that only ever dedups onto already-verified rows
        # reads as a pass while proving nothing about the insert path.
        origin = "NEW" if trip_created and (p.get("created_at") or "") >= trip_created else "REUSED"
        # `updated_at` is the ONLY field that distinguishes "this run issued no second write"
        # from "it rewrote the same values" — the fixed-point check the repair plan requires.
        # The row id is printed because the fixed-point check compares ids across two runs —
        # without it the comparison is not possible at all.
        print(f"    day {tp['day_number']} #{tp['sort_order']}  {p.get('name', '?')} "
              f"[{p.get('place_type', '?')}] ({round(p.get('lat', 0), 4)},{round(p.get('lng', 0), 4)})"
              f"  {badge}  [{origin}]")
        print(f"        id={p.get('id')}  updated={p.get('updated_at')}")
    verified = [p for p in places if p.get("country")]
    fresh = [p for p in places
             if trip_created and (p.get("created_at") or "") >= trip_created]
    print(f"=== grounding: {len(verified)}/{len(places)} places carry a VERIFIED country "
          f"({len(fresh)} row(s) created by THIS run, {len(places) - len(fresh)} reused)")

    # Would an exact-coordinate repair reach these rows? A row's OWN coordinate has been
    # Mapbox-verified iff its `_coord_cache_key` is already in `geocode_country_cache` — the key
    # is a lossless repr() and deliberately un-bucketed, so a hit means the SAME binary64
    # coordinate (modulo signed zero), not proximity. This is the measurement that decides
    # whether the cheap exact-coordinate repair captures the observed NULL-on-reuse gap or
    # almost none of it.
    #
    # A cache hit does NOT by itself license writing the country: `_store_cached_country` runs
    # BEFORE `_ground_place`'s claim comparison (grounding.py:131 vs :132), so a hit means
    # "Mapbox answered", never "the claim agreed". This only reports reachability.
    from grounding import _coord_cache_key, GEOCODE_CACHE_TABLE, LOCATION_VERIFICATION_VERSION

    null_rows = [p for p in places if not p.get("country")]
    if null_rows:
        reachable = 0
        for p in null_rows:
            hit = (await client.table(GEOCODE_CACHE_TABLE).select("country_code")
                   .eq("coord_key", _coord_cache_key(p["lat"], p["lng"]))
                   .eq("verification_version", LOCATION_VERIFICATION_VERSION)
                   .execute()).data
            mark = "exact-coord VERIFIED in cache" if hit else "own coord never grounded"
            reachable += 1 if hit else 0
            print(f"    NULL row {p.get('name', '?')!r}: {mark}")
        print(f"=== exact-coordinate repair would reach {reachable}/{len(null_rows)} NULL row(s)")
    mismatched = [p for p in places
                  if p.get("country") and (p.get("country") != p.get("country_name"))]
    if mismatched:
        # `find_or_create_place` binds p_country from the verified country NAME; if these ever
        # diverge the two writers have drifted apart again, which is the whole point of the fix.
        print(f"    !! {len(mismatched)} row(s) where country != country_name — WRITERS HAVE DRIFTED")
    print("=== trip_days weather:")
    for d in sorted(tds, key=lambda x: x["day_number"]):
        print(f"    day {d['day_number']} {d['day_date']}  {d.get('weather_source')}: {d.get('weather_summary')} "
              f"{d.get('title') or ''}")
    legs = (
        await client.table("transport_legs")
        .select("from_place_id,to_place_id,leg_order,transport_mode,status,duration_seconds,distance_meters,warning")
        .eq("trip_id", trip_id).execute()
    ).data
    print(f"=== transport_legs: {len(legs)}")
    for lg in sorted(legs, key=lambda x: x.get("leg_order") or 0):
        frm = by_id.get(lg["from_place_id"], {}).get("name", "?")
        to = by_id.get(lg["to_place_id"], {}).get("name", "?")
        dur = lg.get("duration_seconds")
        dist = lg.get("distance_meters")
        mins = f"{round(dur / 60)}min" if dur else "-"
        dist_s = f"{dist}m" if dist is not None else "-"
        warn = f"  ⚠ {lg['warning']}" if lg.get("warning") else ""
        print(f"    #{lg['leg_order']} {lg.get('transport_mode')}/{lg.get('status')}  "
              f"{frm} -> {to}  {mins} {dist_s}{warn}")
    rests = (
        await client.table("restaurant_suggestions")
        .select("trip_day_id,restaurant_place_id,near_place_id,cuisine,summary")
        .eq("trip_id", trip_id).execute()
    ).data
    # restaurant places may not be in `by_id` (that only holds itinerary places) — fetch their names.
    rest_pids = [r["restaurant_place_id"] for r in rests if r.get("restaurant_place_id")]
    rest_names = {}
    if rest_pids:
        rest_names = {p["id"]: p["name"] for p in
                      (await client.table("places").select("id,name").in_("id", rest_pids).execute()).data}
    print(f"=== restaurant_suggestions: {len(rests)}")
    for rs in rests:
        name = rest_names.get(rs.get("restaurant_place_id"), "?")
        near = by_id.get(rs.get("near_place_id"), {}).get("name", "?")
        cuisine = rs.get("cuisine") or "-"
        print(f"    {name} [{cuisine}]  near {near}  — {rs.get('summary')}")
    hotels = (
        await client.table("hotel_suggestions")
        .select("name,area,star_rating,price_snapshot,status").eq("trip_id", trip_id).execute()
    ).data
    print(f"=== hotel_suggestions: {len(hotels)}")
    for h in hotels:
        price = (h.get("price_snapshot") or {})
        star = h.get("star_rating")
        print(f"    {h.get('name')}  ★{star if star is not None else '-'}  "
              f"{price.get('pricePerNight')}/{price.get('currency')}  [{h.get('area') or ''}]")


async def _run(args: argparse.Namespace) -> None:
    # Imported here (not at module scope) so `import scripts.live_run` stays keyless + network-free.
    from jobs import compute_idempotency_key, enqueue_job
    from main import get_supabase_client
    from pipeline.runner import record_event, run_generation

    client = await get_supabase_client()

    if args.inspect:
        await _inspect(client, args.inspect)
        return

    user_id = args.user or os.environ["ASTRAIL_TEST_USER_ID"]
    reels = [u.strip() for u in args.reels.split(",") if u.strip()] if args.reels else list(_DEFAULT_REELS)
    start, end = (args.start, args.end) if (args.start and args.end) else _default_dates()

    # Idempotent: a same-key run already exists -> inspect it instead of double-generating.
    # Pass the output-affecting fields (matches main.py): changed preferences -> a new trip.
    idem = compute_idempotency_key(user_id, reels, start, end,
                                   preferences=args.preferences, pace=args.pace,
                                   destination_hint=args.dest)
    existing = (
        await client.table("jobs").select("trip_id").eq("idempotency_key", idem).maybe_single().execute()
    )
    if existing is not None and existing.data is not None:
        trip_id = existing.data["trip_id"]
        print(f"[idempotent] a run with this key exists -> trip {trip_id} "
              "(change --start/--end to force a fresh run); inspecting:")
        await _inspect(client, trip_id)
        return

    trip = (
        await client.table("trips").insert({
            "user_id": user_id, "status": "generating",
            "destination_hint": args.dest, "start_date": start, "end_date": end,
        }).execute()
    ).data[0]
    trip_id = trip["id"]
    await record_event(
        client, trip_id, event_type="stage", stage="create_trip", message="Starting your trip",
        payload={"reel_urls": reels, "start_date": start, "end_date": end, "pace": args.pace,
                 "preferences": args.preferences, "destination_hint": args.dest},
    )
    job_id, winning = await enqueue_job(trip_id, user_id, idem)
    if winning != trip_id:
        print(f"[race] lost an idempotency-key race; canonical trip is {winning}")
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        await _inspect(client, winning)
        return

    print(f"[created] trip={trip_id} job={job_id} reels={len(reels)} {start}..{end} pace={args.pace} "
          f"preferences={args.preferences!r}")
    print("[running] REAL pipeline: Apify -> OpenAI -> Mapbox -> dedup/route -> Open-Meteo -> persist ...")
    await run_generation(trip_id, user_id, reels, start, end, job_id=job_id, pace=args.pace,
                         preferences=args.preferences, destination_hint=args.dest, client=client)
    await _inspect(client, trip_id)

    if args.cleanup:
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        print(f"\n[cleanup] deleted trip {trip_id} (cascade); global `places` rows kept (flywheel)")
    else:
        print(f"\nTRIP_ID (view in Supabase): {trip_id}")


def _configure_logging(quiet: bool) -> None:
    """Surface the grounding counters WITHOUT handing INFO to every library in the process.

    `pipeline.persist` emits ONE `trip_place_grounding` line per trip carrying
    grounded/ineligible/mismatched/failed counts — the only signal that separates "every
    coordinate legitimately disagreed" from "the Mapbox credential is dead". Nothing else in
    this script configures logging, so without this the smoke discards it silently.

    Root STAYS at WARNING and the one logger we want is lifted instead. Raising root to get
    that line also raises `httpx`, which prints the Mapbox secret token on every geocode (see
    `_NOISY_TRANSPORT_LOGGERS`) — this tool runs with the real one in its environment.
    """
    logging.basicConfig(level=logging.WARNING, format="  [log] %(name)s %(message)s")
    # Assigned unconditionally, in BOTH directions: a `if not quiet: raise it` would leave
    # `--quiet` meaning "whatever this logger was already set to", which is a promise about
    # process state rather than about the flag.
    for name in _VERBOSE_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING if quiet else logging.INFO)
    # NOT optional tidying — see `_NOISY_TRANSPORT_LOGGERS`. Deleting this loop puts a live
    # Mapbox token back in the smoke output the day anyone lifts root again.
    for name in _NOISY_TRANSPORT_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="scripts.live_run",
        description="Live pipeline smoke tool — spends real credits + writes the live dev Supabase DB.",
    )
    p.add_argument("--reels", help="comma-separated Reel URLs (default: repo Japan demo reels)")
    p.add_argument("--start", help="ISO start date (default: today+5)")
    p.add_argument("--end", help="ISO end date (default: today+7)")
    p.add_argument("--dest", default="Japan", help="destination hint (default: Japan)")
    p.add_argument("--pace", default="balanced", choices=["relaxed", "balanced", "packed"],
                   help="itinerary pace (default: balanced)")
    p.add_argument("--preferences", default=None,
                   help="free-text preferences; non-blank -> source=explicit + writes to mem0. "
                        "Omit on a later trip (same user) to see source=memory recall.")
    p.add_argument("--user", help="user_id (default: ASTRAIL_TEST_USER_ID env)")
    p.add_argument("--cleanup", action="store_true", help="delete the generated trip after (hermetic smoke)")
    p.add_argument("--inspect", metavar="TRIP_ID", help="re-print an existing trip and exit (no run, no cost)")
    p.add_argument("--quiet", action="store_true", help="suppress backend INFO logs (hides the grounding counters)")
    return p.parse_args(argv)


if __name__ == "__main__":
    _args = _parse_args()
    _configure_logging(_args.quiet)
    asyncio.run(_run(_args))

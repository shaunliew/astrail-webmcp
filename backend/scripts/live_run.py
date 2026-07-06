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
import os

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
    trip = (
        await client.table("trips").select("id,status,destination_hint,start_date,end_date,title,summary")
        .eq("id", trip_id).maybe_single().execute()
    ).data
    if trip is None:
        print(f"no trip {trip_id}")
        return
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
        (await client.table("places").select("id,name,place_type,lat,lng").in_("id", pids).execute()).data
        if pids else []
    )
    by_id = {p["id"]: p for p in places}
    print(f"\n=== TRIP {trip['id']}")
    print(f"    status={trip['status']} dest={trip['destination_hint']} "
          f"{trip['start_date']}..{trip['end_date']}")
    print(f"    trip_title={trip.get('title')!r}")
    print(f"    trip_summary={trip.get('summary')!r}")
    print(f"=== trip_places: {len(tps)} | places: {len(places)} | trip_days: {len(tds)}")
    for tp in sorted(tps, key=lambda x: (x["day_number"] or 0, x["sort_order"] or 0)):
        p = by_id.get(tp["place_id"], {})
        print(f"    day {tp['day_number']} #{tp['sort_order']}  {p.get('name', '?')} "
              f"[{p.get('place_type', '?')}] ({round(p.get('lat', 0), 4)},{round(p.get('lng', 0), 4)})")
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
    idem = compute_idempotency_key(user_id, reels, start, end)
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
        client, trip_id, event_type="stage", stage="create_trip", message="trip created",
        payload={"reel_urls": reels, "start_date": start, "end_date": end, "pace": args.pace},
    )
    job_id, winning = await enqueue_job(trip_id, user_id, idem)
    if winning != trip_id:
        print(f"[race] lost an idempotency-key race; canonical trip is {winning}")
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        await _inspect(client, winning)
        return

    print(f"[created] trip={trip_id} job={job_id} reels={len(reels)} {start}..{end} pace={args.pace}")
    print("[running] REAL pipeline: Apify -> OpenAI -> Mapbox -> dedup/route -> Open-Meteo -> persist ...")
    await run_generation(trip_id, user_id, reels, start, end, job_id=job_id, pace=args.pace, client=client)
    await _inspect(client, trip_id)

    if args.cleanup:
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        print(f"\n[cleanup] deleted trip {trip_id} (cascade); global `places` rows kept (flywheel)")
    else:
        print(f"\nTRIP_ID (view in Supabase): {trip_id}")


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
    p.add_argument("--user", help="user_id (default: ASTRAIL_TEST_USER_ID env)")
    p.add_argument("--cleanup", action="store_true", help="delete the generated trip after (hermetic smoke)")
    p.add_argument("--inspect", metavar="TRIP_ID", help="re-print an existing trip and exit (no run, no cost)")
    return p.parse_args(argv)


if __name__ == "__main__":
    asyncio.run(_run(_parse_args()))

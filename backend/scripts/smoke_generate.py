"""One-shot REAL generation smoke against a DEPLOYED backend.

⚠️ SPENDS CREDITS (Apify scrape + OpenAI). Run only with an explicit go.

Flow: self-load backend/.env → admin-provision a throwaway user + token → POST a real
reel to the deployed /generate-trip → stream /generate-trip/stream/{trip_id} to the
terminal `result` event → print the itinerary summary → DELETE the throwaway user
(cascades the trip, no trace). Proves the full pipeline works on the deployed service.

Run:
    cd backend && SMOKE_BASE_URL=https://astrail-backend.onrender.com \
        uv run python -m scripts.smoke_generate
Options (env): REELS=<comma-sep reel urls>  DEST=Japan  PACE=balanced  KEEP_USER=1
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import uuid

# Repo's real Japan demo set (evals/fixtures/japan_demo_reels.json) — known-good for scraping.
_DEFAULT_REELS = [
    "https://www.instagram.com/reel/DYbmT-SNzVK/",
    "https://www.instagram.com/reel/DYM_I5IvLSv/",
]


def _ensure_env() -> None:
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        from dotenv import find_dotenv, load_dotenv

        load_dotenv(find_dotenv(usecwd=True))


async def _provision_user(httpx) -> tuple[str, str]:
    base = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    anon = (os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_ANON_KEY") or key)
    email = f"gen-smoke-{uuid.uuid4().hex[:12]}@example.com"
    pw = uuid.uuid4().hex + "Aa1!"
    async with httpx.AsyncClient(base_url=base, timeout=30) as g:
        cr = await g.post("/auth/v1/admin/users",
                          headers={"apikey": key, "Authorization": f"Bearer {key}"},
                          json={"email": email, "password": pw, "email_confirm": True})
        cr.raise_for_status()
        uid = cr.json()["id"]
        tk = await g.post("/auth/v1/token", params={"grant_type": "password"},
                          headers={"apikey": anon}, json={"email": email, "password": pw})
        if tk.status_code != 200:
            await g.delete(f"/auth/v1/admin/users/{uid}",
                           headers={"apikey": key, "Authorization": f"Bearer {key}"})
            raise RuntimeError(f"token mint failed {tk.status_code}: {tk.text[:160]}")
        return uid, tk.json()["access_token"]


async def _delete_user(httpx, uid: str) -> None:
    base, key = os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    async with httpx.AsyncClient(base_url=base, timeout=30) as g:
        r = await g.delete(f"/auth/v1/admin/users/{uid}",
                           headers={"apikey": key, "Authorization": f"Bearer {key}"})
        print(f"  (deleted throwaway user {uid}: {r.status_code})")


def _summarize(result: dict) -> tuple[bool, str]:
    """Return (ok, summary). Result payload is {"itinerary": {...}}; days carry place_names
    (full lat/lng/evidence places persist to the DB for the FE's RLS-direct read).
    ok = an itinerary with >=1 day and >=1 place_name."""
    if not isinstance(result, dict):
        return False, f"result content is not an object: {result!r}"
    itin = result.get("itinerary", result)  # unwrap the {"itinerary": {...}} envelope
    if not isinstance(itin, dict):
        return False, f"itinerary is not an object: {itin!r}"
    if itin.get("error") or result.get("error"):
        return False, f"pipeline returned an error result: {itin.get('error') or result.get('error')}"
    print(f"  (itinerary keys: {list(itin.keys())})")
    days = itin.get("days") or []
    total = sum(len(d.get("place_names") or d.get("places") or []) for d in days)
    lines = [f"days={len(days)}  total place_names={total}"]
    if itin.get("title"):
        lines.append(f"  title: {itin['title']!r}")
    if itin.get("summary") or itin.get("synopsis"):
        lines.append(f"  summary: {str(itin.get('summary') or itin.get('synopsis'))[:140]!r}")
    for i, d in enumerate(days, 1):
        names = d.get("place_names") or d.get("places") or []
        lines.append(f"  day {i}: {names}")
    if itin.get("feasibility_warnings"):
        lines.append(f"  feasibility_warnings: {itin['feasibility_warnings']}")
    ok = len(days) >= 1 and total >= 1
    return ok, "\n".join(lines)


async def _dump_places(client, trip_id: str) -> None:
    """Show the evidence-backed places the run persisted (guardrail #1: name + lat/lng + evidence)."""
    try:
        tp = (await client.table("trip_places").select("place_id,day_number,evidence_json")
              .eq("trip_id", trip_id).execute()).data or []
        if not tp:
            print("  (no trip_places persisted)")
            return
        ids = list({r["place_id"] for r in tp if r.get("place_id")})
        pl = (await client.table("places")
              .select("id,name,lat,lng,country,country_code,country_name")
              .in_("id", ids).execute()).data or []
        pm = {p["id"]: p for p in pl}
        print(f"\n--- persisted evidence-backed places (DB, {len(tp)}) ---")
        for r in sorted(tp, key=lambda x: x.get("day_number") or 0):
            p = pm.get(r.get("place_id"), {})
            ev = r.get("evidence_json") or {}
            quote = ev.get("evidence_caption_quote") or ev.get("caption_quote") or (str(ev)[:80] if ev else "")
            # `country` is a VERIFICATION RECEIPT: non-NULL means the coordinate was
            # reverse-geocoded AND agreed with the extractor's claim. Printed explicitly —
            # a blank would read as "fine" when NULL is the thing worth seeing.
            badge = (f"{p.get('country')} ({p.get('country_code')}/{p.get('country_name')})"
                     if p.get("country") else "country=NULL")
            print(f"  day {r.get('day_number')}: {p.get('name')!r}  ({p.get('lat')},{p.get('lng')})  "
                  f"{badge}  evidence={str(quote)[:80]!r}")
        verified = [p for p in pl if p.get("country")]
        print(f"--- grounding: {len(verified)}/{len(pl)} places carry a VERIFIED country ---")
    except Exception as e:  # noqa: BLE001
        print(f"  (place dump failed: {type(e).__name__}: {e})")


async def main() -> int:
    _ensure_env()
    import httpx

    base = os.environ.get("SMOKE_BASE_URL")
    if not base:
        print("RESULT: FAIL ❌  set SMOKE_BASE_URL=https://<svc>.onrender.com")
        return 2
    base = base.rstrip("/")
    reels = [u.strip() for u in os.environ.get("REELS", "").split(",") if u.strip()] or _DEFAULT_REELS
    dest = os.environ.get("DEST") or None  # let the pipeline infer the destination from the reel
    pace = os.environ.get("PACE", "balanced")
    start = (dt.date.today() + dt.timedelta(days=14)).isoformat()
    end = (dt.date.today() + dt.timedelta(days=16)).isoformat()

    print(f"target={base}\nreels={reels}\ndest={dest} pace={pace} {start}..{end}\n")

    uid, token = await _provision_user(httpx)
    print(f"(provisioned throwaway user {uid})")
    trip_id = None
    result_itin = None
    try:
        async with httpx.AsyncClient(base_url=base, timeout=60) as ac:
            body = {"reel_urls": reels, "start_date": start, "end_date": end,
                    "destination_hint": dest, "pace": pace}
            r = await ac.post("/generate-trip", json=body, headers={"Authorization": f"Bearer {token}"})
            print(f"POST /generate-trip -> {r.status_code} {r.text[:200]}")
            if r.status_code != 200:
                print("RESULT: FAIL ❌  generate-trip did not return 200")
                return 1
            trip_id = r.json()["trip_id"]
            print(f"trip_id={trip_id}\n--- streaming SSE (generation runs 60-180s) ---")

        # Separate long-timeout client for the stream.
        async with httpx.AsyncClient(base_url=base, timeout=httpx.Timeout(320.0, read=320.0)) as sc:
            async with sc.stream("GET", f"/generate-trip/stream/{trip_id}", params={"token": token}) as resp:
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        print("  [DONE]")
                        break
                    try:
                        evt = json.loads(data)
                    except Exception:
                        continue
                    if evt.get("type") == "result":
                        try:
                            result_itin = json.loads(evt.get("content") or "null")
                        except Exception:
                            result_itin = evt.get("content")
                        print(f"  [result] stage={evt.get('stage')} msg={evt.get('msg')}")
                    else:
                        print(f"  [stage] {evt.get('type')}/{evt.get('stage')}: {evt.get('msg')}")
        if trip_id:
            # Show the real evidence-backed places this run persisted (DB, via service-role).
            from supabase_client import get_supabase_client
            client = await get_supabase_client()
            await _dump_places(client, trip_id)
    finally:
        if os.environ.get("KEEP_USER") == "1":
            print(f"  (KEEP_USER=1 -> left user {uid} + trip {trip_id} for inspection)")
        else:
            await _delete_user(httpx, uid)

    if result_itin is None:
        print("\nRESULT: FAIL ❌  no terminal result event received")
        return 1
    ok, summary = _summarize(result_itin)
    print(f"\n--- itinerary ---\n{summary}")
    print("\nRESULT:", "PASS ✅  real generation produced an evidence-backed itinerary on the deployed backend"
          if ok else "FAIL ❌  no usable itinerary (see summary/error above)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

"""Live HTTP smoke for the Phase-2 API surface.

Drives the REAL FastAPI app (main.app) over httpx ASGITransport against LIVE Supabase.
ASGITransport does NOT emit lifespan events, so the job-recovery sweep never fires =>
ZERO pipeline credits. Self-loads backend/.env for live creds.

No-JWT checks (always run):
  - GET /health           -> 200 {"status":"ok"}
  - GET /readiness        -> 200 {"ready":true}   (real live-DB probe)
  - OPTIONS preflight     -> allowed origin echoed; unknown origin NOT echoed
  - POST /generate-trip (no auth) -> 401 enveloped {"error":{"code":"unauthorized",...}}

Authed checks (only if SMOKE_JWT is set to a real Supabase access_token):
  Pre-fills the caller's daily quota to the cap via the RPC (net-zero: restored after),
  then 4 rapid authed POSTs while at cap prove BOTH gates fire with ZERO trips created:
    - first calls  -> 429 quota  (code rate_limited, message "Daily trip limit...", NO Retry-After)
    - the over-burst call -> 429 burst (code rate_limited, Retry-After header present)

Run (no-JWT):  cd backend && uv run python -m scripts.smoke_http
Run (full):    cd backend && SMOKE_JWT=<access_token> uv run python -m scripts.smoke_http
"""
from __future__ import annotations

import asyncio
import base64
import json
import os

PASS, FAIL = "PASS ✅", "FAIL ❌"
_results: list[tuple[str, bool, str]] = []


def _check(name: str, ok: bool, detail: str = "") -> None:
    _results.append((name, ok, detail))
    print(f"  [{PASS if ok else FAIL}] {name}{(' — ' + detail) if detail else ''}")


def _ensure_env() -> None:
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        from dotenv import find_dotenv, load_dotenv

        load_dotenv(find_dotenv(usecwd=True))


def _jwt_sub(token: str) -> str | None:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)  # pad base64url
        return json.loads(base64.urlsafe_b64decode(payload)).get("sub")
    except Exception:
        return None


async def main() -> int:
    _ensure_env()
    import httpx

    import main as app_module
    import rate_limit
    from supabase_client import get_supabase_client

    transport = httpx.ASGITransport(app=app_module.app)
    body = {"reel_urls": ["https://instagram.com/reel/smoke"], "start_date": "2026-09-01", "end_date": "2026-09-03"}

    async with httpx.AsyncClient(transport=transport, base_url="http://smoke") as ac:
        print("\n== No-JWT checks (live, zero-credit) ==")
        r = await ac.get("/health")
        _check("GET /health -> 200 ok", r.status_code == 200 and r.json().get("status") == "ok", f"{r.status_code} {r.text[:80]}")

        r = await ac.get("/readiness")
        _check("GET /readiness -> 200 ready (live DB)", r.status_code == 200 and r.json().get("ready") is True, f"{r.status_code} {r.text[:80]}")

        r = await ac.options("/generate-trip", headers={"Origin": "https://astrail.xyz", "Access-Control-Request-Method": "POST"})
        _check("CORS allow astrail.xyz", r.headers.get("access-control-allow-origin") == "https://astrail.xyz", f"ACAO={r.headers.get('access-control-allow-origin')!r}")

        r = await ac.options("/generate-trip", headers={"Origin": "https://evil.example.com", "Access-Control-Request-Method": "POST"})
        _check("CORS reject evil origin", r.headers.get("access-control-allow-origin") != "https://evil.example.com", f"ACAO={r.headers.get('access-control-allow-origin')!r}")

        r = await ac.post("/generate-trip", json=body)
        env_ok = r.status_code == 401 and r.json().get("error", {}).get("code") == "unauthorized"
        _check("unauth POST -> 401 enveloped", env_ok, f"{r.status_code} {r.text[:100]}")

        token = os.environ.get("SMOKE_JWT")
        if not token:
            print("\n== Authed checks: SKIPPED (set SMOKE_JWT=<access_token> to run the 429 gates) ==")
        else:
            sub = _jwt_sub(token)
            print(f"\n== Authed checks (JWT sub={sub}, quota pre-filled to cap, net-zero) ==")
            if not sub:
                _check("decode JWT sub", False, "could not read 'sub' from SMOKE_JWT")
            else:
                client = await get_supabase_client()
                cap = rate_limit.DAILY_TRIP_QUOTA
                # Pre-fill to cap: increment(limit=cap) returns the new count while < cap, None once at cap.
                bumps = 0
                while True:
                    v = (await client.rpc("increment_daily_trip_usage", {"p_user_id": sub, "p_limit": cap}).execute()).data
                    if v is None:
                        break
                    bumps += 1
                    if bumps > cap + 2:
                        break
                try:
                    rate_limit.limiter.reset()
                    hdrs = {"Authorization": f"Bearer {token}"}
                    codes, retry_after_flags, msgs = [], [], []
                    for _ in range(4):
                        rr = await ac.post("/generate-trip", json=body, headers=hdrs)
                        codes.append(rr.status_code)
                        retry_after_flags.append("retry-after" in {k.lower() for k in rr.headers})
                        try:
                            msgs.append(rr.json().get("error", {}).get("message", ""))
                        except Exception:
                            msgs.append(rr.text[:60])
                    all_429 = all(c == 429 for c in codes)
                    _check("4 authed POSTs at cap -> all 429 (no trip created)", all_429, f"codes={codes}")
                    quota_first = (not retry_after_flags[0]) and ("Daily trip limit" in msgs[0])
                    _check("first 429 is QUOTA (no Retry-After, daily-limit msg)", quota_first, f"retry_after={retry_after_flags[0]} msg={msgs[0]!r}")
                    burst_last = retry_after_flags[-1]
                    _check("over-burst 429 carries Retry-After (burst gate)", burst_last, f"retry_after_flags={retry_after_flags}")
                finally:
                    for _ in range(bumps):  # restore net-zero
                        await client.rpc("decrement_daily_trip_usage", {"p_user_id": sub}).execute()
                    print(f"  (restored: decremented {bumps}x back to starting count)")

    passed = sum(1 for _, ok, _ in _results if ok)
    total = len(_results)
    print(f"\nRESULT: {passed}/{total} checks passed", "✅" if passed == total else "❌")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

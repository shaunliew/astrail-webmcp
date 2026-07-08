"""Live HTTP smoke for the Phase-2 API surface.

Drives the REAL FastAPI app (main.app) over httpx ASGITransport against LIVE Supabase.
ASGITransport does NOT emit lifespan events, so the job-recovery sweep never fires =>
ZERO pipeline credits. Self-loads backend/.env for live creds.

No-JWT checks (always run):
  - GET /health           -> 200 {"status":"ok"}
  - GET /readiness        -> 200 {"ready":true}   (real live-DB probe)
  - OPTIONS preflight     -> allowed origin echoed; unknown origin NOT echoed
  - POST /generate-trip (no auth) -> 401 enveloped {"error":{"code":"unauthorized",...}}

Authed checks (need a real Supabase access_token). Two ways to supply one:
  - SMOKE_JWT=<access_token>  : use a token you already have, or
  - SMOKE_PROVISION=1         : self-serve — admin-create a throwaway user, mint its token,
                                run the checks, then DELETE the user (cleanup in finally).
  Pre-fills the caller's daily quota to the cap via the RPC (net-zero: restored after),
  then 4 rapid authed POSTs while at cap prove BOTH gates fire with ZERO trips created:
    - first calls  -> 429 quota  (code rate_limited, message "Daily trip limit...", NO Retry-After)
    - the over-burst call -> 429 burst (code rate_limited, Retry-After header present)

Run:  cd backend && uv run python -m scripts.smoke_http                 # no-JWT only
      cd backend && SMOKE_PROVISION=1 uv run python -m scripts.smoke_http  # full (self-serve)
      cd backend && SMOKE_JWT=<token> uv run python -m scripts.smoke_http  # full (your token)
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import uuid

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


async def _provision_user(httpx) -> tuple[str, str]:
    """Admin-create a throwaway confirmed user + mint its access token. Returns (user_id, token)."""
    base = os.environ["SUPABASE_URL"]
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    # Any valid project key works as the `apikey` gateway header for the token mint;
    # prefer the anon key if present, else fall back to the service-role key.
    anon_key = (os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
                or os.environ.get("SUPABASE_ANON_KEY")
                or service_key)
    email = f"phase2-smoke-{uuid.uuid4().hex[:12]}@example.com"
    password = uuid.uuid4().hex + "Aa1!"
    async with httpx.AsyncClient(base_url=base, timeout=30) as g:
        cr = await g.post(
            "/auth/v1/admin/users",
            headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
            json={"email": email, "password": password, "email_confirm": True},
        )
        cr.raise_for_status()
        user_id = cr.json()["id"]
        tk = await g.post(
            "/auth/v1/token",
            params={"grant_type": "password"},
            headers={"apikey": anon_key},
            json={"email": email, "password": password},
        )
        if tk.status_code != 200:
            # clean up the user we just made before surfacing the failure
            await g.delete(f"/auth/v1/admin/users/{user_id}",
                           headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"})
            raise RuntimeError(f"password grant failed ({tk.status_code}: {tk.text[:160]}); "
                               "email/password auth may be disabled on this project — use SMOKE_JWT instead")
        return user_id, tk.json()["access_token"]


async def _delete_user(httpx, user_id: str) -> None:
    base = os.environ["SUPABASE_URL"]
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    async with httpx.AsyncClient(base_url=base, timeout=30) as g:
        r = await g.delete(f"/auth/v1/admin/users/{user_id}",
                           headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"})
        print(f"  (deleted throwaway user {user_id}: {r.status_code})")


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
        provisioned: str | None = None
        if not token and os.environ.get("SMOKE_PROVISION") == "1":
            try:
                provisioned, token = await _provision_user(httpx)
                print(f"\n(provisioned throwaway user {provisioned})")
            except Exception as exc:  # noqa: BLE001
                _check("provision throwaway user", False, str(exc))

        if not token:
            print("\n== Authed checks: SKIPPED (set SMOKE_PROVISION=1 or SMOKE_JWT=<token>) ==")
        else:
            sub = _jwt_sub(token)
            print(f"\n== Authed checks (JWT sub={sub}, quota pre-filled to cap, net-zero) ==")
            client = await get_supabase_client()
            cap = rate_limit.DAILY_TRIP_QUOTA
            bumps = 0
            try:
                if not sub:
                    _check("decode JWT sub", False, "could not read 'sub' from token")
                else:
                    # Pre-fill to cap: increment(limit=cap) returns the new count while < cap, None once at cap.
                    while True:
                        v = (await client.rpc("increment_daily_trip_usage", {"p_user_id": sub, "p_limit": cap}).execute()).data
                        if v is None:
                            break
                        bumps += 1
                        if bumps > cap + 2:
                            break
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
                    _check("4 authed POSTs at cap -> all 429 (no trip created)", all(c == 429 for c in codes), f"codes={codes}")
                    _check("first 429 is QUOTA (no Retry-After, daily-limit msg)",
                           (not retry_after_flags[0]) and ("Daily trip limit" in msgs[0]),
                           f"retry_after={retry_after_flags[0]} msg={msgs[0]!r}")
                    _check("over-burst 429 carries Retry-After (burst gate)", retry_after_flags[-1], f"retry_after_flags={retry_after_flags}")
            finally:
                for _ in range(bumps):  # restore net-zero on the (real or throwaway) user's quota
                    await client.rpc("decrement_daily_trip_usage", {"p_user_id": sub}).execute()
                if bumps:
                    print(f"  (restored: decremented {bumps}x back to starting count)")
                if provisioned:
                    await _delete_user(httpx, provisioned)

    passed = sum(1 for _, ok, _ in _results if ok)
    total = len(_results)
    print(f"\nRESULT: {passed}/{total} checks passed", "✅" if passed == total else "❌")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

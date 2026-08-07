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
  The gate that applies depends on `users.plan` — `reserve_and_enqueue_trip_job` checks
  beta -> DAILY quota, trial -> LIFETIME trial limit. All three checks drive the FIRST
  request into a rejection, which is what makes "zero trips created" true:
    - trial at lifetime cap -> 403 trial_exhausted
    - beta  at daily cap    -> 429 rate_limited, "Daily trip limit...", NO Retry-After
    - over burst            -> 429 rate_limited, Retry-After present
  Restores the daily counter, plan and lifetime_trip_count afterwards (net-zero).

  ⚠ Rewritten 2026-08-07. The previous version pre-filled the DAILY counter and expected a
  trial user to be gated by it — it isn't. Its first POST was therefore `created` (a REAL
  trip, real credits) and the two after it were idempotent `replay`s of that job, giving
  [200,200,200,429] and a FAIL while the backend was entirely correct. A smoke that fails on
  a healthy system is worse than none: it teaches people to ignore it. The plan/lifetime
  mutations are provisioned-only — never flip a real SMOKE_JWT user's plan.

Target: in-process app by default; set SMOKE_BASE_URL=https://<svc>.onrender.com to hit a
DEPLOYED service over the real network instead (proves the actual Render deploy).

Run:  cd backend && uv run python -m scripts.smoke_http                 # in-process, no-JWT
      cd backend && SMOKE_PROVISION=1 uv run python -m scripts.smoke_http  # in-process, full
      # against the deployed dev service, full self-serve smoke:
      cd backend && SMOKE_BASE_URL=https://astrail-backend.onrender.com SMOKE_PROVISION=1 \
          uv run python -m scripts.smoke_http
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import uuid

PASS, FAIL = "PASS ✅", "FAIL ❌"
_results: list[tuple[str, bool, str]] = []


def _err_code(rr) -> str:
    """The `error.code` from the standard envelope, or '' when the body is not one."""
    try:
        return rr.json().get("error", {}).get("code", "")
    except Exception:  # noqa: BLE001 - a non-JSON body is a legitimate failure to report
        return ""


def _err_msg(rr) -> str:
    try:
        return rr.json().get("error", {}).get("message", "")
    except Exception:  # noqa: BLE001
        return rr.text[:60]


# How far past the local cap to raise the counter when the TARGET is a deployed service whose
# real cap we cannot read. Every increment is decremented again in the `finally`, so it is net-zero.
_REMOTE_OVERFILL = 50


def _effective_daily_cap(local_cap: int, remote: bool) -> int:
    """How high the daily counter must go for the TARGET to reject the next request.

    `rate_limit.DAILY_TRIP_QUOTA` describes THIS process's environment, NOT the deployed
    service's — local `.env` leaves it at the code default 5 while Render sets 10. Filling to
    the local number leaves the remote user comfortably UNDER its cap, so the request is
    ACCEPTED: a real trip is created and real Apify/OpenAI credits are spent, which is the
    precise failure this smoke exists to prevent. (Observed 2026-08-07.)

    So against a remote target, over-fill past any plausible cap rather than trusting a local
    constant to describe a remote process. Set SMOKE_DAILY_CAP to be exact when you know it.
    """
    override = os.environ.get("SMOKE_DAILY_CAP")
    if override:
        return int(override)
    return max(local_cap, _REMOTE_OVERFILL) if remote else local_cap


async def _fill_daily_to_cap(client, sub: str, cap: int) -> int:
    """Raise the user's daily counter to `cap` and return how many increments it took, so the
    caller can decrement exactly that many and stay net-zero.

    `increment_daily_trip_usage(limit=cap)` returns the new count while below `cap` and NULL once
    at it, so NULL is the stop signal. The `cap + 2` bound stops a runaway if that contract ever
    changes — an unbounded loop here would inflate a real user's quota.
    """
    bumps = 0
    while True:
        v = (await client.rpc("increment_daily_trip_usage",
                              {"p_user_id": sub, "p_limit": cap}).execute()).data
        if v is None or bumps > cap + 2:
            return bumps
        bumps += 1


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

    import rate_limit
    from supabase_client import get_supabase_client

    body = {"reel_urls": ["https://instagram.com/reel/smoke"], "start_date": "2026-09-01", "end_date": "2026-09-03"}
    # SMOKE_BASE_URL set -> hit the DEPLOYED service over the real network;
    # unset -> drive the in-process app via ASGITransport (no lifespan sweep).
    base_url = os.environ.get("SMOKE_BASE_URL")
    if base_url:
        print(f"(target: DEPLOYED service {base_url})")
        client = httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=30)
    else:
        import main as app_module
        print("(target: in-process app via ASGITransport)")
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app_module.app), base_url="http://smoke")

    async with client as ac:
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
            print(f"\n== Authed checks (JWT sub={sub}) ==")
            client = await get_supabase_client()
            trial_cap = rate_limit.TRIAL_LIFETIME_LIMIT
            daily_cap = rate_limit.DAILY_TRIP_QUOTA
            bumps = 0
            original: dict = {}
            try:
                if not sub:
                    _check("decode JWT sub", False, "could not read 'sub' from token")
                elif not rate_limit.ENTITLEMENTS_ENABLED:
                    # Legacy path (ENTITLEMENTS_ENABLED=false): the daily quota gates EVERY plan.
                    print("  (ENTITLEMENTS_ENABLED=false -> legacy daily-quota path)")
                    bumps = await _fill_daily_to_cap(client, sub, _effective_daily_cap(daily_cap, bool(base_url)))
                    rr = await ac.post("/generate-trip", json=body, headers={"Authorization": f"Bearer {token}"})
                    _check("legacy: at daily cap -> 429", rr.status_code == 429, f"{rr.status_code} {rr.text[:80]}")
                else:
                    hdrs = {"Authorization": f"Bearer {token}"}
                    row = {}
                    try:
                        row = (await client.table("users").select("plan,lifetime_trip_count")
                               .eq("id", sub).single().execute()).data or {}
                    except Exception:  # noqa: BLE001 - absent row is handled below
                        pass
                    original = {"plan": row.get("plan"), "lifetime_trip_count": row.get("lifetime_trip_count")}

                    # WHICH GATE APPLIES DEPENDS ON `users.plan` (reserve_and_enqueue_trip_job:
                    # step 2 = beta -> daily, step 3 = trial -> lifetime). Pre-filling the DAILY
                    # counter therefore does NOT gate a trial user — the pre-entitlements version
                    # of this smoke did exactly that, so its first POST was `created` (a real trip,
                    # real credits) and the next two were idempotent `replay`s of it. It reported
                    # [200,200,200,429] and failed while the backend was behaving correctly.
                    #
                    # Both checks below require the FIRST request to be rejected — that is what
                    # makes "zero trips created" true, and it is also what stops a replay: with no
                    # job created there is no active row for step 1 to replay.
                    #
                    # Mutating plan / lifetime_trip_count is DESTRUCTIVE, so it is provisioned-only.
                    # A real SMOKE_JWT user must never have their plan flipped by a smoke test.
                    if provisioned:
                        # --- A. TRIAL user at LIFETIME cap -> 403 trial_exhausted, no trip ---
                        await client.table("users").update(
                            {"plan": "trial", "lifetime_trip_count": trial_cap}).eq("id", sub).execute()
                        rr = await ac.post("/generate-trip", json=body, headers=hdrs)
                        code = _err_code(rr)
                        _check("trial at lifetime cap -> 403 trial_exhausted (no trip)",
                               rr.status_code == 403 and code == "trial_exhausted",
                               f"{rr.status_code} code={code!r}")

                        # --- B. BETA user at DAILY cap -> 429 daily, no Retry-After, no trip ---
                        await client.table("users").update({"plan": "beta"}).eq("id", sub).execute()
                    elif original.get("plan") != "beta":
                        print("  (SMOKE_JWT user is not 'beta' — skipping the entitlement-gate checks;")
                        print("   flipping a real user's plan/lifetime would be destructive. Use SMOKE_PROVISION=1.)")

                    if provisioned or original.get("plan") == "beta":
                        bumps = await _fill_daily_to_cap(client, sub, _effective_daily_cap(daily_cap, bool(base_url)))
                        if not base_url:
                            rate_limit.limiter.reset()  # only the in-process limiter is resettable
                        rr = await ac.post("/generate-trip", json=body, headers=hdrs)
                        has_ra = "retry-after" in {k.lower() for k in rr.headers}
                        msg = _err_msg(rr)
                        _check("beta at daily cap -> 429 daily (no Retry-After, no trip)",
                               rr.status_code == 429 and not has_ra and "Daily trip limit" in msg,
                               f"{rr.status_code} retry_after={has_ra} msg={msg!r}")

                        # --- C. BURST gate: keep going until a 429 carries Retry-After ---
                        # Not a fixed count: checks A/B already consumed burst budget, and
                        # BURST_LIMIT is configurable. Every request here is still rejected by the
                        # daily gate first, so this creates no trips either.
                        saw_burst = False
                        for _ in range(6):
                            rr = await ac.post("/generate-trip", json=body, headers=hdrs)
                            if rr.status_code == 429 and "retry-after" in {k.lower() for k in rr.headers}:
                                saw_burst = True
                                break
                        _check("over-burst 429 carries Retry-After (burst gate)", saw_burst,
                               f"BURST_LIMIT={rate_limit.BURST_LIMIT}, "
                               f"{'saw' if saw_burst else 'NO'} Retry-After 429 within 6 requests")
            finally:
                for _ in range(bumps):  # restore net-zero on the (real or throwaway) user's quota
                    await client.rpc("decrement_daily_trip_usage", {"p_user_id": sub}).execute()
                if bumps:
                    print(f"  (restored: decremented {bumps}x back to starting count)")
                # Restore plan/lifetime even though a provisioned user is about to be deleted — the
                # delete can fail, and leaving a stray 'beta' row would silently grant a seat.
                if original.get("plan") is not None:
                    await client.table("users").update(
                        {"plan": original["plan"],
                         "lifetime_trip_count": original.get("lifetime_trip_count") or 0}
                    ).eq("id", sub).execute()
                    print(f"  (restored plan={original['plan']!r}, "
                          f"lifetime_trip_count={original.get('lifetime_trip_count')})")
                if provisioned:
                    await _delete_user(httpx, provisioned)

    passed = sum(1 for _, ok, _ in _results if ok)
    total = len(_results)
    print(f"\nRESULT: {passed}/{total} checks passed", "✅" if passed == total else "❌")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

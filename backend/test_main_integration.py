"""End-to-end integration test for POST /generate-trip against the connected
dev Supabase project. Injects fake scrape/extract (no live Apify/OpenAI cost)
so the database is the only live dependency. Marked @pytest.mark.integration
and skipped unless RUN_DB_INTEGRATION=1, so the default keyless suite stays
green. See docs/superpowers/plans/2026-07-04-runtime-spine.md
"Database Connectivity & Integration Testing".

Runs entirely inside pytest-asyncio's event loop: the app is driven with an
async httpx client over ASGITransport (NOT the sync TestClient), so the ASGI
call — including the Starlette BackgroundTask that runs the pipeline — shares
the same loop as the memoized async Supabase client and the assertions. Using
the sync TestClient here spins the background task in a separate portal loop,
which then closes and breaks the cross-loop singleton ("Event loop is closed").
"""
import os

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from jose import jwk as jose_jwk
from jose import jwt

pytestmark = pytest.mark.integration
RUN = os.environ.get("RUN_DB_INTEGRATION") == "1"

_TEST_KID = "integration-test-kid"


@pytest.mark.skipif(not RUN, reason="set RUN_DB_INTEGRATION=1 to run against the dev DB")
async def test_generate_trip_end_to_end(monkeypatch):
    import auth
    import main
    import supabase_client
    from models.place import PlaceResult
    from models.reel import ReelData
    from pipeline import runner

    user_id = os.environ["ASTRAIL_TEST_USER_ID"]

    # Force the memoized async client to be (re)created in THIS test's event
    # loop — a client bound to a different/closed loop is the whole bug here.
    monkeypatch.setattr(supabase_client, "_client", None)

    # Self-contained auth: verify against a JWKS whose kid matches the token we
    # mint below, not the project's real private key.
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    public_jwk = jose_jwk.construct(public_pem, "ES256").to_dict()
    public_jwk["kid"] = _TEST_KID

    # Reset both the cache and the debounce clock so _get_jwk actually fetches.
    monkeypatch.setattr(auth, "_JWKS_CACHE", {})
    monkeypatch.setattr(auth, "_JWKS_LAST_FETCH", 0.0)

    async def _fake_fetch_jwks() -> dict[str, dict]:
        return {_TEST_KID: public_jwk}

    monkeypatch.setattr(auth, "_fetch_jwks", _fake_fetch_jwks)

    async def scrape(url):
        return ReelData(reel_url=url, caption="📍Tokyo Tower", location_name="Tokyo",
                        short_code="x", capture_status="CAPTURED", transcript=None)

    async def extract(reel):
        return [PlaceResult(name="Tokyo Tower", name_local=None, category="attraction",
                            source_type="reel_extracted", lat=35.6586, lng=139.7454,
                            confidence=0.9, evidence_quote="📍Tokyo Tower",
                            source_url="https://example.org/a", formatted_address=None)]

    async def run(trip_id, uid, urls, sd, ed, **kw):
        return await runner.run_generation(
            trip_id, uid, urls, sd, ed, job_id=kw.get("job_id"), scrape=scrape, extract=extract,
        )

    monkeypatch.setattr(main, "run_generation", run)
    token = jwt.encode(
        {"sub": user_id, "aud": "authenticated"},
        private_pem,
        algorithm="ES256",
        headers={"kid": _TEST_KID},
    )

    # ASGITransport awaits the full ASGI call, including the BackgroundTask, so
    # the pipeline has completed (events + terminal job status written) by the
    # time the POST resolves.
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/generate-trip",
            headers={"Authorization": f"Bearer {token}"},
            json={"reel_urls": ["https://ig/r1"], "start_date": "2026-08-01", "end_date": "2026-08-01"},
        )
    assert resp.status_code == 200, resp.text
    trip_id = resp.json()["trip_id"]

    client = await main.get_supabase_client()
    try:
        events = (
            await client.table("generation_events").select("event_type").eq("trip_id", trip_id).execute()
        ).data
        assert any(e["event_type"] == "result" for e in events)  # spine ran to completion
        job = (await client.table("jobs").select("status").eq("trip_id", trip_id).execute()).data
        assert job and job[0]["status"] in ("succeeded", "failed")  # terminal job status

        # Normalized persistence landed (the queryable trip the frontend reads).
        trip_places = (await client.table("trip_places").select("place_id,day_number,source_type")
                       .eq("trip_id", trip_id).execute()).data
        assert trip_places, "expected trip_places rows for the generated trip"
        assert all(tp["place_id"] for tp in trip_places)
        assert all(tp["day_number"] for tp in trip_places)            # identity-based: every row has a day
        place_ids = [tp["place_id"] for tp in trip_places]
        places = (await client.table("places").select("id,name,lat,lng")
                  .in_("id", place_ids).execute()).data
        assert places and all(p["lat"] is not None and p["lng"] is not None for p in places)
        trip_days = (await client.table("trip_days").select("day_number")
                     .eq("trip_id", trip_id).execute()).data
        assert trip_days, "expected trip_days rows for the generated trip"
    finally:
        # Cascade: deleting the trip cleans up its jobs / generation_events / trip_places /
        # trip_days (all FK ON DELETE CASCADE). The global `places` rows are intentionally
        # left — they are cross-trip flywheel rows, reused (deduped) by the next run.
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()

"""End-to-end integration test for POST /generate-trip against the connected
dev Supabase project. Injects fake scrape/extract (no live Apify/OpenAI cost)
so the database is the only live dependency. Marked @pytest.mark.integration
and skipped unless RUN_DB_INTEGRATION=1, so the default keyless suite stays
green. See docs/superpowers/plans/2026-07-04-runtime-spine.md
"Database Connectivity & Integration Testing".
"""
import os

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from jose import jwk as jose_jwk
from jose import jwt

pytestmark = pytest.mark.integration
RUN = os.environ.get("RUN_DB_INTEGRATION") == "1"

_TEST_KID = "integration-test-kid"


@pytest.mark.skipif(not RUN, reason="set RUN_DB_INTEGRATION=1 to run against the dev DB")
async def test_generate_trip_end_to_end(monkeypatch):
    import auth
    import main
    from models.place import PlaceResult
    from models.reel import ReelData
    from pipeline import runner

    user_id = os.environ["ASTRAIL_TEST_USER_ID"]

    # Auth is self-contained: verification only needs a JWKS whose kid matches
    # the token we mint below, not the real Supabase project's private key.
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

    monkeypatch.setattr(auth, "_JWKS_CACHE", {})

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
    tc = TestClient(main.app)
    resp = tc.post(
        "/generate-trip",
        headers={"Authorization": f"Bearer {token}"},
        json={"reel_urls": ["https://ig/r1"], "start_date": "2026-08-01", "end_date": "2026-08-01"},
    )
    assert resp.status_code == 200
    trip_id = resp.json()["trip_id"]

    client = await main.get_supabase_client()
    try:
        events = (
            await client.table("generation_events").select("event_type").eq("trip_id", trip_id).execute()
        ).data
        assert any(e["event_type"] == "result" for e in events)  # spine ran to completion
        job = (await client.table("jobs").select("status").eq("trip_id", trip_id).execute()).data
        assert job and job[0]["status"] in ("succeeded", "failed")  # terminal job status
    finally:
        # cascade: deleting the trip cleans up its jobs + generation_events rows
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()

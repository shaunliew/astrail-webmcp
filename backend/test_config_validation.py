"""Startup secret validation (A2 / A-III).

Why this ships in the same PR as `_fail`'s token skip, not later. A run that dies BEFORE
`mark_job_running` returns holds no lease token, and `_fail` now correctly declines to write
the job's terminal state — it leaves the row for the reaper. That is right for a TRANSIENT
blip: the reaper redispatches and the next attempt succeeds. It is wrong for a DETERMINISTIC
pre-claim failure. A missing secret raises before the claim (`os.environ["APIFY_TOKEN"]` in
the runner), the reaper redispatches every pending row each tick, and trip-side
`attempt_count` is never incremented — so NOTHING caps the retries. The job would loop
forever and the trip flip-flop `generating` -> `failed`. Failing fast at boot is the cheapest
close.
"""
from __future__ import annotations

import subprocess
import sys

import pytest

import main
from config_validation import REQUIRED_SECRETS, validate_required_secrets

COMPLETE_ENV = {name: "set" for name in REQUIRED_SECRETS}


def test_all_present_passes():
    validate_required_secrets(COMPLETE_ENV)


def test_missing_variables_are_all_named_in_one_error():
    """Naming every missing var at once matters: a validator that failed on the first one
    turns a fresh deploy into a fix-one-secret-per-restart loop."""
    env = dict(COMPLETE_ENV)
    del env["APIFY_TOKEN"]
    del env["MAPBOX_SECRET_TOKEN"]

    with pytest.raises(RuntimeError) as missing:
        validate_required_secrets(env)

    assert "APIFY_TOKEN" in str(missing.value)
    assert "MAPBOX_SECRET_TOKEN" in str(missing.value)
    assert "OPENAI_API_KEY" not in str(missing.value)


@pytest.mark.parametrize("blank", ["", "   "])
def test_a_blank_or_whitespace_value_counts_as_missing(blank):
    """Render env vars are strings: an unset one and one set to "" arrive the same way, and a
    whitespace-only paste is the classic dashboard mistake. Both must fail loudly rather than
    boot an app that will raise on its first provider call."""
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        validate_required_secrets({**COMPLETE_ENV, "OPENAI_API_KEY": blank})


def test_supabase_jwt_secret_is_deliberately_not_required():
    """DO NOT "fix" this by adding it. `.claude/docs/ENV.md` records that SUPABASE_JWT_SECRET
    was REMOVED because the project verifies asymmetric ES256 tokens via JWKS (derived from
    SUPABASE_URL), not a shared HS256 secret. Requiring it would stop the app booting over a
    secret the project intentionally dropped — a validator causing the outage it exists to
    prevent."""
    assert "SUPABASE_JWT_SECRET" not in REQUIRED_SECRETS
    validate_required_secrets(COMPLETE_ENV)          # green without it


def test_no_connectivity_check_is_performed():
    """Config only. A validator that pinged Supabase or OpenAI would turn a provider blip into
    a failed boot, which is the opposite of the degrade-don't-crash rule the lifespan's broad
    `except` exists to enforce."""
    validate_required_secrets({name: "obviously-not-a-real-credential"
                               for name in REQUIRED_SECRETS})


async def test_lifespan_raises_and_names_the_missing_variable(monkeypatch):
    """PLACEMENT IS THE POINT. The call must sit BEFORE the lifespan's broad `try`, whose
    `except Exception: pass` would otherwise swallow this and boot a broken app — the exact
    opposite of fail-fast. That `try` must keep swallowing DB blips; it must not swallow
    config errors."""
    for name in REQUIRED_SECRETS:
        monkeypatch.setenv(name, "set")
    monkeypatch.delenv("APIFY_TOKEN")

    with pytest.raises(RuntimeError, match="APIFY_TOKEN"):
        async with main.lifespan(main.app):
            pass


async def test_lifespan_still_starts_when_every_secret_is_present(monkeypatch):
    """The other half: a complete config must not be made un-bootable by the new check, and a
    boot-time DB blip must still degrade rather than crash."""
    for name in REQUIRED_SECRETS:
        monkeypatch.setenv(name, "set")

    async def _blipping_client():
        raise RuntimeError("boot-time db blip")

    monkeypatch.setattr(main, "get_supabase_client", _blipping_client)

    async with main.lifespan(main.app):
        pass


def test_importing_main_needs_no_credentials():
    """Credential-free module import is an existing property of this codebase — the whole
    offline suite and the #16 eval depend on it. Adding a validator at MODULE scope instead of
    inside `lifespan` would break every one of them, so pin the distinction in a subprocess
    with the environment genuinely scrubbed (in-process, `main` is already imported)."""
    scrubbed = subprocess.run(
        [sys.executable, "-c", "import main, config_validation; print('ok')"],
        capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"},
    )

    assert scrubbed.returncode == 0, scrubbed.stderr
    assert "ok" in scrubbed.stdout

"""Unit tests for the PURE half of the RESEND pre-flight. No network, no key, no send.

The script's whole value is its verdict, so these tests target the three functions the verdict is
made of — address parsing, the /domains projection, and the alignment rule. A pre-flight that
reported PASS over a wrong from-address would be worse than not running it at all: it would
manufacture confidence for the one failure production silently swallows.

The load-bearing case is `test_subdomain_of_a_verified_domain_is_rejected` — it is written so that
relaxing the exact match to `endswith` turns it RED. See its body.
"""
from __future__ import annotations

import pytest

import httpx

from scripts.preflight_resend import (
    classify_key_probe,
    explain_send_failure,
    from_domain,
    interpret_send,
    main,
    mask_email,
    verified_domains,
    verify_from_domain,
)

_RESTRICTED = {"statusCode": 401, "message": "restricted", "name": "restricted_api_key"}
_KEY = "re_test_key_not_a_real_secret"


class _FakeResp:
    def __init__(self, status: int, payload: object) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> object:
        if isinstance(self._payload, str):
            raise ValueError("not json")
        return self._payload

    @property
    def text(self) -> str:
        return self._payload if isinstance(self._payload, str) else repr(self._payload)


class _FakeClient:
    """Scriptable stand-in for httpx.AsyncClient, recording every call so a test can assert that
    --no-send genuinely sent NOTHING (a claim no pure-helper test can make)."""

    get_resp: _FakeResp = _FakeResp(200, {"data": []})
    post_resp: _FakeResp = _FakeResp(200, {"id": "msg-1"})
    gets: list = []
    posts: list = []

    def __init__(self, *_a, **_k) -> None:
        pass

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *_a) -> bool:
        return False

    async def get(self, url, headers=None):
        type(self).gets.append({"url": url, "headers": headers})
        return type(self).get_resp

    async def post(self, url, headers=None, json=None):
        type(self).posts.append({"url": url, "headers": headers, "json": json})
        return type(self).post_resp


@pytest.fixture
def fake_api(monkeypatch):
    """Patches httpx.AsyncClient (imported lazily inside main) and supplies a valid env."""
    _FakeClient.gets, _FakeClient.posts = [], []
    _FakeClient.get_resp = _FakeResp(401, _RESTRICTED)          # default: send-only key
    _FakeClient.post_resp = _FakeResp(200, {"id": "msg-1"})
    monkeypatch.setattr(httpx, "AsyncClient", _FakeClient)
    monkeypatch.setenv("RESEND_API_KEY", _KEY)
    monkeypatch.setenv("RESEND_FROM_EMAIL", "Astrail <no-reply@astrail.xyz>")
    return _FakeClient


# --- main(): orchestration + exit codes ------------------------------------------------------

async def test_happy_path_exits_0_and_sends_once(fake_api) -> None:
    assert await main(["--to", "traveler@example.com"]) == 0
    assert len(fake_api.posts) == 1
    assert fake_api.posts[0]["json"]["from"] == "Astrail <no-reply@astrail.xyz>"
    assert fake_api.posts[0]["json"]["to"] == ["traveler@example.com"]


async def test_307_send_exits_1_not_0(fake_api) -> None:
    """End-to-end guard for the loose-success bug: a 307 must not reach a PASS verdict."""
    fake_api.post_resp = _FakeResp(307, {"id": "msg-1"})
    assert await main(["--to", "traveler@example.com"]) == 1


async def test_2xx_without_id_exits_1(fake_api) -> None:
    fake_api.post_resp = _FakeResp(200, {"ok": True})
    assert await main(["--to", "traveler@example.com"]) == 1


async def test_unverified_sender_403_exits_1(fake_api, monkeypatch, capsys) -> None:
    # monkeypatch, NOT os.environ directly: a raw assignment survives the test and would leak the
    # broken sender into every test that runs after it, making failures order-dependent.
    monkeypatch.setenv("RESEND_FROM_EMAIL", "Astrail <no-reply@send.astrail.xyz>")
    fake_api.post_resp = _FakeResp(
        403, {"message": "The send.astrail.xyz domain is not verified."}
    )
    assert await main(["--to", "traveler@example.com"]) == 1
    assert "F3" in capsys.readouterr().out


async def test_no_send_with_send_only_key_is_INCONCLUSIVE_exit_2(fake_api, capsys) -> None:
    """Not a PASS. A send-only key cannot prove the from-address without sending, and saying
    otherwise would manufacture the exact false confidence this script removes."""
    assert await main(["--no-send"]) == 2
    assert "INCONCLUSIVE" in capsys.readouterr().out


async def test_no_send_never_posts(fake_api) -> None:
    await main(["--no-send"])
    assert fake_api.posts == [], "--no-send must not send an email under any key type"


async def test_full_access_key_no_send_verified_exits_0(fake_api) -> None:
    fake_api.get_resp = _FakeResp(200, {"data": [{"name": "astrail.xyz", "status": "verified"}]})
    assert await main(["--no-send"]) == 0
    assert fake_api.posts == []


async def test_full_access_key_no_send_unverified_exits_1(fake_api) -> None:
    fake_api.get_resp = _FakeResp(200, {"data": [{"name": "other.com", "status": "verified"}]})
    assert await main(["--no-send"]) == 1


async def test_bad_key_exits_1_and_never_posts(fake_api) -> None:
    fake_api.get_resp = _FakeResp(401, {"message": "invalid", "name": "validation_error"})
    assert await main(["--to", "traveler@example.com"]) == 1
    assert fake_api.posts == []


async def test_missing_api_key_exits_1(fake_api, monkeypatch) -> None:
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.setattr("scripts.preflight_resend._ensure_env", lambda: None)  # don't load .env
    assert await main(["--to", "traveler@example.com"]) == 1


async def test_the_api_key_is_never_printed(fake_api, capsys) -> None:
    """The script prints the key's LENGTH only. A regression here leaks a live secret into a CI log."""
    await main(["--to", "traveler@example.com"])
    assert _KEY not in capsys.readouterr().out


async def test_the_recipient_is_masked_in_output(fake_api, capsys) -> None:
    await main(["--to", "shaunliew20@gmail.com"])
    out = capsys.readouterr().out
    assert "shaunliew20@gmail.com" not in out
    assert "sh…20@gmail.com" in out


# --- classify_key_probe: the 401 that is actually healthy ------------------------------------

def test_restricted_key_401_is_a_healthy_send_only_key() -> None:
    """The real response from the run-sheet's RECOMMENDED key type, captured live 2026-08-07.

    A Sending-access key is forbidden from reading /domains and answers 401 `restricted_api_key`.
    Reading that as a bad key — the obvious reading of any 401 — would reject the exact
    configuration the run-sheet asks for and send an operator hunting a credential problem that
    does not exist, the night before launch. This test pins the discrimination.
    """
    body = {
        "statusCode": 401,
        "message": "This API key is restricted to only send emails",
        "name": "restricted_api_key",
    }
    kind, reason = classify_key_probe(401, body)
    assert kind == "send_only"
    assert "SENDING only" in reason


def test_full_access_key_200_can_list_domains() -> None:
    kind, _ = classify_key_probe(200, {"data": []})
    assert kind == "full"


@pytest.mark.parametrize(
    "status, body",
    [
        (401, {"statusCode": 401, "message": "API key is invalid", "name": "validation_error"}),
        (401, {"message": "missing api key"}),          # no `name` at all
        (403, {"name": "restricted_api_key"}),          # right name, wrong status -> not the 401 case
        (500, {"message": "internal"}),
        (401, "error code: 1010"),                      # Cloudflare bot-block, not JSON
    ],
)
def test_other_failures_are_classified_bad(status: int, body: object) -> None:
    kind, _ = classify_key_probe(status, body)
    assert kind == "bad"


def test_classify_matches_on_name_not_message_prose() -> None:
    """`message` is user-facing copy Resend can reword; `name` is the machine contract. Matching on
    the prose would silently start failing after a copy edit upstream."""
    reworded = {"statusCode": 401, "message": "totally different wording", "name": "restricted_api_key"}
    assert classify_key_probe(401, reworded)[0] == "send_only"


# (The explain_send_failure tests live further down, next to interpret_send. An earlier duplicate
# block sat here and was SHADOWED by those same three names — Python keeps only the last definition,
# so pytest never collected these and the suite reported green over three tests that did not run.)

# --- from_domain: both env-var spellings must work ------------------------------------------

@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Astrail <no-reply@astrail.xyz>", "astrail.xyz"),   # the documented display-name form
        ("no-reply@astrail.xyz", "astrail.xyz"),             # a bare address is equally valid
        ("  Astrail  <No-Reply@ASTRAIL.XYZ>  ", "astrail.xyz"),  # case + whitespace normalised
        ("Astrail <no-reply@send.astrail.xyz>", "send.astrail.xyz"),  # the repo default
    ],
)
def test_from_domain_parses_both_forms(raw: str, expected: str) -> None:
    assert from_domain(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "not-an-address", "Astrail <>", "no-reply@"])
def test_from_domain_returns_none_when_unparseable(raw: str) -> None:
    """None is the signal the caller turns into a FAIL. A str() fallback here would let an
    unparseable address flow into the alignment check and fail with a confusing reason."""
    assert from_domain(raw) is None


@pytest.mark.parametrize(
    "raw",
    [
        "no reply@astrail.xyz",                                     # space in the local part
        "Astrail <no-reply@astrail.xyz>, Other <x@example.com>",    # an address LIST, not one address
        "no-reply@astrail.xyz\nBcc: victim@example.com",            # header injection
        "no-reply@astrail.xyz;x@evil.com",
        "a@b@astrail.xyz",                                          # two @s
    ],
)
def test_malformed_addresses_never_yield_a_domain(raw: str) -> None:
    """`parseaddr` is lenient by design and returns `reply@astrail.xyz` for `no reply@astrail.xyz` —
    a domain that looks verified while the header itself is invalid. Anything that is not exactly one
    clean address must yield None, so it can never be reported as a verified sending identity.

    Only the first case constrains the guard added for this (the others already failed the '@' test),
    which an inversion run caught: without it the suite stayed green and the hardening was inert.
    """
    assert from_domain(raw) is None
    assert verify_from_domain(raw, {"astrail.xyz": "verified"})[0] is False


def test_malformed_rejection_does_not_depend_on_parseaddr_sanitizing() -> None:
    """Version-independence: the raw string is checked BEFORE parseaddr.

    Given `a@x.com, b@y.com`, Python 3.11's parseaddr returns `a@x.com` and 3.14's returns `''`. A
    guard reading only parseaddr's output therefore passes an address LIST as one clean address on
    3.11. This asserts rejection happens on the raw input, so the result is the same either way —
    simulated by feeding the guard the value 3.11's parseaddr would have produced.
    """
    import scripts.preflight_resend as pf

    original = pf.parseaddr
    try:
        # Emulate the lenient 3.11 behaviour: always hand back a clean first address.
        pf.parseaddr = lambda _s: ("", "no-reply@astrail.xyz")
        assert pf.from_domain("Astrail <no-reply@astrail.xyz>, Other <x@example.com>") is None
        assert pf.from_domain("no-reply@astrail.xyz\nBcc: victim@example.com") is None
        # …and a genuinely well-formed address still resolves under the same stub.
        assert pf.from_domain("no-reply@astrail.xyz") == "astrail.xyz"
    finally:
        pf.parseaddr = original


@pytest.mark.parametrize(
    "raw",
    [
        "Astrail <no-reply@astrail.xyz>",
        '"Astrail, Inc" <no-reply@astrail.xyz>',   # a comma IS legal — when QUOTED, per RFC 5322
        "Astrail (Beta) <no-reply@astrail.xyz>",   # RFC comment syntax
        "no-reply@astrail.xyz",
    ],
)
def test_legitimate_display_names_are_not_rejected(raw: str) -> None:
    """The hardening must not reject addresses a real operator would plausibly configure.

    Note the QUOTES on the comma case. An UNQUOTED comma (`Astrail, Inc <no-reply@astrail.xyz>`) is
    not a valid single address — RFC 5322 reads the comma as an address-list separator, and
    parseaddr duly returns `''` for it. Rejecting that is correct behaviour, not over-zealous
    hardening, so it belongs with the malformed cases rather than here. This distinction is why the
    raw-input check screens on the '@' COUNT and not on commas.
    """
    assert from_domain(raw) == "astrail.xyz"


def test_from_domain_does_not_naively_split_on_at() -> None:
    """Regression: `raw.split('@')[1]` yields 'astrail.xyz>' for the display form, which matches no
    verified name — the config would be correct and the script would still report FAIL."""
    assert from_domain("Astrail <no-reply@astrail.xyz>") == "astrail.xyz"
    assert not from_domain("Astrail <no-reply@astrail.xyz>").endswith(">")


# --- verified_domains: projection of the API body -------------------------------------------

def test_verified_domains_maps_name_to_status() -> None:
    payload = {"data": [
        {"id": "1", "name": "astrail.xyz", "status": "verified"},
        {"id": "2", "name": "old.example.com", "status": "pending"},
    ]}
    assert verified_domains(payload) == {"astrail.xyz": "verified", "old.example.com": "pending"}


def test_verified_domains_keeps_unverified_entries() -> None:
    """Deliberately NOT filtered to verified-only: keeping 'pending' lets verify_from_domain say
    'DNS has not propagated' instead of 'not on this account', which are different fixes."""
    assert verified_domains({"data": [{"name": "astrail.xyz", "status": "pending"}]}) == {
        "astrail.xyz": "pending"
    }


@pytest.mark.parametrize("payload", [{}, {"data": None}, {"data": []}, [], None, {"data": [{}]}])
def test_verified_domains_tolerates_malformed_bodies(payload: object) -> None:
    """A shape change on Resend's side must produce an empty map (-> FAIL), never a crash and
    never a spuriously-populated one."""
    assert verified_domains(payload) == {}


# --- verify_from_domain: the alignment rule -------------------------------------------------

def test_verified_root_domain_passes() -> None:
    ok, reason = verify_from_domain("Astrail <no-reply@astrail.xyz>", {"astrail.xyz": "verified"})
    assert ok is True
    assert "verified" in reason


def test_subdomain_of_a_verified_domain_is_rejected() -> None:
    """THE load-bearing test — the exact production bug this script exists to catch.

    The repo default is `no-reply@send.astrail.xyz`; the Resend account verifies `astrail.xyz`.
    `send.astrail.xyz` is the Return-Path/bounce subdomain (SES MX + SPF), NOT a sending identity —
    there is no DKIM selector under it. A send from it is rejected by the API and then SWALLOWED by
    notifications.py, leaving a 7-day deletion grace with no notice.

    This asserts the guard is load-bearing, not merely green: because
    `"send.astrail.xyz".endswith("astrail.xyz")` is True, relaxing verify_from_domain's exact match
    to a suffix match makes this test FAIL. That inversion is the point — a green run of the other
    tests alone would not prove the rule does any work.
    """
    assert "send.astrail.xyz".endswith("astrail.xyz")  # the trap a suffix match would fall into

    ok, reason = verify_from_domain(
        "Astrail <no-reply@send.astrail.xyz>", {"astrail.xyz": "verified"}
    )
    assert ok is False
    assert "send.astrail.xyz" in reason
    assert "astrail.xyz" in reason  # the reason names what IS on the account, so the fix is obvious


def test_pending_domain_is_rejected_with_its_status() -> None:
    ok, reason = verify_from_domain("no-reply@astrail.xyz", {"astrail.xyz": "pending"})
    assert ok is False
    assert "pending" in reason
    assert "not 'verified'" in reason


def test_domain_absent_from_account_is_rejected_and_lists_what_is_there() -> None:
    """The 'wrong API key' case — the domain is fine, the account is not. The reason must list the
    account's actual domains or the operator cannot tell which of the two is wrong."""
    ok, reason = verify_from_domain("no-reply@astrail.xyz", {"someone-else.com": "verified"})
    assert ok is False
    assert "someone-else.com" in reason


def test_empty_account_is_rejected() -> None:
    ok, reason = verify_from_domain("no-reply@astrail.xyz", {})
    assert ok is False
    assert "(none)" in reason


def test_unparseable_from_address_is_rejected() -> None:
    ok, reason = verify_from_domain("garbage", {"astrail.xyz": "verified"})
    assert ok is False
    assert "could not parse" in reason


# --- interpret_send: the success test must MATCH PRODUCTION's, not be looser -----------------

def test_2xx_with_id_is_a_success() -> None:
    ok, detail = interpret_send(200, {"id": "abc-123"}, "no-reply@astrail.xyz")
    assert ok is True
    assert detail == "abc-123"


@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_3xx_is_a_FAILURE_because_production_raises_on_it(status: int) -> None:
    """THE regression for the bug Codex caught 2026-08-07.

    `notifications.py::_send_email` calls `resp.raise_for_status()`, and httpx raises for anything
    that is not 2xx — 3xx included (`Response.is_success` is `200 <= code < 300`), with
    `follow_redirects=False` by default so a redirect really does surface. The original check here
    was `status_code >= 400`, which called a 307 "accepted" while production raised on it and then
    SWALLOWED the raise. A pre-flight looser than production certifies configs that fail silently —
    exactly the class of bug this script exists to prevent, turned on the script itself.
    """
    ok, detail = interpret_send(status, {"id": "abc-123"}, "no-reply@astrail.xyz")
    assert ok is False, f"HTTP {status} must FAIL: production's raise_for_status() raises on it"
    assert str(status) in detail


def test_2xx_without_a_message_id_is_a_failure() -> None:
    """Resend returns an id on success; its absence means this is not the success shape."""
    ok, detail = interpret_send(200, {"ok": True}, "no-reply@astrail.xyz")
    assert ok is False
    assert "no message id" in detail


def test_2xx_with_non_dict_body_is_a_failure() -> None:
    ok, _ = interpret_send(200, "<html>ok</html>", "no-reply@astrail.xyz")
    assert ok is False


def test_interpret_send_delegates_real_failures_to_the_explainer() -> None:
    body = {"statusCode": 403, "message": "The send.astrail.xyz domain is not verified."}
    ok, detail = interpret_send(403, body, "Astrail <no-reply@send.astrail.xyz>")
    assert ok is False
    assert "F3" in detail


# --- explain_send_failure: the unverified-domain case a send-only key must surface -----------

def test_send_failure_403_names_the_domain_and_the_f3_risk() -> None:
    body = {"statusCode": 403, "message": "The send.astrail.xyz domain is not verified."}
    out = explain_send_failure(403, body, "Astrail <no-reply@send.astrail.xyz>")
    assert "send.astrail.xyz" in out
    assert "SWALLOWED" in out          # names the production consequence, not just the HTTP error
    assert "F3" in out


@pytest.mark.parametrize(
    "status, message",
    [
        (403, "account is suspended"),                     # a 403 that is NOT a domain problem
        (403, "this API key is blocked"),
        (422, "recipient address must be verified"),       # 'verified' but about the RECIPIENT
    ],
)
def test_unrelated_failures_are_not_misdiagnosed_as_an_unverified_sender(
    status: int, message: str
) -> None:
    """Sending a launch-night operator to re-verify DNS that was never broken costs more than a
    vague message does. An earlier version blamed the sender domain for EVERY 403."""
    out = explain_send_failure(status, {"message": message}, "no-reply@astrail.xyz")
    assert message in out
    assert "NOT a verified sending identity" not in out
    assert "Not a recognised unverified-sender error" in out


def test_error_about_a_DIFFERENT_domain_is_not_blamed_on_the_configured_one() -> None:
    """The substring trap, one function later than where it was guarded against.

    Configured sender is `astrail.xyz`; Resend reports an error about `send.astrail.xyz`. Because
    `"astrail.xyz" in "the send.astrail.xyz domain is not verified"` is True, a containment test
    would tell the operator their (correct) `astrail.xyz` config is unverified — sending them to
    re-verify DNS that is fine. Exact token match is required.
    """
    body = {"message": "The send.astrail.xyz domain is not verified."}
    out = explain_send_failure(403, body, "Astrail <no-reply@astrail.xyz>")
    assert "NOT a verified sending identity" not in out
    assert "Not a recognised unverified-sender error" in out


def test_the_real_unverified_case_still_gets_its_warning() -> None:
    """Companion to the above — narrowing the rule must not lose the TRUE positive. A false negative
    here is worse than the false positive it replaced: it drops the F3 warning on the real bug."""
    body = {"message": "The send.astrail.xyz domain is not verified."}
    out = explain_send_failure(403, body, "Astrail <no-reply@send.astrail.xyz>")
    assert "NOT a verified sending identity" in out
    assert "F3" in out


def test_domain_at_end_of_sentence_still_matches() -> None:
    """Edge dots are stripped, so a trailing period does not defeat the token match."""
    out = explain_send_failure(403, {"message": "Not verified: astrail.xyz."}, "no-reply@astrail.xyz")
    assert "NOT a verified sending identity" in out


# --- mask_email must not leak the thing it is masking ---------------------------------------

@pytest.mark.parametrize(
    "raw",
    [
        "a@x.com, victim@y.com",           # `partition` would keep "x.com, victim@y.com" as "domain"
        "a@x.com\nBcc: victim@y.com",
        "a@x.com;victim@y.com",
    ],
)
def test_mask_email_refuses_multi_address_input_instead_of_leaking_it(raw: str) -> None:
    """`str.partition('@')` keeps EVERYTHING after the first '@', so a masker built on it would print
    the second recipient verbatim — leaking exactly what it exists to hide."""
    out = mask_email(raw)
    assert "victim" not in out
    assert out == "(invalid address)"


def test_send_failure_generic_error_still_prints_the_body() -> None:
    """Any non-403 must still surface the raw message — the whole point is that production hides it."""
    out = explain_send_failure(422, {"message": "invalid `to` field"}, "no-reply@astrail.xyz")
    assert "invalid `to` field" in out
    assert "422" in out


def test_send_failure_tolerates_non_dict_body() -> None:
    out = explain_send_failure(502, "<html>bad gateway</html>", "no-reply@astrail.xyz")
    assert "502" in out


# --- mask_email -----------------------------------------------------------------------------

def test_mask_email_keeps_enough_to_confirm_the_target() -> None:
    assert mask_email("shaunliew20@gmail.com") == "sh…20@gmail.com"


@pytest.mark.parametrize("raw", ["a@b.com", "abcd@x.io"])
def test_mask_email_does_not_expand_a_short_local_part(raw: str) -> None:
    """A short local part cannot be partially masked without revealing it — drop it entirely."""
    assert "…@" in mask_email(raw)
    assert raw.split("@")[0] not in mask_email(raw)

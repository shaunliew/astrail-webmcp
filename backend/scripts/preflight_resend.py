"""Pre-flight for the RESEND config, run BEFORE the key goes anywhere near Render (Task 6, switch 1).

WHY THIS EXISTS. `notifications.py::_send_email` swallows every exception by design — a missing
deletion notice must never fail a deletion — and logs only the exception TYPE name. That is correct
in production and useless for configuration: a revoked key, an unverified from-domain, and a genuine
Resend outage all produce the identical line `deletion email send failed: HTTPStatusError`, and the
request still returns 200 with the account already in a 7-day grace. So the app can never tell you
your config is wrong. This script is the inverse: it swallows NOTHING and prints the response body.

WHAT IT PROVES:
  1. RESEND_API_KEY authenticates          -> GET /domains returns 200, or 401 `restricted_api_key`
  2. the FROM domain is a sending identity -> by domain list (full-access key) or by SEND (send-only)
  3. a real send is accepted               -> POST /emails returns a message id

⚠ THE KEY TYPE DECIDES HOW GATE 2 IS PROVEN. The run-sheet tells you to use a dedicated
**Sending access** key, and such a key is *forbidden* from reading `/domains` — it answers 401
`restricted_api_key`. That 401 is a PASS for gate 1 (an unauthenticated key fails with a different
`name`), but it means the from-domain cannot be checked by listing. For a send-only key the ONLY
proof is gate 3, so `--no-send` returns INCONCLUSIVE rather than PASS. Do not read that as success.

Gate 2 is the one that matters. The repo default from-address WAS `no-reply@send.astrail.xyz` until
2026-08-07 (corrected after this script proved it 403s), and
`send.<domain>` is Resend's Return-Path/bounce subdomain (SES MX + SPF), NOT a sending identity —
the DKIM key lives at `resend._domainkey.astrail.xyz`, on the ROOT. Sending from the `send.`
subdomain is rejected by the API and then swallowed, which is exactly blocker F3's shape (a silent
failure = a 7-day countdown nobody is told about). Hence the exact-match rule in `verify_from_domain`
— see its docstring for why a suffix match would defeat this script.

COST: gate 3 sends ONE real email to the address you pass. Nothing is written to any Astrail DB, no
Supabase client is built, and no pipeline credit is spent.

KNOWN LIMITS (accepted 2026-08-07 after three review rounds; every one fails SAFE — it rejects, and
a rejection is a visible FAIL, never a false PASS):
  * An address with more than one '@' is refused, so the exotic-but-legal quoted local part
    (`"a@b"@astrail.xyz`) and a display name containing '@' are rejected rather than parsed. The
    raw Resend error is still printed in full; only the added F3 commentary is lost.
  * Domain tokenization is ASCII, so an IDN written in Unicode rather than punycode would likewise
    lose the F3 note (not the error itself).
  * `mask_email` refuses a quoted-local-part recipient, printing "(invalid address)" while still
    sending to it.
None is reachable by the configured sender `Astrail <no-reply@astrail.xyz>` — one '@', ASCII domain.

Run:
    cd backend && uv run python -m scripts.preflight_resend --to you@example.com
    cd backend && uv run python -m scripts.preflight_resend --no-send   # gate 1 (+2 iff full-access)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
from email.utils import parseaddr

_DOMAINS_ENDPOINT = "https://api.resend.com/domains"
_EMAILS_ENDPOINT = "https://api.resend.com/emails"

# Mirrors notifications.py's _DEFAULT_FROM deliberately — if that default changes, this script must
# report the NEW default, since its whole job is to catch a wrong from-address before Render does not.
# Both were `no-reply@send.astrail.xyz` until 2026-08-07, which this script proved returns 403.
_DEFAULT_FROM = "Astrail <no-reply@astrail.xyz>"

# Resend's discriminator for "authenticated, but scoped to sending only". Matched on `name`, not on
# `message`: the prose is user-facing copy and can be reworded, the machine name is the contract.
_RESTRICTED_KEY = "restricted_api_key"


def mask_email(address: str) -> str:
    """Partially mask a recipient for terminal/CI output: `shaunliew20@gmail.com` -> `sh…20@gmail.com`.

    The operator typed this address, so it is not a secret to them — but this script is exactly the
    kind of thing that ends up in a shared terminal or a CI log, and a recipient address is PII.
    Enough is kept for the operator to confirm they targeted the right inbox.
    """
    raw = address or ""
    # `partition` keeps EVERYTHING after the first '@' as the "domain", so `a@x.com, b@y.com` would
    # print the second recipient verbatim — a masker that leaks the address it was masking. Anything
    # that is not exactly one address is not masked, it is refused.
    if raw.count("@") != 1 or any(ch in raw for ch in " \t\r\n,;"):
        return "(invalid address)"
    local, _, domain = raw.partition("@")
    if not domain or len(local) <= 4:
        return f"{'…' if local else ''}@{domain}" if domain else "(unset)"
    return f"{local[:2]}…{local[-2:]}@{domain}"


def _ensure_env() -> None:
    """Load backend/.env when the value is not already exported, matching the other smokes so this
    runs as a plain `uv run python -m scripts.preflight_resend` with no --env-file."""
    if not os.environ.get("RESEND_API_KEY"):
        from dotenv import find_dotenv, load_dotenv

        load_dotenv(find_dotenv(usecwd=True))


def from_domain(from_email: str) -> str | None:
    """The domain of a from-address, accepting BOTH forms the env var may hold.

    `RESEND_FROM_EMAIL` is documented as a display-name address (`Astrail <no-reply@astrail.xyz>`)
    but a bare `no-reply@astrail.xyz` is equally valid, so this parses with `email.utils.parseaddr`
    rather than splitting on '@' — the naive split returns `astrail.xyz>` for the display form and
    would then never match a verified name, failing an otherwise-correct config.

    Returns None when there is no parseable address, which the caller must treat as a FAIL: an
    unparseable from-address cannot possibly be verified.
    """
    raw = from_email or ""
    # Validate the RAW input FIRST, not just parseaddr's output.
    #
    # parseaddr SANITIZES malformed input, and *what* it sanitizes is version-dependent: given
    # `a@x.com, b@y.com` Python 3.11 returns `a@x.com` while 3.14 returns `''`. A guard that
    # inspects only the output therefore sees one clean address on 3.11 and hands back a
    # "verified" domain for an address LIST. This repo pins 3.14 (`requires-python = ">=3.14"`,
    # `python:3.14-slim`, CI 3.14) so production was never exposed — but resting a security check
    # on a stdlib sanitizing detail that has already changed once is not a guard, it is a
    # coincidence. Checking the raw string makes this independent of parseaddr entirely.
    #
    # A comma is deliberately NOT rejected: `Astrail, Inc <no-reply@astrail.xyz>` is a legitimate
    # display name. The '@' COUNT is what actually separates one address from a list.
    if any(ch in raw for ch in "\r\n") or raw.count("@") != 1:
        return None
    _, addr = parseaddr(raw)
    # Then the parsed form, for what the raw check cannot see (e.g. `no reply@astrail.xyz`, whose
    # domain would look verified while the header itself is invalid).
    if "@" not in addr or any(ch in addr for ch in " \t\r\n,;<>"):
        return None
    domain = addr.rsplit("@", 1)[1].strip().lower()
    return domain or None


def classify_key_probe(status: int, payload: object) -> tuple[str, str]:
    """Read a GET /domains response as a verdict on the KEY: 'full' | 'send_only' | 'bad'.

    The subtle case is 401. A 401 whose `name` is `restricted_api_key` means the key authenticated
    correctly and is simply scoped to sending — that is a *healthy* key, and the type the run-sheet
    asks for. Treating every 401 as a bad key (the obvious reading) would reject the recommended
    configuration and send someone hunting a non-existent credential problem the night before launch.
    An invalid/revoked key returns 401 with a different `name`, which is why this branches on `name`
    and not on the status code alone.
    """
    if status == 200:
        return "full", "key accepted, and it can read the domain list (full access)"
    name = payload.get("name") if isinstance(payload, dict) else None
    if status == 401 and name == _RESTRICTED_KEY:
        return "send_only", "key authenticated — scoped to SENDING only (cannot list domains)"
    message = payload.get("message") if isinstance(payload, dict) else None
    return "bad", f"HTTP {status}" + (f" — {message}" if message else "")


def verified_domains(payload: object) -> dict[str, str]:
    """Map every domain Resend knows about to its status, from a GET /domains body.

    Returns ALL of them, not just the verified ones, so the caller can tell "the domain is not on
    this account at all" (probably the wrong API key) from "it is on the account but still pending"
    (DNS not propagated) — two failures with very different fixes.
    """
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return {}
    return {
        str(d["name"]).strip().lower(): str(d.get("status", "unknown"))
        for d in data
        if isinstance(d, dict) and d.get("name")
    }


def verify_from_domain(from_email: str, domains: dict[str, str]) -> tuple[bool, str]:
    """Is `from_email` sendable on this account? Returns (ok, human-readable reason).

    EXACT match on the domain name — never a suffix/endswith match. This is the load-bearing line
    in the script. The precise bug it exists to catch is `no-reply@send.astrail.xyz` against a
    Resend account that has verified `astrail.xyz`, and `"send.astrail.xyz".endswith("astrail.xyz")`
    is True — so a suffix match would report PASS over the exact misconfiguration this whole
    pre-flight was written to prevent. A verified parent domain does NOT make its subdomains
    sendable; each sending identity is registered separately.
    """
    domain = from_domain(from_email)
    if domain is None:
        return False, f"could not parse an address out of RESEND_FROM_EMAIL={from_email!r}"
    status = domains.get(domain)
    if status is None:
        known = ", ".join(sorted(domains)) or "(none)"
        return False, f"'{domain}' is not a domain on this Resend account. Account has: {known}"
    if status != "verified":
        return False, f"'{domain}' is on the account but its status is '{status}', not 'verified'"
    return True, f"'{domain}' is verified on this Resend account"


def interpret_send(status: int, payload: object, from_email: str) -> tuple[bool, str]:
    """Did POST /emails actually succeed, by PRODUCTION's definition? Returns (ok, detail).

    The success test is `200 <= status < 300`, deliberately mirroring `httpx.Response.is_success`,
    because `notifications.py::_send_email` calls `resp.raise_for_status()` — and httpx raises for
    **anything that is not 2xx, including 3xx**. A `status < 400` test (the obvious one) would call a
    307 "accepted" here while production raised on it, and `_send_email` swallowed the raise. That
    would make this pre-flight certify a configuration that then fails silently — the precise class
    of bug the script exists to prevent, turned on the script itself. httpx also defaults to
    `follow_redirects=False`, so a redirect really does surface as a 3xx rather than being chased.

    A 2xx with no message `id` is also a FAIL: Resend returns an id on success, and its absence means
    the response is not the success shape we think it is.
    """
    if 200 <= status < 300:
        message_id = payload.get("id") if isinstance(payload, dict) else None
        if not message_id:
            return False, (
                f"HTTP {status} but the body carries no message id — not Resend's success shape.\n"
                f"     body: {payload!r}"
            )
        return True, str(message_id)
    return False, explain_send_failure(status, payload, from_email)


# Resend's unverified-sender error names the domain and says it is not verified. Matched on BOTH
# signals so an unrelated 403 (a suspended account, a blocked key) is not misdiagnosed as a domain
# problem — sending a launch-night operator to fix DNS that is already correct costs more than a
# vague message does.
def _looks_like_unverified_domain(status: int, message: object, from_email: str) -> bool:
    if not isinstance(message, str):
        return False
    lowered = message.lower()
    domain = (from_domain(from_email) or "").lower()
    if not domain or status not in (403, 422) or "not verified" not in lowered:
        return False
    # EXACT token match, never `domain in lowered`. The configured `astrail.xyz` is a SUBSTRING of
    # an error about `send.astrail.xyz`, so a containment test would blame the configured sender for
    # an error about a DIFFERENT domain — precisely the substring trap `verify_from_domain` goes out
    # of its way to avoid, reintroduced one function later. Edge dots are stripped so a domain
    # ending a sentence ("... not verified for astrail.xyz.") still matches.
    tokens = {t.strip(".") for t in re.split(r"[^0-9a-z.\-]+", lowered)}
    return domain in tokens


def explain_send_failure(status: int, payload: object, from_email: str) -> str:
    """Turn a failed POST /emails into the operator's next action.

    A send-only key proves the from-address only here, so this is where an unverified from-domain
    surfaces. That case gets the loud F3 warning; every OTHER failure gets the raw body and no
    diagnosis. An earlier version treated *every* 403 as an unverified domain, which would tell an
    operator whose account was suspended to go re-verify DNS that was never broken.
    """
    message = payload.get("message") if isinstance(payload, dict) else None
    detail = message or (payload if isinstance(payload, str) else repr(payload))
    lines = [f"HTTP {status}: {detail}"]
    if _looks_like_unverified_domain(status, message, from_email):
        domain = from_domain(from_email)
        lines += [
            f"  -> '{domain}' is NOT a verified sending identity on this Resend account.",
            "  -> In production this is SWALLOWED: the user enters a 7-day deletion grace and the",
            "     cancel-by notice never arrives (blocker F3's exact shape). Fix before Render.",
        ]
    else:
        lines.append("  -> Not a recognised unverified-sender error; read the body above before acting.")
    return "\n".join(lines)


async def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    _ensure_env()

    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        print("RESULT: FAIL ❌  RESEND_API_KEY is unset.")
        print("  Without it the deletion endpoints fail closed with 503 (main.py resend_configured()).")
        return 1

    from_email = os.environ.get("RESEND_FROM_EMAIL") or _DEFAULT_FROM
    used_default = not os.environ.get("RESEND_FROM_EMAIL")
    print(f"key    : re_… ({len(api_key)} chars)          [never printed in full]")
    print(f"from   : {from_email}" + ("   ⚠ FALLING BACK TO THE CODE DEFAULT" if used_default else ""))
    if used_default:
        print("         RESEND_FROM_EMAIL is unset, so notifications.py's default applies. That")
        print("         default is correct as of 2026-08-07, but set it explicitly in Render anyway:")
        print("         the sending identity should not silently depend on a code constant.")

    import httpx  # lazy, matching notifications.py: importing this module needs no network

    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=20.0) as http:
        # --- Gate 1: the key authenticates -----------------------------------------------
        print("\n[1/3] GET /domains  (probing the key) …")
        resp = await http.get(_DOMAINS_ENDPOINT, headers=headers)
        body: object
        try:
            body = resp.json()
        except ValueError:
            body = resp.text
        kind, reason = classify_key_probe(resp.status_code, body)
        print(f"      {reason}")
        if kind == "bad":
            print(f"\nRESULT: FAIL ❌  the key was rejected. Raw body: {body!r}")
            return 1

        # --- Gate 2: the from-address is sendable ----------------------------------------
        print("\n[2/3] checking the FROM domain …")
        if kind == "full":
            domains = verified_domains(body)
            print(f"      domains on account: {domains or '(none)'}")
            ok, why = verify_from_domain(from_email, domains)
            print(f"      {why}")
            if not ok:
                print("\nRESULT: FAIL ❌  this from-address cannot send.")
                print("  In production this failure is SWALLOWED by notifications.py — the user would")
                print("  enter a 7-day grace and never get the cancel-by notice. Fix before Render.")
                return 1
        else:
            print("      SKIPPED — a send-only key may not list domains. The from-address is proven")
            print("      by the real send in gate 3, which is the authoritative test either way.")

        if args.no_send:
            if kind == "full":
                print("\nRESULT: PASS ✅  key valid + from-domain verified. (--no-send: nothing sent.)")
                print("  NOT proven: that an actual send is accepted. Re-run with --to for that.")
                return 0
            # Honest verdict: for a send-only key, --no-send proves only that the key authenticates.
            print("\nRESULT: INCONCLUSIVE ⚠  the key authenticates, but with a send-only key the")
            print("  from-address CANNOT be checked without sending. This is NOT a pass — re-run:")
            print("      uv run python -m scripts.preflight_resend --to you@example.com")
            return 2

        # --- Gate 3: a real send is accepted ---------------------------------------------
        print(f"\n[3/3] POST /emails -> {mask_email(args.to)} …")
        payload = {
            "from": from_email,
            "to": [args.to],
            "subject": "Astrail Resend pre-flight",
            "text": (
                "This is the Astrail RESEND pre-flight (scripts/preflight_resend.py).\n\n"
                "If you are reading this, the API key, the from-address and delivery all work, and "
                "the account-deletion notices can be trusted to actually arrive.\n"
            ),
        }
        resp = await http.post(_EMAILS_ENDPOINT, headers=headers, json=payload)
        try:
            body = resp.json()
        except ValueError:
            body = resp.text
        sent_ok, detail = interpret_send(resp.status_code, body, from_email)
        if not sent_ok:
            print("RESULT: FAIL ❌  " + detail)
            return 1
        print(f"      accepted (HTTP {resp.status_code}). message id: {detail}")

    proven = "key valid · from-domain accepted by a real send · message queued"
    print(f"\nRESULT: PASS ✅  {proven}.")
    print(f"  Confirm it ARRIVED at {mask_email(args.to)} — API acceptance is not delivery.")
    return 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="scripts.preflight_resend",
        description="Verify RESEND_API_KEY + RESEND_FROM_EMAIL before they are set in Render.",
    )
    p.add_argument("--to", help="inbox for the real test send (required unless --no-send)")
    p.add_argument("--no-send", action="store_true",
                   help="probe the key only; sends no email. INCONCLUSIVE on a send-only key.")
    args = p.parse_args(argv)
    if not args.no_send and not args.to:
        p.error("--to is required unless --no-send is passed")
    return args


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

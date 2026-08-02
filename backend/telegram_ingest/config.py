"""The bot's ENTIRE authorization surface: the config loader and the chat allowlist.

There is no `authz.py`. `is_allowed_chat` below is the only thing standing between a
Telegram group and the ingest path, so every choice here is made in the closed direction.

Fails CLOSED on an empty allowlist. Unset, blank, or parsing to nothing is a boot failure,
never "accept everything" — the worst failure mode in this bot is being added to a random
group and silently ingesting it, spending Apify and OpenAI credits on strangers' content.
There is no allow-all value; the only way to accept a chat is to name it.

Validation mirrors `config_validation.validate_required_secrets` and, like it, must be
called BEFORE the broad `try` at boot — read that module's docstring, the placement is
load-bearing. Three properties copied exactly:
  - all-at-once, so a fresh deploy is not a fix-one-secret-per-restart loop;
  - names, never values, so no credential reaches the boot log;
  - blank counts as missing, because on Render an unset var and one set to "" arrive
    identically and a whitespace-only paste is the classic dashboard mistake.

"Never values" extends to the TRACEBACK, not just the message. `int()` and `uuid.UUID()`
both put the string they rejected into their own `ValueError` text, and Python's implicit
chaining prints that frame above ours as "During handling of the above exception" — so a
`raise` inside an `except` here would leak a pasted token through a clean-looking message.
Both parsers therefore return a value-free reason and the single `raise` sits outside every
`except` block. Verified empirically, not assumed.

Deliberately has no logger: nothing here imports `logging` (asserted structurally, from the
AST), so the one place holding a bot token in memory has no way to print it.

Pure: no I/O, no network, no clock. `env` is injectable, same shape as the precedent.
"""
from __future__ import annotations

import os
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass

BOT_TOKEN_VAR = "TELEGRAM_BOT_TOKEN"
ALLOWED_CHAT_IDS_VAR = "TELEGRAM_ALLOWED_CHAT_IDS"
INGEST_USER_ID_VAR = "ASTRAIL_INGEST_USER_ID"

# Plain ASCII decimal with an optional leading `-`, and nothing else. NOT `int(entry)`:
# `int` accepts unicode digit scripts (`٤٢` -> 42) and PEP 515 underscores (`4_2` -> 42),
# so on an allowlist it will happily authorize a number the operator did not write. `+42`
# is rejected too — it means what it says, but a second spelling of one id on an
# authorization list buys nothing and costs a way for two entries to look different and
# match the same chat. `[0-9]` is spelled out rather than `\d`, which is unicode-aware.
_CHAT_ID_GRAMMAR = re.compile(r"-?[0-9]+")

_REASON_NON_INTEGER = "contains a non-integer entry"
# No Telegram chat has id 0. Refusing it also makes `is_allowed_chat(0)` unconditionally
# False, which closes the class of upstream bug where an absent `chat.id` reads as 0.
_REASON_ZERO = "contains a zero chat id"
_REASON_EMPTY = "contains no chat ids"
_REASON_NOT_UUID = "is not a UUID"


@dataclass(frozen=True, slots=True)
class TelegramConfig:
    """Everything the worker needs to run, validated. Frozen: the allowlist is consulted on
    every message for the life of the process and must not be editable at runtime."""

    bot_token: str
    allowed_chat_ids: frozenset[int]
    ingest_user_id: str
    """A canonical lowercase hyphenated UUID string — `str(uuid.UUID(raw))`, never `raw`."""

    # Constructor defaults, NOT env vars: the worker declares exactly eight environment
    # variables and a ninth would break the deployment gate that counts them.
    poll_timeout_s: int = 50
    queue_maxsize: int = 100

    def __post_init__(self) -> None:
        """Fail closed is a property of the TYPE, not of one call site.

        `load_telegram_config` already refuses an empty allowlist, so this is unreachable
        through it. It is here because without it the only thing stopping a
        `TelegramConfig` that authorizes nothing-named — the exact object an allow-all
        `is_allowed_chat` would need — is one `if` in one function.
        """
        if not self.allowed_chat_ids:
            raise ValueError("allowed_chat_ids must name at least one chat")

    def is_allowed_chat(self, chat_id: int) -> bool:
        """The gate. No coercion — a caller that passes the wrong type is DENIED, not
        admitted, and denial is the loud failure (nothing ingests, someone notices)."""
        return chat_id in self.allowed_chat_ids


def _parse_chat_ids(raw: str) -> tuple[frozenset[int], list[str]]:
    """Parse the allowlist into ids plus value-free reasons. Never raises, never logs.

    A bad entry is collected, never skipped: silently dropping one boots a bot whose
    allowlist is not the one the operator wrote, and half an authorization list is not a
    safe subset. Empty entries are the one exception — a trailing comma is a formatting
    slip — and are tolerated only while a real id remains.
    """
    ids: set[int] = set()
    saw_non_integer = False
    saw_zero = False

    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if not _CHAT_ID_GRAMMAR.fullmatch(entry):
            saw_non_integer = True
            continue
        try:
            value = int(entry)
        except ValueError:
            # Past CPython's 4300-digit int(str) limit. Grammar-valid, still not an id.
            saw_non_integer = True
            continue
        if value == 0:
            saw_zero = True
            continue
        ids.add(value)

    reasons: list[str] = []
    if saw_non_integer:
        reasons.append(_REASON_NON_INTEGER)
    if saw_zero:
        reasons.append(_REASON_ZERO)
    if not ids and not reasons:
        reasons.append(_REASON_EMPTY)
    return frozenset(ids), reasons


def _parse_uuid(raw: str) -> str | None:
    """Canonical UUID string, or None. Never raises — its `ValueError` carries the value.

    `uuid.UUID` accepts braced, un-hyphenated, uppercase and `urn:uuid:` spellings but NOT
    surrounding whitespace, so `raw` must already be stripped: the dashboard paste this
    loader exists to survive is exactly the spelling it would refuse.
    """
    try:
        return str(uuid.UUID(raw))
    except ValueError:
        return None


def load_telegram_config(env: Mapping[str, str] | None = None) -> TelegramConfig:
    """Load + validate the worker's Telegram config. Raises RuntimeError naming EVERY
    problem — variable names only, never a value, in a stable order.

    `env` defaults to `os.environ` and is typed read-only on purpose: normalizing a value
    in place would edit the process environment of every other module in the worker.
    """
    env = os.environ if env is None else env
    missing: list[str] = []
    invalid: list[str] = []

    bot_token = (env.get(BOT_TOKEN_VAR) or "").strip()
    if not bot_token:
        missing.append(BOT_TOKEN_VAR)

    allowed_chat_ids: frozenset[int] = frozenset()
    raw_chat_ids = (env.get(ALLOWED_CHAT_IDS_VAR) or "").strip()
    if not raw_chat_ids:
        missing.append(ALLOWED_CHAT_IDS_VAR)
    else:
        allowed_chat_ids, reasons = _parse_chat_ids(raw_chat_ids)
        invalid.extend(f"{ALLOWED_CHAT_IDS_VAR} ({reason})" for reason in reasons)

    ingest_user_id = ""
    raw_user_id = (env.get(INGEST_USER_ID_VAR) or "").strip()
    if not raw_user_id:
        missing.append(INGEST_USER_ID_VAR)
    else:
        parsed = _parse_uuid(raw_user_id)
        if parsed is None:
            invalid.append(f"{INGEST_USER_ID_VAR} ({_REASON_NOT_UUID})")
        else:
            ingest_user_id = parsed

    if missing or invalid:
        # Outside every `except`, so nothing chains and no rejected value reaches the
        # traceback. "Missing" and "invalid" stay separate words: the operator needs to
        # know whether to ADD a variable or FIX one.
        parts: list[str] = []
        if missing:
            parts.append(f"Missing environment variables: {', '.join(missing)}.")
        if invalid:
            parts.append(f"Invalid environment variables: {'; '.join(invalid)}.")
        raise RuntimeError("Telegram worker configuration rejected. " + " ".join(parts))

    return TelegramConfig(
        bot_token=bot_token,
        allowed_chat_ids=allowed_chat_ids,
        ingest_user_id=ingest_user_id,
    )

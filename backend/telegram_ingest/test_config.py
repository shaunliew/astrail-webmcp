"""config — the bot's entire authorization surface. Pure unit tests, no env, no mocks.

Every test passes a plain dict as `env`. Nothing here reads `os.environ` or calls
`monkeypatch.setenv`: a config validator whose tests depend on the ambient environment
passes or fails for reasons that have nothing to do with the code.

Three literals are load-bearing across this file:
  - `CANARY-...` values stand in for a pasted secret, so the leak assertions are greppable;
  - the leak assertions read `traceback.format_exc()`, not `str(exc)` — a value can reach
    the boot log through a chained `__context__` frame while the message itself is clean,
    which is exactly how `int()` and `uuid.UUID()` leak (both put the rejected string in
    their own `ValueError`);
  - `_VALID` is the one well-formed env, so each test states its single deviation from it.
"""
from __future__ import annotations

import ast
import dataclasses
import traceback
from pathlib import Path

import pytest

from telegram_ingest import config as config_module
from telegram_ingest.config import TelegramConfig, load_telegram_config

# A supergroup id. Telegram supergroup ids are negative and this is the bot's only venue,
# so a loader that rejected the sign would be unusable in production while green in tests.
SUPERGROUP = -1001234567890
UUID_CANONICAL = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"

_VALID = {
    "TELEGRAM_BOT_TOKEN": "123456:CANARY-BOT-TOKEN",
    "TELEGRAM_ALLOWED_CHAT_IDS": str(SUPERGROUP),
    "ASTRAIL_INGEST_USER_ID": UUID_CANONICAL,
}


def _env(**overrides: str | None) -> dict[str, str]:
    """`_VALID` with overrides; a `None` override DELETES the var (unset, not blank)."""
    env = dict(_VALID)
    for name, value in overrides.items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value
    return env


def _raise_message(env: dict[str, str]) -> str:
    with pytest.raises(RuntimeError) as excinfo:
        load_telegram_config(env)
    return str(excinfo.value)


def _raise_traceback(env: dict[str, str]) -> str:
    """The FULL formatted traceback, including any chained `__context__` frame."""
    try:
        load_telegram_config(env)
    except RuntimeError:
        return traceback.format_exc()
    raise AssertionError("expected load_telegram_config to raise")


# --------------------------------------------------------------------------------------
# Happy path and the shape of what is returned
# --------------------------------------------------------------------------------------


def test_happy_path_parses_all_three_vars() -> None:
    """RED if any of the three vars is dropped, mis-parsed, or a default changes value."""
    config = load_telegram_config(_VALID)

    assert config.bot_token == "123456:CANARY-BOT-TOKEN"
    assert config.allowed_chat_ids == frozenset({SUPERGROUP})
    assert config.ingest_user_id == UUID_CANONICAL
    assert config.poll_timeout_s == 50
    assert config.queue_maxsize == 100


def test_timeout_and_maxsize_are_not_env_vars() -> None:
    """RED if the loader grows a fourth/fifth `env.get`.

    The worker's deployment gate counts exactly eight env vars. Reading these two from the
    environment would add a ninth and tenth that `render.yaml` never declares, so they are
    constructor defaults and an operator setting them must have no effect.
    """
    env = _env()
    env["TELEGRAM_POLL_TIMEOUT_S"] = "7"
    env["TELEGRAM_QUEUE_MAXSIZE"] = "9"

    config = load_telegram_config(env)

    assert config.poll_timeout_s == 50
    assert config.queue_maxsize == 100


def test_loader_does_not_mutate_the_env_it_is_given() -> None:
    """RED if the loader writes back a normalized value (`env[NAME] = stripped`).

    `env` defaults to `os.environ`; a loader that normalized in place would edit the
    process environment of every other module in the worker.
    """
    env = _env(TELEGRAM_BOT_TOKEN="  padded  ")
    before = dict(env)

    load_telegram_config(env)

    assert env == before


# --------------------------------------------------------------------------------------
# Fails CLOSED — the highest-value property in the module
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "label"),
    [
        (None, "unset"),
        ("", "empty string"),
        ("   ", "whitespace only"),
        (",", "separators only"),
    ],
)
def test_empty_allowlist_is_a_boot_failure(value: str | None, label: str) -> None:
    """RED if the empty allowlist is ever allowed to mean 'accept every chat'.

    Four spellings of "no chats named" must all refuse to boot. The tempting reading — an
    absent allowlist accepts everything — is the worst failure mode in the bot: it gets
    added to a random group and spends Apify and OpenAI credits on strangers' content.
    There is no allow-all value; the only way to accept a chat is to name it.
    """
    message = _raise_message(_env(TELEGRAM_ALLOWED_CHAT_IDS=value))

    assert "TELEGRAM_ALLOWED_CHAT_IDS" in message, label


def test_no_config_value_means_allow_all() -> None:
    """RED if a sentinel like `*` or `all` is ever wired in as an allow-all escape hatch."""
    for sentinel in ("*", "all", "ALL", "any", "0"):
        with pytest.raises(RuntimeError):
            load_telegram_config(_env(TELEGRAM_ALLOWED_CHAT_IDS=sentinel))


# --------------------------------------------------------------------------------------
# The error contract: all-at-once, names never values, missing vs invalid
# --------------------------------------------------------------------------------------


def test_all_three_problems_reported_in_one_error() -> None:
    """RED if the validator returns on the first problem.

    Failing one name at a time turns a fresh deploy into a fix-one-secret-per-restart
    loop — three restarts to learn what one boot could have said.
    """
    message = _raise_message({})

    assert "TELEGRAM_BOT_TOKEN" in message
    assert "TELEGRAM_ALLOWED_CHAT_IDS" in message
    assert "ASTRAIL_INGEST_USER_ID" in message


def test_error_never_echoes_a_value_not_even_a_valid_one() -> None:
    """RED if the message interpolates any value, or dumps the env it was handed.

    `TELEGRAM_BOT_TOKEN` here is VALID — it is not part of the failure at all, and it
    still must not appear. A validator that echoed what it found would put a live bot
    token in the boot log, and Render's boot log is not a safe place to discover that.
    """
    message = _raise_message(
        _env(TELEGRAM_BOT_TOKEN="SECRET123", ASTRAIL_INGEST_USER_ID="not-a-uuid")
    )

    assert "SECRET123" not in message
    assert "not-a-uuid" not in message
    assert "ASTRAIL_INGEST_USER_ID" in message


def test_every_offending_variable_is_named() -> None:
    """RED if a second problem in a different variable is dropped from the message."""
    message = _raise_message(
        _env(TELEGRAM_BOT_TOKEN="   ", ASTRAIL_INGEST_USER_ID="not-a-uuid")
    )

    assert "TELEGRAM_BOT_TOKEN" in message
    assert "ASTRAIL_INGEST_USER_ID" in message
    assert "not-a-uuid" not in message


def test_rejected_uuid_never_reaches_the_traceback() -> None:
    """RED if the RuntimeError is raised INSIDE `except ValueError`.

    `uuid.UUID(bad)` raises `ValueError` — and Python's implicit chaining prints that
    frame above ours as "During handling of the above exception". The message can be
    perfectly clean while the traceback carries the value. Verified empirically before
    this test was written; only a `raise` outside every `except` (or `from None`) is green.
    """
    tb = _raise_traceback(_env(ASTRAIL_INGEST_USER_ID="CANARY-PASTED-SECRET"))

    assert "CANARY" not in tb


def test_rejected_chat_id_never_reaches_the_traceback() -> None:
    """RED if the RuntimeError is raised INSIDE the chat-id parse's `except ValueError`.

    A separate code path from the UUID one, and a worse leak: `int()`'s own ValueError
    text is `invalid literal for int() with base 10: '<the value>'`. A misconfigured
    allowlist entry is very often a pasted URL or token fragment.
    """
    tb = _raise_traceback(
        _env(TELEGRAM_ALLOWED_CHAT_IDS=f"{SUPERGROUP},CANARY-PASTED-SECRET")
    )

    assert "CANARY" not in tb


def test_missing_is_distinguished_from_invalid() -> None:
    """RED if both classes collapse into one word.

    An operator reading the boot log needs to know whether to ADD a variable or FIX one.
    """
    missing_only = _raise_message(_env(TELEGRAM_BOT_TOKEN=None))
    invalid_only = _raise_message(_env(ASTRAIL_INGEST_USER_ID="nope"))

    assert "missing" in missing_only.lower()
    assert "invalid" in invalid_only.lower()
    assert "invalid" not in missing_only.lower()
    assert "missing" not in invalid_only.lower()


def test_all_problems_are_named_in_a_stable_order() -> None:
    """RED if the message is assembled from a set or a dict iteration order.

    Two boots with the same broken config must produce the same line, or an operator
    diffing logs across a restart cannot tell what changed.
    """
    message = _raise_message({})

    assert message.index("TELEGRAM_BOT_TOKEN") < message.index("TELEGRAM_ALLOWED_CHAT_IDS")
    assert message.index("TELEGRAM_ALLOWED_CHAT_IDS") < message.index("ASTRAIL_INGEST_USER_ID")


def test_two_problems_in_one_variable_are_both_reported() -> None:
    """RED if the entry loop stops at the first bad entry.

    All-at-once WITHIN a variable, not just across variables — the same fix-one-per-restart
    loop, one level down. Both reasons must survive, and neither may echo an entry.
    """
    message = _raise_message(_env(TELEGRAM_ALLOWED_CHAT_IDS="abc,0"))

    assert "non-integer" in message
    assert "zero" in message
    assert "abc" not in message


def test_module_never_imports_logging() -> None:
    """RED if the module grows any `logging` import.

    A module holding a bot token that cannot reach a logger cannot leak through one — a
    structural assertion, not a review convention, same argument as `reel_filter`. Walks
    the AST rather than checking `hasattr`, which `from logging import getLogger` defeats.
    """
    tree = ast.parse(Path(config_module.__file__).read_text())
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])

    assert "logging" not in imported


# --------------------------------------------------------------------------------------
# Blank counts as missing
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", ["TELEGRAM_BOT_TOKEN", "ASTRAIL_INGEST_USER_ID"])
def test_whitespace_only_counts_as_missing(name: str) -> None:
    """RED if the check is `env.get(name) is None` instead of `.strip()`.

    On Render an unset var and one set to "" arrive identically, and a whitespace-only
    paste is the classic dashboard mistake.
    """
    message = _raise_message(_env(**{name: "   "}))

    assert name in message
    assert "missing" in message.lower()


def test_bot_token_is_stored_stripped() -> None:
    """RED if the loader stores the raw value.

    A token pasted with a trailing newline builds `https://api.telegram.org/bot<tok>\\n/...`
    and every Bot API call 404s — a failure that looks like a revoked token, not a typo.
    """
    config = load_telegram_config(_env(TELEGRAM_BOT_TOKEN="  123456:REAL  "))

    assert config.bot_token == "123456:REAL"


# --------------------------------------------------------------------------------------
# Chat-id parsing
# --------------------------------------------------------------------------------------


def test_negative_supergroup_id_parses() -> None:
    """RED if the parse rejects the sign.

    Supergroup ids are negative and a supergroup is the bot's only intended venue.
    """
    config = load_telegram_config(_env(TELEGRAM_ALLOWED_CHAT_IDS="-1001234567890"))

    assert config.allowed_chat_ids == frozenset({-1001234567890})


def test_multiple_ids_with_surrounding_whitespace() -> None:
    """RED if entries are not stripped, or if duplicates are not collapsed."""
    config = load_telegram_config(
        _env(TELEGRAM_ALLOWED_CHAT_IDS=" -100123 , 456 , -100123 ")
    )

    assert config.allowed_chat_ids == frozenset({-100123, 456})


@pytest.mark.parametrize("raw", ["-100123,", ",-100123", "-100123, ,", " , -100123 , "])
def test_empty_entries_tolerated_while_a_real_id_remains(raw: str) -> None:
    """RED if an empty entry is treated as a non-integer entry.

    A stray comma is a formatting slip, not a misconfigured chat — tolerated because a
    real id remains. `","` with nothing else is still a failure (see the fail-closed test),
    which is the line between "tolerate the slip" and "boot with an empty allowlist".
    """
    config = load_telegram_config(_env(TELEGRAM_ALLOWED_CHAT_IDS=raw))

    assert config.allowed_chat_ids == frozenset({-100123})


def test_leading_zeros_are_accepted() -> None:
    """RED if the grammar is tightened to forbid them.

    Deliberate non-guard: unlike `٤٢` or `4_2`, `-00100123` denotes exactly the number it
    reads as, so it is not the silent-remap hazard the strict grammar exists to stop.
    """
    config = load_telegram_config(_env(TELEGRAM_ALLOWED_CHAT_IDS="-00100123"))

    assert config.allowed_chat_ids == frozenset({-100123})


def test_non_integer_entry_raises_rather_than_being_skipped() -> None:
    """RED if the parse is wrapped in `try: ... except ValueError: continue`.

    Silently dropping the bad entry boots a bot whose allowlist is not the one the
    operator wrote. Half an authorization list is not a safe subset — it is a config the
    nobody reviewed.
    """
    message = _raise_message(_env(TELEGRAM_ALLOWED_CHAT_IDS="-100123,abc"))

    assert "TELEGRAM_ALLOWED_CHAT_IDS" in message


@pytest.mark.parametrize(
    ("entry", "why"),
    [
        ("٤٢", "arabic-indic digits: int() reads this as 42"),
        ("４２", "fullwidth digits: int() reads this as 42"),
        ("-100_123", "PEP 515 underscores: int() reads this as -100123"),
        ("+100123", "a second spelling of an id the operator did not write that way"),
        ("3.0", "a float"),
        ("1e3", "scientific notation"),
        ("0x2a", "hex"),
        ("-", "a bare sign"),
        ("9" * 5000, "beyond CPython's 4300-digit int(str) limit"),
    ],
)
def test_only_plain_ascii_integers_are_accepted(entry: str, why: str) -> None:
    """RED if the parse is a bare `int(entry)`.

    `int()` is far more permissive than it looks: it accepts unicode digit scripts and
    PEP 515 underscore separators, so `٤٢` and `4_2` both become 42. On an allowlist that
    means the number authorized is not the number written — an entry that reads like one
    chat authorizing a different one. On the bot's only authorization surface, a string
    that does not mean what it says is rejected, loudly, at boot.
    """
    message = _raise_message(_env(TELEGRAM_ALLOWED_CHAT_IDS=entry))

    assert "TELEGRAM_ALLOWED_CHAT_IDS" in message, why


@pytest.mark.parametrize("zero", ["0", "-0", "000"])
def test_zero_is_not_a_valid_chat_id(zero: str) -> None:
    """RED if `0` is allowed into the allowlist.

    No Telegram chat has id 0, so 0 in the allowlist is always an operator error. Refusing
    it at boot also makes `is_allowed_chat(0)` unconditionally False, which closes the
    whole class of upstream bug where a missing `chat.id` defaults to a zero-valued int.
    Every spelling that reaches 0 must be refused, not just the literal `"0"`.
    """
    message = _raise_message(_env(TELEGRAM_ALLOWED_CHAT_IDS=f"{SUPERGROUP},{zero}"))

    assert "TELEGRAM_ALLOWED_CHAT_IDS" in message


def test_large_id_beyond_telegram_range_is_accepted() -> None:
    """RED if a magnitude bound is added.

    Deliberate non-guard, recorded so it is a decision and not an oversight: an
    out-of-range integer can never equal a real `chat.id`, so it authorizes nothing. A
    bound would be speculative machinery guarding a hole that does not exist.
    """
    config = load_telegram_config(_env(TELEGRAM_ALLOWED_CHAT_IDS="999999999999999999999"))

    assert config.allowed_chat_ids == frozenset({999999999999999999999})


# --------------------------------------------------------------------------------------
# UUID
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "spelling",
    [
        "6BA7B810-9DAD-11D1-80B4-00C04FD430C8",
        "{6BA7B810-9DAD-11D1-80B4-00C04FD430C8}",
        "6BA7B8109DAD11D180B400C04FD430C8",
        "urn:uuid:6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    ],
)
def test_uuid_is_canonicalized(spelling: str) -> None:
    """RED if the raw string is stored instead of `str(uuid.UUID(value))`.

    Every accepted spelling must reach the DB in one form. Postgres `uuid` would coerce
    these itself, but the value is also compared and logged Python-side, where
    `"{6BA7...}" != "6ba7..."` and the mismatch is invisible.
    """
    config = load_telegram_config(_env(ASTRAIL_INGEST_USER_ID=spelling))

    assert config.ingest_user_id == UUID_CANONICAL


def test_padded_uuid_is_accepted() -> None:
    """RED if the value is handed to `uuid.UUID` unstripped.

    Verified: `uuid.UUID` tolerates braces and a `urn:` prefix but NOT surrounding
    whitespace — so the dashboard paste this loader is written to survive is precisely the
    spelling `uuid.UUID` refuses.
    """
    config = load_telegram_config(_env(ASTRAIL_INGEST_USER_ID=f"  {UUID_CANONICAL}  "))

    assert config.ingest_user_id == UUID_CANONICAL


def test_invalid_uuid_raises_and_names_the_variable() -> None:
    """RED if the UUID parse is skipped or its failure swallowed.

    An unparseable id reaches the DB as a foreign key that matches no user; every insert
    the worker attempts fails at 3am instead of at boot.
    """
    message = _raise_message(_env(ASTRAIL_INGEST_USER_ID="12345"))

    assert "ASTRAIL_INGEST_USER_ID" in message


# --------------------------------------------------------------------------------------
# is_allowed_chat — the membership test the whole bot gates on
# --------------------------------------------------------------------------------------


def test_is_allowed_chat_admits_only_named_chats() -> None:
    """RED if the test inverts, or if it is ever relaxed to `not self.allowed_chat_ids or ...`."""
    config = load_telegram_config(_env(TELEGRAM_ALLOWED_CHAT_IDS=f"{SUPERGROUP},456"))

    assert config.is_allowed_chat(SUPERGROUP) is True
    assert config.is_allowed_chat(456) is True
    assert config.is_allowed_chat(-999) is False
    assert config.is_allowed_chat(0) is False


def test_is_allowed_chat_fails_closed_on_a_type_mismatch() -> None:
    """RED if the gate ever coerces its argument (`int(chat_id) in ...`).

    Telegram sends `chat.id` as a JSON number, but if a caller ever hands over the string
    form the gate must deny rather than admit. Denying is loud — nothing ingests, someone
    notices — while a coercing gate would quietly widen what counts as a member.
    """
    config = load_telegram_config(_env(TELEGRAM_ALLOWED_CHAT_IDS=str(SUPERGROUP)))

    assert config.is_allowed_chat(str(SUPERGROUP)) is False  # type: ignore[arg-type]


# --------------------------------------------------------------------------------------
# Immutability
# --------------------------------------------------------------------------------------


def test_config_is_frozen() -> None:
    """RED if `frozen=True` is dropped.

    The allowlist is read on every message for the life of the process; a config that can
    be reassigned is an authorization decision that can be edited at runtime.
    """
    config = load_telegram_config(_VALID)

    with pytest.raises(dataclasses.FrozenInstanceError):
        config.bot_token = "other"  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        config.allowed_chat_ids = frozenset({1})  # type: ignore[misc]


def test_allowlist_is_a_frozenset_not_a_set() -> None:
    """RED if the field is built as a plain `set`.

    A frozen dataclass freezes rebinding, not the objects it holds — a mutable `set` here
    would let any caller `.add()` a chat id into the live allowlist.
    """
    config = load_telegram_config(_VALID)

    assert isinstance(config.allowed_chat_ids, frozenset)
    assert not hasattr(config.allowed_chat_ids, "add")


def test_a_config_authorizing_nothing_cannot_be_constructed() -> None:
    """RED if `__post_init__` is dropped.

    Found by asking which described behaviour has no code rather than which guard could be
    deleted: `is_allowed_chat` relaxed to `not self.allowed_chat_ids or chat_id in ...` —
    an allow-all — was invisible to every other test in this file, because the only object
    that would expose it was one the loader happens never to build. Refusing to build it at
    all makes that branch provably dead instead of merely unreached.
    """
    with pytest.raises(ValueError):
        TelegramConfig(
            bot_token="t",
            allowed_chat_ids=frozenset(),
            ingest_user_id=UUID_CANONICAL,
        )


def test_constructing_directly_still_yields_the_documented_defaults() -> None:
    """RED if the two defaults drift from the values T5 and T6 are written against."""
    config = TelegramConfig(
        bot_token="t",
        allowed_chat_ids=frozenset({1}),
        ingest_user_id=UUID_CANONICAL,
    )

    assert (config.poll_timeout_s, config.queue_maxsize) == (50, 100)

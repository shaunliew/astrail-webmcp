"""Logging canaries for the live smoke tool.

`scripts/live_run.py` is the one thing in this repo a human runs BY HAND with every live
credential in the environment at once — Apify, OpenAI, and `MAPBOX_SECRET_TOKEN`. What its
`_configure_logging` chooses to print therefore decides whether a real secret token lands in
the operator's terminal, scrollback, and whatever they paste into a PR.

`httpx` is the live door: it logs `HTTP Request: GET <url> "HTTP/1.1 200 OK"` at INFO, and the
Mapbox token rides IN that URL as `access_token=sk...` (`geocode/mapbox_forward.py`'s TOKEN
SAFETY note — the Search Box API has no header auth, so the token MUST be a query param). Every
sanitized error message in `geocode/` and every `type(exc).__name__` in `pipeline/persist.py`
is undone by one root logger at INFO.

That is the same failure `telegram_ingest/worker.py` documents at `_NOISY_TRANSPORT_LOGGERS`,
where the credential in the URL is the bot token instead. These tests are the canary the fix
needs so the pin is a guard rather than a thing that happened to be right once. Import stays
keyless like the module it covers.
"""
from __future__ import annotations

import logging

import pytest

from scripts import live_run

CANARY = "CANARY-SECRET"


def _formatted(caplog: pytest.LogCaptureFixture) -> str:
    """Every record as `logging` would emit it, INCLUDING any attached traceback — a leak
    through `logger.exception` prints the whole `__context__` chain, which `getMessage()`
    alone would not see."""
    formatter = logging.Formatter("%(levelname)s %(message)s")
    return "\n".join(formatter.format(record) for record in caplog.records)


@pytest.fixture
def pristine_logging():
    """Let `_configure_logging` run FOR REAL, then put the process back exactly as it was.

    `basicConfig` mutates the ROOT logger, where pytest's own capture lives, and the pins
    mutate module-global logger objects shared by the whole session — leaving either changed
    would silently re-level every test that runs afterwards. Handlers are cleared first so
    `basicConfig` is not the documented no-op it becomes when root already has one.
    """
    root = logging.getLogger()
    saved_level, saved_handlers = root.level, root.handlers[:]
    saved = {name: logging.getLogger(name).level
             for name in (*live_run._NOISY_TRANSPORT_LOGGERS, *live_run._VERBOSE_LOGGERS)}
    root.handlers.clear()
    try:
        yield root
    finally:
        root.handlers[:] = saved_handlers
        root.setLevel(saved_level)
        for name, level in saved.items():
            logging.getLogger(name).setLevel(level)


def test_configure_logging_raises_only_the_counters_logger(pristine_logging):
    """Root stays DOWN at WARNING and exactly one logger is lifted to INFO.

    The tool needs `pipeline.persist`'s single `trip_place_grounding` line — the only signal
    separating "every coordinate legitimately disagreed" from "the Mapbox credential is dead".
    Lifting ROOT to get it hands INFO to every third-party library in the process at the same
    time, which is how the credential leak below happens; lifting the one logger that emits it
    does not. Both halves are asserted here because either alone is trivially satisfiable —
    delete all logging and the leak test passes; restore `basicConfig(level=INFO)` and the
    counters appear.
    """
    live_run._configure_logging(quiet=False)

    assert pristine_logging.level == logging.WARNING
    assert pristine_logging.handlers                          # something is actually printing
    assert logging.getLogger("pipeline.persist").isEnabledFor(logging.INFO)
    # A library nobody pinned: it inherits root, and root is the thing being held down.
    assert not logging.getLogger("openai").isEnabledFor(logging.INFO)

    # `--quiet` is documented as "hides the grounding counters", and that is now the ONLY
    # difference between the two modes.
    live_run._configure_logging(quiet=True)

    assert not logging.getLogger("pipeline.persist").isEnabledFor(logging.INFO)


def test_configure_logging_keeps_the_mapbox_token_out_of_httpx_request_lines(pristine_logging,
                                                                             caplog):
    """The absence pass, and the reason this file exists.

    Two assertions, deliberately: the OWN level of each transport logger (the pin exists —
    inheriting WARNING from root passes an effective-level check while a later
    `basicConfig(level=INFO)` silently re-opens the door), and the behaviour under a root
    logger that has been raised to INFO by something else, which is exactly what `caplog`
    does here and exactly what the pin is defence against.
    """
    live_run._configure_logging(quiet=False)

    for name in live_run._NOISY_TRANSPORT_LOGGERS:
        assert logging.getLogger(name).level == logging.WARNING, name
        assert not logging.getLogger(name).isEnabledFor(logging.INFO), name

    leaky = (f'HTTP Request: GET https://api.mapbox.com/search/geocode/v6/reverse'
             f'?longitude=139.7&latitude=35.6&access_token={CANARY} "HTTP/1.1 200 OK"')
    with caplog.at_level(logging.INFO):          # root at INFO — the pin is the only guard left
        logging.getLogger("httpx").info(leaky)

    assert CANARY not in _formatted(caplog), _formatted(caplog)

    # Reachability, inline and deliberately not a separate test: the SAME line at the SAME
    # level on an UNPINNED logger does land. Without this the assertion above would also pass
    # against a caplog that captured nothing at all.
    with caplog.at_level(logging.INFO):
        logging.getLogger("scripts.test_live_run_unpinned").info(leaky)

    assert CANARY in _formatted(caplog)

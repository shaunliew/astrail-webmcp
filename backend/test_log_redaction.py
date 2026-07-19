"""ISSUES-B1 regression: the stream `?token=<JWT>` must never reach a log sink.

Two layers, and the SECOND is the load-bearing one:

1. `test_token_query_param_*` exercise the filter object directly. They prove the regex
   redacts and preserves the access-log shape — but they stay GREEN even if nothing ever
   installs the filter, so on their own they guard nothing in production.
2. `test_installed_filter_redacts_through_the_real_uvicorn_access_logger` emits through the
   ACTUAL `uvicorn.access` logger after importing `main`. Deleting `_install_log_redaction()`
   from `main.py` must turn this one RED — that asymmetry is why both exist.

`test_unhandled_error_handler_logs_path_without_query` pins the OTHER half of the contract:
`api/errors.py` logs `request.url.path`, which excludes the query string, so it never needs
redacting in the first place. Switching it to `request.url` would reopen B1 by another route.
"""
import logging

import pytest

from log_redaction import TokenRedactionFilter

# JWT-shaped so a substring assertion cannot pass by accident on a short token.
SENTINEL = "eyJhbGciOiJFUzI1NiJ9.SENTINEL_B1_PROBE_9f3a2b7c.sIgNaTuRe"


def _access_record(path: str) -> logging.LogRecord:
    """A record shaped exactly like uvicorn's access log: the URL lives in `args`, not `msg`."""
    return logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 0,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:1", "GET", path, "1.1", 200), None,
    )


def test_token_query_param_is_redacted_from_access_log():
    record = _access_record("/generate-trip/stream/t1?token=" + SENTINEL + "&cursor=3")

    assert TokenRedactionFilter().filter(record) is True   # the line is kept, not dropped
    rendered = record.getMessage()
    assert SENTINEL not in rendered
    assert "token=REDACTED" in rendered
    assert "cursor=3" in rendered                          # only the credential is touched


def test_redaction_preserves_the_whole_access_log_line_shape():
    """Access logs stay useful for debugging: method, path, protocol and status all survive.
    A filter that swallowed the line (returned False) or mangled the format would 'fix' B1 by
    destroying the sink instead of sanitising it."""
    record = _access_record("/saved-reels/organize/j1/stream?token=" + SENTINEL + "&cursor=3")

    TokenRedactionFilter().filter(record)

    assert record.getMessage() == (
        '1.2.3.4:1 - "GET /saved-reels/organize/j1/stream?token=REDACTED&cursor=3 HTTP/1.1" 200'
    )


def test_token_in_the_message_itself_is_redacted():
    """Defence in depth: an f-string log line (token in `msg`, empty `args`) is redacted too."""
    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 0,
        f"connection open /stream?token={SENTINEL}", (), None,
    )

    TokenRedactionFilter().filter(record)

    assert SENTINEL not in record.getMessage()
    assert "token=REDACTED" in record.getMessage()


def test_records_without_a_token_are_untouched():
    record = _access_record("/health")

    TokenRedactionFilter().filter(record)

    assert record.getMessage() == '1.2.3.4:1 - "GET /health HTTP/1.1" 200'


@pytest.mark.parametrize(
    ("msg", "args", "expected"),
    [
        ("no args at all", None, "no args at all"),
        # A lone mapping arg: `logging` unwraps it, so record.args is a dict, NOT a tuple.
        ("mapping %(trip)s", ({"trip": "t1"},), "mapping t1"),
        ("mixed %s %d", ("plain", 7), "mixed plain 7"),
    ],
)
def test_filter_tolerates_non_string_and_non_tuple_args(msg, args, expected):
    """uvicorn is not the only producer on this logger, and a filter that raised would take
    down the log call it was meant to sanitise. Anything unusual renders unharmed."""
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 0, msg, args, None)

    assert TokenRedactionFilter().filter(record) is True
    assert record.getMessage() == expected


def test_installed_filter_redacts_through_the_real_uvicorn_access_logger(caplog):
    """Guards the WIRING, not the regex. Importing `main` must install the filter on the real
    `uvicorn.access` logger; deleting `_install_log_redaction()` from main.py turns this RED
    while every test above stays green — which is the entire reason it exists."""
    import main  # noqa: F401  — importing main runs install()

    logger = logging.getLogger("uvicorn.access")
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        logger.handle(_access_record("/generate-trip/stream/t1?token=" + SENTINEL))

    assert SENTINEL not in caplog.text
    assert "token=" not in caplog.text.replace("token=REDACTED", "")
    assert "token=REDACTED" in caplog.text


def test_install_is_scoped_to_the_uvicorn_access_logger(caplog):
    """Scoped blast radius: `install()` attaches to `uvicorn.access` and nothing else. A filter
    on root — or on a root HANDLER — would rewrite arbitrary application log lines, corrupting
    any payload that merely looks like a query param.

    The behavioural half below cannot carry this alone: a filter added to the ROOT LOGGER would
    still leave this assertion green, because `callHandlers` invokes ancestor loggers' handlers
    but never their filters. So assert the placement structurally too — that half is what
    actually fails if `install()` is repointed at root.
    """
    import main  # noqa: F401

    def _has_redactor(filters) -> bool:
        return any(isinstance(f, TokenRedactionFilter) for f in filters)

    root = logging.getLogger()
    assert _has_redactor(logging.getLogger("uvicorn.access").filters)
    assert not _has_redactor(root.filters)
    assert not any(_has_redactor(h.filters) for h in root.handlers)

    logger = logging.getLogger("astrail.unrelated.test")
    with caplog.at_level(logging.INFO, logger="astrail.unrelated.test"):
        logger.info("payload token=%s", "not-a-credential-just-text")

    assert "token=not-a-credential-just-text" in caplog.text


async def test_unhandled_error_handler_logs_path_without_query(caplog):
    """`api/errors.py` logs `request.url.path`, NOT `request.url` — the query string (and so
    the stream JWT) never enters that line. This is a non-leak today; keep it that way."""
    from fastapi import Request

    from api.errors import unhandled_exception_handler

    request = Request({
        "type": "http",
        "method": "GET",
        "path": "/generate-trip/stream/t1",
        "query_string": f"token={SENTINEL}".encode(),
        "headers": [],
        "scheme": "http",
        "server": ("testserver", 80),
    })

    with caplog.at_level(logging.ERROR, logger="api.errors"):
        try:
            raise RuntimeError("boom")
        except RuntimeError as exc:
            response = await unhandled_exception_handler(request, exc)

    assert response.status_code == 500
    assert SENTINEL not in caplog.text
    assert "token=" not in caplog.text
    assert "/generate-trip/stream/t1" in caplog.text   # the path itself is still logged

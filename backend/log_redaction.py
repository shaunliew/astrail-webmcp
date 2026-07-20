"""Redact bearer credentials from uvicorn access logs (ISSUES-B1, Branch A).

Browser `EventSource` cannot set an Authorization header, so the stream routes accept
`?token=<JWT>`. Uvicorn's access logger records the full request line, which put a live
Supabase JWT into every Render log entry for a stream request.

Scope of the fix — measured, not assumed. A sentinel probe against the live service
(`srv-d976aess728c738pskk0`, 2026-07-19) found the token in `--type app` (the in-container
uvicorn access log) and found that **no `--type request` platform logs exist at all** on this
plan. So this filter closes every observable sink; one-time stream tokens (Branch B) stay
deferred behind "public beta / external log access / a plan change that surfaces request
logs". Re-run the probe after any Render plan or tier change.

Two properties this depends on:

- A filter attached to a LOGGER runs in `Logger.handle`, before any handler sees the record,
  so it covers whatever uvicorn writes access lines to (stdout here) without the app having
  to own the handler or a `--log-config`.
- `logging.config.dictConfig` — which uvicorn runs to install its default log config — clears
  a configured logger's *handlers* but not its *filters*, so this survives regardless of
  whether uvicorn configures logging before or after it imports the app. (It configures first.)

`install()` is called once, from `main` at import, so the filter is attached exactly once per
process; it is deliberately not re-entrant-guarded, because there is no second caller.
"""
from __future__ import annotations

import logging
import re

# Matches any `*token=` param (access_token, token, …) up to the next separator. Deliberately
# a superset: over-redacting a credential-shaped param is safe, missing one is the bug.
_TOKEN_RE = re.compile(r"(token=)[^&\s\"]+")


class TokenRedactionFilter(logging.Filter):
    """Rewrite `token=<value>` to `token=REDACTED` in a record, keeping the line itself.

    Always returns True: access logs stay emitted and keep their shape (method, path,
    protocol, status). Suppressing the record would trade a credential leak for the loss of
    the debugging sink — the value is redacted, the line is not.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        # uvicorn.access passes the URL through `args`, so that is the load-bearing branch;
        # `msg` is covered too for any f-string log line on the same logger. Non-str args
        # (status codes) and non-tuple `args` (a lone dict) pass through untouched — a filter
        # that raised would take down the log call it was meant to sanitise.
        if isinstance(record.args, tuple):
            record.args = tuple(
                _TOKEN_RE.sub(r"\1REDACTED", a) if isinstance(a, str) else a
                for a in record.args
            )
        if isinstance(record.msg, str):
            record.msg = _TOKEN_RE.sub(r"\1REDACTED", record.msg)
        return True


def install() -> None:
    """Attach the filter to `uvicorn.access` ONLY — a root-level filter would rewrite
    arbitrary application log lines that merely look like they carry a query param."""
    logging.getLogger("uvicorn.access").addFilter(TokenRedactionFilter())

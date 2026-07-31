"""Unit tests for the reel-covers backfill (Task 6).

All three side-effecting seams are faked — the Apify `scrape`, the Storage `rehost`, and the
Supabase table/query — so the offline suite spends NO Apify credits, touches NO Storage, and needs
NO env/keys (credential-free, guardrail #16).

The load-bearing property is the KEYSET pagination correction: the loop fetches
`where thumbnail_url is null and normalized_url > :cursor order by normalized_url limit N`, advancing
the cursor PAST every processed row (success OR failure) each page. A row that persistently fails
rehost stays NULL but is never re-fetched, so the run terminates. The naive alternative — repeatedly
draining the first `IS NULL` page — would re-fetch a stuck row forever; `_FakeTable` trips a circuit
breaker after `max_fetches` selects so that regression FAILS the test loudly instead of hanging.
"""
from __future__ import annotations

import importlib

import pytest

from pipeline.cache import _cover_key
from scripts.backfill_reel_covers import main, run_backfill

_COVER = "https://scontent.cdninstagram.com/v/t51/cover.jpg"
_REHOSTED = "https://storage.example/reel-covers/x.jpg"


# --- fakes ---------------------------------------------------------------------------------------


class _Resp:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class _FakeQuery:
    """A chainable postgrest-lookalike over one `_FakeTable`. Supports the exact chain the backfill
    uses: select/is_/eq/gt/order/limit/execute and update/eq/execute (+ count/head for the dry-run)."""

    def __init__(self, table):
        self._t = table
        self._filters: list[tuple[str, str, object]] = []
        self._order: str | None = None
        self._limit: int | None = None
        self._count = None
        self._head = False
        self._op = "select"
        self._update: dict | None = None

    def select(self, *_cols, count=None, head=None):
        self._op, self._count, self._head = "select", count, bool(head)
        return self

    def update(self, values):
        self._op, self._update = "update", values
        return self

    def is_(self, col, val):
        self._filters.append(("is", col, val))
        return self

    def eq(self, col, val):
        self._filters.append(("eq", col, val))
        return self

    def gt(self, col, val):
        self._filters.append(("gt", col, val))
        return self

    def order(self, col, **_):
        self._order = col
        return self

    def limit(self, size, **_):
        self._limit = size
        return self

    def _match(self, row) -> bool:
        for kind, col, val in self._filters:
            cur = row.get(col)
            if kind == "is":
                if val in ("null", None):
                    if cur is not None:
                        return False
                elif cur != val:
                    return False
            elif kind == "eq":
                if cur != val:
                    return False
            elif kind == "gt":
                if not (cur is not None and cur > val):
                    return False
        return True

    async def execute(self):
        t = self._t
        if self._op == "update":
            matched = [r for r in t.rows if self._match(r)]
            for row in matched:
                row.update(self._update)
            t.updates.append((dict(self._update), list(self._filters)))
            return _Resp([], count=len(matched))
        matched = [r for r in t.rows if self._match(r)]
        if self._count or self._head:                       # dry-run count: no pagination, no body
            return _Resp([], count=len(matched))
        t.fetches += 1
        if t.fetches > t.max_fetches:
            raise RuntimeError(
                f"select ran {t.fetches} times (> {t.max_fetches}) — the cursor is not advancing "
                "(drain-the-first-NULL-page infinite loop). Keyset pagination must advance past every row."
            )
        if self._order:
            matched.sort(key=lambda r: r.get(self._order) or "")
        if self._limit is not None:
            matched = matched[: self._limit]
        return _Resp([dict(r) for r in matched])            # copies: DB mutations don't rewrite a live batch


class _FakeTable:
    def __init__(self, rows, *, max_fetches=20):
        self.rows = rows
        self.updates: list[tuple[dict, list]] = []
        self.fetches = 0
        self.max_fetches = max_fetches

    def select(self, *cols, count=None, head=None):
        return _FakeQuery(self).select(*cols, count=count, head=head)

    def update(self, values):
        return _FakeQuery(self).update(values)


class _FakeClient:
    def __init__(self, rows, *, max_fetches=20):
        self.reel_cache = _FakeTable(rows, max_fetches=max_fetches)

    def table(self, name):
        assert name == "reel_cache"
        return self.reel_cache


class _FakeReel:
    def __init__(self, display_url, short_code="ZZZ999"):
        self.display_url = display_url
        self.short_code = short_code


class _FakeScrape:
    """Records (url, token) per call; returns a reel with a fixed display_url (or raises)."""

    def __init__(self, display_url=_COVER, *, error: Exception | None = None):
        self.calls: list[tuple[str, str]] = []
        self._display_url = display_url
        self._error = error

    async def __call__(self, url, *, token):
        self.calls.append((url, token))
        if self._error is not None:
            raise self._error
        return _FakeReel(self._display_url)


class _FakeRehost:
    """Records (display_url, cover_key); returns a fixed result (str URL / None)."""

    def __init__(self, result):
        self.result = result
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, client, display_url, cover_key):
        self.calls.append((display_url, cover_key))
        return self.result


def _factory_for(client):
    calls = {"n": 0}

    async def _make():
        calls["n"] += 1
        return client

    _make.calls = calls
    return _make


def _null_row(code: str) -> dict:
    return {
        "normalized_url": f"https://www.instagram.com/reel/{code}",
        "source_platform": "instagram",
        "thumbnail_url": None,
    }


# --- run_backfill: the core loop -----------------------------------------------------------------


async def test_null_row_is_rehosted_and_updated():
    rows = [_null_row("ABC123")]
    client = _FakeClient(rows)
    scrape, rehost = _FakeScrape(), _FakeRehost(_REHOSTED)

    tally = await run_backfill(client, scrape=scrape, rehost=rehost, token="tok")

    assert tally == {"done": 1, "failed": 0, "skipped": 0}
    assert rows[0]["thumbnail_url"] == _REHOSTED
    assert rows[0]["raw_payload"] == {"display_url": _COVER}
    # scraped once with the row's normalized URL + token; rehost got the validated key
    assert scrape.calls == [("https://www.instagram.com/reel/ABC123", "tok")]
    assert rehost.calls == [(_COVER, "ABC123")]


async def test_rehost_none_stays_null_and_counted_failed():
    rows = [_null_row("ABC123")]
    client = _FakeClient(rows)
    scrape, rehost = _FakeScrape(), _FakeRehost(None)          # download/upload failed

    tally = await run_backfill(client, scrape=scrape, rehost=rehost, token="tok")

    assert tally == {"done": 0, "failed": 1, "skipped": 0}
    assert rows[0]["thumbnail_url"] is None                    # stays NULL
    assert client.reel_cache.updates == []                     # no thumbnail update written


async def test_rerun_skips_already_filled_row():
    """Anti-vacuous: the fixture holds BOTH a filled and a NULL row. The filled row must never be
    scraped or updated (it is excluded by the `thumbnail_url IS NULL` filter); only the NULL row is."""
    filled = {
        "normalized_url": "https://www.instagram.com/reel/FILLED0",
        "source_platform": "instagram",
        "thumbnail_url": "https://storage.example/reel-covers/existing.jpg",
    }
    empty = _null_row("EMPTY00")
    client = _FakeClient([filled, empty])
    scrape, rehost = _FakeScrape(), _FakeRehost(_REHOSTED)

    tally = await run_backfill(client, scrape=scrape, rehost=rehost, token="tok")

    assert tally == {"done": 1, "failed": 0, "skipped": 0}
    assert scrape.calls == [("https://www.instagram.com/reel/EMPTY00", "tok")]   # filled NEVER scraped
    assert filled["thumbnail_url"] == "https://storage.example/reel-covers/existing.jpg"   # untouched
    assert empty["thumbnail_url"] == _REHOSTED


async def test_persistent_failure_terminates_without_reprocessing():
    """The load-bearing keyset guard: every row ALWAYS fails rehost, so each stays NULL. The run must
    TERMINATE, processing each row exactly once. A drain-the-first-NULL-page implementation would
    re-fetch the stuck rows forever → `_FakeTable`'s circuit breaker raises → this test fails loudly."""
    rows = [_null_row(code) for code in ("AAA111", "BBB222", "CCC333")]
    client = _FakeClient(rows, max_fetches=6)                  # tight: a non-advancing loop trips fast
    scrape, rehost = _FakeScrape(), _FakeRehost(None)          # persistent failure

    tally = await run_backfill(client, scrape=scrape, rehost=rehost, token="tok", batch_size=2)

    assert tally == {"done": 0, "failed": 3, "skipped": 0}
    scraped_urls = [u for u, _ in scrape.calls]
    assert sorted(scraped_urls) == [r["normalized_url"] for r in rows]   # each row scraped EXACTLY once
    assert len(scraped_urls) == len(set(scraped_urls))


async def test_keyset_paginates_across_pages():
    """Keyset advances past every processed row across multiple pages (offset pagination would skip
    rows as updated rows fall out of the NULL set). All 5 rows processed once; the loop terminates."""
    rows = [_null_row(code) for code in ("AAA", "BBB", "CCC", "DDD", "EEE")]
    client = _FakeClient(rows, max_fetches=10)
    scrape, rehost = _FakeScrape(), _FakeRehost(_REHOSTED)

    tally = await run_backfill(client, scrape=scrape, rehost=rehost, token="tok", batch_size=2)

    assert tally == {"done": 5, "failed": 0, "skipped": 0}
    assert sorted(u for u, _ in scrape.calls) == sorted(r["normalized_url"] for r in rows)
    assert all(r["thumbnail_url"] == _REHOSTED for r in rows)


async def test_cover_key_is_validated_normalized_url_not_reel_short_code():
    """The Storage key comes from `_cover_key(normalized_url)`, never the scraped reel's short_code
    (an attacker-influenced field that could carry `../` path traversal or be None → collisions)."""
    rows = [_null_row("ABC123")]
    client = _FakeClient(rows)
    scrape = _FakeScrape()
    scrape._display_url = _COVER
    rehost = _FakeRehost(_REHOSTED)

    # make the scraped reel carry a hostile short_code — it must be ignored for the key
    async def _hostile(url, *, token):
        scrape.calls.append((url, token))
        return _FakeReel(_COVER, short_code="../evil")

    await run_backfill(client, scrape=_hostile, rehost=rehost, token="tok")

    cover_key = rehost.calls[0][1]
    assert cover_key == _cover_key("https://www.instagram.com/reel/ABC123") == "ABC123"
    assert ".." not in cover_key and "/" not in cover_key


async def test_scrape_without_cover_is_skipped():
    """A reel that scrapes but exposes no displayUrl has no cover to re-host → skipped (not failed);
    rehost is never called and nothing is written."""
    rows = [_null_row("ABC123")]
    client = _FakeClient(rows)
    scrape, rehost = _FakeScrape(display_url=None), _FakeRehost(_REHOSTED)

    tally = await run_backfill(client, scrape=scrape, rehost=rehost, token="tok")

    assert tally == {"done": 0, "failed": 0, "skipped": 1}
    assert rehost.calls == []
    assert client.reel_cache.updates == []
    assert rows[0]["thumbnail_url"] is None


async def test_scrape_error_is_counted_failed_and_isolated():
    """One row raising in scrape never aborts the run — it is counted failed and the loop continues."""
    rows = [_null_row("AAA111"), _null_row("BBB222")]
    client = _FakeClient(rows)
    rehost = _FakeRehost(_REHOSTED)

    calls: list[str] = []

    async def _scrape(url, *, token):
        calls.append(url)
        if url.endswith("AAA111"):
            raise RuntimeError("boom")
        return _FakeReel(_COVER)

    tally = await run_backfill(client, scrape=_scrape, rehost=rehost, token="tok")

    assert tally == {"done": 1, "failed": 1, "skipped": 0}
    assert rows[1]["thumbnail_url"] == _REHOSTED                # the good row still processed


# --- main: the CLI gate --------------------------------------------------------------------------


async def test_without_confirm_refuses_and_touches_nothing():
    """Mirrors the drop-script gate: without --confirm the script refuses (non-zero), builds no client,
    and calls no scrape/rehost — it SPENDS APIFY CREDITS, so it must never run unattended."""
    client = _FakeClient([_null_row("ABC123")])
    factory = _factory_for(client)
    scrape, rehost = _FakeScrape(), _FakeRehost(_REHOSTED)

    rc = await main([], client_factory=factory, scrape=scrape, rehost=rehost, token="tok")

    assert rc != 0
    assert factory.calls["n"] == 0                              # no client even built
    assert scrape.calls == [] and rehost.calls == []
    assert client.reel_cache.fetches == 0 and client.reel_cache.updates == []


async def test_dry_run_counts_null_rows_without_scraping(capsys):
    """--dry-run reports the NULL-row count and spends nothing: no scrape, no rehost, no writes."""
    client = _FakeClient([_null_row("AAA"), _null_row("BBB"), _null_row("CCC")])
    factory = _factory_for(client)
    scrape, rehost = _FakeScrape(), _FakeRehost(_REHOSTED)

    rc = await main(["--dry-run"], client_factory=factory, scrape=scrape, rehost=rehost, token="tok")

    assert rc == 0
    assert factory.calls["n"] == 1                              # a client is built (read-only count)
    assert scrape.calls == [] and rehost.calls == []           # but nothing is scraped/re-hosted
    assert client.reel_cache.updates == []
    assert "3" in capsys.readouterr().err                       # the count is reported


async def test_confirm_runs_the_backfill():
    """With --confirm the injected seams run end-to-end: the NULL row is scraped, re-hosted, updated."""
    client = _FakeClient([_null_row("ABC123")])
    factory = _factory_for(client)
    scrape, rehost = _FakeScrape(), _FakeRehost(_REHOSTED)

    rc = await main(["--confirm"], client_factory=factory, scrape=scrape, rehost=rehost, token="tok")

    assert rc == 0
    assert factory.calls["n"] == 1
    assert scrape.calls == [("https://www.instagram.com/reel/ABC123", "tok")]
    assert client.reel_cache.rows[0]["thumbnail_url"] == _REHOSTED


def test_import_needs_no_keys(monkeypatch):
    for var in ("APIFY_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    import scripts.backfill_reel_covers as m

    importlib.reload(m)
    assert m.TABLE == "reel_cache"

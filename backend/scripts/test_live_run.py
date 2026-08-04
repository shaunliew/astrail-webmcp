"""Logging canaries — and the #42 geometry acceptance — for the live smoke tool.

Two unrelated properties of the same script live here. The first half is about what the tool
must NOT print (a credential); the second half is about what it must BE ABLE to print (per-leg
`route_geometry`), because a smoke that cannot see the thing under test reports the same output
whether the feature landed or was a no-op.

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

The #42 half drives the REAL `_inspect` against a projection-honouring in-memory fake with
captured stdout. Projection fidelity is the whole point: a whole-row fake would let `_inspect`
omit `route_geometry` from its `.select(...)` and still read it here, so the read would pass
every test while the real PostgREST client left the key out and the smoke printed `no-geom`
for a perfectly routed trip.
"""
from __future__ import annotations

import asyncio
import logging
import re

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


# --- #42 per-leg route geometry ------------------------------------------------------------

_TRIP_ID = "trip-1"
_ACCEPT_PREFIX = "    → geometry acceptance "
# Any point count at all. The malformed-geometry test asserts NO count appears — naming one
# specific number there would stay green against an implementation that printed a different
# (equally wrong, equally confident) one.
_ANY_PTS = re.compile(r"▸\d+pts")


class _Result:
    def __init__(self, data): self.data = data


class _Table:
    """A postgrest-lookalike over one in-memory table that HONOURS the `.select(...)` projection.

    Only the chain `_inspect` actually uses is implemented: select / eq / in_ / maybe_single /
    execute. Anything else should fail loudly rather than be silently ignored.
    """

    def __init__(self, name, db):
        self.name, self.db = name, db
        self._columns = None
        self._f = {}
        self._in = {}
        self._single = False

    def select(self, *columns):
        cols = [c.strip() for spec in columns for c in str(spec).split(",") if c.strip()]
        self._columns = None if (not cols or "*" in cols) else cols
        return self

    def eq(self, c, v):
        # `eq.None` is not a PostgREST NULL predicate — it matches nothing. Raising turns that
        # mistake into an immediate red instead of a silent production no-op.
        if v is None:
            raise ValueError(f"eq({c!r}, None) is not a PostgREST filter")
        self._f[c] = v
        return self

    def in_(self, c, values):
        self._in[c] = list(values)
        return self

    def maybe_single(self):
        self._single = True
        return self

    def _project(self, r):
        """The selected columns ONLY. A selected key the stored row lacks comes back as `None`,
        which is how PostgREST reports a column that exists on the table and is NULL here; an
        UNselected key is absent entirely, which is what makes dropping a column from
        `_inspect`'s `.select(...)` observable."""
        if self._columns is None:
            return dict(r)
        return {c: r.get(c) for c in self._columns}

    def _match(self, r):
        return (all(r.get(k) == v for k, v in self._f.items())
                and all(r.get(k) in vs for k, vs in self._in.items()))

    async def execute(self):
        # SUSPEND once, like every real client call, so this fake is not `async` in name only.
        await asyncio.sleep(0)
        rows = [self._project(r) for r in self.db.get(self.name, []) if self._match(r)]
        if self._single:
            if len(rows) > 1:
                raise ValueError(f"maybe_single matched {len(rows)} rows on {self.name!r}")
            # ZERO rows is a BARE `None`, not a result whose `.data` is None — the shape
            # `_inspect`'s `trip_result is not None` guard exists for.
            return _Result(rows[0]) if rows else None
        return _Result(rows)


class _Client:
    def __init__(self, db): self.db = db
    def table(self, name): return _Table(name, self.db)


def _line(*points) -> dict:
    """A fresh drawable LineString. A FUNCTION, not a module constant: the fake projects rows by
    reference (shallow copies all the way down), so one shared literal handed to two tests could
    be corrupted for every other test in this file."""
    return {"type": "LineString", "coordinates": [list(p) for p in points]}


def _leg(order: int, status: str, geometry, *, frm: str = "p1", to: str = "p2") -> dict:
    return {"from_place_id": frm, "to_place_id": to, "leg_order": order,
            "transport_mode": "walk", "status": status, "duration_seconds": 600,
            "distance_meters": 800, "warning": None, "route_geometry": geometry}


def _seed(legs: list[dict]) -> dict:
    """The smallest DB `_inspect` can walk end-to-end, plus the given transport legs.

    Every place carries a verified `country` on purpose: a NULL one sends `_inspect` into the
    exact-coordinate repair branch, which queries `geocode_country_cache` and has nothing to do
    with what these tests measure.
    """
    places = [
        {"id": f"p{i}", "name": name, "place_type": "attraction",
         "lat": 35.6 + i / 10, "lng": 139.7, "country": "Japan",
         "country_code": "JP", "country_name": "Japan",
         "created_at": "2026-08-03T00:00:00Z", "updated_at": "2026-08-03T00:00:00Z"}
        for i, name in enumerate(("Senso-ji", "teamLab", "Shibuya Sky"), start=1)
    ]
    return {
        "trips": [{"id": _TRIP_ID, "status": "complete", "destination_hint": "Japan",
                   "start_date": "2026-08-08", "end_date": "2026-08-10", "title": "Tokyo",
                   "summary": "s", "preference_summary": None, "preference_sources": None,
                   "created_at": "2026-08-03T00:00:00Z"}],
        "trip_places": [{"trip_id": _TRIP_ID, "place_id": p["id"], "day_number": 1,
                         "sort_order": i, "source_type": "reel"}
                        for i, p in enumerate(places)],
        "trip_days": [{"trip_id": _TRIP_ID, "day_number": 1, "day_date": "2026-08-08",
                       "weather_source": "open-meteo", "weather_summary": "clear",
                       "title": "Day 1"}],
        "places": places,
        "generation_events": [],
        "memory_events": [],
        "transport_legs": [{"trip_id": _TRIP_ID, **lg} for lg in legs],
        "restaurant_suggestions": [],
        "hotel_suggestions": [],
    }


class _Spy:
    """A predicate stand-in that CONTROLS the outcome instead of merely observing the argument.

    `is_drawable_linestring`'s own docstring spells out why: asserting "it was called with X" is
    satisfied by an implementation that calls it, discards the result, and decides with a weaker
    local check. Forcing the return value and asserting the production outcome flipped is the
    only version of this test that can fail.
    """

    def __init__(self, result: bool):
        self.result, self.seen = result, []

    def __call__(self, obj):
        self.seen.append(obj)
        return self.result


def test_geometry_acceptance_passes_on_healthy_trip():
    """DECLARED POSITIVE CONTROL — deliberately NOT attributable to any single guard.

    All three conjuncts hold here, so this test cannot say which one produced the `True`. Its
    job is to stop the four negative tests below from passing vacuously against a helper that
    returns `False` unconditionally.
    """
    legs = [_leg(0, "ok", _line((139.7, 35.6), (139.75, 35.65), (139.8, 35.7))),
            _leg(1, "ok", _line((139.8, 35.7), (139.85, 35.75)))]

    passed, line = live_run._geometry_acceptance(legs)

    assert passed is True
    assert line == (f"{_ACCEPT_PREFIX}PASS: 2/2 ok-legs drawable; 0 non-ok leaked; "
                    "routed legs present")


def test_geometry_acceptance_calls_the_shared_predicate(monkeypatch):
    """The ACCEPTANCE HELPER's own call site, proven by CONTROL rather than observation.

    The malformed-Polygon test below proves only that *some* validator rejects a Polygon — a
    weaker local `type == "LineString"` check would pass it too. And the point-count spy test
    deliberately patches `_geometry_acceptance` away, so it cannot vouch for this call site
    either. Hence: an otherwise genuinely DRAWABLE geometry, a spy forced to `False`, and the
    verdict flipping to FAIL.
    """
    geometry = _line((139.7, 35.6), (139.8, 35.7))
    spy = _Spy(result=False)
    monkeypatch.setattr(live_run, "is_drawable_linestring", spy)

    passed, line = live_run._geometry_acceptance([_leg(0, "ok", geometry)])

    assert spy.seen == [geometry]
    assert passed is False
    assert line == (f"{_ACCEPT_PREFIX}FAIL: 0/1 ok-legs drawable; 0 non-ok leaked; "
                    "routed legs present")


def test_geometry_acceptance_fails_when_no_routed_leg():
    """`bool(ok)` — a trip where nothing routed at all. A bare `with_geom/total` ratio would
    report `0/0` and call that success."""
    legs = [_leg(0, "no_route", None), _leg(1, "failed", None)]

    passed, line = live_run._geometry_acceptance(legs)

    assert passed is False
    assert line == (f"{_ACCEPT_PREFIX}FAIL: 0/0 ok-legs drawable; 0 non-ok leaked; "
                    "NO ROUTED LEG AT ALL")


def test_geometry_acceptance_fails_when_ok_leg_geometry_malformed():
    """The completeness conjunct — an `ok` leg whose geometry is not drawable."""
    polygon = {"type": "Polygon", "coordinates": [[139.7, 35.6], [139.8, 35.7]]}

    passed, line = live_run._geometry_acceptance([_leg(0, "ok", polygon)])

    assert passed is False
    assert line == (f"{_ACCEPT_PREFIX}FAIL: 0/1 ok-legs drawable; 0 non-ok leaked; "
                    "routed legs present")


def test_geometry_acceptance_fails_when_non_ok_leg_carries_empty_dict():
    """`not leaked`, and the fixture is built so that `not leaked` is the ONLY thing failing.

    The healthy `ok` leg is mandatory: without it `bool(ok)` is already `False`, the verdict is
    `False` for a different reason entirely, and deleting the leak check changes nothing. Note
    the check tests `is not None` — literal NULL — so `{}` is a leak even though it is falsy.
    """
    legs = [_leg(0, "ok", _line((139.7, 35.6), (139.8, 35.7))),
            _leg(1, "no_route", {}, frm="p2", to="p3")]

    passed, line = live_run._geometry_acceptance(legs)

    assert passed is False
    assert line == (f"{_ACCEPT_PREFIX}FAIL: 1/1 ok-legs drawable; 1 non-ok leaked; "
                    "routed legs present")


async def test_inspect_prints_geometry_acceptance_pass_and_point_counts(capsys):
    """The real `_inspect`, end to end, on a PARTIAL trip — one routed leg and one `no_route`.

    Partial rather than healthy on purpose: the acceptance rule explicitly permits a `no_route`
    leg with `route_geometry = NULL`, so a healthy-only fixture lets the obvious
    `len(lg["route_geometry"]["coordinates"])` pass here and then `TypeError` on a legitimate
    production trip. The exact PASS string is asserted because a generic "some line appeared"
    check stays green when `route_geometry` is dropped from the projection — the helper then
    prints FAIL, which is still a line.
    """
    db = _seed([_leg(0, "ok", _line((139.7, 35.6), (139.75, 35.65), (139.8, 35.7))),
                _leg(1, "no_route", None, frm="p2", to="p3")])

    await live_run._inspect(_Client(db), _TRIP_ID)

    out = capsys.readouterr().out
    assert f"{_ACCEPT_PREFIX}PASS: 1/1 ok-legs drawable; 0 non-ok leaked; routed legs present" in out
    assert "▸3pts" in out       # the routed leg
    assert "▸no-geom" in out    # the no_route leg, printed rather than crashed on


async def test_inspect_prints_no_geom_for_malformed_ok_leg(capsys):
    """The PRINT's use of the shared predicate, via an input a weaker guard would accept.

    The Polygon carries two perfectly valid coordinates, so an `isinstance(g, dict)` /
    `g["coordinates"]` guard would print a confident `▸2pts` for geometry the acceptance line
    directly beneath it simultaneously calls invalid. Asserting no count of ANY value appears is
    what makes the two lines unable to contradict each other.
    """
    polygon = {"type": "Polygon", "coordinates": [[139.7, 35.6], [139.8, 35.7]]}
    db = _seed([_leg(0, "ok", polygon)])

    await live_run._inspect(_Client(db), _TRIP_ID)

    out = capsys.readouterr().out
    assert f"{_ACCEPT_PREFIX}FAIL: 0/1 ok-legs drawable; 0 non-ok leaked; routed legs present" in out
    assert "▸no-geom" in out
    assert _ANY_PTS.search(out) is None, out


async def test_inspect_point_count_calls_the_shared_predicate(monkeypatch, capsys):
    """The POINT-COUNT call site, isolated from the acceptance one.

    `_inspect` reaches the predicate by TWO paths — directly for the count, and indirectly
    through `_geometry_acceptance` — so a bare "was it invoked?" spy is satisfied by the
    acceptance call alone and stays green even if the count used a weaker local validator.
    `_geometry_acceptance` is therefore replaced FIRST by a stub that does not touch the
    predicate, leaving the count as the only remaining caller. Both directions are exercised:
    a spy that cannot change the output cannot prove the output depends on it.
    """
    geometry = _line((139.7, 35.6), (139.8, 35.7))
    db = _seed([_leg(0, "ok", geometry)])
    monkeypatch.setattr(live_run, "_geometry_acceptance",
                        lambda legs: (True, "    → stubbed, predicate untouched"))

    rejecting = _Spy(result=False)
    monkeypatch.setattr(live_run, "is_drawable_linestring", rejecting)
    await live_run._inspect(_Client(db), _TRIP_ID)
    out = capsys.readouterr().out

    assert rejecting.seen == [geometry]
    assert "▸no-geom" in out
    assert _ANY_PTS.search(out) is None, out

    accepting = _Spy(result=True)
    monkeypatch.setattr(live_run, "is_drawable_linestring", accepting)
    await live_run._inspect(_Client(db), _TRIP_ID)
    out = capsys.readouterr().out

    assert accepting.seen == [geometry]
    assert "▸2pts" in out

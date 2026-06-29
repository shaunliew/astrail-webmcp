"""Two-gate (alias + geo) in-trip dedup — pure, offline."""
from models.place import CanonicalPlace, PlaceResult
from pipeline.dedup import dedupe_places


def _p(name, lat, lng, conf=0.9, *, name_local=None, evidence=None, source_type="reel_extracted"):
    return PlaceResult(name=name, category="restaurant", confidence=conf,
                       evidence_quote=evidence or name, lat=lat, lng=lng,
                       name_local=name_local, source_type=source_type)


def test_merges_same_venue_close_and_alias_overlap():
    # English name in one mention, Japanese name_local bridging the other → alias overlap + ~same coords
    a = _p("Ichiran Shibuya", 35.6611, 139.7011, 0.85, name_local="一蘭 渋谷店", evidence="📍一蘭 渋谷店")
    b = _p("一蘭 渋谷店", 35.6612, 139.7012, 0.95, evidence="Ichiran 渋谷")
    res = dedupe_places([a, b])
    assert len(res.places) == 1
    c = res.places[0]
    assert isinstance(c, CanonicalPlace)
    assert c.times_referenced == 2
    assert c.confidence == 0.95                      # representative = highest confidence
    assert set(c.evidence_quotes) == {"📍一蘭 渋谷店", "Ichiran 渋谷"}
    assert "一蘭 渋谷店" in c.aliases and "Ichiran Shibuya" in c.aliases


def test_does_not_merge_same_chain_different_branches_geo_gate():
    # same chain root, but >500 m apart → geo gate blocks the merge (acceptance: Shibuya vs Shinjuku)
    a = _p("Ichiran", 35.6611, 139.7011)
    b = _p("Ichiran", 35.6938, 139.7035)            # Shinjuku, ~3.6 km away
    res = dedupe_places([a, b])
    assert len(res.places) == 2                     # NOT merged


def test_semantic_only_is_not_enough():
    # identical names but far apart → semantic matches, geo fails → no merge
    res = dedupe_places([_p("Cafe X", 35.0, 139.0), _p("Cafe X", 36.0, 140.0)])
    assert len(res.places) == 2


def test_geo_only_is_not_enough():
    # different venues in the same building (<500 m) → geo matches, semantic fails → no merge
    res = dedupe_places([_p("Ramen A", 35.6600, 139.7000), _p("Sushi B", 35.6601, 139.7001)])
    assert len(res.places) == 2


def test_no_coords_never_merges():
    a = PlaceResult(name="X", category="other", confidence=0.9, evidence_quote="X", lat=None, lng=None)
    b = PlaceResult(name="X", category="other", confidence=0.9, evidence_quote="X", lat=None, lng=None)
    assert len(dedupe_places([a, b]).places) == 2   # geo gate needs coords on both


def test_cap_drops_lowest_confidence_keeps_input_order():
    places = [_p(f"P{i}", 35.0 + i, 139.0 + i, conf=round(0.5 + i * 0.05, 2)) for i in range(10)]
    res = dedupe_places(places, max_places=8)
    assert len(res.places) == 8
    # the two lowest-confidence (P0=0.5, P1=0.55) are dropped; survivors stay in input order
    names = [p.name for p in res.places]
    assert names == ["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]
    assert any("dropped 'P0'" in n for n in res.notes)


def test_cap_never_drops_user_requested():
    places = [_p(f"P{i}", 35.0 + i, 139.0 + i, conf=0.99) for i in range(8)]
    places.append(_p("MyPick", 36.5, 140.5, conf=0.10, source_type="user_requested"))
    res = dedupe_places(places, max_places=8)
    assert "MyPick" in [p.name for p in res.places]   # kept despite lowest conf + over cap


def test_distinct_places_pass_through_unchanged_order():
    places = [_p("A", 35.0, 139.0), _p("B", 35.5, 139.5), _p("C", 36.0, 140.0)]
    res = dedupe_places(places)
    assert [p.name for p in res.places] == ["A", "B", "C"]
    assert all(p.times_referenced == 1 for p in res.places)


def test_user_requested_protected_even_when_merged_with_higher_conf_rep():
    # a low-conf user_requested mention merging with a higher-conf reel rep stays protected
    fillers = [_p(f"P{i}", 35.0 + i, 139.0 + i, conf=0.99) for i in range(8)]
    rep = _p("MyPick", 36.5, 140.5, conf=0.99)                                  # reel rep (higher conf)
    req = _p("MyPick", 36.5001, 140.5001, conf=0.10, source_type="user_requested")  # merges with rep
    res = dedupe_places(fillers + [rep, req], max_places=8)
    kept = {p.name: p for p in res.places}
    assert "MyPick" in kept                                  # survived the cap (8 fillers would fill it)
    assert kept["MyPick"].source_type == "user_requested"    # cluster-level protection


def test_transitive_cluster_merges_via_any_member():
    # A~B (~333 m) and B~C (~333 m) but A~C (~666 m) — all one cluster via B (any-member match)
    a, b, c = _p("Spot", 35.0000, 139.0), _p("Spot", 35.0030, 139.0), _p("Spot", 35.0060, 139.0)
    res = dedupe_places([a, b, c])
    assert len(res.places) == 1 and res.places[0].times_referenced == 3

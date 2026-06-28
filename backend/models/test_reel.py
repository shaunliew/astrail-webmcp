"""ReelData contract — validates the recorded reel fixtures."""
import json
from pathlib import Path

from models.reel import ReelData

EVAL_FIX = Path(__file__).parents[1] / "evals" / "fixtures" / "japan_demo_reels.json"
MINI_FIX = Path(__file__).parents[1] / "pipeline" / "fixtures" / "mini_reels.json"


def test_validates_the_japan_demo_reels_fixture():
    reels = json.loads(EVAL_FIX.read_text(encoding="utf-8"))["reels"]
    models = [ReelData.model_validate(r) for r in reels]
    assert len(models) == 4
    assert models[0].reel_url.startswith("https://www.instagram.com/reel/")
    assert models[0].caption  # non-empty


def test_validates_the_mini_reels_fixture():
    reels = json.loads(MINI_FIX.read_text(encoding="utf-8"))["reels"]
    models = [ReelData.model_validate(r) for r in reels]
    assert [m.short_code for m in models] == ["MINI_AAA", "MINI_BBB"]


def test_defaults_and_extra_ignored():
    rd = ReelData.model_validate({"reel_url": "x", "unexpected_field": 1})
    assert rd.caption == ""
    assert rd.location_name is None
    assert rd.capture_status == "NEEDS_CAPTURE"
    assert not hasattr(rd, "unexpected_field")  # extra="ignore"

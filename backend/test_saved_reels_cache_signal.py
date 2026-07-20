from pathlib import Path
import re

from genagents.place_extractor import EXTRACTOR_VERSION


# The migration that CURRENTLY defines saved_reel_cards — re-point this on every view swap.
# It carries the live copies of the literals these guards protect; pointing at a superseded
# migration pins a definition the database no longer has and goes quietly useless the next
# time EXTRACTOR_VERSION is bumped. See the bump procedure in place_extractor.py.
MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "20260720120000_saved_reels_cache_signal_v2.sql"
)


def test_saved_reel_cards_migration_embeds_current_extractor_version():
    sql = MIGRATION_PATH.read_text(encoding="utf-8")
    match = re.search(r"extractor_version\s*=\s*'([^']+)'", sql)

    assert match is not None
    assert match.group(1) == EXTRACTOR_VERSION


def test_saved_reel_cards_migration_preserves_verified_place_join_literal():
    sql = MIGRATION_PATH.read_text(encoding="utf-8")

    assert """left join public.reel_place_mentions
  on reel_place_mentions.reel_cache_id = saved_reels.reel_cache_id
 and reel_place_mentions.verification_version = 'mapbox-country-v1'
 and reel_place_mentions.user_id = saved_reels.user_id
 and saved_reels.analysis_status = 'organized'""" in sql

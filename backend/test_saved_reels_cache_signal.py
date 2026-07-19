from pathlib import Path
import re

from genagents.place_extractor import EXTRACTOR_VERSION


# The migration that CURRENTLY defines saved_reel_cards. A3 dropped and recreated the view
# to add the owner-scoped mention join, so it carries the live copies of both literals these
# guards protect; pointing at 20260719103000 would pin a superseded definition and go quietly
# useless the next time EXTRACTOR_VERSION is bumped.
MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "20260720100000_reel_place_mentions_user_scope.sql"
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
 and reel_place_mentions.user_id = saved_reels.user_id""" in sql

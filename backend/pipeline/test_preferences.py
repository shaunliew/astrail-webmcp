"""Pure, offline tests for preference merge/render/distill (no mem0, no network)."""
from pipeline.preferences import (distill_memory_text, merge_preferences,
                                  preference_block)


def test_explicit_input_wins():
    ctx = merge_preferences(explicit_text="ramen, walkable days", pace="relaxed",
                            memory_facts=["prefers luxury"])
    assert ctx.source == "explicit"
    # explicit wins wholesale: memory is NOT injected when the user stated preferences
    block = preference_block(ctx)
    assert "ramen, walkable days" in block
    assert "luxury" not in block
    assert "your preferences" in ctx.summary.lower()


def test_blank_input_uses_memory():
    ctx = merge_preferences(explicit_text="", pace="balanced",
                            memory_facts=["likes ramen", "avoids theme parks"])
    assert ctx.source == "memory"
    block = preference_block(ctx)
    assert "likes ramen" in block and "avoids theme parks" in block
    assert "saved travel preferences" in ctx.summary.lower()


def test_blank_input_no_memory_infers_default():
    ctx = merge_preferences(explicit_text="  ", pace="balanced", memory_facts=[])
    assert ctx.source == "inferred_default"
    assert preference_block(ctx) is None   # nothing to inject
    assert "infer" in ctx.summary.lower()


def test_distill_only_writes_on_explicit():
    explicit = merge_preferences(explicit_text="loves ramen", pace="relaxed", memory_facts=[])
    assert distill_memory_text(explicit, synopsis="Planned a 3-day Tokyo trip.") \
        == "Travel preferences: loves ramen. Planned a 3-day Tokyo trip."
    mem = merge_preferences(explicit_text="", pace="balanced", memory_facts=["likes ramen"])
    assert distill_memory_text(mem, synopsis="x") is None   # nothing NEW to learn
    default = merge_preferences(explicit_text="", pace="balanced", memory_facts=[])
    assert distill_memory_text(default, synopsis="x") is None


def test_distill_never_leaks_synopsis_secrets():
    # synopsis is a templated string built by the caller; distill only concatenates —
    # this pins that raw reel text is never introduced here.
    ctx = merge_preferences(explicit_text="quiet trip", pace="relaxed", memory_facts=[])
    out = distill_memory_text(ctx, synopsis="Planned a 2-day Kyoto trip (relaxed pace).")
    assert "reel" not in out.lower() and "caption" not in out.lower()

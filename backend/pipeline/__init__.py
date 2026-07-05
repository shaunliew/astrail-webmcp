"""Astrail generation pipeline.

Step 2 ships the offline, fixture-backed skeleton (output contract + fixture/cache
sources + a runnable harness the issue #16 eval can score). Real LLM stages
(extractor, enricher, narrator) replace the fixture-backed placeholders in later steps.
Fully offline: no live OpenAI / Apify / Mapbox / mem0 / Supabase on the default path.
"""

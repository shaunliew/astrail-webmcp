# Astrail Database Design

This folder contains database design artifacts.

## Mermaid

Open `astrail-v1-erd.mmd` in a Mermaid previewer to review the Astrail V1
database scheme. This is the only diagram source kept in the repo.

Use it for:

- aligning product/backend/frontend on table boundaries
- checking relationship shape before writing migrations
- explaining the difference between user-private data, trip data, and global Reel/place cache data

Do not use it as:

- the canonical Supabase migration
- the source of RLS policy truth
- the source of indexes, triggers, enum constraints, or pgvector setup

Canonical schema changes must live in `supabase/migrations/` as forward-only migrations.

## Layers

1. Private user layer: `traveler_profiles`, `user_preference_facts`, `memory_events`.
2. Trip layer: `trips`, `trip_inspiration_items`, generation output tables.
3. Global knowledge layer: `reel_cache`, `places`, `location_graph_nodes`, `location_graph_edges`.

The global knowledge layer can reuse Reel/place extraction across users. It must not store user-specific traveler preferences.

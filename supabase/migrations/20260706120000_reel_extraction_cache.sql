-- Extraction cache: store the validated PlaceResults per reel + the extractor version that produced
-- them (bump-to-invalidate). Both nullable/additive. reel_cache is already the per-reel,
-- normalized_url-unique, global service-role-write flywheel — the right key/grain. No RLS change.
alter table public.reel_cache add column if not exists extracted_places jsonb;
alter table public.reel_cache add column if not exists extractor_version text;

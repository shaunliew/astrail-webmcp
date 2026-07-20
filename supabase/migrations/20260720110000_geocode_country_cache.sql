-- Write-through coordinate→country cache for Mapbox reverse-geocode verification.
--
-- `reverse_country` has one call site (`_ground_place`) and every call sets
-- `permanent: "true"` — Mapbox's storable-results tier. Without this table a WARM organize
-- cost exactly as much as a cold one (the extraction-cache hit skips Apify+OpenAI but still
-- re-grounds every place), and it was quota-exempt besides: the daily quota charges only on
-- an extraction-cache MISS, so a warm re-organize loop drove permanent geocodes bounded only
-- by BURST_LIMIT, outside the daily limit.
--
-- New table, so deploying this migration ahead of the code is a no-op for the running
-- version — nothing reads or writes it until `_ground_place` ships.
--
-- INVALIDATION IS A VERSION BUMP, NOT A TTL. Rows key on the backend's
-- LOCATION_VERIFICATION_VERSION, the same lever that invalidates reel_place_mentions, so the
-- cache and the evidence it justified can never disagree about which verification contract
-- they were written under. A fixed coordinate's country changes only on a real border change
-- or a provider correction; both are one-off events that warrant a bump (which also
-- re-verifies the mentions). `created_at` exists for the audit query behind that trigger, not
-- for expiry:
--   select count(*) from geocode_country_cache where created_at < now() - interval '1 year';

create table public.geocode_country_cache (
  -- Lossless `repr()`-based coordinate pair; see `_coord_cache_key` in backend/organizer.py.
  -- Deliberately NOT bucketed: a hit must mean Mapbox verified THIS coordinate, not a
  -- neighbour ~11 m away that could sit across a border.
  coord_key text not null,
  verification_version text not null,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  country_name text not null check (btrim(country_name) <> ''),
  created_at timestamptz not null default now(),
  primary key (coord_key, verification_version),
  -- Shape guard, not a parser: it catches a malformed or empty key, never a wrong coordinate.
  constraint geocode_country_cache_coord_key_shape_check
    check (coord_key ~ '^-?[0-9][0-9.eE+-]*,-?[0-9][0-9.eE+-]*$')
);

-- Service-role only, same pattern as reel_place_mentions: the backend is the sole reader and
-- writer, and nothing here belongs to a user.
alter table public.geocode_country_cache enable row level security;
revoke all on public.geocode_country_cache from public, anon, authenticated;
grant all on public.geocode_country_cache to service_role;

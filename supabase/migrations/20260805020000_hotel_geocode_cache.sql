-- Write-through cache for the hotel FORWARD-geocode seam (Travala name/address -> Mapbox coord).
--
-- Named to disambiguate from geocode_country_cache (20260720110000), whose service-role /
-- version-bump patterns this table MIRRORS. That table caches the REVERSE country-verification
-- seam for reel places (already write-through cached); this one caches the hotel FORWARD-geocode
-- seam, the ONE live Mapbox path that is still uncached. Both bill Mapbox's Permanent Geocoding
-- tier ($5/1,000, no free tier, ~$5/mo block minimum) because we STORE the coordinate, so without
-- a cache the hotel bill grows LINEARLY with trips. Observed reuse on remote-dev (35 trips): 149
-- hotel rows -> 23 distinct hotels (85% reuse), so per-hotel-once caching is a large, cheap win.
--
-- New table, so deploying this migration ahead of the code is a no-op for the running version —
-- nothing reads or writes it until the hotel resolver ships (opt-in via an injected client).
--
-- THE KEY IS A STABLE IDENTITY, NOT THE QUERY. The JP Mapbox query is the *translated* hotel name,
-- which does not exist until AFTER the cache read, so it cannot be the key. `cache_key` is therefore
-- computed app-side as STRATEGY_VERSION + SHA-256 of canonical-JSON `{provider,country,hotelId}`
-- (NFKC + casefold) — a stable identity known BEFORE translation. Only a non-null, unique Travala
-- hotelId is cacheable; a missing/duplicate id resolves live and is never stored. The column is plain
-- `text` here; the algorithm lives in the T3 helper.
--
-- STORES THE GEOCODE FACT, NOT THE PER-TRIP GATE DECISION. `status` is 'found' | 'miss' — the raw
-- resolve outcome. The ~60 km proximity gate is TRIP-SPECIFIC (it depends on the trip centroid), so
-- it re-runs per trip in rank_hotels and is NEVER cached: a hotel far from one trip's centroid must
-- not be negative-cached and hidden from a later trip near it.
--
-- coord<->status<->country_code INVARIANT (extends 20260804120000's coord/status CHECK, ADDS
-- country_code): a 'found' row MUST carry lat, lng AND country_code; a 'miss' row MUST have all three
-- NULL. This makes the honest-failure contract a hard DB rule — the writer can never persist a
-- coordinate-bearing miss or a coordinate-less found.
--
-- BOUNDED TTL ON BOTH STATUSES — the deliberate divergence from geocode_country_cache. That table
-- has NO TTL because a fixed coordinate's country is IMMUTABLE (a border change warrants a version
-- bump, which also re-verifies the evidence). A hotel identity->coord mapping is MUTABLE
-- (relocation / rebrand / Travala ID-reuse / mis-translation / a Mapbox correction), so a wrong or
-- stale result must SELF-CORRECT rather than persist forever. Both statuses therefore carry a
-- NOT-NULL `expires_at`, set app-side (found = now()+365d — pay <= once/year per hotel; miss =
-- now()+14d — a miss can become a find sooner). INVALIDATION = a STRATEGY_VERSION bump for ALGORITHM
-- changes (invalidates en masse via the key); the TTL covers DATA drift.
--
-- `name_fingerprint` is a READ-SIDE INVALIDATION GUARD, not merely audit: the key is
-- {provider,country,hotelId}, so Travala ID-reuse or a hotel relocation/rebrand would otherwise
-- return a stale coord for a now-different hotel until the row expires. On a hit, the resolver
-- compares the CURRENT hotel's name+address+location digest against this stored value and treats a
-- mismatch as a read-miss (re-resolve + re-gate).

create table public.hotel_geocode_cache (
  -- STRATEGY_VERSION + SHA-256 of canonical-JSON {provider,country,hotelId}; computed app-side (T3).
  cache_key text primary key,
  status text not null
    constraint hotel_geocode_cache_status_check check (status in ('found', 'miss')),
  lat double precision
    constraint hotel_geocode_cache_lat_range
      check (lat is null or (lat >= -90 and lat <= 90)),
  lng double precision
    constraint hotel_geocode_cache_lng_range
      check (lng is null or (lng >= -180 and lng <= 180)),
  -- Nullable (NULL on a miss); when present it is the same ISO-3166-1 alpha-2 shape the
  -- geocode_country_cache country_code enforces.
  country_code text
    constraint hotel_geocode_cache_country_code_shape
      check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  -- Digest of Travala name+address+location; read-side invalidation guard + drift audit.
  name_fingerprint text,
  created_at timestamptz not null default now(),
  -- Both statuses carry a bounded TTL; the value is set app-side, the column just enforces NOT NULL.
  expires_at timestamptz not null,
  -- found -> real coord + country; miss -> none. The honest-failure contract as a hard DB rule.
  constraint hotel_geocode_cache_status_coords_consistent
    check (
      (status = 'found' and lat is not null and lng is not null and country_code is not null)
      or (status = 'miss' and lat is null and lng is null and country_code is null)
    )
);

-- The sweep deletes expired rows; index the column it filters on.
create index hotel_geocode_cache_expires_at_idx
  on public.hotel_geocode_cache (expires_at);

-- Service-role only, same pattern as geocode_country_cache: the backend is the sole reader and
-- writer, and nothing here belongs to a user, so anon/authenticated get nothing at all.
alter table public.hotel_geocode_cache enable row level security;
revoke all on public.hotel_geocode_cache from public, anon, authenticated;
grant all on public.hotel_geocode_cache to service_role;

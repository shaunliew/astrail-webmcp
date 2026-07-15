-- supabase/migrations/20260715120000_trip_tradeoffs.sql
alter table public.trips
  add column if not exists tradeoffs jsonb not null
  default '{"notes": [], "comparisons": []}'::jsonb;

comment on column public.trips.tradeoffs is
  'Trip-level tradeoffs contract: { notes: TripTradeoffNote[], comparisons: TripTradeoffComparison[] }. '
  'notes = deterministic feasibility gaps; comparisons = derived hotel A-vs-B (price_vs_rating). See '
  'docs/superpowers/specs/2026-07-15-evidence-tradeoff-contract-design.md.';

-- refresh the stale evidence comment to name the exact TripPlaceEvidence keys
comment on column public.trip_places.evidence_json is
  'Per-trip place evidence contract (TripPlaceEvidence): '
  '{ confidence, source_url, quote, quotes, rationale, evidence_kind }.';

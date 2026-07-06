-- Trip-level narration: the generated trip title + read-only orchestrator summary.
-- (Per-day narration lives on trip_days.title/summary, which already exist.) Both nullable,
-- populated best-effort by the narrator — a trip renders fine without them. No RLS change:
-- the existing trips SELECT policy covers all columns of an owned row; the runner writes via
-- service_role. preference_summary is a DIFFERENT contract (the Trip Brief) and is not reused.
alter table public.trips add column if not exists title text;
alter table public.trips add column if not exists summary text;

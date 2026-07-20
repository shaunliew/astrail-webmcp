-- Drop the day-level reel-analysis quota functions superseded by the exactly-once item-level
-- RPCs (`reserve_organize_item_analysis` / `refund_organize_item_analysis`, which charge per
-- organize_job_item and so cannot double-charge a retried item).
--
-- Signatures match 20260718130000_saved_reels_organize.sql:286/314 — both `(uuid, date)`, the
-- `date` defaulted to `current_date`. Zero Python callers: `usage.py` calls only the item-level
-- RPCs, verified repo-wide. Their pgTAP coverage in supabase/tests/007 is removed in the same
-- change (plan 204 -> 190).
--
-- `user_daily_usage.reel_analysis_count`, the column they maintained, is NOT dropped: the
-- item-level RPCs write the same column, so it remains live.

drop function if exists public.reserve_daily_reel_analysis(uuid, date);
drop function if exists public.refund_daily_reel_analysis(uuid, date);

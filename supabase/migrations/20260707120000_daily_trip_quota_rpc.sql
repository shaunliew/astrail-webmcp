-- supabase/migrations/20260707120000_daily_trip_quota_rpc.sql
-- Atomic per-user daily trip quota on the existing public.user_daily_usage table
-- (unique(user_id, usage_date), generated_trip_count). Lives in `public` (NOT
-- `private`) so the service-role client can reach it via PostgREST .rpc(); EXECUTE
-- is revoked from anon/authenticated so only the backend service role can call it.

create or replace function public.increment_daily_trip_usage(p_user_id uuid, p_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_count int;
begin
  insert into public.user_daily_usage as u (user_id, usage_date, generated_trip_count)
  values (p_user_id, current_date, 1)
  on conflict (user_id, usage_date)
  do update set generated_trip_count = u.generated_trip_count + 1,
                updated_at = now()
  where u.generated_trip_count < p_limit
  returning u.generated_trip_count into v_new_count;

  return v_new_count;  -- NULL => already at/over p_limit (ON CONFLICT WHERE was false)
end;
$$;

revoke all on function public.increment_daily_trip_usage(uuid, int) from public, anon, authenticated;
grant execute on function public.increment_daily_trip_usage(uuid, int) to service_role;

create or replace function public.decrement_daily_trip_usage(p_user_id uuid, p_usage_date date default current_date)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_count int;
begin
  update public.user_daily_usage
  set generated_trip_count = greatest(generated_trip_count - 1, 0), updated_at = now()
  where user_id = p_user_id and usage_date = p_usage_date
  returning generated_trip_count into v_new_count;
  return v_new_count;
end;
$$;

revoke all on function public.decrement_daily_trip_usage(uuid, date) from public, anon, authenticated;
grant execute on function public.decrement_daily_trip_usage(uuid, date) to service_role;

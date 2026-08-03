-- Beta-seat request: stamp public.users.seat_requested_at, idempotently.
--
-- An RPC, not a PostgREST .update(): `users` has no authenticated UPDATE RLS policy, and the
-- idempotent stamp is coalesce(seat_requested_at, now()) — a SQL expression the client can't
-- express. Same posture as the arc's other mutations (increment_daily_trip_usage,
-- reserve_and_enqueue_trip_job): security definer, search_path pinned empty, EXECUTE revoked
-- from public/anon/authenticated and granted only to service_role.
--
-- Idempotent by coalesce: the FIRST call stamps now(); repeat calls return the ORIGINAL stamp.
-- No matching row → the UPDATE affects nothing → the function returns NULL (the endpoint maps
-- that to 503 identity_unavailable). seat_requested_at was added in 20260803120000.
create or replace function public.request_seat(p_user_id uuid)
returns timestamptz
language sql security definer set search_path = ''
as $$
  update public.users set seat_requested_at = coalesce(seat_requested_at, now())
   where id = p_user_id
  returning seat_requested_at;
$$;
revoke all on function public.request_seat(uuid) from public, anon, authenticated;
grant execute on function public.request_seat(uuid) to service_role;

-- Make Saved Reel analysis quota reservation and item charge state one transaction.

alter table public.organize_job_items
  add column analysis_usage_date date;

update public.organize_job_items
set analysis_usage_date = analysis_reserved_at::date
where analysis_charge_state <> 'not_charged';

alter table public.organize_job_items
  drop constraint organize_job_items_analysis_charge_state_check;

alter table public.organize_job_items
  add constraint organize_job_items_analysis_charge_state_check
  check (
    (analysis_charge_state = 'not_charged'
      and analysis_usage_date is null
      and analysis_reserved_at is null
      and analysis_refunded_at is null
      and analysis_consumed_at is null)
    or (analysis_charge_state = 'reserved'
      and analysis_usage_date is not null
      and analysis_reserved_at is not null
      and analysis_refunded_at is null
      and analysis_consumed_at is null)
    or (analysis_charge_state = 'refunded'
      and analysis_usage_date is not null
      and analysis_reserved_at is not null
      and analysis_refunded_at is not null
      and analysis_consumed_at is null)
    or (analysis_charge_state = 'consumed'
      and analysis_usage_date is not null
      and analysis_reserved_at is not null
      and analysis_refunded_at is null
      and analysis_consumed_at is not null)
  );

create or replace function public.reserve_organize_item_analysis(
  p_item_id uuid,
  p_user_id uuid
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_usage_date date;
begin
  select analysis_charge_state, analysis_usage_date
  into v_state, v_usage_date
  from public.organize_job_items
  where id = p_item_id
    and user_id = p_user_id
  for update;

  if not found then
    return null;
  end if;

  if v_state in ('reserved', 'consumed') then
    return v_usage_date;
  end if;

  if v_state not in ('not_charged', 'refunded') then
    return null;
  end if;

  insert into public.user_daily_usage as usage (
    user_id,
    usage_date,
    reel_analysis_count
  )
  values (p_user_id, current_date, 1)
  on conflict (user_id, usage_date)
  do update set
    reel_analysis_count = usage.reel_analysis_count + 1,
    updated_at = now()
  where usage.reel_analysis_count < 5
  returning usage_date into v_usage_date;

  if not found then
    return null;
  end if;

  update public.organize_job_items
  set analysis_charge_state = 'reserved',
      analysis_usage_date = v_usage_date,
      analysis_reserved_at = now(),
      analysis_refunded_at = null,
      analysis_consumed_at = null
  where id = p_item_id
    and user_id = p_user_id;

  return v_usage_date;
end;
$$;

revoke all on function public.reserve_organize_item_analysis(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_organize_item_analysis(uuid, uuid) to service_role;

create or replace function public.refund_organize_item_analysis(
  p_item_id uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_usage_date date;
begin
  select analysis_charge_state, analysis_usage_date
  into v_state, v_usage_date
  from public.organize_job_items
  where id = p_item_id
    and user_id = p_user_id
  for update;

  if not found then
    return false;
  end if;

  if v_state = 'refunded' then
    return true;
  end if;

  if v_state <> 'reserved' then
    return false;
  end if;

  update public.user_daily_usage
  set reel_analysis_count = greatest(reel_analysis_count - 1, 0),
      updated_at = now()
  where user_id = p_user_id
    and usage_date = v_usage_date;

  if not found then
    return false;
  end if;

  update public.organize_job_items
  set analysis_charge_state = 'refunded',
      analysis_refunded_at = now()
  where id = p_item_id
    and user_id = p_user_id;

  return true;
end;
$$;

revoke all on function public.refund_organize_item_analysis(uuid, uuid) from public, anon, authenticated;
grant execute on function public.refund_organize_item_analysis(uuid, uuid) to service_role;

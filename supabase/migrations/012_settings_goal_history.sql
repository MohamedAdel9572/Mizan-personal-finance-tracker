-- =====================================================================
--  Mizan 012 - Settings you can change (the "slightly behind" band and an
--  adjustment on the automatic gold price), remove your goal, clear your
--  history. Run after 011. Safe to run again.
-- =====================================================================

alter table public.user_settings add column if not exists warn_threshold_pct numeric(5,2) not null default 5.00;
alter table public.user_settings add column if not exists gold_adjust_pct    numeric(5,2) not null default 0.00;
alter table public.user_settings drop constraint if exists user_settings_warn_threshold_pct_check;
alter table public.user_settings add constraint user_settings_warn_threshold_pct_check check (warn_threshold_pct between 0 and 50);
alter table public.user_settings drop constraint if exists user_settings_gold_adjust_pct_check;
alter table public.user_settings add constraint user_settings_gold_adjust_pct_check check (gold_adjust_pct between -20 and 20);

create or replace function public.get_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'warn_threshold_pct', coalesce((select s.warn_threshold_pct from public.user_settings s where s.user_id = public.app_uid()), 5.00)::text,
    'gold_adjust_pct',    coalesce((select s.gold_adjust_pct    from public.user_settings s where s.user_id = public.app_uid()), 0.00)::text)
  where public.app_uid() is not null
$$;

-- Pass only what you change; null keeps the current value.
create or replace function public.set_settings(p_warn_threshold_pct text default null, p_gold_adjust_pct text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me   uuid := public.app_uid();
  warn numeric;
  adj  numeric;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if nullif(trim(coalesce(p_warn_threshold_pct, '')), '') is not null then
    if trim(p_warn_threshold_pct) !~ '^\d{1,2}(\.\d{1,2})?$' then
      raise exception 'The "slightly behind" limit must be a number from 0 to 50.' using errcode = '22023';
    end if;
    warn := trim(p_warn_threshold_pct)::numeric;
    if warn > 50 then raise exception 'The "slightly behind" limit must be a number from 0 to 50.' using errcode = '22023'; end if;
  end if;
  if nullif(trim(coalesce(p_gold_adjust_pct, '')), '') is not null then
    if trim(p_gold_adjust_pct) !~ '^[+-]?\d{1,2}(\.\d{1,2})?$' then
      raise exception 'The gold price adjustment must be a number from -20 to 20.' using errcode = '22023';
    end if;
    adj := trim(p_gold_adjust_pct)::numeric;
    if abs(adj) > 20 then raise exception 'The gold price adjustment must be a number from -20 to 20.' using errcode = '22023'; end if;
  end if;

  insert into public.user_settings (user_id, warn_threshold_pct, gold_adjust_pct)
  values (me, coalesce(warn, 5.00), coalesce(adj, 0.00))
  on conflict (user_id) do update
    set warn_threshold_pct = coalesce(warn, public.user_settings.warn_threshold_pct),
        gold_adjust_pct    = coalesce(adj,  public.user_settings.gold_adjust_pct),
        updated_at         = now()
    where (public.user_settings.warn_threshold_pct, public.user_settings.gold_adjust_pct)
          is distinct from (coalesce(warn, public.user_settings.warn_threshold_pct), coalesce(adj, public.user_settings.gold_adjust_pct));
end $$;

create or replace function public.delete_goal()
returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := public.app_uid();
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  delete from public.goals where user_id = me;
end $$;

-- Empties the History list. Your plan, actuals and gold are not touched.
create or replace function public.clear_history()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.app_uid();
  n  integer;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  delete from public.audit_events where user_id = me;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.get_settings(), public.set_settings(text, text), public.delete_goal(), public.clear_history() from public;
grant execute on function public.get_settings(), public.set_settings(text, text), public.delete_goal(), public.clear_history() to anon, authenticated;

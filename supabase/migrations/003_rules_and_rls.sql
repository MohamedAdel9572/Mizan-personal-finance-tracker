-- =====================================================================
--  Mizan 003 - Validation triggers, immutability, history, RLS, grants.
--  Run after 002_schema.sql. Safe to run again.
--
--  RLS: every table is "user_id = app_uid()". The policies call
--  (select public.app_uid()) instead of public.app_uid() so Postgres runs it
--  once per query, not once per row (it hashes the token each call).
-- =====================================================================

create or replace function private.cairo_month()
returns date language sql stable set search_path = '' as $$
  select date_trunc('month', (now() at time zone 'Africa/Cairo'))::date
$$;

create or replace function private.deleting_account()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('mizan.deleting_user', true), '') <> ''
$$;

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
--  Plan versions are never changed or deleted (except when the whole
--  account is deleted).
-- ---------------------------------------------------------------------
create or replace function private.plan_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and private.deleting_account() then
    return old;
  end if;
  raise exception 'Plan versions can''t be changed. Save a new version instead.';
end $$;

do $$
declare t text;
begin
  foreach t in array array['plan_versions', 'plan_items', 'plan_item_amounts', 'plan_rates'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_immutable', t);
    execute format('create trigger %I before update or delete on public.%I
                    for each row execute function private.plan_immutable()', t || '_immutable', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
--  Actuals: no future months, no months before your plan, known item keys
-- ---------------------------------------------------------------------
create or replace function private.check_actual_month(p_user uuid, p_month date)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  first_start date;
begin
  if p_month > private.cairo_month() then
    raise exception 'You can''t log % yet - it is in the future.', to_char(p_month, 'YYYY-MM');
  end if;
  select min(start_month) into first_start from public.plan_versions where user_id = p_user;
  if first_start is null then
    raise exception 'Create your plan before logging actuals.';
  end if;
  if p_month < first_start then
    raise exception '% is before your plan starts (%).', to_char(p_month, 'YYYY-MM'), to_char(first_start, 'YYYY-MM');
  end if;
end $$;

create or replace function private.validate_actual()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.check_actual_month(new.user_id, new.month);
  if tg_table_name = 'actual_entries' then
    -- separate IF: plpgsql would fail on new.item_key for the other tables
    if not exists (select 1 from public.plan_items i
                    where i.user_id = new.user_id
                      and i.item_key = (to_jsonb(new)->>'item_key')::uuid
                      and i.kind <> 'asset') then
      raise exception 'This line is not in your plan.';
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['actual_entries', 'unplanned_items', 'monthly_checkins'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_validate', t);
    execute format('create trigger %I before insert or update on public.%I
                    for each row execute function private.validate_actual()', t || '_validate', t);
  end loop;
  foreach t in array array['actual_entries', 'monthly_checkins', 'goals', 'user_settings'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I
                    for each row execute function private.touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

create or replace function private.validate_gold_holding()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.purchase_date > (now() at time zone 'Africa/Cairo')::date then
    raise exception 'Purchase date can''t be in the future.';
  end if;
  if new.sold_date is not null and new.sold_date > (now() at time zone 'Africa/Cairo')::date then
    raise exception 'Sold date can''t be in the future.';
  end if;
  return new;
end $$;
drop trigger if exists gold_holdings_validate on public.gold_holdings;
create trigger gold_holdings_validate before insert or update on public.gold_holdings
  for each row execute function private.validate_gold_holding();

-- user_id can never be moved to another user
create or replace function private.keep_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'Not allowed.';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
--  History: every change to user data writes one audit_events row
-- ---------------------------------------------------------------------
create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r       jsonb := to_jsonb(coalesce(new, old));
  op      text := lower(tg_op);
  verb    text := case tg_op when 'INSERT' then 'Added' when 'UPDATE' then 'Edited' else 'Deleted' end;
  label   text;
  item    text;
begin
  if private.deleting_account() then
    return null;
  end if;

  label := case tg_table_name
    when 'actual_entries' then
      (select coalesce(max(i.name), 'line') from public.plan_items i
        where i.user_id = (r->>'user_id')::uuid and i.item_key = (r->>'item_key')::uuid)
    when 'unplanned_items'      then 'unplanned ' || (r->>'kind') || ' "' || (r->>'name') || '"'
    when 'monthly_checkins'     then 'check-in'
    when 'gold_holdings'        then 'gold "' || (r->>'label') || '"'
    when 'gold_price_overrides' then (r->>'karat') || 'K price override'
    when 'goals'                then 'goal'
    when 'user_settings'        then 'settings'
    else tg_table_name
  end;
  if tg_table_name = 'actual_entries' then
    item := 'actual ' || label || ' = ' || (r->>'amount');
  elsif r ? 'amount' then
    item := label || ' = ' || (r->>'amount');
  else
    item := label;
  end if;

  insert into public.audit_events (user_id, event_type, entity, entity_id, month, summary, details)
  values ((r->>'user_id')::uuid, op, tg_table_name,
          coalesce(r->>'id', r->>'month', r->>'user_id'),
          (r->>'month')::date,
          verb || ' ' || item || coalesce(' (' || to_char((r->>'month')::date, 'YYYY-MM') || ')', ''),
          jsonb_strip_nulls(jsonb_build_object(
            'old', case when tg_op <> 'INSERT' then to_jsonb(old) end,
            'new', case when tg_op <> 'DELETE' then to_jsonb(new) end)));
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['actual_entries', 'unplanned_items', 'monthly_checkins', 'gold_holdings',
                           'gold_price_overrides', 'goals', 'user_settings'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I
                    for each row execute function private.audit_row()', t || '_audit', t);
    execute format('drop trigger if exists %I on public.%I', t || '_keep_owner', t);
    execute format('create trigger %I before update on public.%I
                    for each row execute function private.keep_owner()', t || '_keep_owner', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
--  Row Level Security: a user can only ever see / change their own rows
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['user_settings', 'goals', 'plan_versions', 'plan_items', 'plan_item_amounts',
                           'plan_rates', 'monthly_checkins', 'actual_entries', 'unplanned_items',
                           'gold_holdings', 'gold_price_overrides', 'audit_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows: select" on public.%I', t);
    execute format('create policy "own rows: select" on public.%I for select
                    using (user_id = (select public.app_uid()))', t);
    execute format('drop policy if exists "own rows: insert" on public.%I', t);
    execute format('create policy "own rows: insert" on public.%I for insert
                    with check (user_id = (select public.app_uid()))', t);
    execute format('drop policy if exists "own rows: update" on public.%I', t);
    execute format('create policy "own rows: update" on public.%I for update
                    using (user_id = (select public.app_uid()))
                    with check (user_id = (select public.app_uid()))', t);
    execute format('drop policy if exists "own rows: delete" on public.%I', t);
    execute format('create policy "own rows: delete" on public.%I for delete
                    using (user_id = (select public.app_uid()))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;

-- Shared gold prices: any signed-in user can read; only the service role writes.
alter table public.gold_prices enable row level security;
drop policy if exists "gold prices: signed-in read" on public.gold_prices;
create policy "gold prices: signed-in read" on public.gold_prices
  for select using ((select public.app_uid()) is not null);
revoke all on public.gold_prices from anon, authenticated;
grant select on public.gold_prices to anon, authenticated;

-- What the browser may write directly (RLS + triggers still apply).
-- Plan tables and audit_events: no direct writes at all.
grant insert, update, delete on public.goals, public.monthly_checkins, public.actual_entries,
  public.unplanned_items, public.gold_holdings to anon, authenticated;
grant insert on public.gold_price_overrides to anon, authenticated;
grant update (gold_sell_spread_pct) on public.user_settings to anon, authenticated;

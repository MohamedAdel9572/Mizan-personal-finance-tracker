-- =====================================================================
--  Mizan 007 - Deleting a plan. Run after 006. Safe to run again.
--
--  Saved versions stay protected against edits. Only these two functions
--  may delete them (they set mizan.deleting_plan for their own transaction):
--  * delete_latest_plan_version(): undo the last save/import; the previous
--    version becomes current again. Actuals keep working (stable line keys).
--  * delete_plan(): every version plus the actuals, check-ins and unplanned
--    items that belong to it. Gold holdings are kept.
--  Each writes ONE History entry instead of one per deleted row.
-- =====================================================================

create or replace function private.deleting_plan_of(p_user uuid)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('mizan.deleting_plan', true), '') = p_user::text
$$;

create or replace function private.plan_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (private.deleting_account() or private.deleting_plan_of(old.user_id)) then
    return old;
  end if;
  raise exception 'Plan versions can''t be changed. Save a new version instead.';
end $$;

-- no per-row History entries while a whole plan is being deleted
create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  r       jsonb := to_jsonb(coalesce(new, old));
  op      text := lower(tg_op);
  verb    text := case tg_op when 'INSERT' then 'Added' when 'UPDATE' then 'Edited' else 'Deleted' end;
  label   text;
  item    text;
begin
  if private.deleting_account() or private.deleting_plan_of((r->>'user_id')::uuid) then
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

alter table public.audit_events drop constraint if exists audit_events_event_type_check;
alter table public.audit_events add constraint audit_events_event_type_check
  check (event_type in ('insert', 'update', 'delete', 'plan_version', 'upload', 'plan_delete'));

create or replace function public.delete_latest_plan_version()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.app_uid();
  v  public.plan_versions;
  n  int;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  perform pg_advisory_xact_lock(hashtext('plan:' || me::text));
  select count(*) into n from public.plan_versions where user_id = me;
  if n = 0 then raise exception 'You have no plan.'; end if;
  if n = 1 then raise exception 'This is your only version. Use "Delete plan" instead.'; end if;
  select * into v from public.plan_versions where user_id = me order by version_no desc limit 1;

  perform set_config('mizan.deleting_plan', me::text, true);
  delete from public.plan_versions where id = v.id;
  perform set_config('mizan.deleting_plan', '', true);

  insert into public.audit_events (user_id, event_type, entity, entity_id, month, summary, details)
  values (me, 'plan_delete', 'plan_versions', v.id::text, v.effective_from,
          'Deleted plan version ' || v.version_no || '; version ' || (v.version_no - 1) || ' is current again',
          jsonb_build_object('version_no', v.version_no));
  return jsonb_build_object('deleted_version', v.version_no, 'current_version', v.version_no - 1);
end $$;

create or replace function public.delete_plan()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me  uuid := public.app_uid();
  n_v int;
  n_a int;
  n_c int;
  n_u int;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  perform pg_advisory_xact_lock(hashtext('plan:' || me::text));
  select count(*) into n_v from public.plan_versions where user_id = me;
  if n_v = 0 then raise exception 'You have no plan.'; end if;

  perform set_config('mizan.deleting_plan', me::text, true);
  delete from public.actual_entries where user_id = me;     get diagnostics n_a = row_count;
  delete from public.monthly_checkins where user_id = me;   get diagnostics n_c = row_count;
  delete from public.unplanned_items where user_id = me;    get diagnostics n_u = row_count;
  delete from public.plan_versions where user_id = me;      -- items, amounts and rates cascade
  perform set_config('mizan.deleting_plan', '', true);

  insert into public.audit_events (user_id, event_type, entity, summary, details)
  values (me, 'plan_delete', 'plan',
          'Deleted the plan: ' || n_v || ' versions, ' || n_c || ' logged months, ' || n_u || ' unplanned items. Gold kept.',
          jsonb_build_object('versions', n_v, 'actuals', n_a, 'checkins', n_c, 'unplanned', n_u));
  return jsonb_build_object('versions', n_v, 'actuals', n_a, 'checkins', n_c, 'unplanned', n_u);
end $$;

revoke all on function public.delete_latest_plan_version(), public.delete_plan() from public;
grant execute on function public.delete_latest_plan_version(), public.delete_plan() to anon, authenticated;

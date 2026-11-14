-- =====================================================================
--  Mizan 008 - History timeline + gold price per gram. Run after 007.
--  Safe to run again.
--
--  get_history()        your History entries, newest first (max 500 per call)
--  get_gold_prices()    per karat: your own price (if set) and the latest
--                       fetched price, money as text
--  set_gold_price()     save your price per gram for a karat; null clears it
--                       (then the fetched price is used once step 5 adds it)
-- =====================================================================

create or replace function public.get_history(p_limit int default 300, p_before timestamptz default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'at', e.at, 'type', e.event_type, 'entity', e.entity,
           'month', to_char(e.month, 'YYYY-MM'), 'summary', e.summary) order by e.at desc, e.id desc), '[]')
    from (select * from public.audit_events
           where user_id = public.app_uid()
             and (p_before is null or at < p_before)
           order by at desc, id desc
           limit least(greatest(coalesce(p_limit, 300), 1), 500)) e
$$;

create or replace function public.get_gold_prices()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'karat', k.karat,
           'my_price', o.price_per_gram_egp::text, 'my_price_at', o.set_at,
           'fetched_price', p.price_per_gram_egp::text, 'fetched_at', p.fetched_at, 'source', p.source)
           order by k.karat desc), '[]')
    from (values (24), (21), (18)) k(karat)
    left join lateral (select x.price_per_gram_egp, x.set_at from public.gold_price_overrides x
                        where x.user_id = public.app_uid() and x.karat = k.karat
                        order by x.set_at desc, x.id desc limit 1) o on true
    left join lateral (select y.price_per_gram_egp, y.fetched_at, y.source from public.gold_prices y
                        where y.karat = k.karat order by y.fetched_at desc limit 1) p on true
   where public.app_uid() is not null
$$;

create or replace function public.set_gold_price(p_karat int, p_price text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me  uuid := public.app_uid();
  amt numeric;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if p_karat is null or p_karat not in (24, 21, 18) then raise exception 'Karat must be 24, 21 or 18.'; end if;
  if nullif(trim(coalesce(p_price, '')), '') is null then
    insert into public.gold_price_overrides (user_id, karat, price_per_gram_egp, cleared) values (me, p_karat, null, true);
    return;
  end if;
  amt := private.parse_amount(to_jsonb(replace(replace(trim(p_price), ',', ''), ' ', '')), 'Price per gram');
  if amt = 0 then raise exception 'Price per gram must be more than 0.'; end if;
  insert into public.gold_price_overrides (user_id, karat, price_per_gram_egp) values (me, p_karat, amt);
end $$;

revoke all on function public.get_history(int, timestamptz), public.get_gold_prices(), public.set_gold_price(int, text) from public;
grant execute on function public.get_history(int, timestamptz), public.get_gold_prices(), public.set_gold_price(int, text) to anon, authenticated;

-- creating your settings row at sign-up is not worth a History entry; changes still are
drop trigger if exists user_settings_audit on public.user_settings;
create trigger user_settings_audit after update or delete on public.user_settings
  for each row execute function private.audit_row();
delete from public.audit_events where entity = 'user_settings' and event_type = 'insert';

-- clearer History text for gold price changes (same function as 007, one case added)
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
    when 'gold_price_overrides' then (r->>'karat') || 'K price per gram'
    when 'goals'                then 'goal'
    when 'user_settings'        then 'settings'
    else tg_table_name
  end;
  if tg_table_name = 'actual_entries' then
    item := 'actual ' || label || ' = ' || (r->>'amount');
  elsif tg_table_name = 'gold_price_overrides' then
    verb := case when r->>'price_per_gram_egp' is null then 'Cleared' else 'Set' end;
    item := label || coalesce(' = ' || (r->>'price_per_gram_egp'), '');
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

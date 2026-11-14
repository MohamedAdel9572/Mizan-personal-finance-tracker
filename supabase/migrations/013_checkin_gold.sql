-- =====================================================================
--  Mizan 013 - Gold value saved with each logged month, so net worth of a
--  past month uses the gold price of the day you logged it. Run after 012.
--  Safe to run again.
-- =====================================================================

alter table public.monthly_checkins add column if not exists gold_value public.money;
alter table public.monthly_checkins drop constraint if exists monthly_checkins_gold_value_check;
alter table public.monthly_checkins add constraint monthly_checkins_gold_value_check check (gold_value is null or gold_value >= 0);

create or replace function public.get_actuals()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'checkins', (select coalesce(jsonb_agg(jsonb_build_object(
                    'month', to_char(c.month, 'YYYY-MM'),
                    'savings_balance', c.savings_balance::text,
                    'gold_value', c.gold_value::text,
                    'note', c.note) order by c.month), '[]')
                 from public.monthly_checkins c where c.user_id = public.app_uid()),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                    'month', to_char(e.month, 'YYYY-MM'),
                    'item_key', e.item_key,
                    'amount', e.amount::text,
                    'note', e.note) order by e.month), '[]')
                from public.actual_entries e where e.user_id = public.app_uid()),
    'unplanned', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', u.id,
                    'month', to_char(u.month, 'YYYY-MM'),
                    'kind', u.kind,
                    'name', u.name,
                    'amount', u.amount::text,
                    'note', u.note) order by u.month, u.id), '[]')
                  from public.unplanned_items u where u.user_id = public.app_uid())
  )
$$;

-- Same as 005's save_checkin plus p_gold_value (the app sends the gold value of that month).
-- The old 4-argument version is dropped so calls are never ambiguous.
drop function if exists public.save_checkin(text, jsonb, text, text);
create or replace function public.save_checkin(p_month text, p_entries jsonb,
                                               p_savings_balance text default null, p_note text default '',
                                               p_gold_value text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me   uuid := public.app_uid();
  m    date;
  e    jsonb;
  k    uuid;
  bal  numeric;
  gold numeric;
  n    int := 0;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  m := private.parse_month(p_month, 'Month');
  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'Invalid check-in.';
  end if;
  if nullif(trim(coalesce(p_savings_balance, '')), '') is not null then
    bal := private.parse_amount(to_jsonb(trim(p_savings_balance)), 'Savings balance');
  end if;
  if nullif(trim(coalesce(p_gold_value, '')), '') is not null then
    gold := private.parse_amount(to_jsonb(replace(trim(p_gold_value), ',', '')), 'Gold value');
  end if;

  for e in select * from jsonb_array_elements(p_entries) loop
    n := n + 1;
    if n > 300 then raise exception 'Too many lines.'; end if;
    begin
      k := (e->>'item_key')::uuid;
    exception when invalid_text_representation then
      raise exception 'Line %: invalid line key.', n;
    end;
    insert into public.actual_entries (user_id, month, item_key, amount)
    values (me, m, k, private.parse_amount(e->'amount', 'Line ' || n))
    on conflict (user_id, month, item_key) do update
      set amount = excluded.amount
      where public.actual_entries.amount is distinct from excluded.amount;
  end loop;

  insert into public.monthly_checkins (user_id, month, savings_balance, note, gold_value)
  values (me, m, bal, left(coalesce(p_note, ''), 500), gold)
  on conflict (user_id, month) do update
    set savings_balance = excluded.savings_balance, note = excluded.note,
        gold_value = coalesce(excluded.gold_value, public.monthly_checkins.gold_value)
    where public.monthly_checkins.savings_balance is distinct from excluded.savings_balance
       or public.monthly_checkins.note is distinct from excluded.note
       or (excluded.gold_value is not null and public.monthly_checkins.gold_value is distinct from excluded.gold_value);
end $$;

revoke all on function public.save_checkin(text, jsonb, text, text, text) from public;
grant execute on function public.save_checkin(text, jsonb, text, text, text) to anon, authenticated;

-- =====================================================================
--  Mizan 005 - Actuals RPCs. Run after 004. Safe to run again.
--
--  get_actuals()       everything the Log and Plan-vs-actual screens need,
--                      money as text (exact).
--  save_checkin(...)   one month's check-in in ONE transaction: every line's
--                      real amount + the check-in row. Half-saved months
--                      are impossible.
--  add_unplanned / delete_unplanned for one-off items.
--
--  The triggers from 003 still validate every row (month rules, known line,
--  no negatives) and write History.
-- =====================================================================

create or replace function public.get_actuals()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'checkins', (select coalesce(jsonb_agg(jsonb_build_object(
                    'month', to_char(c.month, 'YYYY-MM'),
                    'savings_balance', c.savings_balance::text,
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

-- p_entries: [{"item_key": "...", "amount": "123.45"}, ...]
create or replace function public.save_checkin(p_month text, p_entries jsonb,
                                               p_savings_balance text default null, p_note text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  me  uuid := public.app_uid();
  m   date;
  e   jsonb;
  k   uuid;
  bal numeric;
  n   int := 0;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  m := private.parse_month(p_month, 'Month');
  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'Invalid check-in.';
  end if;
  if nullif(trim(coalesce(p_savings_balance, '')), '') is not null then
    bal := private.parse_amount(to_jsonb(trim(p_savings_balance)), 'Savings balance');
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

  insert into public.monthly_checkins (user_id, month, savings_balance, note)
  values (me, m, bal, left(coalesce(p_note, ''), 500))
  on conflict (user_id, month) do update
    set savings_balance = excluded.savings_balance, note = excluded.note
    where public.monthly_checkins.savings_balance is distinct from excluded.savings_balance
       or public.monthly_checkins.note is distinct from excluded.note;
end $$;

create or replace function public.add_unplanned(p_month text, p_kind text, p_name text,
                                                p_amount text, p_note text default '')
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  me  uuid := public.app_uid();
  amt numeric;
  id  bigint;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if p_kind is null or p_kind not in ('income', 'expense') then
    raise exception 'Choose income or expense.';
  end if;
  if coalesce(trim(p_name), '') = '' or length(trim(p_name)) > 80 then
    raise exception 'Name is required (max 80 characters).';
  end if;
  amt := private.parse_amount(to_jsonb(coalesce(p_amount, '')), 'Amount');
  if amt = 0 then raise exception 'Amount must be more than 0.'; end if;
  insert into public.unplanned_items (user_id, month, kind, name, amount, note)
  values (me, private.parse_month(p_month, 'Month'), p_kind, trim(p_name), amt, left(coalesce(p_note, ''), 500))
  returning unplanned_items.id into id;
  return id;
end $$;

create or replace function public.delete_unplanned(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.app_uid() is null then raise exception 'Please sign in first.'; end if;
  delete from public.unplanned_items where id = p_id and user_id = public.app_uid();
  if not found then raise exception 'Item not found.'; end if;
end $$;

revoke all on function public.get_actuals(), public.save_checkin(text, jsonb, text, text),
  public.add_unplanned(text, text, text, text, text), public.delete_unplanned(bigint) from public;
grant execute on function public.get_actuals(), public.save_checkin(text, jsonb, text, text),
  public.add_unplanned(text, text, text, text, text), public.delete_unplanned(bigint) to anon, authenticated;

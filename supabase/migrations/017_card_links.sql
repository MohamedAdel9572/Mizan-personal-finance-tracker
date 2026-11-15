-- =====================================================================
--  Mizan 017 - Plan lines paid with a card. Run after 016. Safe to run again.
--
--  A plan line (e.g. Tablet) can be linked to a card:
--    installment: the card already holds the amount; each month's payment adds it back
--                 to what's available (a "payment" entry on the card)
--    monthly:     the card is charged each month (a "spend" entry on the card)
--  settle_line logs the month's actual for the line AND, when paid with the card,
--  adds the matching card entry, in one step. Paid cash = only the actual.
--  Lines without a link work as before.
-- =====================================================================

create table if not exists public.card_links (
  user_id  uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  item_key uuid not null,
  card_id  bigint not null references public.cards(id) on delete cascade,
  mode     text not null check (mode in ('installment', 'monthly')),
  primary key (user_id, item_key)
);

alter table public.card_txns add column if not exists item_key uuid;
alter table public.card_txns add column if not exists month date;
create unique index if not exists card_txns_line_month_idx on public.card_txns (user_id, item_key, month) where item_key is not null;

alter table public.card_links enable row level security;
drop policy if exists "own rows: select" on public.card_links;
create policy "own rows: select" on public.card_links for select using (user_id = (select public.app_uid()));
revoke all on public.card_links from anon, authenticated;
grant select on public.card_links to anon, authenticated;

create or replace function private.line_name(p_user uuid, p_key uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select i.name from public.plan_items i join public.plan_versions v on v.id = i.version_id
                    where i.user_id = p_user and i.item_key = p_key order by v.version_no desc limit 1), 'line')
$$;

create or replace function public.get_cards()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.app_uid() is null then null else jsonb_build_object(
    'cards', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'bank', c.bank, 'kind', c.kind, 'last4', c.last4, 'color', c.color,
        'credit_limit', c.credit_limit::text, 'opening_balance', c.opening_balance::text, 'due_day', c.due_day,
        'created_at', c.created_at) order by c.created_at, c.id)
      from public.cards c where c.user_id = public.app_uid()), '[]'),
    'txns', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'card_id', t.card_id, 'kind', t.kind, 'amount', t.amount::text,
        'date', to_char(t.txn_date, 'YYYY-MM-DD'), 'note', t.note, 'created_at', t.created_at,
        'item_key', t.item_key, 'month', to_char(t.month, 'YYYY-MM'))
        order by t.txn_date desc, t.id desc)
      from public.card_txns t where t.user_id = public.app_uid()), '[]'),
    'links', coalesce((select jsonb_agg(jsonb_build_object('item_key', l.item_key, 'card_id', l.card_id, 'mode', l.mode))
      from public.card_links l where l.user_id = public.app_uid()), '[]')) end
$$;

-- p_card_id null removes the link. Entries already on the card stay.
create or replace function public.set_card_link(p_item_key text, p_card_id bigint, p_mode text default 'installment')
returns void language plpgsql security definer set search_path = '' as $$
declare
  me   uuid := public.app_uid();
  k    uuid;
  c    public.cards;
  old  public.card_links;
  nm   text;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  begin k := p_item_key::uuid; exception when others then raise exception 'Invalid line.'; end;
  if not exists (select 1 from public.plan_items where user_id = me and item_key = k) then raise exception 'Line not found.'; end if;
  nm := private.line_name(me, k);
  select * into old from public.card_links where user_id = me and item_key = k;
  if p_card_id is null then
    delete from public.card_links where user_id = me and item_key = k;
    if old.card_id is not null then
      perform private.card_log(me, 'delete', 'card_links', old.card_id,
        '"' || nm || '" is no longer paid with "' || (select name from public.cards where id = old.card_id) || '"', '{}');
    end if;
    return;
  end if;
  if coalesce(p_mode, '') not in ('installment', 'monthly') then raise exception 'Pick installment or monthly charge.'; end if;
  select * into c from public.cards where id = p_card_id and user_id = me;
  if c.id is null then raise exception 'Card not found.'; end if;
  insert into public.card_links (user_id, item_key, card_id, mode) values (me, k, c.id, p_mode)
  on conflict (user_id, item_key) do update set card_id = excluded.card_id, mode = excluded.mode;
  if old.card_id is distinct from c.id or old.mode is distinct from p_mode then
    perform private.card_log(me, 'insert', 'card_links', c.id,
      '"' || nm || '" is paid with "' || c.name || '" (' || case p_mode when 'installment' then 'installment' else 'charged monthly' end || ')', '{}');
  end if;
end $$;

-- Log the month's actual for a line and, when p_via = 'card', the matching entry on its card.
-- p_via = 'cash' logs only the actual and removes a card entry made for that month before.
create or replace function public.settle_line(p_month text, p_item_key text, p_amount text, p_via text, p_date text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me   uuid := public.app_uid();
  m    date;
  k    uuid;
  amt  numeric;
  d    date;
  l    public.card_links;
  nm   text;
  today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  m := private.parse_month(p_month, 'Month');
  begin k := p_item_key::uuid; exception when others then raise exception 'Invalid line.'; end;
  if not exists (select 1 from public.plan_items where user_id = me and item_key = k) then raise exception 'Line not found.'; end if;
  amt := private.parse_amount(to_jsonb(replace(coalesce(p_amount, ''), ',', '')), 'Amount');
  if coalesce(p_via, '') not in ('card', 'cash') then raise exception 'Pick card or cash.'; end if;
  if nullif(p_date, '') is null then
    d := least(today, (m + interval '1 month - 1 day')::date);
  elsif p_date !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Date is not valid.';
  else d := p_date::date;
  end if;
  if d > today then raise exception 'Date can''t be in the future.'; end if;

  insert into public.actual_entries (user_id, month, item_key, amount) values (me, m, k, amt)
  on conflict (user_id, month, item_key) do update set amount = excluded.amount
    where public.actual_entries.amount is distinct from excluded.amount;

  select * into l from public.card_links where user_id = me and item_key = k;
  if p_via = 'cash' or amt = 0 then
    delete from public.card_txns where user_id = me and item_key = k and month = m;
    return;
  end if;
  if l.card_id is null then raise exception 'This line isn''t linked to a card.'; end if;
  nm := private.line_name(me, k);
  if exists (select 1 from public.card_txns where user_id = me and item_key = k and month = m) then
    update public.card_txns set card_id = l.card_id, kind = case l.mode when 'installment' then 'payment' else 'spend' end,
           amount = amt, txn_date = d
     where user_id = me and item_key = k and month = m;
  else
    insert into public.card_txns (user_id, card_id, kind, amount, txn_date, note, item_key, month)
    values (me, l.card_id, case l.mode when 'installment' then 'payment' else 'spend' end, amt, d,
            left(nm || ' · ' || to_char(m, 'Mon YYYY'), 120), k, m);
  end if;
  perform private.card_log(me, 'insert', 'card_txns', l.card_id,
    case l.mode when 'installment' then 'Paid ' else 'Charged ' end || private.money_text(amt) ||
    case l.mode when 'installment' then ' to "' else ' on "' end || (select name from public.cards where id = l.card_id) ||
    '" for ' || nm || ' (' || to_char(m, 'YYYY-MM') || ')', '{}');
end $$;

-- Keep a line's card entry in step with its actual: changing the actual on the Log page
-- changes the card entry's amount; clearing it (or clearing the month) removes the entry.
create or replace function private.sync_card_from_actual()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or new.amount = 0 then
    delete from public.card_txns where user_id = old.user_id and item_key = old.item_key and month = old.month;
  elsif new.amount is distinct from old.amount then
    update public.card_txns set amount = new.amount
     where user_id = new.user_id and item_key = new.item_key and month = new.month;
  end if;
  return null;
end $$;
drop trigger if exists actual_entries_sync_card on public.actual_entries;
create trigger actual_entries_sync_card after update or delete on public.actual_entries
  for each row execute function private.sync_card_from_actual();

revoke all on function public.get_cards(), public.set_card_link(text, bigint, text),
  public.settle_line(text, text, text, text, text) from public;
grant execute on function public.get_cards(), public.set_card_link(text, bigint, text),
  public.settle_line(text, text, text, text, text) to anon, authenticated;

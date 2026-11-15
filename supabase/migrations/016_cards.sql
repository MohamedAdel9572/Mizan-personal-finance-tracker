-- =====================================================================
--  Mizan 016 - Cards: credit cards (limit, used, available) and debit
--  cards (balance), each with a history of spends and payments.
--  Run after 015. Safe to run again.
--
--  Numbers:
--    credit: used = opening (already used when added) + spends - payments - refunds
--            available = limit - used
--    debit:  balance = opening + deposits (payments) + refunds - spends
--  Writes go through the functions below only; each one writes History.
-- =====================================================================

create table if not exists public.cards (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 60),
  bank            text not null default '' check (length(bank) <= 60),
  kind            text not null check (kind in ('credit', 'debit')),
  last4           text check (last4 is null or last4 ~ '^\d{4}$'),
  color           text not null default 'teal' check (color in ('teal', 'indigo', 'rose', 'amber', 'slate', 'emerald')),
  credit_limit    public.money check (credit_limit is null or credit_limit > 0),
  opening_balance public.money not null default 0 check (opening_balance >= 0),
  due_day         smallint check (due_day is null or due_day between 1 and 31),
  created_at      timestamptz not null default now(),
  check ((kind = 'credit') = (credit_limit is not null))
);
create index if not exists cards_user_idx on public.cards (user_id);

create table if not exists public.card_txns (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  card_id    bigint not null references public.cards(id) on delete cascade,
  kind       text not null check (kind in ('spend', 'payment', 'refund')),
  amount     public.money not null check (amount > 0),
  txn_date   date not null,
  note       text not null default '' check (length(note) <= 120),
  created_at timestamptz not null default now()
);
create index if not exists card_txns_card_idx on public.card_txns (user_id, card_id, txn_date desc);

do $$
declare t text;
begin
  foreach t in array array['cards', 'card_txns'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows: select" on public.%I', t);
    execute format('create policy "own rows: select" on public.%I for select
                    using (user_id = (select public.app_uid()))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;

create or replace function private.card_log(p_user uuid, p_type text, p_entity text, p_id bigint, p_summary text, p_details jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (user_id, event_type, entity, entity_id, summary, details)
  values (p_user, p_type, p_entity, p_id::text, p_summary, coalesce(p_details, '{}'))
$$;

create or replace function private.money_text(n numeric)
returns text language sql immutable set search_path = '' as $$
  select case when n = trunc(n) then to_char(n, 'FM999,999,999,999,990') else to_char(n, 'FM999,999,999,999,990.00') end
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
        'date', to_char(t.txn_date, 'YYYY-MM-DD'), 'note', t.note, 'created_at', t.created_at)
        order by t.txn_date desc, t.id desc)
      from public.card_txns t where t.user_id = public.app_uid()), '[]')) end
$$;

-- p: {name, bank, kind, last4, color, credit_limit, opening_balance, due_day}. p_id null = new card.
create or replace function public.save_card(p_id bigint, p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := public.app_uid();
  v_name text := trim(coalesce(p->>'name', ''));
  v_bank text := trim(coalesce(p->>'bank', ''));
  v_kind text := coalesce(p->>'kind', '');
  v_last text := nullif(trim(coalesce(p->>'last4', '')), '');
  v_col  text := coalesce(nullif(p->>'color', ''), 'teal');
  v_lim  numeric;
  v_open numeric;
  v_due  smallint;
  old    public.cards;
  new_id bigint;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if v_name = '' or length(v_name) > 60 then raise exception 'Card name is required (max 60 characters).'; end if;
  if length(v_bank) > 60 then raise exception 'Bank name is too long (max 60 characters).'; end if;
  if v_kind not in ('credit', 'debit') then raise exception 'Pick credit or debit.'; end if;
  if v_last is not null and v_last !~ '^\d{4}$' then raise exception 'Last 4 digits must be exactly 4 numbers.'; end if;
  if v_col not in ('teal', 'indigo', 'rose', 'amber', 'slate', 'emerald') then v_col := 'teal'; end if;
  if v_kind = 'credit' then
    v_lim := private.parse_amount(to_jsonb(replace(coalesce(p->>'credit_limit', ''), ',', '')), 'Credit limit');
    if v_lim = 0 then raise exception 'Credit limit must be more than 0.'; end if;
  end if;
  v_open := private.parse_amount(to_jsonb(replace(coalesce(nullif(p->>'opening_balance', ''), '0'), ',', '')),
                                 case v_kind when 'credit' then 'Already used' else 'Balance' end);
  if nullif(p->>'due_day', '') is not null then
    if (p->>'due_day') !~ '^\d{1,2}$' or (p->>'due_day')::int not between 1 and 31 then
      raise exception 'Payment due day must be from 1 to 31.';
    end if;
    v_due := (p->>'due_day')::smallint;
  end if;

  if p_id is null then
    insert into public.cards (user_id, name, bank, kind, last4, color, credit_limit, opening_balance, due_day)
    values (me, v_name, v_bank, v_kind, v_last, v_col, v_lim, v_open, case when v_kind = 'credit' then v_due end)
    returning id into new_id;
    perform private.card_log(me, 'insert', 'cards', new_id,
      'Added ' || v_kind || ' card "' || v_name || '"' ||
      case when v_kind = 'credit' then ', limit ' || private.money_text(v_lim) else ', balance ' || private.money_text(v_open) end, '{}');
    return new_id;
  end if;

  select * into old from public.cards where id = p_id and user_id = me for update;
  if old.id is null then raise exception 'Card not found.'; end if;
  if old.kind <> v_kind then raise exception 'A card can''t change between credit and debit. Add a new card instead.'; end if;
  update public.cards
     set name = v_name, bank = v_bank, last4 = v_last, color = v_col, credit_limit = v_lim,
         opening_balance = v_open, due_day = case when v_kind = 'credit' then v_due end
   where id = p_id;
  if old.credit_limit is distinct from v_lim then
    perform private.card_log(me, 'update', 'cards', p_id,
      'Changed limit of "' || v_name || '": ' || private.money_text(old.credit_limit) || ' -> ' || private.money_text(v_lim),
      jsonb_build_object('old_limit', old.credit_limit, 'new_limit', v_lim));
  end if;
  if (old.name, old.bank, old.last4, old.color, old.opening_balance, old.due_day)
     is distinct from (v_name, v_bank, v_last, v_col, v_open, case when v_kind = 'credit' then v_due end) then
    perform private.card_log(me, 'update', 'cards', p_id, 'Edited card "' || v_name || '"', '{}');
  end if;
  return p_id;
end $$;

create or replace function public.delete_card(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.app_uid();
  c  public.cards;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  delete from public.cards where id = p_id and user_id = me returning * into c;
  if c.id is null then raise exception 'Card not found.'; end if;
  perform private.card_log(me, 'delete', 'cards', p_id, 'Deleted card "' || c.name || '" and its history', '{}');
end $$;

-- p: {card_id, kind spend|payment|refund, amount, date YYYY-MM-DD, note}. p_id null = new.
create or replace function public.save_card_txn(p_id bigint, p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := public.app_uid();
  c      public.cards;
  v_kind text := coalesce(p->>'kind', '');
  v_amt  numeric;
  v_date date;
  v_note text := trim(coalesce(p->>'note', ''));
  new_id bigint;
  verb   text;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select * into c from public.cards where id = nullif(p->>'card_id', '')::bigint and user_id = me;
  if c.id is null then raise exception 'Card not found.'; end if;
  if v_kind not in ('spend', 'payment', 'refund') then raise exception 'Pick spend, payment or refund.'; end if;
  v_amt := private.parse_amount(to_jsonb(replace(coalesce(p->>'amount', ''), ',', '')), 'Amount');
  if v_amt = 0 then raise exception 'Amount must be more than 0.'; end if;
  if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Date is not valid.'; end if;
  v_date := (p->>'date')::date;
  if v_date > (now() at time zone 'Africa/Cairo')::date then raise exception 'Date can''t be in the future.'; end if;
  if length(v_note) > 120 then raise exception 'Note is too long (max 120 characters).'; end if;
  verb := case v_kind when 'spend' then 'Spent ' when 'refund' then 'Refund ' else case c.kind when 'credit' then 'Paid ' else 'Deposited ' end end;

  if p_id is null then
    insert into public.card_txns (user_id, card_id, kind, amount, txn_date, note)
    values (me, c.id, v_kind, v_amt, v_date, v_note) returning id into new_id;
    perform private.card_log(me, 'insert', 'card_txns', new_id,
      verb || private.money_text(v_amt) || case when v_kind = 'spend' then ' on "' else ' to "' end || c.name || '"' ||
      case when v_note <> '' then ' (' || v_note || ')' else '' end, '{}');
    return new_id;
  end if;
  update public.card_txns set card_id = c.id, kind = v_kind, amount = v_amt, txn_date = v_date, note = v_note
   where id = p_id and user_id = me
     and (card_id, kind, amount, txn_date, note) is distinct from (c.id, v_kind, v_amt, v_date, v_note);
  if found then
    perform private.card_log(me, 'update', 'card_txns', p_id,
      'Edited ' || lower(trim(verb)) || ' ' || private.money_text(v_amt) || ' on "' || c.name || '"', '{}');
  elsif not exists (select 1 from public.card_txns where id = p_id and user_id = me) then
    raise exception 'Entry not found.';
  end if;
  return p_id;
end $$;

create or replace function public.delete_card_txn(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.app_uid();
  t  public.card_txns;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  delete from public.card_txns where id = p_id and user_id = me returning * into t;
  if t.id is null then raise exception 'Entry not found.'; end if;
  perform private.card_log(me, 'delete', 'card_txns', p_id,
    'Deleted ' || t.kind || ' ' || private.money_text(t.amount) || ' from "' ||
    (select name from public.cards where id = t.card_id) || '"', '{}');
end $$;

revoke all on function public.get_cards(), public.save_card(bigint, jsonb), public.delete_card(bigint),
  public.save_card_txn(bigint, jsonb), public.delete_card_txn(bigint) from public;
grant execute on function public.get_cards(), public.save_card(bigint, jsonb), public.delete_card(bigint),
  public.save_card_txn(bigint, jsonb), public.delete_card_txn(bigint) to anon, authenticated;

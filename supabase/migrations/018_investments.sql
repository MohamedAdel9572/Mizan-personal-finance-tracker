-- =====================================================================
--  Mizan 018 - Investments. Run after 017. Safe to run again.
--
--  Your savings are spread over investments (e.g. Mashreq daily profit, Thndr, a fund).
--  All of them together are your savings balance:
--    - each investment has the amount it held when the plan starts (opening)
--    - each month you log its profit or loss (typed as an amount, or worked out
--      by the app from that month's rate); the plan's actual Interest row for a
--      month = the total profit/loss of all investments that month
--    - moving money between investments changes neither profit nor savings
--    - the money you save each month (income - expenses) lands in one investment,
--      the one marked "savings land here"
-- =====================================================================

create table if not exists public.invest_accounts (
  id               bigint generated always as identity primary key,
  user_id          uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 60),
  opening          public.money not null default 0 check (opening >= 0),
  usual_rate       numeric(9,4) check (usual_rate is null or usual_rate between -100 and 1000),
  rate_unit        text not null default 'yearly' check (rate_unit in ('yearly', 'monthly', 'daily')),
  receives_savings boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists invest_accounts_user_idx on public.invest_accounts (user_id);
create unique index if not exists invest_accounts_one_savings on public.invest_accounts (user_id) where receives_savings;

create table if not exists public.invest_months (
  user_id    uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  account_id bigint not null references public.invest_accounts(id) on delete cascade,
  month      public.month_date not null,
  profit     numeric(16,2) not null,          -- negative = loss
  rate       numeric(9,4),                    -- set when the profit was worked out from a rate
  rate_unit  text check (rate_unit is null or rate_unit in ('yearly', 'monthly', 'daily')),
  note       text not null default '' check (length(note) <= 120),
  primary key (account_id, month)
);
create index if not exists invest_months_user_idx on public.invest_months (user_id, month);

create table if not exists public.invest_moves (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default public.app_uid() references public.profiles(id) on delete cascade,
  from_account bigint not null references public.invest_accounts(id) on delete cascade,
  to_account   bigint not null references public.invest_accounts(id) on delete cascade,
  amount       public.money not null check (amount > 0),
  move_date    date not null,
  note         text not null default '' check (length(note) <= 120),
  created_at   timestamptz not null default now(),
  check (from_account <> to_account)
);
create index if not exists invest_moves_user_idx on public.invest_moves (user_id, move_date);

do $$
declare t text;
begin
  foreach t in array array['invest_accounts', 'invest_months', 'invest_moves'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows: select" on public.%I', t);
    execute format('create policy "own rows: select" on public.%I for select
                    using (user_id = (select public.app_uid()))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;

create or replace function private.signed_money_text(n numeric)
returns text language sql immutable set search_path = '' as $$
  select case when n < 0 then '-' else '+' end || private.money_text(abs(n))
$$;

create or replace function public.get_investments()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when public.app_uid() is null then null else jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'opening', a.opening::text, 'usual_rate', a.usual_rate::text,
        'rate_unit', a.rate_unit, 'receives_savings', a.receives_savings, 'created_at', a.created_at)
        order by a.created_at, a.id)
      from public.invest_accounts a where a.user_id = public.app_uid()), '[]'),
    'months', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', m.account_id, 'month', to_char(m.month, 'YYYY-MM'), 'profit', m.profit::text,
        'rate', m.rate::text, 'rate_unit', m.rate_unit, 'note', m.note) order by m.month)
      from public.invest_months m where m.user_id = public.app_uid()), '[]'),
    'moves', coalesce((select jsonb_agg(jsonb_build_object(
        'id', v.id, 'from_account', v.from_account, 'to_account', v.to_account, 'amount', v.amount::text,
        'date', to_char(v.move_date, 'YYYY-MM-DD'), 'note', v.note) order by v.move_date, v.id)
      from public.invest_moves v where v.user_id = public.app_uid()), '[]')) end
$$;

-- p: {name, opening, usual_rate, rate_unit, receives_savings}. p_id null = new.
create or replace function public.save_invest_account(p_id bigint, p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := public.app_uid();
  v_name text := trim(coalesce(p->>'name', ''));
  v_open numeric;
  v_rate numeric;
  v_unit text := coalesce(nullif(p->>'rate_unit', ''), 'yearly');
  v_recv boolean := coalesce((p->>'receives_savings')::boolean, false);
  old    public.invest_accounts;
  new_id bigint;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  if v_name = '' or length(v_name) > 60 then raise exception 'Name is required (max 60 characters).'; end if;
  v_open := private.parse_amount(to_jsonb(replace(coalesce(nullif(p->>'opening', ''), '0'), ',', '')), 'Amount at plan start');
  if nullif(p->>'usual_rate', '') is not null then
    if (p->>'usual_rate') !~ '^-?\d{1,4}(\.\d{1,4})?$' then raise exception 'Usual rate must be a number like 17 or 0.05.'; end if;
    v_rate := (p->>'usual_rate')::numeric;
  end if;
  if v_unit not in ('yearly', 'monthly', 'daily') then raise exception 'Pick yearly, monthly or daily.'; end if;
  -- only one investment receives the monthly savings
  if v_recv then update public.invest_accounts set receives_savings = false where user_id = me and receives_savings and id is distinct from p_id; end if;

  if p_id is null then
    insert into public.invest_accounts (user_id, name, opening, usual_rate, rate_unit, receives_savings)
    values (me, v_name, v_open, v_rate, v_unit, v_recv
            or not exists (select 1 from public.invest_accounts where user_id = me))   -- the first one gets the savings
    returning id into new_id;
    perform private.card_log(me, 'insert', 'invest_accounts', new_id,
      'Added investment "' || v_name || '" with ' || private.money_text(v_open) || ' at plan start', '{}');
    return new_id;
  end if;
  select * into old from public.invest_accounts where id = p_id and user_id = me for update;
  if old.id is null then raise exception 'Investment not found.'; end if;
  update public.invest_accounts set name = v_name, opening = v_open, usual_rate = v_rate, rate_unit = v_unit,
         receives_savings = v_recv where id = p_id;
  if (old.name, old.opening, old.usual_rate, old.rate_unit, old.receives_savings) is distinct from (v_name, v_open, v_rate, v_unit, v_recv) then
    perform private.card_log(me, 'update', 'invest_accounts', p_id, 'Edited investment "' || v_name || '"' ||
      case when old.opening is distinct from v_open then ': at plan start ' || private.money_text(old.opening) || ' -> ' || private.money_text(v_open) else '' end, '{}');
  end if;
  return p_id;
end $$;

create or replace function public.delete_invest_account(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.app_uid();
  a  public.invest_accounts;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  delete from public.invest_accounts where id = p_id and user_id = me returning * into a;
  if a.id is null then raise exception 'Investment not found.'; end if;
  perform private.card_log(me, 'delete', 'invest_accounts', p_id, 'Deleted investment "' || a.name || '" and its history', '{}');
end $$;

-- Save one month for several investments at once.
-- p_rows: [{account_id, profit (signed, or "" to clear), rate, rate_unit, note}]
create or replace function public.save_invest_month(p_month text, p_rows jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me   uuid := public.app_uid();
  m    date;
  r    jsonb;
  a    public.invest_accounts;
  v_p  numeric;
  v_r  numeric;
  v_u  text;
  v_n  text;
  old  public.invest_months;
  parts text[] := '{}';
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  m := private.parse_month(p_month, 'Month');
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Nothing to save.'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    select * into a from public.invest_accounts where id = nullif(r->>'account_id', '')::bigint and user_id = me;
    if a.id is null then raise exception 'Investment not found.'; end if;
    select * into old from public.invest_months where account_id = a.id and month = m;
    if nullif(replace(coalesce(r->>'profit', ''), ',', ''), '') is null then
      delete from public.invest_months where account_id = a.id and month = m;
      if old.account_id is not null then parts := parts || (a.name || ' cleared'); end if;
      continue;
    end if;
    if replace(r->>'profit', ',', '') !~ '^-?\d{1,14}(\.\d{1,2})?$' then
      raise exception '%: "%" is not a valid amount.', a.name, r->>'profit';
    end if;
    v_p := replace(r->>'profit', ',', '')::numeric;
    v_r := null; v_u := null;
    if nullif(r->>'rate', '') is not null then
      if (r->>'rate') !~ '^-?\d{1,4}(\.\d{1,4})?$' then raise exception '%: rate must be a number like 17 or 0.05.', a.name; end if;
      v_r := (r->>'rate')::numeric;
      v_u := coalesce(nullif(r->>'rate_unit', ''), 'yearly');
      if v_u not in ('yearly', 'monthly', 'daily') then raise exception 'Pick yearly, monthly or daily.'; end if;
    end if;
    v_n := trim(coalesce(r->>'note', ''));
    if length(v_n) > 120 then raise exception '%: note is too long (max 120 characters).', a.name; end if;
    insert into public.invest_months (user_id, account_id, month, profit, rate, rate_unit, note)
    values (me, a.id, m, v_p, v_r, v_u, v_n)
    on conflict (account_id, month) do update set profit = excluded.profit, rate = excluded.rate,
      rate_unit = excluded.rate_unit, note = excluded.note;
    if old.account_id is null or (old.profit, old.rate, old.rate_unit, old.note) is distinct from (v_p, v_r, v_u, v_n) then
      parts := parts || (a.name || ' ' || private.signed_money_text(v_p));
    end if;
  end loop;
  if array_length(parts, 1) > 0 then
    perform private.card_log(me, 'update', 'invest_months', null,
      'Investments ' || to_char(m, 'YYYY-MM') || ': ' || array_to_string(parts, ', '), '{}');
  end if;
end $$;

-- p: {from_account, to_account, amount, date, note}. p_id null = new.
create or replace function public.save_invest_move(p_id bigint, p jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := public.app_uid();
  f      public.invest_accounts;
  t      public.invest_accounts;
  v_amt  numeric;
  v_date date;
  v_note text := trim(coalesce(p->>'note', ''));
  new_id bigint;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  select * into f from public.invest_accounts where id = nullif(p->>'from_account', '')::bigint and user_id = me;
  select * into t from public.invest_accounts where id = nullif(p->>'to_account', '')::bigint and user_id = me;
  if f.id is null or t.id is null then raise exception 'Investment not found.'; end if;
  if f.id = t.id then raise exception 'Pick two different investments.'; end if;
  v_amt := private.parse_amount(to_jsonb(replace(coalesce(p->>'amount', ''), ',', '')), 'Amount');
  if v_amt = 0 then raise exception 'Amount must be more than 0.'; end if;
  if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Date is not valid.'; end if;
  v_date := (p->>'date')::date;
  if v_date > (now() at time zone 'Africa/Cairo')::date then raise exception 'Date can''t be in the future.'; end if;
  if length(v_note) > 120 then raise exception 'Note is too long (max 120 characters).'; end if;
  if p_id is null then
    insert into public.invest_moves (user_id, from_account, to_account, amount, move_date, note)
    values (me, f.id, t.id, v_amt, v_date, v_note) returning id into new_id;
  else
    update public.invest_moves set from_account = f.id, to_account = t.id, amount = v_amt, move_date = v_date, note = v_note
     where id = p_id and user_id = me returning id into new_id;
    if new_id is null then raise exception 'Move not found.'; end if;
  end if;
  perform private.card_log(me, case when p_id is null then 'insert' else 'update' end, 'invest_moves', new_id,
    'Moved ' || private.money_text(v_amt) || ' from "' || f.name || '" to "' || t.name || '"', '{}');
  return new_id;
end $$;

create or replace function public.delete_invest_move(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me uuid := public.app_uid();
  v  public.invest_moves;
begin
  if me is null then raise exception 'Please sign in first.'; end if;
  delete from public.invest_moves where id = p_id and user_id = me returning * into v;
  if v.id is null then raise exception 'Move not found.'; end if;
  perform private.card_log(me, 'delete', 'invest_moves', p_id, 'Deleted a move of ' || private.money_text(v.amount), '{}');
end $$;

revoke all on function public.get_investments(), public.save_invest_account(bigint, jsonb), public.delete_invest_account(bigint),
  public.save_invest_month(text, jsonb), public.save_invest_move(bigint, jsonb), public.delete_invest_move(bigint) from public;
grant execute on function public.get_investments(), public.save_invest_account(bigint, jsonb), public.delete_invest_account(bigint),
  public.save_invest_month(text, jsonb), public.save_invest_move(bigint, jsonb), public.delete_invest_move(bigint) to anon, authenticated;

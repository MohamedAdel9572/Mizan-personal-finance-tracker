-- Shared test helpers. Included by each *_test.sql with \ir helpers.sql
set client_min_messages = notice;
-- ---------- test helpers (created as superuser) ----------
create schema if not exists test;
grant usage on schema test to anon;

create or replace function test.act_as(p_token text) returns void language sql as $$
  select set_config('request.headers',
    case when p_token is null then '' else json_build_object('x-mizan-session', p_token)::text end, false);
  select null::void;
$$;

create or replace function test.eq(p_got text, p_want text, p_msg text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL %: got [%], expected [%]', p_msg, p_got, p_want;
  end if;
  raise notice 'ok - %', p_msg;
end $$;

create or replace function test.throws(p_sql text, p_like text, p_msg text) returns void language plpgsql as $$
declare m text;
begin
  begin
    execute p_sql;
  exception when others then
    m := sqlerrm;
  end;
  if m is null then raise exception 'FAIL %: expected an error, got none', p_msg; end if;
  if m not ilike p_like then raise exception 'FAIL %: wrong error [%]', p_msg, m; end if;
  raise notice 'ok - %', p_msg;
end $$;

create or replace function test.rows(p_sql text) returns text language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n::text;
end $$;

-- base plan used by the validation tests (every line has a fixed key)
create or replace function test.base_plan() returns jsonb language sql immutable as $$
  select $j${
    "start_month": "2026-06", "effective_from": "2026-06", "horizon_months": 12, "opening_balance": "100000.00",
    "rates": [{"from": "2026-06", "annual_rate_pct": "17"}],
    "items": [
      {"item_key": "11111111-1111-4111-8111-111111111111", "kind": "income", "name": "Salary",
       "recurrence": "recurring", "start": "2026-06", "amounts": [{"month": "2026-06", "amount": "28000"}]},
      {"item_key": "22222222-2222-4222-8222-222222222222", "kind": "expense", "name": "Car",
       "recurrence": "recurring", "start": "2026-06", "end": "2026-12", "amounts": [{"month": "2026-06", "amount": 5300}]},
      {"item_key": "33333333-3333-4333-8333-333333333333", "kind": "income", "name": "Bonus",
       "recurrence": "one_off", "amounts": [{"month": "2026-08", "amount": "32000"}, {"month": "2026-12", "amount": "35000"}]},
      {"item_key": "44444444-4444-4444-8444-444444444444", "kind": "asset", "name": "Gold",
       "recurrence": "recurring", "start": "2026-06", "amounts": [{"month": "2026-06", "amount": "100000"}]}
    ]}$j$::jsonb
$$;

grant execute on all functions in schema test to anon;

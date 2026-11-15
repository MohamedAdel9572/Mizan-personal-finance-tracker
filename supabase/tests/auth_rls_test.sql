-- =====================================================================
--  Auth, lockout, RLS isolation, validation, immutability, history.
--  Runs as the "anon" role with the x-mizan-session header, exactly like
--  the website does through PostgREST.
-- =====================================================================
set client_min_messages = notice;

\ir helpers.sql

-- =====================================================================
\echo '--- sign up'
set role anon;
select test.act_as(null);
select public.app_signup('Ahmed A', '01000000001', 'password-a1') as tok_a \gset
select public.app_signup('Bassem B', '+20 100 000 0002', 'password-b1') as tok_b \gset
select test.eq(length(:'tok_a')::text, '64', 'sign up returns a 64-char token');
select test.throws($$select public.app_signup('X', '01000000001', 'password-x1')$$, '%already registered%', 'duplicate mobile rejected');
select test.throws($$select public.app_signup('X', '01000000009', 'short')$$, '%at least 8%', 'short password rejected');
select test.throws($$select public.app_signup('  ', '01000000009', 'password-x1')$$, '%your name%', 'empty name rejected');
select test.throws($$select public.app_signup('X', '123', 'password-x1')$$, '%valid mobile%', 'bad mobile rejected');

reset role;
insert into private.settings values ('signup_code', 'open-sesame');
set role anon;
select test.throws($$select public.app_signup('C', '01000000003', 'password-c1')$$, '%sign-up code%', 'sign-up code required when set');
select test.eq(length(public.app_signup('C', '01000000003', 'password-c1', 'open-sesame'))::text, '64', 'sign-up with the right code works');
reset role;
delete from private.settings where key = 'signup_code';
select test.eq((select count(*) from private.sessions s join public.profiles p on p.id = s.user_id
                where p.mobile = '01000000001')::text, '1', 'only the token hash is stored (1 session row)');
select test.eq((select count(*) from private.sessions where token_hash = :'tok_a')::text, '0', 'raw token is never stored');
select test.eq((select (password_hash like '$2a$10$%')::text from private.accounts a
                join public.profiles p on p.id = a.user_id where p.mobile = '01000000001'), 'true', 'password stored as bcrypt');
set role anon;

\echo '--- app_uid'
select test.act_as(:'tok_a');
select id as uid_a from public.app_me() \gset
select test.eq((select mobile from public.app_me()), '01000000001', 'app_me returns own profile');
select test.act_as(:'tok_b');
select id as uid_b from public.app_me() \gset
select test.eq((select mobile from public.app_me()), '01000000002', 'mobile normalised from +20 format');
select test.act_as('0000000000000000000000000000000000000000000000000000000000000000');
select test.eq(public.app_uid()::text, null, 'unknown token is signed out');
select test.act_as(null);
select test.eq(public.app_uid()::text, null, 'no header is signed out');

\echo '--- lockout'
select test.eq(public.app_login('01000000002', 'wrong-1')->>'error', 'Wrong mobile number or password.', 'wrong password 1');
select test.eq(public.app_login('01000000002', 'wrong-2')->>'error', 'Wrong mobile number or password.', 'wrong password 2');
select test.eq(public.app_login('01000000002', 'wrong-3')->>'error', 'Wrong mobile number or password.', 'wrong password 3');
select test.eq(public.app_login('01000000002', 'wrong-4')->>'error', 'Wrong mobile number or password.', 'wrong password 4');
select test.eq(public.app_login('01000000002', 'wrong-5')->>'error', 'Too many wrong attempts. Please try again in 15 minutes.', '5th wrong password locks');
select test.eq(public.app_login('01000000002', 'password-b1')->>'error', 'Too many wrong attempts. Please try again in 15 minutes.', 'right password refused while locked');
reset role;
select test.eq((select (locked_until between now() + interval '14 minutes' and now() + interval '15 minutes')::text
                from private.accounts where user_id = :'uid_b'), 'true', 'lock lasts 15 minutes');
update private.accounts set locked_until = now() - interval '1 second' where user_id = :'uid_b';
set role anon;
select test.eq(public.app_login('01000000002', 'wrong-6')->>'error', 'Wrong mobile number or password.', 'counter restarts after the lock expires');
select test.eq((public.app_login('01000000002', 'password-b1') ? 'token')::text, 'true', 'login works after the lock expires');
select test.eq(public.app_login('01999999999', 'whatever-1')->>'error', 'Wrong mobile number or password.', 'unknown mobile gives the same message');

\echo '--- plan: save and validate'
select test.act_as(:'tok_a');
select test.eq(public.save_plan_version(test.base_plan())->>'version_no', '1', 'first plan version saved');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{items,1,end}', '"2026-05"'))$$,
                   '%end month is before the start month%', 'end before start rejected');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{items,0,amounts,0,amount}', '"-5"'))$$,
                   '%negative%', 'negative amount rejected');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{items,0,kind}', '"loan"'))$$,
                   '%unknown type "loan"%', 'unknown item type rejected');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{items,0,start}', '"2026-13"'))$$,
                   '%not a valid month%', 'month 13 rejected');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{start_month}', '"2026-06-15"'))$$,
                   '%not a valid month%', 'mid-month date rejected');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{rates}', '[]'))$$,
                   '%interest rate%', 'missing interest rate rejected');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{items,0,amounts,0,month}', '"2026-07"'))$$,
                   '%first amount must be in the start month%', 'recurring line needs an amount in its start month');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{items,0,amounts,0,amount}', '"12.345"'))$$,
                   '%not a valid amount%', 'more than 2 decimals rejected');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{items,1,item_key}', '"11111111-1111-4111-8111-111111111111"'))$$,
                   '%can''t change between income, expense and asset%', 'line key cannot switch kind');
select test.eq((select count(*) from public.plan_versions)::text, '1', 'failed saves wrote nothing');
select test.eq(jsonb_array_length(public.get_plan_versions())::text, '1', 'get_plan_versions returns 1 version');
select test.eq(public.get_plan_versions()#>>'{0,items,1,amounts,0,amount}', '5300.00', 'money returned as exact text');

\echo '--- actuals'
insert into public.actual_entries (month, item_key, amount) values
  ('2026-06-01', '11111111-1111-4111-8111-111111111111', 28000),
  ('2026-06-01', '22222222-2222-4222-8222-222222222222', 6000);
insert into public.unplanned_items (month, kind, name, amount) values ('2026-07-01', 'expense', 'Car repair', 4500);
insert into public.monthly_checkins (month, savings_balance) values ('2026-06-01', 120000);
insert into public.goals (target_amount, target_month) values (1000000, '2028-12-01');
insert into public.gold_holdings (label, karat, grams, purchase_price, purchase_date) values ('BTC bar', 24, 10, 40000, '2026-01-10');
insert into public.gold_price_overrides (karat, price_per_gram_egp) values (21, 4300);
select test.eq((select count(*) from public.actual_entries)::text, '2', 'actuals saved');
select test.throws(format('insert into public.monthly_checkins (month) values (%L)',
                          (date_trunc('month', now() at time zone 'Africa/Cairo') + interval '1 month')::date),
                   '%in the future%', 'future month rejected');
select test.throws($$insert into public.monthly_checkins (month) values ('2026-05-01')$$, '%before your plan starts%', 'month before the plan rejected');
select test.throws($$insert into public.monthly_checkins (month) values ('2026-06-15')$$, '%month_date%', 'mid-month date rejected by the domain');
select test.throws($$insert into public.actual_entries (month, item_key, amount) values ('2026-07-01', gen_random_uuid(), 1)$$,
                   '%not in your plan%', 'unknown line rejected');
select test.throws($$insert into public.actual_entries (month, item_key, amount) values ('2026-07-01', '44444444-4444-4444-8444-444444444444', 1)$$,
                   '%not in your plan%', 'asset line cannot get a spending actual');
select test.throws($$insert into public.actual_entries (month, item_key, amount) values ('2026-07-01', '11111111-1111-4111-8111-111111111111', -1)$$,
                   '%check constraint%', 'negative actual rejected');
select test.throws($$insert into public.unplanned_items (month, kind, name, amount) values ('2026-07-01', 'loan', 'x', 1)$$,
                   '%check constraint%', 'unknown unplanned type rejected');
select test.throws($$insert into public.gold_holdings (label, karat, grams, purchase_price, purchase_date) values ('x', 20, 1, 1, '2026-01-01')$$,
                   '%check constraint%', 'unknown karat rejected');
select test.throws($$insert into public.gold_holdings (label, karat, grams, purchase_price, purchase_date) values ('x', 21, 1, 1, current_date + 400)$$,
                   '%future%', 'future purchase date rejected');

\echo '--- plan versions: immutable, new version, history'
select test.throws($$update public.plan_items set name = 'Hacked'$$, '%permission denied%', 'client cannot update plan items');
select test.throws($$delete from public.plan_versions$$, '%permission denied%', 'client cannot delete plan versions');
select test.throws($$insert into public.audit_events (user_id, event_type, entity, summary) values (public.app_uid(), 'insert', 'x', 'fake')$$,
                   '%permission denied%', 'client cannot write history');
select test.throws($$update public.profiles set mobile = '01000000009'$$, '%permission denied%', 'client cannot change own mobile directly');
update public.profiles set full_name = 'Ahmed Adel';
select test.eq((select full_name from public.app_me()), 'Ahmed Adel', 'client can rename self');

select test.eq(public.save_plan_version(
  jsonb_set(jsonb_set(jsonb_set(test.base_plan(), '{effective_from}', '"2026-09"'),
    '{items,0,amounts}', '[{"month":"2026-06","amount":"28000"},{"month":"2026-09","amount":"35000"}]'),
    '{items,1}', '{"kind":"expense","name":"PS5","recurrence":"recurring","start":"2026-09","end":"2027-08","amounts":[{"month":"2026-09","amount":"3000"}]}')
  )->>'version_no', '2', 'second version saved');
select test.throws($$select public.save_plan_version(jsonb_set(test.base_plan(), '{effective_from}', '"2026-05"'))$$,
                   '%before the plan start%', 'new version cannot start before the plan start');
select test.eq((select summary from public.audit_events where event_type = 'plan_version' order by id desc limit 1),
               'Saved plan version 2 (effective 2026-09), added: PS5, removed: Car, edited: Salary', 'history describes the version change');
select test.eq((select count(*) from public.audit_events where entity = 'actual_entries')::text, '2', 'history has one row per actual');
select test.eq((select summary from public.audit_events where entity = 'unplanned_items'),
               'Added unplanned expense "Car repair" = 4500.00 (2026-07)', 'history summary for unplanned item');
insert into public.actual_entries (month, item_key, amount) values ('2026-10-01', '22222222-2222-4222-8222-222222222222', 5300);
select test.eq('ok', 'ok', 'actual for a line removed in a later version is still allowed');

reset role;
select test.throws($$update public.plan_items set name = 'Hacked'$$, '%can''t be changed%', 'even the owner role cannot edit a saved version');
select test.throws($$delete from public.plan_versions$$, '%can''t be changed%', 'even the owner role cannot delete a saved version');
insert into public.gold_prices (karat, price_per_gram_egp, source) values (24, 4800, 'test');

\echo '--- RLS: user B'
set role anon;
select test.act_as(:'tok_b');
select test.eq(public.save_plan_version(jsonb_set(test.base_plan(), '{items}', '[]'))->>'version_no', '1', 'B saves own plan (version numbers are per user)');
do $$
declare t text; n bigint;
begin
  foreach t in array array['profiles', 'user_settings', 'goals', 'plan_versions', 'plan_items', 'plan_item_amounts',
                           'plan_rates', 'monthly_checkins', 'actual_entries', 'unplanned_items', 'gold_holdings',
                           'gold_price_overrides', 'audit_events'] loop
    execute format('select count(*) from public.%I where %s <> public.app_uid()', t,
                   case t when 'profiles' then 'id' else 'user_id' end) into n;
    if n <> 0 then raise exception 'FAIL B can see % rows of A in %', n, t; end if;
  end loop;
  raise notice 'ok - B sees none of A''s rows in any of 13 tables';
end $$;
select test.eq(jsonb_array_length(public.get_plan_versions())::text, '1', 'get_plan_versions returns only B''s version');
select test.eq(test.rows('update public.actual_entries set amount = 1'), '0', 'B cannot update A''s actuals');
select test.eq(test.rows('delete from public.gold_holdings'), '0', 'B cannot delete A''s gold');
select test.throws('delete from public.audit_events', '%permission denied%', 'nobody can delete history from the client');
select test.throws(format('insert into public.monthly_checkins (user_id, month) values (%L, ''2026-07-01'')', :'uid_a'),
                   '%row-level security%', 'B cannot insert a row owned by A');
select test.throws(format('insert into public.goals (user_id, target_amount, target_month) values (%L, 5, ''2030-01-01'')', :'uid_a'),
                   '%row-level security%', 'B cannot create A''s goal');
select test.throws($$select public.save_plan_version(test.base_plan())$$, '%invalid item key%', 'B cannot reuse A''s line keys');
select test.eq((select count(*) from public.gold_prices)::text, '1', 'signed-in user reads shared gold prices');

\echo '--- signed out'
select test.act_as(null);
do $$
declare t text; n bigint;
begin
  foreach t in array array['profiles', 'user_settings', 'goals', 'plan_versions', 'plan_items', 'plan_item_amounts',
                           'plan_rates', 'monthly_checkins', 'actual_entries', 'unplanned_items', 'gold_holdings',
                           'gold_price_overrides', 'audit_events', 'gold_prices'] loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then raise exception 'FAIL signed-out caller sees % rows in %', n, t; end if;
  end loop;
  raise notice 'ok - signed-out caller sees nothing in any of 14 tables';
end $$;
select test.throws($$select public.save_plan_version(test.base_plan())$$, '%sign in%', 'signed-out save rejected');
select test.throws($$insert into public.goals (target_amount, target_month) values (5, '2030-01-01')$$, '%row-level security%', 'signed-out insert rejected');
select test.eq(public.ping()::text, 'true', 'ping works without signing in');

reset role;
select test.eq((select amount::text from public.actual_entries where user_id = :'uid_a' and month = '2026-06-01'
                and item_key = '11111111-1111-4111-8111-111111111111'), '28000.00', 'A''s data untouched by B');

\echo '--- change password'
set role anon;
select test.act_as(null);
select public.app_login('01000000001', 'password-a1')->>'token' as tok_a2 \gset
select test.act_as(:'tok_a');
select test.throws($$select public.app_change_password('nope-nope', 'password-a2')$$, '%Current password is wrong%', 'wrong current password rejected');
select test.throws($$select public.app_change_password('password-a1', 'short')$$, '%at least 8%', 'short new password rejected');
select public.app_change_password('password-a1', 'password-a2');
select test.eq(public.app_uid()::text, :'uid_a', 'this device stays signed in');
select test.act_as(:'tok_a2');
select test.eq(public.app_uid()::text, null, 'other devices are signed out');
select test.eq(public.app_login('01000000001', 'password-a1')->>'error', 'Wrong mobile number or password.', 'old password no longer works');
select test.eq((public.app_login('01000000001', 'password-a2') ? 'token')::text, 'true', 'new password works');

\echo '--- logout'
select public.app_login('01000000002', 'password-b1')->>'token' as tok_b2 \gset
select test.act_as(:'tok_b2');
select public.app_logout();
select test.eq(public.app_uid()::text, null, 'logout kills the session');

\echo '--- delete account'
select test.act_as(:'tok_a');
select test.throws($$select public.app_delete_account('nope-nope')$$, '%Wrong password%', 'delete needs the right password');
select public.app_delete_account('password-a2');
reset role;
select set_config('test.uid_a', :'uid_a', false);
do $$
declare t text; n bigint; a uuid := current_setting('test.uid_a')::uuid;
begin
  foreach t in array array['user_settings', 'goals', 'plan_versions', 'plan_items', 'plan_item_amounts', 'plan_rates',
                           'monthly_checkins', 'actual_entries', 'unplanned_items', 'gold_holdings',
                           'gold_price_overrides', 'audit_events'] loop
    execute format('select count(*) from public.%I where user_id = $1', t) using a into n;
    if n <> 0 then raise exception 'FAIL % rows of the deleted user left in %', n, t; end if;
  end loop;
  select count(*) into n from private.sessions where user_id = a;
  if n <> 0 then raise exception 'FAIL sessions left'; end if;
  select count(*) into n from private.accounts where user_id = a;
  if n <> 0 then raise exception 'FAIL account left'; end if;
  raise notice 'ok - deleting the account removed every row it owned';
end $$;
select test.eq((select count(*) from public.plan_versions where user_id = :'uid_b')::text, '1', 'other users keep their data');

drop schema test cascade;

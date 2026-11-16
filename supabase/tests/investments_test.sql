-- =====================================================================
--  018: investments
-- =====================================================================
\ir helpers.sql
set role anon;
select test.act_as(null);
select test.throws($$select public.save_invest_account(null, '{"name":"X"}')$$, '%sign in%', 'investments need a session');
select public.app_signup('Mona M', '01577700011', 'password-m1') as tok_m \gset
select public.app_signup('Nour N', '01577700012', 'password-n1') as tok_n \gset
select test.act_as(:'tok_m');

select public.save_invest_account(null, '{"name":"Mashreq daily profit","opening":"100,000","usual_rate":"17","rate_unit":"yearly"}') as ma \gset
select public.save_invest_account(null, '{"name":"Thndr","opening":"0"}') as th \gset
select test.eq((select receives_savings::text from public.invest_accounts where id = :'ma'), 'true', 'first investment receives the savings');
select test.eq((select receives_savings::text from public.invest_accounts where id = :'th'), 'false', 'second one does not');
select public.save_invest_account(:'th', '{"name":"Thndr","opening":"0","receives_savings":true}');
select test.eq((select count(*)::text from public.invest_accounts where receives_savings), '1', 'only one receives the savings');
select test.eq((select name from public.invest_accounts where receives_savings), 'Thndr', 'moved to Thndr');

select public.save_invest_month('2026-11', jsonb_build_array(
  jsonb_build_object('account_id', :'ma', 'profit', '1,416.67', 'rate', '17', 'rate_unit', 'yearly'),
  jsonb_build_object('account_id', :'th', 'profit', '-800')));
select test.eq((select sum(profit)::text from public.invest_months where month = '2026-11-01'), '616.67', 'profit and loss saved');
select test.eq((select summary from public.audit_events where entity = 'invest_months' order by id desc limit 1),
  'Investments 2026-11: Mashreq daily profit +1,416.67, Thndr -800', 'month written to History');
select public.save_invest_month('2026-11', jsonb_build_array(jsonb_build_object('account_id', :'th', 'profit', '')));
select test.eq((select count(*)::text from public.invest_months where month = '2026-11-01'), '1', 'empty profit clears the month');
select test.throws(format($$select public.save_invest_month('2026-11', '[{"account_id":%s,"profit":"abc"}]')$$, :'ma'), '%not a valid amount%', 'profit checked');

select public.save_invest_move(null, jsonb_build_object('from_account', :'ma', 'to_account', :'th', 'amount', '20,000', 'date', '2026-11-10'));
select test.eq((select amount::text from public.invest_moves), '20000.00', 'move saved');
select test.throws(format($$select public.save_invest_move(null, '{"from_account":%s,"to_account":%s,"amount":"5","date":"2026-11-10"}')$$, :'ma', :'ma'), '%two different%', 'move needs two investments');
select test.eq(jsonb_array_length(public.get_investments()->'accounts')::text, '2', 'get_investments lists accounts');

select test.act_as(:'tok_n');
select test.eq(jsonb_array_length(public.get_investments()->'accounts')::text, '0', 'N sees none of M''s investments');
select test.throws(format($$select public.save_invest_month('2026-11', '[{"account_id":%s,"profit":"5"}]')$$, :'ma'), '%not found%', 'N cannot log M''s investment');

select test.act_as(:'tok_m');
select public.delete_invest_account(:'th');
select test.eq((select count(*)::text from public.invest_moves), '0', 'deleting an investment deletes its moves');

-- =====================================================================
--  get_history, get_gold_prices, set_gold_price
-- =====================================================================
\ir helpers.sql
set role anon;
select test.act_as(null);
select public.app_signup('Jana J', '01400000001', 'password-j1') as tok_j \gset
select public.app_signup('Karim K', '01400000002', 'password-k1') as tok_k \gset
select test.eq(public.get_history()::text, '[]', 'signed out: no history');
select test.eq(public.get_gold_prices()::text, '[]', 'signed out: no prices');
select test.throws($$select public.set_gold_price(21, '5900')$$, '%sign in%', 'set price needs a session');

select test.act_as(:'tok_j');
select public.save_plan_version(test.base_plan());
select public.save_checkin('2026-07', '[{"item_key": "11111111-1111-4111-8111-111111111111", "amount": "28000"}]');
select test.eq((public.get_history()#>>'{0,type}'), 'insert', 'newest entry first');
select test.eq((select count(*) from jsonb_array_elements(public.get_history()) x where x->>'type' = 'plan_version')::text, '1', 'plan version in history');
select test.eq(jsonb_array_length(public.get_history(1))::text, '1', 'limit works');

select test.eq(public.get_gold_prices()#>>'{1,karat}', '21', 'karats listed 24, 21, 18');
select test.eq((public.get_gold_prices()#>'{1,my_price}')::text, 'null', 'no price yet');
select public.set_gold_price(21, '5,900'::text);
select test.eq(public.get_gold_prices()#>>'{1,my_price}', '5900.00', 'price saved (thousand separator accepted)');
select public.set_gold_price(21, '5950');
select test.eq(public.get_gold_prices()#>>'{1,my_price}', '5950.00', 'latest price wins');
select public.set_gold_price(21, '');
select test.eq((public.get_gold_prices()#>'{1,my_price}')::text, 'null', 'empty clears the price');
select test.throws($$select public.set_gold_price(22, '1')$$, '%24, 21 or 18%', 'bad karat rejected');
select test.throws($$select public.set_gold_price(21, '-5')$$, '%negative%', 'negative price rejected');
select test.throws($$select public.set_gold_price(21, '0')$$, '%more than 0%', 'zero price rejected');
select test.eq((select count(*) from jsonb_array_elements(public.get_history()) x where x->>'entity' = 'gold_price_overrides')::text, '3', 'price changes in history');

reset role;
insert into public.gold_prices (karat, price_per_gram_egp, source) values (21, 5900, 'test-feed');
set role anon;
select test.eq(public.get_gold_prices()#>>'{1,fetched_price}', '5900.00', 'fetched price visible');

select test.act_as(:'tok_k');
select test.eq(public.get_history()::text, '[]', 'K sees none of J''s history');
select test.eq((public.get_gold_prices()#>'{1,my_price}')::text, 'null', 'K does not see J''s price');

select public.app_delete_account('password-k1');
select test.act_as(:'tok_j');
select public.app_delete_account('password-j1');
reset role;
delete from public.gold_prices where source = 'test-feed';
drop schema test cascade;

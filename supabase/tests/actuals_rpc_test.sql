-- =====================================================================
--  Actuals RPCs: get_actuals, save_checkin, add/delete_unplanned
-- =====================================================================
\ir helpers.sql

set role anon;
select test.act_as(null);
select public.app_signup('Dina D', '01100000001', 'password-d1') as tok_d \gset
select public.app_signup('Emad E', '01100000002', 'password-e1') as tok_e \gset

\echo '--- signed out'
select test.throws($$select public.save_checkin('2026-07', '[]')$$, '%sign in%', 'save_checkin needs a session');
select test.throws($$select public.add_unplanned('2026-07', 'expense', 'x', '1')$$, '%sign in%', 'add_unplanned needs a session');
select test.eq(public.get_actuals()::text, '{"entries": [], "checkins": [], "unplanned": []}', 'get_actuals is empty when signed out');

\echo '--- save_checkin'
select test.act_as(:'tok_d');
select test.throws($$select public.save_checkin('2026-07', '[]')$$, '%Create your plan%', 'check-in before a plan is rejected');
select public.save_plan_version(test.base_plan());
select public.save_checkin('2026-07',
  '[{"item_key": "11111111-1111-4111-8111-111111111111", "amount": "28000"},
    {"item_key": "22222222-2222-4222-8222-222222222222", "amount": "5300.50"}]', '120000', 'first month');
select test.eq(public.get_actuals()#>>'{entries,1,amount}', '5300.50', 'entries saved, money as text');
select test.eq(public.get_actuals()#>>'{checkins,0,savings_balance}', '120000.00', 'savings balance saved');
select test.eq(public.get_actuals()#>>'{checkins,0,month}', '2026-07', 'month returned as YYYY-MM');

select public.save_checkin('2026-07',
  '[{"item_key": "11111111-1111-4111-8111-111111111111", "amount": "28000"},
    {"item_key": "22222222-2222-4222-8222-222222222222", "amount": "6000"}]', '', 'first month');
select test.eq(public.get_actuals()#>>'{entries,1,amount}', '6000.00', 'saving again updates the amount');
select test.eq((public.get_actuals()#>'{checkins,0,savings_balance}')::text, 'null', 'empty balance clears it');
select test.eq((select count(*) from public.audit_events where entity = 'actual_entries')::text, '3',
               'unchanged lines are not re-logged in History (2 inserts + 1 edit)');

\echo '--- gold value with a check-in (013)'
select test.eq((public.get_actuals()#>'{checkins,0,gold_value}')::text, 'null', 'no gold value yet');
select public.save_checkin('2026-07',
  '[{"item_key": "11111111-1111-4111-8111-111111111111", "amount": "28000"},
    {"item_key": "22222222-2222-4222-8222-222222222222", "amount": "6000"}]', '', 'first month', '103,600');
select test.eq(public.get_actuals()#>>'{checkins,0,gold_value}', '103600.00', 'gold value saved (commas ok)');
select public.save_checkin('2026-07',
  '[{"item_key": "11111111-1111-4111-8111-111111111111", "amount": "28000"},
    {"item_key": "22222222-2222-4222-8222-222222222222", "amount": "6000"}]', '', 'first month');
select test.eq(public.get_actuals()#>>'{checkins,0,gold_value}', '103600.00', 'saving without a gold value keeps the old one');
select test.throws($$select public.save_checkin('2026-07', '[]', '', '', '-5')$$, '%negative%', 'negative gold value rejected');

select test.throws($$select public.save_checkin('2026-08',
  '[{"item_key": "11111111-1111-4111-8111-111111111111", "amount": "28000"},
    {"item_key": "22222222-2222-4222-8222-222222222222", "amount": "-1"}]')$$, '%negative%', 'negative amount rejected');
select test.eq((select count(*) from public.actual_entries where month = '2026-08-01')::text, '0',
               'a rejected check-in saves nothing (atomic)');
select test.throws($$select public.save_checkin('2026-08', '[{"item_key": "not-a-uuid", "amount": "1"}]')$$,
                   '%invalid line key%', 'bad line key rejected');
select test.throws($$select public.save_checkin('2026-08', '[{"item_key": "99999999-9999-4999-8999-999999999999", "amount": "1"}]')$$,
                   '%not in your plan%', 'unknown line rejected');
select test.throws($$select public.save_checkin('2026-8', '[]')$$, '%not a valid month%', 'bad month rejected');
select test.throws($$select public.save_checkin('2026-08', '[]', 'abc')$$, '%not a valid amount%', 'bad balance rejected');
select test.throws(format('select public.save_checkin(%L, ''[]'')',
                          to_char(date_trunc('month', now() at time zone 'Africa/Cairo') + interval '1 month', 'YYYY-MM')),
                   '%in the future%', 'future month rejected');

\echo '--- unplanned'
select public.add_unplanned('2026-07', 'expense', '  Car repair ', '4500', 'radiator') as unp_id \gset
select test.eq(public.get_actuals()#>>'{unplanned,0,name}', 'Car repair', 'unplanned item saved and trimmed');
select test.throws($$select public.add_unplanned('2026-07', 'loan', 'x', '1')$$, '%income or expense%', 'unknown kind rejected');
select test.throws($$select public.add_unplanned('2026-07', 'expense', '', '1')$$, '%Name is required%', 'empty name rejected');
select test.throws($$select public.add_unplanned('2026-07', 'expense', 'x', '0')$$, '%more than 0%', 'zero amount rejected');

\echo '--- isolation'
select test.act_as(:'tok_e');
select test.eq(public.get_actuals()::text, '{"entries": [], "checkins": [], "unplanned": []}', 'E sees none of D''s actuals');
select test.throws(format('select public.delete_unplanned(%s)', :'unp_id'), '%not found%', 'E cannot delete D''s item');
select public.save_plan_version(jsonb_set(test.base_plan(), '{items}', '[]'));
select test.throws($$select public.save_checkin('2026-07', '[{"item_key": "11111111-1111-4111-8111-111111111111", "amount": "1"}]')$$,
                   '%not in your plan%', 'E cannot log against D''s line keys');

select test.act_as(:'tok_d');
select public.delete_unplanned(:'unp_id');
select test.eq(jsonb_array_length(public.get_actuals()->'unplanned')::text, '0', 'owner deletes the item');
select test.throws(format('select public.delete_unplanned(%s)', :'unp_id'), '%not found%', 'deleting twice says not found');

-- clean up so other test files can reuse the fixed line keys
select public.app_delete_account('password-d1');
select test.act_as(:'tok_e');
select public.app_delete_account('password-e1');

reset role;
drop schema test cascade;

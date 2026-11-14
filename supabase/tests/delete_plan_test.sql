-- =====================================================================
--  delete_latest_plan_version + delete_plan
-- =====================================================================
\ir helpers.sql
set role anon;
select test.act_as(null);
select public.app_signup('Hana H', '01300000001', 'password-h1') as tok_h \gset
select public.app_signup('Ibrahim I', '01300000002', 'password-i1') as tok_i \gset

select test.throws($$select public.delete_plan()$$, '%sign in%', 'delete_plan needs a session');

select test.act_as(:'tok_h');
select test.throws($$select public.delete_plan()$$, '%no plan%', 'nothing to delete');
select public.save_plan_version(test.base_plan());
select test.throws($$select public.delete_latest_plan_version()$$, '%only version%', 'cannot undo the only version');
select public.save_plan_version(jsonb_set(test.base_plan(), '{items,0,amounts,0,amount}', '"30000"'));
select public.save_checkin('2026-07', '[{"item_key": "11111111-1111-4111-8111-111111111111", "amount": "30000"}]');
select public.add_unplanned('2026-07', 'expense', 'Repair', '100');
select public.import_workbook(null, '[]', '[]', '[{"row": 11, "label": "BTC", "karat": 21, "grams": "2.5", "price": "12510", "date": "2025-03-21"}]');

select test.eq(public.delete_latest_plan_version()::text, '{"current_version": 1, "deleted_version": 2}', 'latest version deleted');
select test.eq(public.get_plan_versions()#>>'{0,items,0,amounts,0,amount}', '28000.00', 'version 1 is current again');
select test.eq((select count(*) from public.actual_entries)::text, '1', 'actuals kept when undoing a version');
select test.eq((select summary from public.audit_events order by id desc limit 1),
               'Deleted plan version 2; version 1 is current again', 'undo logged in History');
select test.eq(public.save_plan_version(test.base_plan())->>'version_no', '2', 'version numbers continue after an undo');

select test.act_as(:'tok_i');
select test.throws($$select public.delete_plan()$$, '%no plan%', 'I cannot delete H''s plan');
select test.act_as(:'tok_h');

select test.eq(public.delete_plan()::text, '{"actuals": 1, "checkins": 1, "versions": 2, "unplanned": 1}', 'whole plan deleted');
select test.eq(public.get_plan_versions()::text, '[]', 'no versions left');
select test.eq(public.get_actuals()::text, '{"entries": [], "checkins": [], "unplanned": []}', 'actuals, check-ins and unplanned removed');
select test.eq(jsonb_array_length(public.get_gold_holdings())::text, '1', 'gold kept');
select test.eq((select summary from public.audit_events order by id desc limit 1),
               'Deleted the plan: 2 versions, 1 logged months, 1 unplanned items. Gold kept.', 'one History entry for the whole delete');
select test.eq((select count(*) from public.audit_events where event_type = 'delete')::text, '0', 'no per-row History noise');
select test.throws($$update public.plan_items set name = 'x'$$, '%permission denied%', 'versions still protected after delete');
select test.eq(public.save_plan_version(test.base_plan())->>'version_no', '1', 'a new plan starts at version 1');

reset role;
select test.throws($$delete from public.plan_versions$$, '%can''t be changed%', 'outside the delete functions versions stay protected');
set role anon;

select public.app_delete_account('password-h1');
select test.act_as(:'tok_i');
select public.app_delete_account('password-i1');
reset role;
drop schema test cascade;

\ir helpers.sql
set role anon;
select test.act_as(null);
select public.app_signup('Nour N', '01600000001', 'password-n1') as tok_n \gset
select test.throws($$select public.set_goal('1000000', '2028-12')$$, '%sign in%', 'set_goal needs a session');
select test.act_as(:'tok_n');
select test.eq(public.get_goal()::text, null, 'no goal yet');
select public.set_goal('1,000,000', '2028-12', '15000');
select test.eq(public.get_goal()::text, '{"target_month": "2028-12", "target_amount": "1000000.00", "monthly_savings_target": "15000.00"}', 'goal saved');
select public.set_goal('1200000', '2029-06', '');
select test.eq(public.get_goal()::text, '{"target_month": "2029-06", "target_amount": "1200000.00", "monthly_savings_target": null}', 'goal updated, savings target cleared');
select test.throws($$select public.set_goal('0', '2028-12')$$, '%more than 0%', 'zero target rejected');
select test.throws($$select public.set_goal('5', '2028-13')$$, '%not a valid month%', 'bad month rejected');
select test.eq((select count(*) from public.audit_events where entity = 'goals')::text, '2', 'goal changes in history');
select public.app_delete_account('password-n1');
reset role;
drop schema test cascade;

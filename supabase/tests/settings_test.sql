\ir helpers.sql
set role anon;
select test.act_as(null);
select public.app_signup('Sara S', '01600000002', 'password-s1') as tok_s \gset
select public.app_signup('Omar O', '01600000003', 'password-o1') as tok_o \gset
select test.throws($$select public.clear_history()$$, '%sign in%', 'clear_history needs a session');

-- settings
select test.act_as(:'tok_s');
select test.eq(public.get_settings()::text, '{"gold_adjust_pct": "0.00", "warn_threshold_pct": "5.00"}', 'defaults');
select public.set_settings('10', null);
select test.eq(public.get_settings()->>'warn_threshold_pct', '10.00', 'warn limit saved');
select public.set_settings(null, '+1.3');
select test.eq(public.get_settings()::text, '{"gold_adjust_pct": "1.30", "warn_threshold_pct": "10.00"}', 'adjust saved, warn kept');
select public.set_settings('', '-2');
select test.eq(public.get_settings()->>'gold_adjust_pct', '-2.00', 'negative adjust ok');
select test.throws($$select public.set_settings('51', null)$$, '%0 to 50%', 'warn > 50 rejected');
select test.throws($$select public.set_settings('abc', null)$$, '%0 to 50%', 'warn text rejected');
select test.throws($$select public.set_settings(null, '25')$$, '%-20 to 20%', 'adjust > 20 rejected');

-- goal remove
select public.set_goal('1000000', '2028-12');
select public.delete_goal();
select test.eq(public.get_goal()::text, null, 'goal removed');
select public.delete_goal();

-- clear history: only mine
select test.act_as(:'tok_o');
select public.set_goal('500000', '2027-12');
select test.act_as(:'tok_s');
select test.eq((public.clear_history() > 0)::text, 'true', 'cleared some rows');
select test.eq((select count(*) from public.audit_events)::text, '0', 'my history is empty');
select test.eq(public.get_settings()->>'gold_adjust_pct', '-2.00', 'settings kept after clear');
select test.act_as(:'tok_o');
select test.eq(((select count(*) from public.audit_events) > 0)::text, 'true', 'other user history untouched');

select public.app_delete_account('password-o1');
select test.act_as(:'tok_s');
select public.app_delete_account('password-s1');
reset role;
drop schema test cascade;

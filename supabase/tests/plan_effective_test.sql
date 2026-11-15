-- =====================================================================
--  015: a new version may start before the current version's month
-- =====================================================================
\ir helpers.sql
set role anon;
select test.act_as(null);
select public.app_signup('Jana J', '01477700001', 'password-j1') as tok_j \gset
select test.act_as(:'tok_j');
select public.save_plan_version(test.base_plan());
select test.eq(public.save_plan_version(jsonb_set(test.base_plan(), '{effective_from}', '"2027-05"'))->>'version_no', '2', 'version 2 from a later month');
select test.eq(public.save_plan_version(jsonb_set(test.base_plan(), '{effective_from}', '"2026-08"'))->>'version_no', '3', 'version 3 may start before version 2');
select test.eq((select to_char(effective_from, 'YYYY-MM') from public.plan_versions where version_no = 3), '2026-08', 'version 3 keeps its month');
